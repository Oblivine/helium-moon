// HELIUM MOON - client game: owns the renderer, scene, local player, audio/voice,
// the active transport (local sim or server), session lifecycle and every
// per-player sensory effect of the terror radius.
import * as THREE from 'three';
import { CONFIG } from '../../shared/config.js';
import { World, SURFACE } from '../../shared/world.js';
import { GameSim } from '../../shared/sim/sim.js';
import { NOTES, ANTENNA_BEARINGS } from '../../shared/sim/objectives.js';
import { HV_STATES } from '../../shared/sim/heliumVoice.js';
import { SF_STATES } from '../../shared/sim/skunk.js';
import { clamp, lerp, smoothstep, pointAtDistance } from '../../shared/math.js';
import { terrorAtDistance, horrorCues, huntTerrorTarget } from '../../shared/horror.js';
import { Renderer } from '../render/renderer.js';
import { TextureBank } from '../render/textures.js';
import { G } from '../render/shaderlib.js';
import { makePropMaterials } from '../render/props.js';
import { Environment } from './environment.js';
import { PlayerController } from './player.js';
import { Flashlight } from './flashlight.js';
import { Arms, Smoulders } from './arms.js';
import { BreathFX, AnomalyFX } from './effects.js';
import { PebbleViews } from './pebbles.js';
import { BalloonViews, PingViews } from '../entities/balloons.js';
import { Journal, nightTip } from '../core/journal.js';
import { Input } from '../core/input.js';
import { TouchControls } from '../ui/touch.js';
import { AudioEngine } from '../audio/audio.js';
import { VoiceSystem } from '../audio/voice.js';
import { LocalTransport } from '../net/transport.js';
import { SnapBuffer, HeliumView, SkunkView, PlayerAvatar, ObjectiveViews, PLAYER_COLORS } from '../entities/views.js';
import { WildlifeSystem } from '../entities/wildlife.js';
import { devHunt, devReveal, devRelocate } from '../../shared/sim/dev.js';

const ATTACK_LOCK_DIST = 1.22;   // m (4 ft): the camera locks onto him only this close (owner)

const T = CONFIG.TERROR;
const PST = ['alive', 'downed', 'dead', 'escaped'];
const REMOTE_LIGHTS = 2;

function textureList(q) {
  const L = [];
  for (const b of ['cedar', 'cottonwood', 'elm', 'hackberry', 'oak', 'sycamore']) {
    L.push([`bark_${b}_c`, `assets/tex/bark_${b}_c.jpg`], [`bark_${b}_n`, `assets/tex/bark_${b}_n.jpg`, { srgb: false }], [`bark_${b}_r`, `assets/tex/bark_${b}_r.jpg`, { srgb: false }]);
  }
  for (const l of ['ash', 'aspen', 'bush', 'cedar', 'oak']) L.push([`leafc_${l}`, `assets/tex/leafc_${l}.png`, { repeat: false }]);
  L.push(['grass_card', 'assets/tex/grass_card.png', { repeat: false }], ['reed_card', 'assets/tex/reed_card.png', { repeat: false }]);
  L.push(['moon', 'assets/tex/moon.png', { repeat: false }], ['water_n', 'assets/tex/water_n.png', { srgb: false }], ['frost', 'assets/tex/frost.png', { srgb: false }]);
  for (const p of ['concrete_c', 'granite_c', 'gravel_c', 'metal_c', 'wood_c']) L.push([p, `assets/tex/${p}.jpg`]);
  for (const p of ['concrete_n', 'corrugated_n', 'gravel_n', 'wood_n']) L.push([p, `assets/tex/${p}.jpg`, { srgb: false }]);
  return L;
}
const GROUND = ['litter', 'trail', 'mud', 'grass', 'silt', 'clay'];

export class Game {
  constructor(canvas, settings, ui, opts = {}) {
    this.canvas = canvas; this.settings = settings; this.ui = ui; this.opts = opts;
    this.mode = 'loading'; this.paused = false;
    this.net = null; this.offs = []; this.myId = null;
    this.terror = 0; this.fear = 0; this.cold = 0; this.critical = 0; this.gasFx = 0; this.damage = 0; this.heartPulse = 0;
    this.hvDist = 1e9; this.sightCool = 0; this.chasing = false;
    this.avatars = new Map(); this.plBufs = new Map(); this.pending = new Set();
    this.inputT = 0; this.sessionT = 0; this.last = 0; this.fpsAcc = 0; this.fpsN = 0; this.fps = 60; this.frameMs = 16;
    this.lobby = null; this.notesRead = []; this.reading = null; this.prog = null; this.exposure = 1;
  }

  // ---------------------------------------------------------------- loading
  async init(progress) {
    const set = this.settings;
    const preset = this.preset = set.preset;
    this.renderer = new Renderer(this.canvas, set);
    this.renderer.setQuality(preset, set.renderScale);
    progress(0.02, 'Loading textures');
    const bank = this.bank = new TextureBank(this.renderer.gl);
    const gsize = preset.label === 'Low' || preset.label === 'Medium' ? 512 : 1024;
    const list = textureList();
    let done = 0;
    const total = list.length + 2;
    await Promise.all([
      bank.loadAll(list, () => progress(0.02 + 0.22 * (++done / total), 'Loading textures')),
      bank.array('groundC', GROUND.map((g) => `assets/tex/ground_${g}_c.jpg`), gsize, true).then(() => progress(0.02 + 0.22 * (++done / total), 'Loading textures')),
      bank.array('groundN', GROUND.map((g) => `assets/tex/ground_${g}_n.jpg`), gsize, false).then(() => progress(0.02 + 0.22 * (++done / total), 'Loading textures')),
    ]);
    bank.tex.frost.wrapS = bank.tex.frost.wrapT = THREE.MirroredRepeatWrapping; bank.tex.frost.needsUpdate = true;
    this.world = await World.createAsync({}, (f, t) => progress(0.25 + f * 0.3, t));
    const world = this.world;
    progress(0.56, 'Planting trees');
    await new Promise((r) => setTimeout(r, 0));
    this.env = new Environment(world, bank, this.renderer, preset, (t) => progress(0.62, t));
    this.scene = this.env.scene;
    this.camera = new THREE.PerspectiveCamera(set.fov, window.innerWidth / window.innerHeight, 0.06, 2600);
    this.scene.add(this.camera);
    this.player = new PlayerController(world, this.camera, set);
    this.flashlight = new Flashlight(this.scene, preset, this.camera);
    this.arms = new Arms(this.camera, this.flashlight); this.smoulders = new Smoulders(this.scene);
    await this.arms.load().catch((e) => console.warn('hand models did not load; arms will show sleeves only', e));
    this.vice = { cigs: 0, beers: 0, bottles: 0, smoked: 0, smoke: -1, buzz: -1 };
    this.remoteLights = [];
    for (let i = 0; i < REMOTE_LIGHTS; i++) {
      const L = new THREE.PointLight(0xffa54d, 0, CONFIG.FLASHLIGHT.RANGE, 2);   // teammates' lighters
      this.scene.add(L); this.remoteLights.push(L);
    }
    this.input = new Input(this.canvas, set);
    this.input.onLockChange = (locked) => this._onLockChange(locked);
    if (this.opts.touch) {
      // no pointer lock on phones: look is a drag on the right half of the screen
      this.input.dragLook = true; this.input.lockFailed = true; this.input.noLock = true;
      this.touch = new TouchControls(this.input, set);
    }
    this.propMats = makePropMaterials(bank.tex);
    this.objViews = new ObjectiveViews(this.scene, this.propMats);
    this.breath = new BreathFX(this.scene);
    this.pebbles = new PebbleViews(this.scene,world);
    this.balloons = new BalloonViews(this.scene); this.pings = new PingViews(this.scene);
    this.journal = Journal.load();
    this.anomaly = new AnomalyFX(this.scene, world);
    progress(0.72, 'Recording the night');
    this.audio = new AudioEngine(set);
    await this.audio.init(world, (f) => progress(0.72 + f * 0.16, 'Recording the night'));
    this.player.onFootstep = (info) => this.audio.footstep(info);
    this.player.onLand = (impact) => this.audio.footstep({
      surface: this.player.surface, water: this.player.inWater, brush: this.player.inBrush,
      loud: clamp(impact / 8, 0.5, 1), speed: 0,
    });
    this.audio.onExhale = (v) => this._exhale(v);
    this.audio.onBeat = () => { this.heartPulse = 1; };
    this.voice = new VoiceSystem(this.audio, set, {
      myId: () => (this.net ? this.net.myId() : 'p1'),
      sig: (to, data) => this.net && this.net.networked && this.net.send({ t: 'sig', to, data }),
      voiceState: (mic) => this.net && this.net.networked && this.net.send({ t: 'voice_state', mic }),
      act: (a) => this.net && this.mode === 'playing' && this.net.send({ t: 'act', ...a }),
      binary: (b) => this.net && this.net.binary(b),
      get networked() { return false; },
    });
    Object.defineProperty(this.voice.net, 'networked', { get: () => !!(this.net && this.net.networked) });
    this.voice.onChange = (st) => this.ui.voiceStatus(st);
    progress(0.9, 'Something is in the trees');
    const [hv, sf] = await Promise.all([HeliumView.create(this.scene, world), SkunkView.create(this.scene, world)]);
    this.hv = hv; this.sf = sf;
    this.wildlife = new WildlifeSystem(this.scene, world, this.audio);
    this.hvBuf = new SnapBuffer([3, 4], [7, 10, 11, 12, 13], 8); this.sfBuf = new SnapBuffer([3, 4], [6, 8], 8);   // >8 m between snapshots = relocation: snap, never slide
    progress(0.97, 'Compiling shaders');
    this._menuCamera(0);
    this.env.update(0.016, this.camera, 0);
    this._precompile();
    window.addEventListener('resize', () => this._resize());
    set.onChange(() => this._settingsChanged());
    const wake = () => { this.audio.resume(); };
    window.addEventListener('pointerdown', wake, true); window.addEventListener('keydown', wake, true);
    this._resize();
    this.mode = 'menu';
    progress(1, 'Ready');
    if (!this.opts.manual) { this.last = performance.now(); requestAnimationFrame((t) => this._frame(t)); }
  }

  // compile every program against the HDR scene target the game really renders into (compiling against the
  // canvas produced a second, unused sRGB variant of every material) - creatures included, so their first
  // appearance doesn't stall the frame
  _precompile() {
    const gl = this.renderer.gl;
    const vis = [this.hv.root.visible, this.sf.root.visible];
    this.hv.root.visible = true; this.sf.root.visible = true;
    const wl = this.wildlife ? [this.wildlife.deer.root, this.wildlife.owl.root] : [];
    for (const r of wl) r.visible = true;
    try { gl.setRenderTarget(this.renderer.sceneRT); gl.compile(this.scene, this.camera); } catch (e) { /* optional */ }
    gl.setRenderTarget(null);
    this.hv.root.visible = vis[0]; this.sf.root.visible = vis[1];
    for (const r of wl) r.visible = false;
  }

  _resize() {
    this.renderer.resize();
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  _settingsChanged() {
    const s = this.settings;
    this.camera.fov = s.fov; this.camera.updateProjectionMatrix();
    if (s.preset !== this.renderer.preset || this._rs !== s.renderScale) { this._rs = s.renderScale; this.renderer.setQuality(s.preset, s.renderScale); }
    if (!s.adaptiveRes && this.renderer.dynScale !== 1) { this.renderer.dynScale = 1; this.renderer.resize(); }
  }

  // ---------------------------------------------------------------- transport + session
  attach(net) {
    this.detach();
    this.net = net;
    this.offs = [
      net.on('start', (m) => this.beginSession(m.info)),
      net.on('snap', (m) => this._onSnap(m.s)),
      net.on('ev', (m) => { for (const e of m.ev) this._onEvent(e); }),
      net.on('chat', (m) => this.ui.chatLine(m.name, m.text, this._colorOf(m.from))),
      net.on('sig', (m) => this.voice.onSignal(m.from, m.data)),
      net.on('binary', (b) => this.voice.onBinary(b)),
      net.on('left', (m) => this._dropAvatar(m.id)),
      net.on('lobby', (m) => this._onLobby(m)),
      net.on('disconnect', () => { if (this.net === net) this._disconnected(); }),
    ];
  }

  detach() {
    for (const f of this.offs) f(); this.offs = [];
    const previous = this.net;
    this.net = null; this.lobby = null; this.myId = null;
    // Unsubscribe before closing so an intentional mode change cannot trigger
    // the old connection's disconnect handler and send us back to the menu.
    if (previous) previous.close();
    this.voice && this.voice.dropAllPeers();
  }

  startSingle(name) {
    this.audio.resume();
    const t = new LocalTransport(this.world);
    this.attach(t);
    t.start(name || this.settings.playerName || 'You', this.settings.difficulty);
  }

  _onLobby(m) {
    this.lobby = m;
    // The player may enable their microphone before opening a multiplayer
    // connection. Announce the current state once the lobby socket exists so
    // the authenticated fallback can accept voice frames when WebRTC is blocked.
    if (this.voice.micOn && this.net?.networked) this.net.send({ t: 'voice_state', mic: true });
    this.voice.syncPeers(m.players.map((p) => p.id));
    this.ui.lobby(m, this.myId || this.net.myId());
    if (m.state === 'lobby' && (this.mode === 'playing' || this.mode === 'ended')) this._toLobbyView();
  }

  _toLobbyView() {
    this._endSessionCleanup();
    this.mode = 'lobby';
    this.ui.showEnd(null); this.ui.showHUD(false); this.ui.showMenu(true); this.ui.openLobby();
  }

  _disconnected() {
    if (this.mode === 'playing' || this.mode === 'ended' || this.mode === 'lobby') {
      this.ui.toast('Lost connection to the server.', 5000);
      this.quitToMenu(true);
    }
  }

  beginSession(info) {
    this._endSessionCleanup();
    this.info = info; this.myId = this.net.myId();
    this.mode = 'playing'; this.paused = false; this.ended = false; this.result = null;
    this.snapT = -1; this.renderT = 0; this.interp = this.net.networked ? 0.12 : 0.06;
    this.hvBuf.clear(); this.sfBuf.clear(); this.plBufs.clear();
    this.objViews.build(info.layout, this.world);
    this._trailMap = null;
    for (const [id, a] of this.avatars) a.dispose(this.scene);
    this.avatars.clear();
    info.players.forEach((p, i) => { if (p.id !== this.myId) this._ensureAvatar(p.id, p.name, i); });
    this.names = new Map(info.players.map((p, i) => [p.id, { name: p.name, idx: i }]));
    const idx = Math.max(0, info.players.findIndex((p) => p.id === this.myId));
    const sp = GameSim.prototype.spawnPoint.call({ world: this.world }, idx);
    this.player.spawn(sp.x, sp.z, sp.yaw);
    this.player.injured = 0; this.player.slow = 1; this.player.downed = 0; this.player.lookLock = null; this._attackLock = 0; this._attackLockPending = 0; this._grab = null; this.player.eyeOffset = 0; this.player.extraRoll = 0; if (this.camera.fov !== this.settings.fov) { this.camera.fov = this.settings.fov; this.camera.updateProjectionMatrix(); }
    this.flashlight.battery = 1; this.flashlight.on = true; this.flashlight.snap(this.camera);
    this.terror = 0; this.fear = 0; this.cold = 0; this.critical = 0; this.gasFx = 0; this.damage = 0; this.chasing = false;
    this.rules = info.rules || { id: 'ranger', ...CONFIG.DIFFICULTY.ranger };
    this.me = null; this.myState = 'alive'; this.health = this.rules.health;
    this.flashlight.fuelMul = this.rules.fuel;
    this.lungs = this.rules.lungs; this.holdingBreath = false; this.gaspT = 0; this.lungDelay = 0;
    this.balloons.clear(); this.pings.clear(); this.arms.reset(); this.smoulders.clear();
    this.vice = { cigs: 0, beers: 0, bottles: 0, smoked: 0, smoke: -1, buzz: -1 }; this.player.staminaMul = 1;
    this.subs = []; this.subT = 0; this.ui.subtitle(null); this.ui.hint(null);
    this._alarmT = 0; this._hintT = 12; this._sawHunt = false;
    this.pebbleReadyAt=0;
    this.notesRead = []; this.reading = null; this.sessionT = 0; this.fade = 1; this.fadeTarget = 0;
    this.obj = null; this.team = { fuel: false, fuse: false }; this.extractOpen = false; this.spectate = null;
    this.anomaly.reset();
    this.audio.stopAll();
    this.ui.showEnd(null); this.ui.showMenu(false); this.ui.showPause(false); this.ui.showHUD(true);
    this.ui.intro();
    this.input.enabled = true;
    if (!this.input.locked) { this.input.requestLock(); this.ui.clickToPlay(!this.input.locked && !this.input.dragLook); }
    if (this.touch) { this.touch.reset(); try { const el = document.documentElement; if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); } catch (e) { /* not allowed here */ } }
    this._objectivesDirty = true;
  }

  _endSessionCleanup() {
    this.pebbles?.clear();this.pebbleReadyAt=0;
    this.ui.closeChat();
    this.voice && this.voice.endSession();
    this.audio && this.audio.stopAll();
    this.reading = null; this.ui.showNote(null);
  }

  restart() {
    if (!this.net) return;
    if (this.net.networked) { if (this._isHost()) this.net.send({ t: 'restart' }); else this.ui.toast('Waiting for the host to restart…'); }
    else this.net.send({ t: 'restart' });
  }

  returnToLobby() { if (this.net && this.net.networked) { if (this._isHost()) this.net.send({ t: 'to_lobby' }); else this._toLobbyView(); } }

  quitToMenu(silent = false) {
    this._endSessionCleanup();
    if (this.net && this.net.networked) this.net.send({ t: 'leave' });
    this.detach();
    for (const a of this.avatars.values()) a.dispose(this.scene);
    this.avatars.clear();
    this.objViews.clear();
    this.mode = 'menu'; this.paused = false; this.input.enabled = false; this.input.exitLock();
    this.ui.showHUD(false); this.ui.showPause(false); this.ui.showEnd(null); this.ui.showMenu(true);
    if (!silent) this.ui.toast('');
  }

  _isHost() { return !!(this.lobby && this.lobby.host === (this.net && this.net.myId())); }

  // ---------------------------------------------------------------- developer mode (owner, Oct 25)
  // Rules are applied to a locally simulated game every frame (they can be toggled mid-game).
  _devTick() {
    const sim = this.sim, s = this.settings;
    if (sim) sim.dev = s.devMode ? { skipDread: !!s.devSkipDread, invincible: !!s.devInvincible } : null;
    if (this._devHuntPending && sim && this.mode === 'playing' && sim.time > CONFIG.SESSION.INTRO_TIME + 2) {
      // walk the player out of the protected spawn area onto the trail, then start the hunt
      this._devHuntPending = false;
      this.teleport(140, 0); this.player.lookLock = null;
      const sp = sim.players.get(this.myId || 'p1'), pp = this.player.pos;   // the sim only accepts small moves: place it directly
      if (sp) { sp.x = sp.lastX = pp.x; sp.z = sp.lastZ = pp.z; sp.y = pp.y; }
      this._devHuntAt = sim.time + 1.5;
    }
    if (this._devHuntAt && sim && sim.time > this._devHuntAt) { this._devHuntAt = 0; this.devAction('hunt'); }
  }
  // from the main menu: a solo game with the developer rules (optionally a hunt right away)
  devStart(hunt) {
    if (!this.settings.devMode) return;
    this._devHuntPending = !!hunt;
    this.startSingle(this.settings.playerName || 'You');
  }
  devAction(a) {
    const sim = this.sim;
    if (!this.settings.devMode) return;
    if (!sim || this.mode !== 'playing') { this.ui.toast('Developer actions work in single player.', 2500); return; }
    sim.dev = { skipDread: !!this.settings.devSkipDread, invincible: !!this.settings.devInvincible };
    const id = this.myId || 'p1';
    const ok = a === 'hunt' ? devHunt(sim, id) : a === 'reveal' ? devReveal(sim, id) : a === 'relocate' ? devRelocate(sim, id) : false;
    const label = { hunt: 'Hunt started', reveal: 'He will show himself', relocate: 'He moved ahead of you' }[a];
    const why = typeof ok === 'string' ? ok : a === 'relocate' ? 'no hidden spot ahead' : 'try again in a moment';
    this.ui.toast(ok === true ? `DEV: ${label}` : `DEV: couldn't do that right now (${why})`, 2500);
  }

  pause(on) {
    if (this.mode !== 'playing') return;
    this.paused = on;
    if (this.net && !this.net.networked) this.net.paused = on;
    this.ui.showPause(on);
    if (on) this.input.exitLock();
    else { this.input.requestLock(); this.ui.clickToPlay(false); }
  }

  _onLockChange(locked) {
    if (this.mode !== 'playing' || this.ended) return;
    if (!locked && !this.input.dragLook && !this.paused && !this.ui.chatOpen) this.pause(true);
    if (locked) this.ui.clickToPlay(false);
  }

  _colorOf(id) { const n = this.names && this.names.get(id); return '#' + PLAYER_COLORS[(n ? n.idx : 0) % PLAYER_COLORS.length].toString(16).padStart(6, '0'); }

  async _ensureAvatar(id, name, idx) {
    if (this.avatars.has(id) || this.pending.has(id)) return;
    this.pending.add(id);
    const a = await PlayerAvatar.create(this.scene, id, name, idx, this.world);
    this.pending.delete(id);
    if (this.mode !== 'playing' || !this.names || !this.names.has(id)) { a.dispose(this.scene); return; }
    this.avatars.set(id, a);
    this._precompile();
  }
  _dropAvatar(id) { const a = this.avatars.get(id); if (a) { a.dispose(this.scene); this.avatars.delete(id); } this.plBufs.delete(id); this.voice.dropPeer(id); }

  // ---------------------------------------------------------------- network state
  _onSnap(s) {
    if (this.mode !== 'playing') return;
    if (this.snapT < 0) this.renderT = s.t - this.interp;
    this.snapT = s.t; this.simState = s.st; this.phase = s.ph;
    this.pebbles.sync(s.pebbles,s.t);
    this.balloons.sync(s.bl);
    this.hvBuf.push(s.t, s.hv); this.sfBuf.push(s.t, s.sf);
    for (const row of s.pl) {
      if (row[0] === this.myId) { this.me = row; continue; }
      let b = this.plBufs.get(row[0]);
      if (!b) { b = new SnapBuffer([4], [0, 6, 7, 8]); this.plBufs.set(row[0], b); }
      b.push(s.t, row);
    }
    if (s.obj) {
      const wasTeam = { ...this.team };
      this.obj = s.obj; this.team = s.obj.team; this.extractOpen = s.obj.ex;
      this.objViews.apply(s.obj);
      if (wasTeam.fuel !== this.team.fuel || wasTeam.fuse !== this.team.fuse || wasTeam.crank !== this.team.crank) this._objectivesDirty = true;
    }
    this.gas = s.gas || [];
    if (this.me) {
      this.pebbleReadyAt=this.me[12]||0;
      const st = PST[this.me[8]];
      if (st !== this.myState) this._myStateChanged(this.myState, st);
      this.myState = st; this.health = this.me[7];
    }
  }

  _myStateChanged(from, to) {
    if (to === 'downed') { this.ui.toast('You are down. A teammate can revive you.', 4000); }
    if (to === 'alive' && from === 'downed') { this.player.downed = 0; this.ui.toast('Back on your feet.', 2500); }
    if (to === 'dead' && this.net.networked) { this.ui.toast('You died. Spectating your team.', 5000); this.voice.disableMicTransmit = true; }
    if (to === 'escaped') this.ui.toast('You made it to the cruiser.', 4000);
  }

  _name(id) { const n = this.names && this.names.get(id); return n ? n.name : 'Someone'; }

  // Remote fear reactions are visual-only. Snapshot yaw and all movement stay
  // authoritative; this just lets another player see where their teammate's
  // attention snaps during a Helium Voice encounter.
  _reactAvatar(pid, pos, hit = false) {
    if (pid && pid !== this.myId) this.avatars.get(pid)?.reactToThreat(pos, hit);
  }

  _onEvent(e) {
    if (this.mode !== 'playing') return;
    const A = this.audio, pos = e.x !== undefined ? { x: e.x, y: e.y ?? (this.world.heightAt(e.x, e.z) + 1), z: e.z } : null;
    switch (e.type) {
      case 'begin': this._objectivesDirty = true; this.wildlife?.end(); break;
      case 'pebble_throw':
        this.pebbles.spawn(e,Math.max(0,(this.snapT||e.t)-e.t));
        if(e.pid===this.myId){this.pebbleReadyAt=e.readyAt;this.arms.play('throw');}
        break;
      case 'pebble_impact':
        this.pebbles.impact(e.id,pos,e.kind);
        if(e.bottle)A.at('bottleSmash',pos,{bus:'sfx',gain:1.3,ref:7,reverb:.4});else this.audio.pebbleImpact(pos,e.seq||0);
        break;
      case 'pebble_status':
        if(e.pid===this.myId){
          if(Number.isFinite(e.readyAt))this.pebbleReadyAt=e.readyAt;
          const text={search:'Pebbles distract him while he is searching.',cooldown:'Give it a moment before throwing another pebble.',
            held:'You cannot throw while held.',covered:'Uncover yourself before throwing.',state:'You cannot throw right now.',
            unavailable:'You cannot throw right now.',busy:'Wait for the other pebbles to land.',aim:'Aim at the ground nearby.',paused:'Resume to throw a pebble.'};
          this.ui.toast(text[e.reason]||'You cannot throw a pebble right now.',2200);
        }
        break;
      // a real animal: deer bolting from the brush or an owl lifting off (SCARE_RESEARCH X4)
      case 'wildlife': if (this.wildlife && this._near(pos, 90)) this.wildlife.spawn(e, this.player.pos); break;
      case 'hv_vocal': if (this._near(pos, CONFIG.HV.FOOTSTEP_MAX_DISTANCE) && this._canSee(pos)) { A.hvVocal(e.k, e.s, pos); this.voice.suppress(2); } break;
      case 'hv_line': break;
      // Real moving joints during a search: audible through cover, at their
      // physical location. No visibility gate: a hidden player needs this cue.
      case 'hv_search_move': if (this._near(pos, CONFIG.HV.SEARCH_CRACK_MAX_DISTANCE)) A.hvSearchMove(e.s, pos); break;
      // the grab is silent apart from body contact and nearby environmental sound
      case 'hv_attack': {
        const at = { x: e.x, y: this.world.heightAt(e.x, e.z) + 1.7, z: e.z }, k = e.seq || 0;
        if (e.phase === 'reach' || e.phase === 'windup') {
          if (this._near(at, 12)) { this.player.shake = Math.max(this.player.shake, 0.6); this.voice.suppress(3); }
        } else if (e.phase === 'grab') {
          A.at('cloth' + (k % 2), at, { bus: 'mon', gain: 1.4, ref: 2, reverb: 0.05 });
          A.at('pop' + (k % 4), at, { bus: 'mon', gain: 0.8, ref: 2, reverb: 0.05 });
          this._reactAvatar(e.pid, at, true);
          if (e.pid === this.myId) this._grabStart(e);
        } else if (e.phase === 'release') {
          if (e.pid === this.myId) this._grabEnd(e);
        } else if (e.phase === 'miss' || e.phase === 'strike') A.at('swing' + (k % 3), at, { bus: 'mon', gain: 0.9, ref: 2.5, reverb: 0.08 });
        break;
      }
      // you hid and he lost you: somewhere close, a long exhale, then he drops
      case 'hv_lost': this._reactAvatar(e.pid, pos); if (this._near(pos, 30)) this.audio.hvBreath({ ...pos, y: pos.y + 1.6 }, (e.seq || 0) + 7); break;
      case 'hv_collapse': A.at('bodyDrop' + ((e.seq || 0) % 2), { x: e.x, y: (e.y ?? this.world.heightAt(e.x, e.z)) + 0.3, z: e.z }, { bus: 'mon', gain: 1.4, ref: 4, reverb: 0.2 }); break;
      // a look back caught him: one dry crack of his joints as he locks
      case 'hv_freeze': this._reactAvatar(e.pid, pos); if (this._near(pos, 25)) A.at('pop' + ((e.seq || 0) % 4), { ...pos, y: pos.y + 0.6 }, { bus: 'mon', gain: 0.7, ref: 2, reverb: 0.1, range: { fadeStart: 8, maxDistance: 25 } }); break;
      // in the grass: he unfolds - grass, joints, cloth
      case 'hv_rise': {
        A.at('fs_brush' + ((e.seq || 0) % 4), pos, { bus: 'mon', gain: 1.3, ref: 3, reverb: 0.05 });
        for (let i = 0; i < 3; i++) setTimeout(() => this.mode === 'playing' && A.at('pop' + ((e.seq + i) % 4), { ...pos, y: pos.y + 0.5 + i * 0.4 }, { bus: 'mon', gain: 0.9, ref: 2, reverb: 0.1 }), 150 + i * 260);
        break;
      }
      // closing in (the mark): far off, his joints crack - quiet, easy to miss
      case 'hv_pops': if (this._near(pos, 40)) A.at('pop' + ((e.seq || 0) % 4), { ...pos, y: pos.y + 1.2 }, { bus: 'mon', gain: 0.55, ref: 3, reverb: 0.35, range: { fadeStart: 12, maxDistance: 40 } }); break;
      case 'hv_sig': break; // legacy event: speech is permanently disabled
      case 'sf_vocal': A.sfVocal(e.k, e.s, pos); break;
      case 'snap': break; // no artificial branch-snap warning of an unseen approach
      // unseen relocation: his footsteps simply stop for a moment (the tell), then
      // resume from wherever he is now. No visual effect, by design.
      case 'hv_relocate': this._hvQuietUntil = performance.now() + 2500; break;
      // "the forest holds its breath" (docs/SCARE_RESEARCH.md C1): he is closing in near here
      case 'hush': if (this._near(pos, 80)) { this._hushUntil = performance.now() + 7000; this._hushRelease = 4 + Math.random() * 5; } break;
      case 'chase':
        this.chasing = !!e.on;
        break;
      case 'hit':
        if (e.pid === this.myId) { this.damage = 1; this.player.shake = 1.2; A.ui('hurt', 0.9); this.player.injured = 1; if (e.by === 'hv') { this._attackLockPending = 1.5; const left = Math.max(0, (e.health ?? 1) - 1); this._hint('grabbed', left > 0 ? `He let go. You can survive ${left === 1 ? 'one more grab' : left + ' more grabs'}. The one after that is the last.` : 'He let go. The next time he gets hold of you is the last.', 8000); } }
        else { this._reactAvatar(e.pid, pos, true); const a = this.avatars.get(e.pid); if (a) A.at('hurt', { x: a.pos.x, y: a.pos.y + 1.5, z: a.pos.z }, { gain: 1, ref: 5 }); }
        break;
      case 'downed': case 'dead':
        if (e.pid === this.myId) { this.damage = 1; this.player.shake = 1.6; A.ui('down', 1); this.player.downed = 1; if (e.by === 'hv') this._attackLockPending = 2.5; }
        else { this._reactAvatar(e.pid, pos, true); const a = this.avatars.get(e.pid); if (a) A.at('down', { x: a.pos.x, y: a.pos.y + 1, z: a.pos.z }, { gain: 1.1, ref: 6 }); this.ui.toast(`${this._name(e.pid)} ${e.type === 'dead' ? 'is gone' : 'is down'}.`, 3500); }
        break;
      case 'revived': if (e.pid !== this.myId) this.ui.toast(`${this._name(e.by)} revived ${this._name(e.pid)}.`, 3000); break;
      case 'gas': A.sfVocal('gas', e.seq || 1, pos); break;
      case 'objective': {
        const s = this.objViews.stations.get(e.id);
        this.ui.toast({ gen: 'The generator coughs and catches.', relay: 'The relay box hums back to life.', uplink:'The aerial locks toward the mast. The rescue link is aligned.', mast: 'Distress call sent. A county unit is responding to the highway bridge.' }[e.id] || 'Objective complete.', 5000);
        if (s) {
          const sp = { x: s.def.x, y: s.def.y + 0.6, z: s.def.z };
          if (e.id === 'gen') A.loopAt('gen', 'genLoop', sp, { gain: 1.1, ref: 5, reverb: 0.3 });
          if (e.id === 'relay') A.loopAt('relay', 'hum', sp, { gain: 0.35, ref: 2 });
          if (e.id === 'mast') A.at('radio', { x: s.def.x, y: s.def.y + 1.4, z: s.def.z }, { gain: 1.2, ref: 4 });
        }
        this._objectivesDirty = true;
        break;
      }
      case 'extract_open': {
        const ex = this.info.layout.extract;
        A.loopAt('siren', 'siren', { x: ex.x + 4, y: ex.y + 1.6, z: ex.z + 3 }, { gain: 1.5, ref: 25, rolloff: 1, reverb: 0.5 });
        this._objectivesDirty = true;
        break;
      }
      case 'pickup': {
        const it = this.info.layout.items.find((i) => i.id === e.id);
        this.objViews.setHeld(e.id, true);
        if (e.pid === this.myId) {
          this.arms.play('reach');
          if (e.kind === 'cigs') { A.ui('paper', 0.5); this.ui.toast(`A pack of cigarettes. ${this._key('smoke')} with the lighter lit: steadier hands for repairs, shorter breath all night. Crouched, it sets one down for him to smell.`, 7000); }
          else if (e.kind === 'beer') { A.ui('clink', 0.7); this.ui.toast(`A bottle of beer. ${this._key('drink')} to drink: your legs last longer, you breathe louder. The empty is your next throw.`, 6500); }
          else if (e.kind === 'battery') { this.flashlight.addBattery(CONFIG.FLASHLIGHT.BATTERY_PICKUP); A.ui('clink', 0.6); this.ui.toast('A spare lighter. More fuel.', 2000); }
          else if (e.kind === 'blanket') { this.player.hasCamoBlanket = true; A.ui('paper', 0.55); this.ui.toast('Camouflage blanket: crouch, light off, hold X while still to hide.', 4500); }
          else if (e.kind === 'note') { A.ui('paper', 0.8); const n = this._sessionNote(e.note); if (n) { this.notesRead.push(n.id); this.reading = n; this.ui.showNote(n, this.journal.noteFound(n.id)); } }
          else { A.ui('clink', 0.7); this.ui.toast(e.kind === 'fuel' ? 'Picked up the gas can.' : e.kind==='crank'?'Handwheel recovered. Fit it to the far-bank aerial and turn toward the mast.':'Picked up the fuse kit.', 3000); }
        } else if (it && e.kind !== 'battery') this.ui.toast(`${this._name(e.pid)} found ${e.kind === 'note' ? 'a note' : it.name.toLowerCase()}.`, 3000);
        if (e.kind === 'note' && e.pid !== this.myId) { const n = NOTES.find((q) => q.id === e.note); if (n && !this.notesRead.includes(n.id)) this.notesRead.push(n.id); }
        this._objectivesDirty = true;
        break;
      }
      case 'mimic': this.voice.onMimicEvent(e); break;
      // ---- Update 0.9
      case 'balloon_pop':
        this.balloons.pop(e.id, pos);
        A.at('balloonPop' + ((e.seq || 0) % 2), pos, { bus: 'sfx', gain: 1.7, ref: 9, reverb: 0.5 });
        if (e.pid === this.myId) this.player.shake = Math.max(this.player.shake, 0.5);
        else this._reactAvatar(e.pid, pos);
        if (e.pid === this.myId) this._hint('popped', 'That was loud. If he is anywhere near, he heard it. Crouch to pass under them, or untie them.');
        break;
      case 'vice': if (e.pid === this.myId) this.vice = e; break;
      case 'smoke':
        if (e.pid === this.myId) { this.arms.startSmoke(e.dur); A.ui('drag', 0.5); this._hint('smoke', 'While it burns your hands are steadier and repairs go faster. He can see the ember and smell the smoke: you cannot hide until it is out. Each one costs you breath for the rest of the night.', 11000); }
        break;
      case 'drink':
        if (e.pid === this.myId) { this.arms.play('drink'); A.ui('beerOpen', 0.6); this._hint('beer', 'For a little over a minute you can run longer, and you breathe louder when he is close. You kept the empty: your next throw is the bottle, and he hears it from much farther than a pebble.', 11000); }
        break;
      case 'cig_drop': this.smoulders.add(e.id, e.x, e.y, e.z, e.dur); if (e.pid === this.myId) this.arms.play('reach'); break;
      case 'cig_out': this.smoulders.remove(e.id); break;
      case 'balloon_untie': this.balloons.untie(e.id); A.at('balloonSqueak', pos, { bus: 'sfx', gain: 0.5, ref: 2, reverb: 0.05 }); break;
      case 'ambient': this._ambient(e, pos); break;
      case 'ping': {
        this.pings.add(pos, PLAYER_COLORS[(this.names.get(e.pid)?.idx || 0) % PLAYER_COLORS.length]);
        A.at('pingTick', pos, { bus: 'sfx', gain: 0.8, ref: 6, reverb: 0.1, occlude: false });
        break;
      }
      case 'radio': this._radio(e.id); break;
      case 'hv_hunt_phase':
        if (e.phase === 'search' && e.pid === this.myId) this._hint('search', this.touch ? 'He is searching for you. Stay low, dark and still. If he comes close, hold BREATH. PEBBLE thrown away from you draws him off.' : `He is searching for you. Stay low, dark and still. If he comes close, hold ${this.settings.keyName(this.settings.bindings.jump)} to hold your breath. ${this.settings.keyName(this.settings.bindings.pebble)} throws a pebble to draw him off.`, 11000);
        break;
      case 'hv_heard': if (e.pid === this.myId) this._hint('heard', 'He heard you breathing. Next time, hold your breath while he is close.'); break;
      case 'objective_step': this._objectivesDirty = true; break;
      case 'objective_dial': this._objectivesDirty = true; break;
      case 'end': this._end(e); break;
      default: break;
    }
  }

  // The hunt hum plays only while a hunt is on AND he is actually close to this player
  // (owner, Oct 25: no far-off false alarms). 10 m hysteresis so it doesn't flicker.
  _huntHum() {
    if (!this.chasing || this.mode !== 'playing' || !this.hv) { this._humOn = false; return false; }
    const R = CONFIG.HV.HUNT_HUM_RANGE, d = this.hv.pos.distanceTo(this.player.pos);
    this._humOn = d < (this._humOn ? R + 10 : R);
    return this._humOn;
  }

  // 1 while the wildlife around this player is holding its breath: for a few seconds after a
  // hush, and for as long as he stays close or a hunt is on. Released slowly (audio side).
  _hush() {
    if (!this._hushUntil || this.mode !== 'playing') return 0;
    const now = performance.now(), close = this.hv && this.hv.pos.distanceTo(this.player.pos) < 45;
    if (now < this._hushUntil || this.chasing || close) { if (now >= this._hushUntil) this._hushUntil = now + 1500; return 1; }
    this._hushUntil = 0; return 0;
  }

  _near(p, d) { return p && Math.hypot(p.x - this.player.pos.x, p.z - this.player.pos.z) < d; }

  _canSee(p) {
    if (!p) return false;
    const to = new THREE.Vector3(p.x, p.y, p.z).sub(this.camera.position);
    const distance = to.length();
    if (distance > 45) return false;
    const facing = to.normalize().dot(this.camera.getWorldDirection(new THREE.Vector3()));
    if (facing < Math.cos(THREE.MathUtils.degToRad(this.camera.fov / 2))) return false;
    if (distance > 14 && (!this.flashlight.on || facing < 0.9)) return false;
    const eye = this.camera.position;
    return this.world.lineOfSight(eye.x, eye.y, eye.z, p.x, p.y, p.z, { brushK: 0.3 }) > 0.3;
  }

  _end(r) {
    if (this.ended) return;
    this.ended = true; this.result = r;
    this.ui.closeChat();
    this.voice.endSession();
    this.endDelay = r.result === 'won' ? 2.5 : 3.2;     // game-clock countdown to the end screen
    this.fadeTarget = r.result === 'won' ? 0.4 : 0.85;
  }

  _showEnd() {
    const r = this.result;
    this.mode = 'ended'; this.input.enabled = false; this.input.exitLock();
    this.ui.showHUD(false); this.ui.showPause(false); this.ui.showNote(null);
    const me = r.players.find((p) => p.id === this.myId);
    // file the night in the journal (once), then show the report
    const filed = this.journal.record(r, this.myId, this.rules, this.notesRead);
    this.touch?.setVisible(false);
    this.ui.showEnd(r, { me: me ? me.state : 'dead', networked: !!this.net.networked, host: this._isHost(), notes: this.notesRead.length,
      filed, rules: this.rules, tip: nightTip(r, filed.stats, filed.me), names: this.names, myId: this.myId, journal: this.journal });
  }

  // ---------------------------------------------------------------- main loop
  _frame(now) {
    const dt = clamp((now - this.last) / 1000, 0, 0.1); this.last = now;
    this.step(dt);
    requestAnimationFrame((t) => this._frame(t));
  }

  // deterministic stepping for tests: ?manual=1, then game.advance(frames, dt)
  advance(frames = 1, dt = 1 / 30, render = true) {
    for (let i = 0; i < frames; i++) this.step(dt, render && i === frames - 1);
  }

  step(dt, render = true) {
    const t0 = performance.now();
    // A solo pause freezes both the sim and client-owned gameplay (battery,
    // movement, session clock and effects). Keep real time for UI/audio and
    // rendering; multiplayer continues while a player's pause menu is open.
    const gameplayDt = this.paused && this.net && !this.net.networked ? 0 : dt;
    G.uTime.value += gameplayDt;
    if (this.net && this.net.tick && !(this.paused && !this.net.networked)) this.net.tick(dt);
    if (this.mode === 'playing' || this.mode === 'ended') this._updatePlaying(gameplayDt);
    else this._menuCamera(dt);
    this.env.update(gameplayDt, this.camera, 0);
    this.audio.setListener(this.camera);
    this.audio.update(dt, { holdBreath: this.holdingBreath && this.mode === 'playing', terror: this.terror, fear: this.fear, cold: this.cold, exert: this.exert || 0, gas: this.gasFx, downed: this.player.downed, critical: this.critical, hunt: this._huntHum(), hush: this._hush(), hushRelease: this._hushRelease || 6, huntNear: this.hv ? clamp(1 - this.hv.pos.distanceTo(this.player.pos) / 40, 0, 1) : 0, inGame: this.mode === 'playing' && !this.paused, menu: this.mode !== 'playing' });
    const meP = this.player.pos;
    this.voice.update(dt, {
      ptt: this.mode === 'playing' && !this.input.textFocus && this.input.down('talk'), inGame: this.mode === 'playing',
      alive: this.myState !== 'dead', me: { x: meP.x, y: meP.y + 1.6, z: meP.z }, players: this._playerPositions(),
    });
    if (render) this._render(dt);
    this.input.endFrame();
    this._perf(performance.now() - t0, dt);
  }

  _playerPositions() {
    const m = this._ppos || (this._ppos = new Map()); m.clear();
    for (const [id, a] of this.avatars) m.set(id, { x: a.pos.x, y: a.pos.y + 1.6, z: a.pos.z, state: PST[a.state] });
    return m;
  }

  _menuCamera(dt) {
    const w = this.world;
    this._mt = (this._mt || 0) + dt;
    const p = pointAtDistance(w.trail, w.trailCum, 6);
    const q = pointAtDistance(w.trail, w.trailCum, 48);
    const sway = Math.sin(this._mt * 0.07) * 0.6;
    const x = p.x + Math.sin(this._mt * 0.05) * 0.4, z = p.z;
    const y = w.heightAt(x, z) + 1.65;
    this.camera.position.set(x, y, z);
    this.camera.lookAt(q.x + Math.cos(q.dir) * sway, w.heightAt(q.x, q.z) + 1.4, q.z - Math.sin(q.dir) * sway);
    this.camera.updateMatrixWorld();
    // a figure standing where the trail bends; he is gone if you stare long enough
    const fx = q.x + Math.cos(q.dir) * 3.6, fz = q.z - Math.sin(q.dir) * 3.6;
    const vis = (this._mt % 70) < 52;
    this.hv.update(dt, [fx, w.heightAt(fx, fz), fz, Math.atan2(p.x - fx, p.z - fz), Math.atan2(p.x - fx, p.z - fz), 0, 0, vis ? 4 : 12, 0.25, 0, 10]);
    this.sf.update(dt, null);
    this.flashlight.light.intensity = 0; this.flashlight.model.visible = false;
    for (const L of this.remoteLights) L.intensity = 0;
    this.terror = 0.12; this.cold = 0; this.fear = 0;
    G.uTerror.value = 0.1; G.uCold.value = 0;
  }

  _updatePlaying(dt) {
    const pl = this.player, inp = this.input, A = this.audio;
    this.sessionT += dt;
    const active = this.mode === 'playing' && !this.paused && !this.ended;
    this._devTick();
    if (this.ended && this.mode === 'playing') { this.endDelay -= dt; if (this.endDelay <= 0) this._showEnd(); }
    // ---- input-driven actions
    const typing = inp.textFocus;
    if (active && !typing) {
      if (inp.hitCode('Escape') && !inp.locked) this.pause(true);
      if (inp.hit('flashlight') && this.myState === 'alive' && !this._grab) { const r = this.flashlight.toggle(this.rushK || 0); A.ui(r === 'on' ? 'lighterOn' : r === 'off' ? 'lighterOff' : 'lighterSpark', 0.55); }
      if (inp.hit('chat') && this.net.networked) this.ui.openChat((text) => { if (text) this.net.send({ t: 'chat', text }); });
      if (inp.hitCode('F3')) this.ui.toggleDebug();
      if (this.settings.devMode) {
        if (inp.hitCode('F6')) this.devAction('hunt');
        if (inp.hitCode('F7')) this.devAction('reveal');
        if (inp.hitCode('F8')) this.devAction('relocate');
        if (inp.hitCode('F9')) { this.settings.devInvincible = !this.settings.devInvincible; this.settings.save(); this.ui.toast(`Invincible ${this.settings.devInvincible ? 'on' : 'off'}`, 1500); }
      }
      if (this.reading && (inp.hit('interact') || inp.hit('forward') || inp.hit('back') || inp.hit('left') || inp.hit('right'))) { this.reading = null; this.ui.showNote(null); inp.pressed.delete(this.settings.bindings.interact); }
    }
    this.ui.showInventory(active && !typing && inp.down('inventory'), () => this._inventoryData());
    // ---- local player
    const downed = this.myState === 'downed', dead = this.myState === 'dead' || this.myState === 'escaped';
    pl.downed = lerp(pl.downed, downed ? 1 : 0, 1 - Math.exp(-dt * 3));
    pl.slow = this.gasFx > 0.3 ? 0.6 : 1;
    pl.injured = this.health < (this.rules?.health ?? CONFIG.PLAYER.MAX_HEALTH) ? 1 : 0;
    const frozen = !active || typing || downed || dead || !!this.reading || !!this._grab;
    this._grabTick(dt);
    // Attack lock (owner, Oct 25): the instant he strikes you, the camera is pulled onto his
    // face and held there for a moment. Only on an actual hit, so it never aims the
    // flashlight for you during the approach (the 7-ft flashlight counter stays yours).
    // Only once he is within ~4 ft (owner), and only on his actual strike: locking while he
    // closes in would aim your flashlight at him and hand you a free 7-ft flash-off.
    if (this.hv && this._attackLockPending && this.myState !== 'dead'
        && Math.hypot(this.hv.pos.x - pl.pos.x, this.hv.pos.z - pl.pos.z) <= ATTACK_LOCK_DIST) {
      this._attackLock = Math.max(this._attackLock || 0, this._attackLockPending || 1.2);
    }
    this._attackLockPending = 0;
    if (this._attackLock > 0) this._attackLock -= dt;
    const locked = (this._attackLock > 0 || this._grab) && this.hv;
    if (locked) {
      const eyeY = pl.pos.y + 1.6 + (pl.eyeOffset || 0), headY = this.hv.pos.y + 1.68;
      const hd = Math.hypot(this.hv.pos.x - pl.pos.x, this.hv.pos.z - pl.pos.z);
      pl.lookLock = { x: this.hv.pos.x, z: this.hv.pos.z, pitch: clamp(Math.atan2(headY - eyeY, Math.max(0.3, hd)), -0.6, 0.6), rate: this._grab?.kind === 'turn' ? 30 : 16 };
    } else if (pl.lookLock && pl.lookLock.rate) pl.lookLock = null;
    if (!dead) pl.update(active && !typing ? dt : dt, frozen ? { consumeLook: () => inp.consumeLook(), down: () => false, hit: () => false } : inp, { frozen, noLook: !active || typing || locked });
    else this._spectate(dt);
    if(active&&!typing&&!this.reading&&!this._grab&&this.myState==='alive'&&inp.hit('pebble')){
      if(pl.covered)this.ui.toast('Uncover yourself before throwing.',2200);
      else if((this.pebbleReadyAt||0)>(this.snapT||0)+.02)this.ui.toast('Give it a moment before throwing another pebble.',1600);
      else this.net.send({t:'act',a:'pebble',yaw:pl.yaw,pitch:pl.pitch});
    }
    // cigarettes and beer
    if (active && !typing && !this.reading && !this._grab && this.myState === 'alive' && !this.arms.busy()) {
      const v = this.vice, now = this.snapT || 0;
      if (inp.hit('smoke')) {
        if (!(v.cigs > 0)) this.ui.toast('No cigarettes.', 1400);
        else if (!this.flashlight.on) this.ui.toast('You need a flame. Light the lighter first.', 2200);
        else if (pl.crouching) this.net.send({ t: 'act', a: 'smoke', drop: 1 });
        else if (v.smoke > now) this.ui.toast('You already have one going.', 1400);
        else this.net.send({ t: 'act', a: 'smoke' });
      }
      if (inp.hit('drink')) { if (v.beers > 0) this.net.send({ t: 'act', a: 'drink' }); else this.ui.toast(v.bottles > 0 ? `Empty. ${this._key('pebble')} throws the bottle.` : 'Nothing to drink.', 1800); }
    }
    {
      const now = this.snapT || 0, buzz = clamp((this.vice.buzz - now) / 12, 0, 1);   // fades over its last seconds
      pl.staminaMul = buzz > 0 ? lerp(1, CONFIG.VICE.BUZZ_STAMINA, buzz) : 1;
      this._buzzT = (this._buzzT || 0) + dt;
      if (buzz > 0 && !dead) { const t = this._buzzT; this.camera.rotation.z += Math.sin(t * 0.9) * 0.022 * buzz; this.camera.rotation.x += Math.sin(t * 0.63 + 1) * 0.008 * buzz; this.camera.rotation.y += Math.sin(t * 0.47) * 0.012 * buzz; }
    }
    this.smoulders.update(dt);
    this.pebbles.update(dt);
    this.balloons.update(dt); this.pings.update(dt);
    this._breath(dt, active && !typing && !this.reading);
    if (active && !typing && inp.hit('ping') && this.net.networked && (this.myState === 'alive' || this.myState === 'downed')) this._ping();
    // ---- interpolation clock
    if (this.snapT >= 0) {
      const target = this.snapT - this.interp;
      this.renderT += dt;
      if (Math.abs(this.renderT - target) > 0.6) this.renderT = target; else this.renderT += (target - this.renderT) * Math.min(1, dt * 4);
    }
    // ---- monsters
    const hs = this.hvBuf.sample(this.renderT);
    const fl = this.flashlight;
    this.hv.update(dt, hs, this.camera.position);
    let shine = 0;
    const ss = this.sfBuf.sample(this.renderT);
    if (ss && fl.on && fl.light.intensity > 5) {
      const h = this.sf.headPos(this._v1 || (this._v1 = new THREE.Vector3()));
      const to = h.clone().sub(fl.light.position); const d = to.length();
      if (d < 35) shine = clamp((to.normalize().dot(fl.dir) - 0.9) / 0.08, 0, 1) * (1 - d / 35) * this.world.lineOfSight(fl.light.position.x, fl.light.position.y, fl.light.position.z, h.x, h.y, h.z, { brushK: 0.15 });
    }
    this.sf.update(dt, ss, shine);
    this._monsterFoley(dt);
    // ---- teammates
    this._updateAvatars(dt);
    // ---- terror radius (evaluated for this player only, from their own position)
    this._terror(dt, hs);
    // ---- gas
    let gasT = 0;
    const gasU = this._gasU || (this._gasU = []); gasU.length = 0;
    for (const g of this.gas || []) {
      const [x, y, z, r, k] = g;
      gasU.push(g);
      const d = Math.hypot(x - pl.pos.x, (y - pl.pos.y - 1.2) * 1.5, z - pl.pos.z);
      if (d < r * (0.55 + 0.45 * k)) gasT = Math.max(gasT, k);
    }
    this.gasFx = lerp(this.gasFx, gasT, 1 - Math.exp(-dt * (gasT > this.gasFx ? 1.5 : 0.35)));
    this.damage = Math.max(0, this.damage - dt * 0.7);
    this.heartPulse = Math.max(0, this.heartPulse - dt * 4);
    // ---- interaction
    this._interact(dt, active && !typing && !this.reading);
    // ---- flashlight + breath + anomalies
    const walkBob = Math.sin(pl.bobT) * clamp(pl.speed / 2, 0, 1);
    fl.update(dt, this.camera, this.terror, { walkBob, gas: this.gasFx, off: dead, rush: this._rush(dt) });
    this.arms.update(dt, { speed: pl.speed, sprint: pl.sprinting, crouch: pl.crouching, using: !!(this.useId || this.reviveId), breath: this.holdingBreath, grabbed: !!this._grab, lighterOn: fl.on, hidden: dead || this.myState !== 'alive' });
    this.wildlife.update(dt, this.camera.position, { on: fl.on && fl.light.intensity > 5, pos: fl.light.position, dir: fl.dir, k: fl.light.intensity / CONFIG.FLASHLIGHT.INTENSITY });
    this.objViews.update(dt, this.sessionT, {
      on: fl.on, pos: fl.light.position, dir: fl.dir, range: CONFIG.FLASHLIGHT.RANGE * 2,
      k: fl.light.intensity / CONFIG.FLASHLIGHT.INTENSITY,
    });
    this.breath.update(dt);
    // eye/camera adaptation: a beam landing on something close floods the view, so exposure drops
    const lit = fl.on && fl.light.intensity > 5 && !dead;
    const expT = lit ? 0.85 : 1;   // a small flame near your eyes: a little less dark-adapted, no beam to flood the view
    this.exposure += (expT - this.exposure) * (1 - Math.exp(-dt * (expT < this.exposure ? 5 : 1.1)));
    const sawAnomaly = this.anomaly.update(dt, this.camera, this.terror);
    if (sawAnomaly && !this._anomShown) { this._anomShown = true; }
    if (!sawAnomaly) this._anomShown = false;
    // ---- network input @ 20 Hz
    this.inputT -= dt;
    if (this.inputT <= 0 && this.net && !this.ended) {
      this.inputT = 1 / CONFIG.NET.INPUT_HZ;
      this.net.send({ t: 'in', x: +pl.pos.x.toFixed(2), y: +pl.pos.y.toFixed(2), z: +pl.pos.z.toFixed(2), yaw: +pl.yaw.toFixed(3), pitch: +pl.pitch.toFixed(3),
        viewFov: this.camera.fov, viewAspect: this.camera.aspect, lean:+pl.lean.toFixed(3),
        crouch: pl.crouching, sprint: pl.sprinting, flash: fl.on && fl.light.intensity > 1, noise: +Math.max(pl.noise + (this.useId && this._stationNoisy ? 0.6 : 0), this.gaspT > 0 ? 0.42 : 0).toFixed(2), breath: this.holdingBreath,
        voice: +this.voice.voiceLevel.toFixed(2), hidden: pl.hidden, covered: pl.covered, paused:this.paused, use: this.useId || null, revive: this.reviveId || null });
    }
    if (this.touch) {
      this.touch.setVisible(active && this.myState !== 'dead' && this.myState !== 'escaped');
      this.touch.state({ blanket: !!pl.hasCamoBlanket, ping: !!(this.net && this.net.networked), smoke: this.vice.cigs > 0, drink: this.vice.beers > 0, bottle: this.vice.bottles > 0, breath: pl.crouching && pl.speed < 0.6, use: this.ui._prompt });
    }
    // ---- HUD
    this._fade(dt);
    this._hud(dt);
  }

  _spectate(dt) {
    // follow a living teammate (multiplayer) or stay where you fell
    let target = null;
    for (const a of this.avatars.values()) if (a.state === 0 || a.state === 1) { target = a; break; }
    if (!target) { this.player._camera(dt, 0); return; }
    const back = new THREE.Vector3(Math.sin(target.yaw) * 2.6, 1.0, Math.cos(target.yaw) * 2.6);
    const want = target.pos.clone().add(back).setY(target.pos.y + 2.2);
    this.camera.position.lerp(want, 1 - Math.exp(-dt * 4));
    this.camera.lookAt(target.pos.x, target.pos.y + 1.3, target.pos.z);
    this.camera.updateMatrixWorld();
    this.spectate = target.id;
  }

  _updateAvatars(dt) {
    let lightIdx = 0;
    const cam = this.camera.position;
    const sorted = [...this.avatars.values()].sort((a, b) => a.pos.distanceToSquared(cam) - b.pos.distanceToSquared(cam));
    for (const a of sorted) {
      const b = this.plBufs.get(a.id);
      const s = b && b.sample(this.renderT);
      if (!s) continue;
      const before = a.pos.clone();
      a.update(dt, s, cam);
      // footsteps for teammates
      const moved = Math.hypot(a.pos.x - before.x, a.pos.z - before.z);
      if (moved < 3) {
        a.stride += moved;
        const sl = a.flags & 4 ? 1.25 : a.flags & 1 ? 0.6 : 0.8;
        if (a.stride > sl && a.state === 0) {
          a.stride = 0;
          const surf = this.world.surfaceAt(a.pos.x, a.pos.z), wd = this.world.waterAt(a.pos.x, a.pos.z);
          this.audio.footstep({ teammate: true, surface: surf, water: wd !== null ? Math.max(0, wd - this.world.heightAt(a.pos.x, a.pos.z)) : 0, brush: this.world.gridAt(this.world.gBrush, a.pos.x, a.pos.z), loud: a.flags & 4 ? 0.45 : a.flags & 1 ? 0.04 : 0.18, speed: a.speed }, { x: a.pos.x, y: a.pos.y + 0.1, z: a.pos.z });
        }
      }
      // flashlight
      if ((a.flags & 2) && a.state !== 2 && a.state !== 3 && lightIdx < this.remoteLights.length && a.pos.distanceTo(cam) < 90) {
        const L = this.remoteLights[lightIdx++];
        const hp = a.handPos(this._v2 || (this._v2 = new THREE.Vector3()));
        const cp = Math.cos(a.pitch);
        L.position.copy(hp);
        L.intensity = CONFIG.FLASHLIGHT.INTENSITY * (0.82 + 0.1 * Math.sin(performance.now() * 0.023 + lightIdx * 2) + 0.06 * Math.sin(performance.now() * 0.041));
      }
    }
    for (; lightIdx < this.remoteLights.length; lightIdx++) this.remoteLights[lightIdx].intensity = 0;
  }

  // ---- the grab, from the inside (Puppet rework). kind: shoulders | throat | face | turn | drag | final
  // how hard he is coming at you right now (0..1): running, closing, within 35 m. Drives the
  // flashlight flicker (owner: "when he runs at you it flickers")
  _rush(dt) {
    const hv = this.hv, pl = this.player;
    let target = 0;
    if (hv.root.visible && HV_STATES[hv.state] === 'chase' && !this._grab) {
      const d = Math.hypot(hv.pos.x - pl.pos.x, hv.pos.z - pl.pos.z);
      const closing = (this._rushD ?? d) - d;
      this._rushD = d;
      if (d < 35 && hv.speed > 3 && closing > 0) target = clamp(1 - d / 35, 0.25, 1);
    } else this._rushD = null;
    this.rushK = lerp(this.rushK || 0, target, 1 - Math.exp(-dt * (target > (this.rushK || 0) ? 6 : 2)));
    return this.rushK;
  }

  _grabStart(e) {
    const pl = this.player;
    // his hand closes on you and your light dies: it clicks off and stays off until you turn it back on
    if (this.flashlight.on) { this.flashlight.on = false; this.audio.ui('lighterOff', 0.7); }
    this._grab = { kind: e.kind, t: 0, dur: e.dur || 1.6, from: { x: pl.pos.x, z: pl.pos.z }, to: { x: e.px ?? pl.pos.x, z: e.pz ?? pl.pos.z } };
    pl.vel.set(0, 0, 0);
    pl.shake = Math.max(pl.shake, e.kind === 'final' ? 1 : 0.75);
    this.voice.suppress(this._grab.dur + 0.5);
    if (e.kind === 'throat' || e.kind === 'face' || e.kind === 'final') setTimeout(() => this._grab && this.audio.ui('choke' + ((e.seq || 0) % 2), 0.85), 180);
  }

  _grabEnd() {
    if (!this._grab) return;
    const kind = this._grab.kind;
    this._grab = null;
    this.player.eyeOffset = 0; this.player.extraRoll = 0;
    if (kind !== 'final') this.fadeTarget = 0;
    this.camera.fov = this.settings.fov; this.camera.updateProjectionMatrix();
    this.player.shake = Math.max(this.player.shake, 0.9);
    this._attackLock = Math.max(this._attackLock || 0, 0.6);
  }

  _grabTick(dt) {
    const g = this._grab, pl = this.player;
    if (!g) return;
    g.t += dt;
    if (g.t > g.dur + 1 || this.myState === 'dead' && g.kind !== 'final') { this._grabEnd(); return; }
    const u = clamp(g.t / g.dur, 0, 1), ease = (x) => x * x * (3 - 2 * x);
    let eye = 0, roll = 0, zoom = 1;
    switch (g.kind) {
      case 'throat': eye = 0.24 * ease(clamp(g.t / 0.5, 0, 1)); roll = 0.06 * Math.sin(g.t * 9); this.fadeTarget = 0.35 * u; break;   // lifted off your feet
      case 'face': this.fadeTarget = g.t > 0.12 && g.t < g.dur - 0.1 ? 0.9 : 0; eye = -0.05; break;                                // his hand over your face
      case 'drag': {                                                                                                                 // yanked toward him by the leg
        const k = ease(clamp(g.t / 0.45, 0, 1));
        pl.pos.x = lerp(g.from.x, g.to.x, k); pl.pos.z = lerp(g.from.z, g.to.z, k);
        pl.pos.y = this.world.heightAt(pl.pos.x, pl.pos.z);
        eye = -0.75 * (1 - ease(clamp((g.t - 0.3) / 0.8, 0, 1))); roll = 0.25 * (1 - u); break;
      }
      case 'turn': roll = -0.12 * (1 - u); break;                                                                                     // spun round to face him
      case 'final': zoom = 1 - 0.32 * ease(u); eye = 0.06 * u; this.fadeTarget = u > 0.65 ? (u - 0.65) / 0.35 : 0; break;            // the last one
      default: zoom = 1 - 0.08 * ease(u); roll = 0.03 * Math.sin(g.t * 13);                                                          // both shoulders
    }
    pl.eyeOffset = lerp(pl.eyeOffset || 0, eye, 1 - Math.exp(-dt * 10)); pl.extraRoll = lerp(pl.extraRoll || 0, roll, 1 - Math.exp(-dt * 10));
    const fov = this.settings.fov * zoom;
    if (Math.abs(this.camera.fov - fov) > 0.05) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
  }

  _monsterFoley(dt) {
    const hv = this.hv, w = this.world;
    const quiet = this._hvQuietUntil && performance.now() < this._hvQuietUntil;
    // operated (low, on all fours): a quick scuttle through the leaves, knuckles on the boardwalk
    if (hv.root.visible && hv.flags & 16 && hv.speed > 0.8 && hv.moved < 3 && !quiet) {
      hv.crawlAcc = (hv.crawlAcc || 0) + hv.moved;
      if (hv.crawlAcc > 1.1) {
        hv.crawlAcc = 0;
        const wood = w.surfaceAt(hv.pos.x, hv.pos.z) === SURFACE.WOOD, n = (Math.random() * 4) | 0;
        this.audio.at(wood ? 'knuckle' + (n % 3) : 'crawl' + n, { x: hv.pos.x, y: hv.pos.y + 0.2, z: hv.pos.z },
          { bus: 'mon', gain: wood ? 1.1 : 0.9, rate: 0.92 + Math.random() * 0.16, ref: 2, reverb: 0.06, range: wood ? { fadeStart: 4, maxDistance: 11 } : { fadeStart: 3, maxDistance: 8 } });
      }
    } else if (hv.root.visible && hv.speed > 2.2 && hv.moved < 3 && !quiet) {
      hv.stepAcc += hv.moved;
      if (hv.stepAcc > 1.35) { hv.stepAcc = 0; this.audio.footstep({ creature: 'hv', surface: w.surfaceAt(hv.pos.x, hv.pos.z), water: 0, brush: w.gridAt(w.gBrush, hv.pos.x, hv.pos.z), loud: hv.speed >= CONFIG.HV.CHASE * 0.8 ? 1 : 0.35, speed: hv.speed }, { x: hv.pos.x, y: hv.pos.y + 0.1, z: hv.pos.z }); }
    }
    const sf = this.sf;
    if (sf.root.visible && sf.speed > 0.6) {
      sf._acc = (sf._acc || 0) + sf.speed * dt;
      if (sf._acc > 0.9) { sf._acc = 0; const b = w.gridAt(w.gBrush, sf.pos.x, sf.pos.z); this.audio.footstep({ creature: 'sf', surface: w.surfaceAt(sf.pos.x, sf.pos.z), water: 0, brush: Math.max(0.5, b), loud: 0.2, speed: 2 }, { x: sf.pos.x, y: sf.pos.y + 0.2, z: sf.pos.z }); }
    }
  }

  _terror(dt, hs) {
    const pl = this.player;
    let d = 1e9;
    if (hs && !(hs[7] & 8)) d = Math.hypot(hs[0] - pl.pos.x, hs[1] - pl.pos.y, hs[2] - pl.pos.z);
    this.hvDist = d;
    let target = huntTerrorTarget(terrorAtDistance(d), this._huntHum());
    if (this.myState === 'dead' || this.ended) target = 0;
    this.terror = target > this.terror ? Math.min(target, this.terror + dt * T.SMOOTH_IN) : Math.max(target, this.terror - dt * T.SMOOTH_OUT);
    const tr = this.terror;
    const cues = horrorCues(tr);
    this.cold = cues.cold;                                       // outer ring: subtle cold before stronger cues
    this.temp = lerp(T.BASE_TEMP_C, T.MIN_TEMP_C, smoothstep(0, 0.9, tr));
    this.critical = 0;
    this.fear = 0;
    pl.tremor = 0;
    const stam = 1 - pl.stamina / CONFIG.PLAYER.STAMINA_MAX;
    this.exert = clamp(Math.max(stam * 1.1, pl.sprinting ? 0.6 : 0), 0, 1);
    G.uTerror.value = 0; G.uCold.value = this.cold;
  }

  // distance along the flashlight beam to the first thing it lights (terrain, trunks, thick brush, bodies)
  _beamDistance() {
    const fl = this.flashlight, w = this.world, p = fl.light.position, d = fl.dir;
    const tmp = this._qtmp || (this._qtmp = []);
    // runs every frame: flat reusable body buffer [x, y, z, r, h] * n, no Math.hypot / iterators
    const B = this._bodyBuf || (this._bodyBuf = new Float64Array(5 * 8)); let nb = 0;
    const put = (x, y, z, r, h) => { if (nb >= 8) return; const o = nb++ * 5; B[o] = x; B[o + 1] = y; B[o + 2] = z; B[o + 3] = r; B[o + 4] = h; };
    if (this.hv.root.visible) put(this.hv.pos.x, this.hv.pos.y, this.hv.pos.z, this.hv.flags & 16 ? 0.7 : 0.4, this.hv.flags & 16 ? 0.95 : 1.95);
    if (this.sf.root.visible) put(this.sf.pos.x, this.sf.pos.y, this.sf.pos.z, 0.55 * CONFIG.SF.MODEL_SCALE, CONFIG.SF.MODEL_SCALE);
    for (const a of this.avatars.values()) if (a.root.visible) put(a.pos.x, a.pos.y, a.pos.z, 0.35, 1.8);
    const wb = this.wildlife && this.wildlife.body(); if (wb) put(wb.x, wb.y, wb.z, wb.r, wb.h);   // a deer or owl in the beam adapts the eye too
    for (let k = 1; k < 48; k++) {
      const t = k * 0.3, x = p.x + d.x * t, y = p.y + d.y * t, z = p.z + d.z * t;
      const g = w.heightAt(x, z);
      if (y < g + 0.02) return t;
      for (let i = 0; i < nb; i++) {
        const o = i * 5, bx = x - B[o], bz = z - B[o + 2], r = B[o + 3];
        if (bx * bx + bz * bz < r * r && y > B[o + 1] && y < B[o + 1] + B[o + 4]) return t;
      }
      if (y - g < 1.5 && w.gridAt(w.gBrush, x, z) > 0.7) return t + 0.6;
      if (k % 2 === 0) {
        const hits = w.queryColliders(x, z, 0.2, tmp);
        for (let i = 0; i < hits.length; i++) {
          const r = hits[i]; if (r >= 100000) continue;
          const c = w.circles[r], cx = x - c[0], cz = z - c[1], rr = c[2] + 0.05;
          if (cx * cx + cz * cz < rr * rr) return t;
        }
      }
    }
    return 14.4;
  }

  _exhale(vol) {
    if (this.mode !== 'playing') return;
    // close by and not hunting you, he breathes out when you do (Puppet search beat)
    const hv = this.hv, st = HV_STATES[hv.state];
    if (hv.root.visible && !this.chasing && (st === 'search' || st === 'still' || st === 'watch' || st === 'stalk')
        && hv.pos.distanceTo(this.player.pos) < 7) {
      const at = hv.headPos(this._v3 || (this._v3 = new THREE.Vector3()));
      setTimeout(() => this.mode === 'playing' && this.audio.hvBreath({ x: at.x, y: at.y, z: at.z }, (this._breathN = (this._breathN || 0) + 1)), 120);
    }
    const t = this.temp ?? T.BASE_TEMP_C;
    const k = clamp((7 - t) / 9, 0, 1) * (0.6 + 0.4 * clamp(vol * 2, 0, 1));
    const lit = this.flashlight.on ? 1 : 0.2;
    if (k > 0.04 && this.myState !== 'dead') this.breath.puff(this.camera, k, lit);
  }

  // ---------------------------------------------------------------- Update 0.9 helpers
  // Hold your breath: crouched and still, hold Jump. Lungs are yours (like stamina): they drain
  // while you hold, refill when you breathe, and if they empty you gasp - loudly - for a moment.
  // every cigarette smoked tonight costs lung capacity
  _lungMax() { return (this.rules?.lungs || 10) * CONFIG.VICE.SMOKE_LUNGS ** (this.vice?.smoked || 0); }
  _key(action) { return this.touch ? action.toUpperCase() : this.settings.keyName(this.settings.bindings[action]); }

  _breath(dt, active) {
    const pl = this.player, B = CONFIG.BREATH, max = this._lungMax();
    if (this.gaspT > 0) this.gaspT -= dt;
    if (this.lungs > max) this.lungs = max;
    const can = active && this.myState === 'alive' && pl.crouching && pl.speed < 0.6 && this.gaspT <= 0 && !this._grab;
    const want = can && this.input.down('jump') && this.lungs > 0;
    if (want) {
      if (!this.holdingBreath) this.audio.ui('in0', 0.5);
      this.lungs = Math.max(0, this.lungs - dt); this.lungDelay = B.REFILL_DELAY;
      if (this.lungs <= 0) { this.gaspT = B.GASP; this.audio.ui('gasp', 0.9); this.player.shake = Math.max(this.player.shake, 0.25); }
    } else {
      this.lungDelay -= dt;
      if (this.lungDelay <= 0) this.lungs = Math.min(max, this.lungs + dt * B.REFILL * (max / 10));
    }
    this.holdingBreath = !!want && this.lungs > 0;
  }

  // the point on the ground (or a trunk) you are looking at, for a ping
  _ping() {
    const w = this.world, p = this.camera.position, d = this.camera.getWorldDirection(this._v7 || (this._v7 = new THREE.Vector3()));
    let hit = null;
    for (let k = 2; k < 90; k++) {
      const t = k * 0.5, x = p.x + d.x * t, y = p.y + d.y * t, z = p.z + d.z * t, g = w.heightAt(x, z);
      if (y < g + 0.05) { hit = { x, y: g, z }; break; }
      if (w.lineOfSight(p.x, p.y, p.z, x, y, z, { brushK: 0 }) < 0.5) { hit = { x, y: Math.max(g, y - 0.2), z }; break; }
    }
    if (!hit) { const t = CONFIG.PING.RANGE - 1; hit = { x: p.x + d.x * t, z: p.z + d.z * t }; hit.y = w.heightAt(hit.x, hit.z); }
    this.net.send({ t: 'act', a: 'ping', x: +hit.x.toFixed(2), y: +hit.y.toFixed(2), z: +hit.z.toFixed(2) });
  }

  // the world beyond the trees (shared/sim/ambient.js): scenery, never a tell
  _ambient(e, pos) {
    const A = this.audio, me = this.player.pos;
    if (e.kind === 'train') {
      // the line runs well south of the refuge: always from the same side of the sky
      A.at('train', { x: me.x + 260, y: me.y + 10, z: me.z + 620 }, { bus: 'amb', gain: 1.5, ref: 500, rolloff: 0.4, reverb: 0.6, occlude: false });
    } else if (e.kind === 'dog') A.at('farmDog' + (e.s % 2), { x: e.x, y: me.y + 2, z: e.z }, { bus: 'amb', gain: 1.6, ref: 70, rolloff: 0.8, reverb: 0.6, occlude: false });
    else if (e.kind === 'branch') A.at('branchFall' + (e.s % 2), pos, { bus: 'sfx', gain: 1.5, ref: 12, reverb: 0.35 });
    else if (e.kind === 'alarm') {
      const lot = { x: e.x, y: this.world.heightAt(e.x, e.z) + 1, z: e.z };
      A.stopLoop('alarm'); A.loopAt('alarm', 'carAlarm', lot, { bus: 'amb', gain: 0.4, ref: 25, rolloff: 1.2, reverb: 0.8, occlude: false });   // owner Nov 10: was too loud; a distant alarm across the lot
      this._alarmT = e.dur || 25;
    }
  }

  // the handheld from the mast cabinet (subtitles; the sim sends the beats)
  _radio(id) {
    const L = {
      call: [['YOU', 'East Trail, Stinchcomb. We need help out here. There is someone in the trees.', 4200], ['DISPATCH', 'Copy, East Trail. Unit 14 is rolling to the highway bridge. Take the handheld out of the cabinet and keep moving north.', 6200], ['DISPATCH', 'Stay on the trail. Do not stop for anyone you do not know.', 4200]],
      bridge: [['UNIT 14', 'Fourteen. I am on the bridge with my lights on. I do not see anybody yet.', 5200]],
      see_light: [['UNIT 14', 'I have a light in the trees. That you? Keep coming.', 4200]],
      no_light: [['UNIT 14', 'I cannot see you out there. If you have a light, show it.', 4600]],
      close: [['UNIT 14', 'There you are. Come on. Come on. Do not look back.', 4600]],
    }[id];
    if (!L) return;
    for (const [who, text, ms] of L) this.subs.push({ who, text, ms });
  }

  _subtitles(dt) {
    if (this._alarmT > 0) { this._alarmT -= dt; if (this._alarmT <= 0) this.audio.stopLoop('alarm'); }
    if (this.subT > 0) { this.subT -= dt * 1000; if (this.subT <= 0) this.ui.subtitle(null); return; }
    const s = this.subs && this.subs.shift();
    if (!s) return;
    this.subT = s.ms + 350;
    if (s.who !== 'YOU') this.audio.ui('radioBlip', 0.35);
    if (this.settings.subtitles !== false) this.ui.subtitle(s.who, s.text);
  }

  // a first-time hint (once ever per browser; Settings can bring them back)
  _hint(id, text, ms = 9000) {
    if (this.settings.hints === false || this.mode !== 'playing') return false;
    if (!this.journal.hint(id)) return false;
    this.ui.hint(text, ms);
    return true;
  }

  _hints(dt) {
    if (this.settings.hints === false || this.ended || this.myState !== 'alive') return;
    this._hintT -= dt;
    if (this._hintT > 0) return;
    this._hintT = 0.5;
    const pl = this.player, s = this.settings, k = (a) => s.keyName(s.bindings[a]);
    if (this.sessionT > 12 && this.sessionT < 40 && this._hint('move', this.touch
      ? 'Left thumb moves (push to the edge to run). Right thumb looks. NOTES opens your map and plan.'
      : `${k('forward')}${k('left')}${k('back')}${k('right')} move · ${k('sprint')} run · ${k('crouch')} crouch · ${k('flashlight')} lighter · hold ${k('inventory')} for the map and plan`, 10000)) return;
    if (this.cold > 0.3 && !this.chasing && this._hint('cold', 'The air just went cold. That is the only warning you get that he is somewhere near.')) return;
    if (this._huntHum() && !this._sawHunt) {
      this._sawHunt = true;
      if (this._hint('hunt', 'That low hum means he is hunting you. Do not run. Get out of his sight, crouch behind a trunk or in thick brush, put the lighter out and stay still.', 12000)) return;
    }
    if (this.hv.root.visible && this.hv.flags & 128 && this._near(this.hv.pos, 40) && this._canSee({ x: this.hv.pos.x, y: this.hv.pos.y + 1.4, z: this.hv.pos.z })
      && this._hint('watched', 'He does not move while you are looking at him. He does when you look away.')) return;
    const b = this.balloons.nearest(pl.pos, 7);
    if (b && this._canSee({ x: b.x, y: b.y + 1.4, z: b.z }) && this._hint('balloon', 'A balloon. He was standing here. Crouch to pass under it, or untie it. Popped, it is the loudest thing in the refuge.', 10000)) return;
    if (this.flashlight.battery < 0.3 && this._hint('fuel', 'The lighter is running low. Spare lighters are scattered along the trail. It lasts longer if you put it out when you can see without it.')) return;
    if (pl.hidden && this.chasing && this.lungs < (this.rules?.lungs || 10) * 0.35 && this.holdingBreath && this._hint('lungs', 'You are nearly out of air. If your lungs empty you will gasp, and he will hear it.')) return;
  }

  // compass strip: heading, and where the current tasks are (known once the memo is read)
  _compass(dt) {
    if (this.settings.compass === false) { this.ui.compass(null); return; }
    this._compT = (this._compT || 0) - dt;
    if (this._compT > 0) return;
    this._compT = 0.05;
    const pl = this.player, L = this.info.layout, pips = [];
    const add = (label, x, z) => pips.push({ label, b: Math.atan2(x - pl.pos.x, -(z - pl.pos.z)), d: Math.hypot(x - pl.pos.x, z - pl.pos.z) });
    if (this.myState === 'alive') {
      if (!this.notesRead.includes('memo')) { const m = L.items.find((i) => i.id === 'note_memo'); if (m) add('MEMO', m.x, m.z); }
      else if (this.extractOpen) add('BRIDGE', L.extract.x, L.extract.z);
      else {
        const names = { gen: 'GENERATOR', relay: 'RELAY', uplink: 'AERIAL', mast: 'MAST' };
        for (const s of L.stations) {
          const v = this.objViews.stations.get(s.id);
          if (v && v.done) continue;
          if (s.id === 'mast' && L.stations.some((o) => o.id !== 'mast' && !(this.objViews.stations.get(o.id) || {}).done)) continue;
          add(names[s.id] || s.id.toUpperCase(), s.x, s.z);
        }
      }
    }
    this.ui.compass(-pl.yaw, pips);
  }

  // ---------------------------------------------------------------- interaction
  _interact(dt, active) {
    const pl = this.player, inp = this.input, L = this.info.layout;
    this.useId = null; this.reviveId = null; this._stationNoisy = false;
    let best = null, bd = 1e9;
    if (active && this.myState === 'alive' && !pl.covered) {
      const f = this.camera.getWorldDirection(this._v5 || (this._v5 = new THREE.Vector3()));
      const eye = this.camera.position;
      const consider = (x, y, z, r, o) => {
        const dx = x - pl.pos.x, dz = z - pl.pos.z, dh = Math.hypot(dx, dz);
        if (dh > r || Math.abs(y - pl.pos.y) > 2.2) return;
        const to = (this._v6 || (this._v6 = new THREE.Vector3())).set(x - eye.x, y - eye.y, z - eye.z).normalize();
        const facing = dh < 0.9 ? 1 : to.dot(f);
        if (facing < 0.35) return;
        if(this.world.lineOfSight(eye.x,eye.y,eye.z,x,y,z,{brushK:0})<.2)return;
        const score = dh - facing;
        if (score < bd) { bd = score; best = o; }
      };
      for (const [id, it] of this.objViews.items) if (!it.held) consider(it.def.x, it.y + 0.1, it.def.z, it.def.wall ? 2.4 : 2.1, { type: 'pickup', id, it });
      for (const [id, s] of this.objViews.stations) if (!s.done) consider(s.def.x, s.def.y + 0.6, s.def.z, 2.5, { type: 'station', id, s });
      for (const a of this.avatars.values()) if (a.state === 1) consider(a.pos.x, a.pos.y + 0.3, a.pos.z, 2.2, { type: 'revive', id: a.id, a });
      for (const b of this.balloons.items.values()) consider(b.x, b.y + CONFIG.BALLOON.HEIGHT - 0.25, b.z, CONFIG.BALLOON.UNTIE_RANGE - 0.2, { type: 'balloon', id: b.id });
    }
    let prompt = null, prog = null;
    const key = this.touch ? 'USE' : this.settings.keyName(this.settings.bindings.interact);
    if (best) {
      if (best.type === 'pickup') {
        const it = best.it.def;
        prompt = `<b>${key}</b> ${it.kind === 'note' ? 'Read' : 'Pick up'} ${it.name.toLowerCase()}`;
        if (inp.hit('interact')) this.net.send({ t: 'act', a: 'pickup', id: best.id });
      } else if (best.type === 'station') {
        const s = best.s.def;
        const missing = this._missing(s);
        if (missing.length) prompt = `<span class="dim">${s.name} — ${missing.join(', ')}</span>`;
        else if(s.action==='dial'){
          prompt=`<b>${key}</b> ${s.name}<br><span class="dim">Turn clockwise · now: ${ANTENNA_BEARINGS[best.s.dial]} · mast bearing: ${s.targetBearing}</span>`;
          if(inp.hit('interact'))this.net.send({t:'act',a:'dial',id:best.id});
        } else {
          // Progress arrives rounded to .001 in snapshots; .333 is a secured third.
          const step=Math.min((s.steps?.length||1)-1,Math.floor(((best.s.prog||0)+.0005)*(s.steps?.length||1)+1e-6));
          const detail=s.steps?.[step];
          prompt = `Hold <b>${key}</b> ${s.name.toLowerCase()}${detail?`<br><span class="dim">${detail} · step ${step+1}/${s.steps.length}</span>`:''}`;
          if (inp.down('interact')) { this.useId = best.id; this._stationNoisy = s.kind !== 'relay'; prog = best.s.prog || 0; this._workSound(dt, s); }
          else if (best.s.prog > 0) prog = best.s.prog;
        }
      } else if (best.type === 'balloon') {
        prompt = `<b>${key}</b> Untie the balloon <span class="dim">· quiet · or crouch under it</span>`;
        if (inp.hit('interact')) this.net.send({ t: 'act', a: 'untie', id: best.id });
      } else if (best.type === 'revive') {
        const row = this.plBufs.get(best.id) && this.plBufs.get(best.id).latest();
        prompt = `Hold <b>${key}</b> to revive ${this._name(best.id)}`;
        if (inp.down('interact')) { this.reviveId = best.id; prog = row ? row[9] : 0; }
      }
    }
    if (this.myState === 'downed' && this.me) { prompt = `<span class="warn">Bleeding out — ${Math.ceil(this.me[10])}s</span>`; prog = this.me[9] > 0 ? this.me[9] : null; }
    this.ui.prompt(prompt); this.ui.progress(prog);
  }

  _missing(s) {
    const out = [];
    for (const n of s.needs) {
      if (n === 'fuel' && !this.team.fuel) out.push('needs the gas can');
      else if (n === 'fuse' && !this.team.fuse) out.push('needs the fuse kit');
      else if (n === 'crank' && !this.team.crank) out.push('needs the handwheel beside this antenna');
      else if (n === 'uplink' && !(this.objViews.stations.get(n)||{}).done) out.push('far-bank aerial is not aligned');
      else if ((n === 'gen' || n === 'relay') && !(this.objViews.stations.get(n) || {}).done) out.push(n === 'gen' ? 'no power (generator)' : 'relay box is dead');
    }
    return [...new Set(out)];
  }

  _workSound(dt, s) {
    this._workT = (this._workT || 0) - dt;
    if (this._workT > 0) return;
    this._workT = s.kind === 'generator' ? 1.6 : s.kind === 'relay' ? 0.9 : 1.3;
    this.audio.at('work_' + (s.kind === 'generator' ? 'gen' : s.kind === 'relay' ? 'relay' : 'mast'), { x: s.x, y: s.y + 0.6, z: s.z }, { gain: 0.9, ref: 3 });
  }

  // ---------------------------------------------------------------- HUD
  _objectiveLines() {
    const L = this.info.layout, out = [];
    if (!this.notesRead.includes('memo')) out.push({ id:'memo',text: 'Read the maintenance memo on the trailhead kiosk', done: false });
    out.push({id:'crank',text:'Recover the antenna handwheel across the river',sub:'Far-bank Service Landing · take the crossing near Fishing Bank',done:!!this.team.crank});
    for (const s of L.stations) {
      const v = this.objViews.stations.get(s.id), done = v && v.done;
      let sub = s.where;
      if (!done && s.id === 'gen') sub += this.team.fuel ? ' · gas can ✓' : ' · gas can: '+(this.notesRead.includes('memo')?L.supplyHints?.fuel||'check the supply register':'read the kiosk memo');
      if (!done && s.id === 'relay') sub += this.team.fuse ? ' · fuse kit ✓' : ' · fuse kit: '+(this.notesRead.includes('memo')?L.supplyHints?.fuse||'check the supply register':'read the kiosk memo');
      const secured=Math.floor(((v?.prog||0)+.0005)*3+1e-6);
      if(!done&&s.action==='dial')sub+=` · turn toward ${s.targetBearing} · now ${ANTENNA_BEARINGS[v?.dial??s.dial]}`;
      else if(!done&&secured)sub+=` · ${secured}/3 steps secured`;
      out.push({ id:s.id,text: s.name, sub, done });
    }
    if (this.extractOpen) out.push({ text: 'Get to the highway bridge — a county unit is waiting', done: false, urgent: true });
    return out;
  }

  _inventoryData() {
    return {
      objectives: this._objectiveLines(),
      team: this.team, battery: this.flashlight.battery, temp: this.temp ?? T.BASE_TEMP_C,
      notes: this.notesRead.map((id) => this._sessionNote(id)).filter(Boolean),
      map:this._fieldMapData(),blanket:this.player.hasCamoBlanket,
      pebbleRemaining:Math.max(0,(this.pebbleReadyAt||0)-(this.snapT||0)),
      supplyHints:this.notesRead.includes('memo')?this.info.layout.supplyHints:null,
      time: this.sessionT,
    };
  }

  _sessionNote(id){
    const note=NOTES.find(n=>n.id===id);
    return note&&id==='memo'&&this.info.layout.memoText?{...note,text:this.info.layout.memoText}:note;
  }

  _activeObjectiveLines(){
    const lines=this._objectiveLines();
    if(!this.notesRead.includes('memo'))return lines.filter(l=>l.id==='memo');
    if(this.extractOpen)return lines.filter(l=>l.urgent);
    const repairs=lines.filter(l=>!l.done&&(l.id==='gen'||l.id==='relay'));
    return (repairs.length?repairs:lines.filter(l=>!l.done)).slice(0,2);
  }

  _fieldMapData(){
    const w=this.world;
    if(!this._trailMap){
      const xs=w.trail.map(p=>p[0]),zs=w.trail.map(p=>p[1]);
      const minX=Math.min(...xs)-40,maxX=Math.max(...xs)+40,minZ=Math.min(...zs)-40,maxZ=Math.max(...zs)+40;
      const scale=Math.min(450/(maxX-minX),260/(maxZ-minZ));
      const padX=(500-(maxX-minX)*scale)/2,padZ=(300-(maxZ-minZ)*scale)/2;
      const project=(x,z)=>[+(padX+(x-minX)*scale).toFixed(1),+(padZ+(z-minZ)*scale).toFixed(1)];
      const path=points=>points.map((p,i)=>(i?'L':'M')+project(...p).join(',')).join(' ');
      this._trailMap={project,path:path(w.trail),river:path(w.river),service:path(w.servicePath),
        markers:Object.values(w.poi).map((p,i)=>({n:i+1,name:p.name,at:project(p.x,p.z)}))};
    }
    return {...this._trailMap,player:this._trailMap.project(this.player.pos.x,this.player.pos.z)};
  }

  _hud(dt) {
    const pl = this.player;
    if (this._objectivesDirty) { this._objectivesDirty = false; this.ui.objectives(this._activeObjectiveLines()); }
    this.ui.meters(pl.stamina / CONFIG.PLAYER.STAMINA_MAX, this.flashlight.battery, this.flashlight.on);
    this.ui.pebble(Math.max(0,(this.pebbleReadyAt||0)-(this.snapT||0)),this.myState==='alive'&&!pl.covered);
    this.ui.lungs(this.lungs / this._lungMax(), this.holdingBreath, this.gaspT > 0);
    this.ui.vices(this.vice, this.snapT || 0);
    this._compass(dt); this._subtitles(dt); this._hints(dt);
    this._teamT = (this._teamT || 0) - dt;
    if (this._teamT <= 0) {
      this._teamT = 0.25;
      const list = [];
      if (this.net && this.net.networked) {
        list.push({ id: this.myId, name: this._name(this.myId), state: this.myState, me: true, talking: this.voice.transmitting, color: this._colorOf(this.myId) });
        for (const a of this.avatars.values()) list.push({ id: a.id, name: a.name, state: PST[a.state], talking: this.voice.isSpeaking(a.id) || !!(a.flags & 16), color: this._colorOf(a.id) });
      }
      this.ui.team(list);
      if (this.settings.devMode && this.settings.devOverlay && !this.ui.debugOn && this.sim) {
        const hv = this.sim.hv, d = this.sim.director, me = this.sim.players.get(this.myId || 'p1');
        const dist = me ? Math.hypot(hv.x - me.x, hv.z - me.z) : 0;
        this.ui.devOverlay([
          `<b>DEV</b> · Helium Voice: ${hv.state}${hv.windup ? ' (winding up)' : ''}${hv.closingOn ? ' · closing in' : ''} · ${dist.toFixed(0)} m`,
          `director: ${d.phase}${d.inDread() ? ' · DREAD' : ''} · escalation ${(d.escalation() * 100).toFixed(0)}% · intensity ${d.intensity.toFixed(2)}${d.chasing ? ' · HUNT ON' : ''}`,
          `skunk: ${this.sim.sf.state} · invincible ${this.sim.dev?.invincible ? 'on' : 'off'} · F6 hunt · F7 appear · F8 teleport · F9 invincible`,
        ].join('<br>'));
      } else this.ui.devOverlay(null);
      if (this.ui.debugOn) {
        const hs = this.hvBuf.latest(), ss = this.sfBuf.latest(), r = this.renderer.gl.info.render;
        this.ui.debug([
          `${this.fps.toFixed(0)} fps · ${this.frameMs.toFixed(1)} ms · scale ${this.renderer.dynScale.toFixed(2)} · calls ${r.calls} · tris ${(r.triangles / 1e6).toFixed(2)}M`,
          `pos ${pl.pos.x.toFixed(1)}, ${pl.pos.z.toFixed(1)} · trail ${this.world.trailAlongAt(pl.pos.x, pl.pos.z).toFixed(0)} m · surf ${pl.surface} · brush ${pl.inBrush.toFixed(2)}${pl.hidden ? ' · HIDDEN' : ''}`,
          `HV ${hs ? HV_STATES[hs[10]] : '-'} ${this.hvDist < 1e8 ? this.hvDist.toFixed(0) + ' m' : ''} · SF6 ${ss ? SF_STATES[ss[8]] : '-'} · phase ${this.phase || '-'}`,
          `terror ${this.terror.toFixed(2)} · fear ${this.fear.toFixed(2)} · ${this.temp?.toFixed(1)}°C · gas ${this.gasFx.toFixed(2)} · voice ${this.voice.voiceLevel.toFixed(2)} · phrases ${this.voice.phrases.length}`,
        ].join('<br>'));
      }
    }
  }

  _fade(dt) {
    if (this.sessionT < 0.2) this.fade = 1;
    this.fade = lerp(this.fade, this.fadeTarget ?? 0, 1 - Math.exp(-dt * (this.ended ? 0.8 : 0.9)));
  }

  // ---------------------------------------------------------------- render
  _render(dt) {
    const env = this.env, fl = this.flashlight, ml = env.moonLight;
    const gas = this._gasU || [];
    const bright = this.settings.brightness || 1;
    this.renderer.exposure = (this.mode === 'playing' || this.mode === 'ended' ? this.exposure : 1) * bright;
    this.renderer.render(this.scene, this.camera, (u) => {
      u.tFrost.value = this.bank.tex.frost;
      const sm = ml.shadow && ml.shadow.map;
      u.tMoonShadow.value = sm ? sm.depthTexture : null;
      u.uShadowOn.value = sm && sm.depthTexture ? 1 : 0;
      if (sm) u.uShadowMatrix.value.copy(ml.shadow.matrix);
      u.uFlashPos.value.copy(fl.light.position);
      u.uFlashDir.value.copy(fl.dir);
      u.uFlashCos.value.set(Math.cos(fl.light.angle), Math.cos(fl.light.angle * (1 - fl.light.penumbra)));
      u.uFlashI.value = 0;   // no beam in the haze: it's a lighter
      u.uFlashRange.value = fl.light.distance;
      const playing = this.mode === 'playing' || this.mode === 'ended';
      u.uExposure.value = (playing ? this.exposure : 1) * bright;
      u.uTerrorFx.value = 0; u.uCold.value = this.cold; u.uFear.value = 0;
      u.uHeart.value = 0;
      u.uDamage.value = this.damage; u.uDowned.value = playing ? this.player.downed : 0;
      u.uGasFx.value = this.gasFx;
      u.uFade.value = playing ? clamp(this.fade, 0, 1) : 0;
      u.uGrain.value = this.settings.filmGrain;
      u.uAberration.value = this.critical * 0.9 * this.settings.cameraShake + this.damage * 0.5;
      u.uAnomaly.value = this.critical * this.settings.cameraShake;
      u.uGasCount.value = Math.min(4, gas.length);
      for (let i = 0; i < 4; i++) {
        const g = gas[i];
        if (g) u.uGas.value[i].set(g[0], g[1] + 0.6, g[2], g[3] * (0.55 + 0.45 * g[4]));
        else u.uGas.value[i].set(0, -999, 0, 0);
      }
    });
  }

  _perf(ms, dt) {
    this.fpsAcc += dt; this.fpsN++;
    this.frameMs = lerp(this.frameMs, ms, 0.05);
    if (this.fpsAcc >= 1) {
      this.fps = this.fpsN / this.fpsAcc; this.fpsAcc = 0; this.fpsN = 0;
      if (this.settings.showFps && !this.ui.debugOn) this.ui.debug(`${this.fps.toFixed(0)} fps`);
      if (this.settings.adaptiveRes && !this.opts.manual && this.mode === 'playing') {
        const r = this.renderer;
        let s = r.dynScale;
        if (this.fps < 40) s = Math.max(0.55, s - 0.1); else if (this.fps > 57 && s < 1) s = Math.min(1, s + 0.05);
        if (Math.abs(s - r.dynScale) > 0.01) { r.dynScale = s; r.resize(); }
      }
    }
  }

  // ---------------------------------------------------------------- test helpers
  teleport(along, side = 0, faceAlong = true) {
    const w = this.world, p = pointAtDistance(w.trail, w.trailCum, along);
    const x = p.x + Math.cos(p.dir) * side, z = p.z - Math.sin(p.dir) * side;
    this.player.spawn(x, z, faceAlong ? Math.atan2(-Math.sin(p.dir), -Math.cos(p.dir)) : this.player.yaw);
    this.flashlight.snap(this.camera);
  }
  look(yaw, pitch) { this.player.yaw = yaw; this.player.pitch = pitch; this.player._camera(0, 0); this.flashlight.snap(this.camera); }
  // place the player at x,z facing a point (also moves the in-browser sim's copy, which rejects >12 m jumps)
  tp(x, z, lookX, lookZ, pitch = -0.1) {
    const yaw = lookX === undefined ? this.player.yaw : Math.atan2(-(lookX - x), -(lookZ - z));
    this.player.spawn(x, z, yaw); this.player.pitch = pitch; this.player._camera(0, 0); this.flashlight.snap(this.camera);
    const sp = this.sim && this.sim.players.get(this.myId);
    if (sp) { sp.x = x; sp.z = z; sp.y = this.player.pos.y; sp.lastX = x; sp.lastZ = z; }
  }
  get sim() { return this.net && this.net.sim; }
}
