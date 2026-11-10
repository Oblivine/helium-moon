// HELIUM MOON - multiplayer server. Serves the game files and runs one authoritative
// GameSim per lobby (monster AI, objectives, health, mimicry selection). Also relays
// WebRTC voice signalling, chat, and mimicry audio snippets between lobby members.
//   node server/server.js            (PORT=8080 by default)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from './ws.js';
import { World } from '../shared/world.js';
import { GameSim } from '../shared/sim/sim.js';
import { CONFIG } from '../shared/config.js';
import { listenOptions, listenWithFallback } from './listen.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let listenConfig;
try { listenConfig = listenOptions(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exit(1); }
const TICK = 1 / 20;
const SNAP_EVERY = 1;   // snapshot every tick (20 Hz) - small payloads
const VERSION = 1;
const TEST_MODE = process.env.HM_TEST === '1';   // enables the 'debug' message for automated tests only

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bin': 'application/octet-stream',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };
const ALLOWED_TOP = new Set(['index.html', 'client', 'shared', 'vendor', 'assets', 'favicon.ico']);

// WebRTC ICE servers handed to every client for proximity voice. STUN alone works on most home
// networks; players behind strict NATs/firewalls need a TURN relay. Configure with either
//   HM_ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
// or TURN_URL=turn:turn.example.com:3478[,turns:...] TURN_USERNAME=u TURN_CREDENTIAL=p
// (TURN credentials necessarily reach players' browsers; prefer short-lived credentials.)
function iceServersFromEnv(env) {
  if (env.HM_ICE_SERVERS) {
    try {
      const v = JSON.parse(env.HM_ICE_SERVERS);
      if (Array.isArray(v) && v.every((e) => e && (typeof e.urls === 'string' || Array.isArray(e.urls)))) return v;
    } catch (e) { /* fall through */ }
    console.warn('HM_ICE_SERVERS is not a JSON array of {urls, username?, credential?}; using defaults');
  }
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (env.TURN_URL) list.push({ urls: env.TURN_URL.split(',').map((u) => u.trim()).filter(Boolean), username: env.TURN_USERNAME || '', credential: env.TURN_CREDENTIAL || '' });
  return list;
}
const ICE_SERVERS = iceServersFromEnv(process.env);

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

// ------------------------------------------------------------------ static files
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel === '' ) rel = 'index.html';
    if (rel === 'healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    const top = rel.split('/')[0];
    const file = path.resolve(ROOT, rel);
    if (!ALLOWED_TOP.has(top) || !file.startsWith(ROOT + path.sep)) { res.writeHead(404); res.end('not found'); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size,
        'cache-control': /\.(jpg|png|bin|ogg|m4a|mp4)$/.test(file) ? 'public, max-age=3600' : 'no-cache' });
      fs.createReadStream(file).pipe(res);
    });
  } catch (e) { res.writeHead(400); res.end('bad request'); }
});

// ------------------------------------------------------------------ world (built once, shared by all lobbies)
log('building world...');
const world = new World({ log: (m) => log('[world]', m) });
log(`world ready in ${world.buildMs} ms`);

// ------------------------------------------------------------------ lobbies
const rooms = new Map();     // code -> room
let nextId = 1;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() { let c; do { c = ''; for (let i = 0; i < 5; i++) c += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]; } while (rooms.has(c)); return c; }

function send(c, obj) { c.send(JSON.stringify(obj)); }
function broadcast(room, obj, except) { const s = JSON.stringify(obj); for (const m of room.members.values()) if (m !== except) m.conn.send(s); }

function lobbyInfo(room) {
  return { t: 'lobby', code: room.code, state: room.state, host: room.host, difficulty: room.difficulty || 'ranger',
    players: [...room.members.values()].map((m) => ({ id: m.id, name: m.name, host: m.id === room.host, ready: m.ready })) };
}

function startGame(room, difficulty) {
  if (room.timer) clearInterval(room.timer);
  // Update 0.9: the host picks the difficulty; a restart keeps it unless the host sends another
  if (typeof difficulty === 'string' && Object.hasOwn(CONFIG.DIFFICULTY, difficulty)) room.difficulty = difficulty;
  const sim = new GameSim(world, { seed: (Math.random() * 2 ** 31) | 0, log, difficulty: room.difficulty || 'ranger' });
  for (const m of room.members.values()) sim.addPlayer(m.id, m.name);
  room.sim = sim; room.state = 'game'; room.tick = 0; room.mimicOk = new Map();
  broadcast(room, { t: 'start', info: sim.info() });
  log(`room ${room.code}: game started with ${room.members.size} players (seed ${sim.seed})`);
  let last = Date.now(), acc = 0;
  room.timer = setInterval(() => {
    const now = Date.now(); acc += Math.min(0.25, (now - last) / 1000); last = now;
    while (acc >= TICK) { sim.step(TICK); acc -= TICK; room.tick++; }
    const ev = sim.drainEvents();
    for (const e of ev) if (e.type === 'mimic') room.mimicOk.set(e.mid, { owner: e.owner, t: Date.now() });
    if (room.mimicOk.size > 32) for (const [k, v] of room.mimicOk) if (Date.now() - v.t > 15000) room.mimicOk.delete(k);
    if (ev.length) broadcast(room, { t: 'ev', ev });
    if (room.tick % SNAP_EVERY === 0) broadcast(room, { t: 'snap', s: sim.snapshot() });
    if (sim.state === 'won' || sim.state === 'lost') {
      clearInterval(room.timer); room.timer = null;
      broadcast(room, { t: 'snap', s: sim.snapshot() });
      setTimeout(() => { if (room.state === 'game' && room.sim === sim) { room.state = 'ended'; broadcast(room, lobbyInfo(room)); } }, 1500);
    }
  }, 1000 * TICK);
}

// Fixed-window rate limit per connection and message kind. Generous for real play
// (inputs at 20 Hz, ICE candidate bursts), but stops one client from flooding a lobby.
const LIMITS = { in: [80, 1000], act: [30, 1000], chat: [6, 5000], sig: [300, 10000], voice_state: [10, 10000], bin: [4, 10000], voice_bin: [100, 10000], lobby: [20, 10000] };
function allow(member, kind) {
  const [max, per] = LIMITS[kind] || [60, 1000], now = Date.now();
  const b = member.rate[kind] || (member.rate[kind] = { n: 0, t: now });
  if (now - b.t > per) { b.n = 0; b.t = now; }
  return ++b.n <= max;
}

// Mimicry audio is only relayed when it answers a mimic event this server issued
// to that same player in the last 15 s, once per event. Without this, a modified
// client could make every teammate's game play arbitrary audio.
const MIMIC_RELAY_MAX = 320000;   // 8 s of 16 kHz int16 plus header
function audioHeader(data) {
  if (!data || data.length < 8) return null;
  const hl = data.readUInt32LE(0);
  if (hl < 2 || hl > 2048 || 4 + hl > data.length) return null;
  try { return { head: JSON.parse(data.subarray(4, 4 + hl).toString('utf8')), hl }; } catch (e) { return null; }
}
function mimicRelayAllowed(room, member, data) {
  if (!room || !room.mimicOk || data.length < 8 || data.length > MIMIC_RELAY_MAX) return false;
  const parsed = audioHeader(data); if (!parsed) return false;
  const { head } = parsed;
  const ok = head && head.k === 'mimic' && room.mimicOk.get(head.mid);
  if (!ok || ok.owner !== member.id || Date.now() - ok.t > 15000) return false;
  room.mimicOk.delete(head.mid);
  return true;
}

// Direct WebRTC is preferred. If it cannot cross a restrictive NAT/firewall,
// relay short 16 kHz microphone frames through the lobby WebSocket. The server
// replaces identity fields and applies strict destination, size and rate bounds.
function relayVoiceFrame(room, member, data, parsed) {
  if (!room || !member.voiceOn || !parsed || data.length > 7000) return false;
  const { head, hl } = parsed;
  if (!head || head.k !== 'voice' || head.sr !== 16000 || !Array.isArray(head.to) || head.to.length > 5) return false;
  const payload = data.subarray(4 + hl);
  if (payload.length < 320 || payload.length > 6000 || payload.length % 2) return false;
  const targets = [...new Set(head.to)].map((id) => room.members.get(String(id))).filter((m) => m && m !== member);
  if (!targets.length) return false;
  const clean = Buffer.from(JSON.stringify({ k: 'voice', from: member.id, sr: 16000, seq: Number(head.seq) >>> 0 }));
  const out = Buffer.allocUnsafe(4 + clean.length + payload.length);
  out.writeUInt32LE(clean.length, 0); clean.copy(out, 4); payload.copy(out, 4 + clean.length);
  for (const target of targets) target.conn.send(out);
  return true;
}

function debugCmd(room, member, m) {
  const sim = room.sim, p = sim.players.get(m.pid || member.id);
  if (m.cmd === 'freeze') { sim.hv.update = () => {}; sim.sf.update = () => {}; sim.mimic.update = () => {}; sim.director.update = () => {}; }
  else if (m.cmd === 'down' && p) { for (let k = 0; k < 8 && p.state === 'alive'; k++) sim.damagePlayer(p, 'hv', p); }
  else if (m.cmd === 'mimic') sim.mimic.force(m.listener || member.id, m.owner || member.id);
  else if (m.cmd === 'tp' && p) { p.x = +m.x; p.z = +m.z; p.lastX = p.x; p.lastZ = p.z; }
  else if(m.cmd==='pebble_phase'&&p&&['search','stalk'].includes(m.phase)){
    // Explicit test-mode fixture: real authoritative actions/flight/cooldowns,
    // with enemy movement frozen so two browsers can isolate distraction rules.
    sim.time=Math.max(400,sim.time);sim.state='play';
    const hv=sim.hv,w=sim.world,i=w.nearestNav(p.x+12,p.z+4,20);
    if(i>=0){const [x,z]=w.cellPos(i);hv.place(x,z);}
    hv.target=p.id;hv.setState('chase');hv.huntPhase=m.phase;
    hv.huntHideUntil=sim.time+(m.phase==='stalk'?20:0);hv.huntEndsAt=sim.time+60;
    hv.huntContactAt=-999;hv.lastSeenChase={x:p.x,z:p.z,t:sim.time};
    hv.yaw=hv.lookYaw=Math.atan2(p.x-hv.x,p.z-hv.z)+Math.PI;
    hv.update=sim.sf.update=sim.mimic.update=sim.director.update=()=>{};
  }
  log(`[debug] ${room.code} ${m.cmd}`);
}

function leave(member) {
  const room = member.room;
  if (!room) return;
  room.members.delete(member.id);
  member.room = null;
  if (room.sim) room.sim.removePlayer(member.id);
  broadcast(room, { t: 'left', id: member.id });
  if (!room.members.size) { if (room.timer) clearInterval(room.timer); rooms.delete(room.code); log(`room ${room.code} closed`); return; }
  if (room.host === member.id) room.host = room.members.keys().next().value;
  broadcast(room, lobbyInfo(room));
}

attachWebSocket(server, '/ws', (conn, req) => {
  const member = { id: 'p' + (nextId++), name: 'Visitor', conn, room: null, ready: false, alive: true, voiceOn: false, rate: {} };
  send(conn, { t: 'welcome', id: member.id, version: VERSION, maxPlayers: CONFIG.NET.MAX_PLAYERS, iceServers: ICE_SERVERS });
  conn.on('message', (data, binary) => {
    if (binary) {
      const room = member.room;
      const parsed = audioHeader(data);
      if (parsed?.head?.k === 'voice') {
        if (allow(member, 'voice_bin')) relayVoiceFrame(room, member, data, parsed);
        return;
      }
      // mimicry audio relay: [u32 header length][json header][pcm payload]
      if (!allow(member, 'bin') || !mimicRelayAllowed(room, member, data)) return;
      for (const m of room.members.values()) if (m !== member) m.conn.send(data);
      return;
    }
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    const room = member.room;
    if (!m || typeof m.t !== 'string') return;
    const kind = ['create', 'join', 'leave', 'start', 'restart', 'to_lobby', 'hello'].includes(m.t) ? 'lobby' : m.t;
    if (!allow(member, kind)) return;
    switch (m.t) {
      case 'hello': member.name = String(m.name || 'Visitor').replace(/[^\p{L}\p{N} _.'-]/gu, '').slice(0, 20) || 'Visitor'; break;
      case 'create': {
        if (room) leave(member);
        const code = makeCode();
        const r = { code, host: member.id, members: new Map(), state: 'lobby', sim: null, timer: null };
        rooms.set(code, r); r.members.set(member.id, member); member.room = r;
        send(conn, lobbyInfo(r)); log(`room ${code} created by ${member.name}`);
        break;
      }
      case 'join': {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) { send(conn, { t: 'error', msg: 'No lobby with that code.' }); break; }
        if (r.members.size >= CONFIG.NET.MAX_PLAYERS) { send(conn, { t: 'error', msg: 'That lobby is full.' }); break; }
        if (r.state === 'game') { send(conn, { t: 'error', msg: 'That game is already in progress.' }); break; }
        if (room) leave(member);
        r.members.set(member.id, member); member.room = r;
        broadcast(r, lobbyInfo(r)); log(`${member.name} joined ${r.code}`);
        break;
      }
      case 'leave': leave(member); send(conn, { t: 'lobby_left' }); break;
      case 'start': if (room && room.host === member.id && room.state !== 'game') startGame(room, m.difficulty); break;
      case 'restart': if (room && room.host === member.id) startGame(room, m.difficulty); break;
      case 'to_lobby': if (room && room.host === member.id) { if (room.timer) clearInterval(room.timer); room.timer = null; room.sim = null; room.state = 'lobby'; broadcast(room, lobbyInfo(room)); } break;
      case 'in': if (room && room.sim) room.sim.input(member.id, m); break;
      case 'act': if (room && room.sim) room.sim.action(member.id, m); break;
      case 'chat': if (room) broadcast(room, { t: 'chat', from: member.id, name: member.name, text: String(m.text || '').slice(0, 140) }); break;
      case 'sig': if (room) { const to = room.members.get(m.to); if (to) send(to.conn, { t: 'sig', from: member.id, data: m.data }); } break;
      case 'debug': if (TEST_MODE && room && room.sim) debugCmd(room, member, m); break;
      case 'voice_state': member.voiceOn = !!m.mic; if (room) broadcast(room, { t: 'voice_state', id: member.id, mic: member.voiceOn }, member); break;
      default: break;
    }
  });
  conn.on('close', () => { member.alive = false; leave(member); });
});

const heartbeatTimer = setInterval(() => { for (const r of rooms.values()) for (const m of r.members.values()) m.conn.ping(); }, 15000);

try {
  const port = await listenWithFallback(server, { ...listenConfig,
    onRetry: (busy, next) => log(`Port ${busy} is already in use. Trying ${next}...`),
  });
  log(`HELIUM MOON server running at http://localhost:${port}/`);
  log('Share your LAN address (or a tunnel / port-forward) with friends so they can join your lobby code.');
} catch (error) {
  clearInterval(heartbeatTimer);
  console.error(error.code === 'EADDRINUSE'
    ? `That port is already in use. Leave the other program running and choose another port:\n  node server/server.js --port 8090`
    : `Could not start the game server: ${error.message}`);
  process.exitCode = 1;
}
