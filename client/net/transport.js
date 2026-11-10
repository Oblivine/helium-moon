// Transports deliver the same messages whether the authoritative sim runs in this
// browser (single player) or on the Node server (multiplayer lobbies):
//   start {info}, snap {s}, ev {ev:[...]}, lobby {...}, chat, sig, voice_state, left, error
import { GameSim } from '../../shared/sim/sim.js';

class Emitter {
  constructor() { this.handlers = new Map(); }
  on(t, fn) { if (!this.handlers.has(t)) this.handlers.set(t, new Set()); this.handlers.get(t).add(fn); return () => this.handlers.get(t).delete(fn); }
  emit(t, m) { const hs = this.handlers.get(t); if (hs) for (const fn of [...hs]) { try { fn(m); } catch (e) { console.error(e); } } }
}

// ------------------------------------------------------------------ single player: sim in-process
export class LocalTransport extends Emitter {
  constructor(world) {
    super();
    this.world = world; this.networked = false; this.id = 'p1'; this.sim = null;
    this.acc = 0; this.paused = false; this.name = 'You';
  }
  myId() { return this.id; }
  start(name, difficulty) {
    this.name = name || this.name;
    if (difficulty) this.difficulty = difficulty;
    this.sim = new GameSim(this.world, { seed: (Math.random() * 2 ** 31) | 0, difficulty: this.difficulty || 'ranger' });
    this.sim.addPlayer(this.id, this.name);
    this.acc = 0;
    this.emit('start', { info: this.sim.info() });
    this.emit('snap', { s: this.sim.snapshot() });
  }
  // fixed 20 Hz steps driven from the render loop
  tick(dt) {
    if (!this.sim || this.paused) return;
    this.acc = Math.min(this.acc + dt, 0.5);
    let stepped = false;
    while (this.acc >= 0.05) {
      this.sim.step(0.05); this.acc -= 0.05; stepped = true;
      const ev = this.sim.drainEvents();
      if (ev.length) this.emit('ev', { ev });
      if (this.sim.state === 'won' || this.sim.state === 'lost') break;
    }
    if (stepped) this.emit('snap', { s: this.sim.snapshot() });
  }
  send(m) {
    if (!this.sim) return;
    if (m.t === 'in') this.sim.input(this.id, m);
    else if (m.t === 'act') this.sim.action(this.id, m);
    else if (m.t === 'restart') this.start(this.name);
    else if (m.t === 'chat') this.emit('chat', { from: this.id, name: this.name, text: m.text });
  }
  binary() { /* nothing to relay */ }
  close() { this.sim = null; }
}

// ------------------------------------------------------------------ multiplayer: WebSocket to server/server.js
export function defaultServerUrl() {
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return '';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export class WSTransport extends Emitter {
  constructor(url) {
    super();
    this.url = url; this.networked = true; this.id = null; this.ws = null; this.open = false;
  }
  myId() { return this.id; }
  connect(name, timeout = 6000) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = this.ws = new WebSocket(this.url); } catch (e) { reject(new Error('Invalid server address.')); return; }
      ws.binaryType = 'arraybuffer';
      const to = setTimeout(() => { reject(new Error('Could not reach the server.')); try { ws.close(); } catch (e) { /* */ } }, timeout);
      ws.onopen = () => { this.open = true; };
      ws.onerror = () => { clearTimeout(to); if (!this.id) reject(new Error('Could not reach the server.')); };
      ws.onclose = () => { this.open = false; this.emit('disconnect', {}); };
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') { this.emit('binary', e.data); return; }
        let m; try { m = JSON.parse(e.data); } catch (er) { return; }
        if (m.t === 'welcome') {
          this.id = m.id; clearTimeout(to);
          // the server's STUN/TURN list for voice (see server/server.js); voice.js falls back to public STUN
          if (Array.isArray(m.iceServers) && typeof window !== 'undefined') window.HM_ICE_SERVERS = m.iceServers; this.send({ t: 'hello', name }); resolve(m); }
        this.emit(m.t, m);
      };
    });
  }
  send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  binary(buf) { if (this.ws && this.ws.readyState === 1) this.ws.send(buf); }
  tick() { /* server-driven */ }
  close() { try { this.ws && this.ws.close(); } catch (e) { /* */ } this.ws = null; }
}
