// HELIUM MOON - authoritative game simulation. Runs on the Node server for
// multiplayer, or inside the browser for single player / a room host. Clients
// own their own movement (co-op trust model); the sim owns monsters, objectives,
// health, revives, gas, mimicry and the outcome.
import { CONFIG } from '../config.js';
import { clamp, makeRng, pointAtDistance } from '../math.js';
import { groundAt } from '../physics.js';
import {tracePebble} from '../pebble.js';
import {eyePosition} from './perception.js';
import { HeliumVoiceAI } from './heliumVoice.js';
import { SkunkAI } from './skunk.js';
import { Director } from './director.js';
import { Objectives } from './objectives.js';
import { MimicDirector } from './mimic.js';
import { Wildlife } from './wildlife.js';
import { Balloons } from './balloons.js';
import { Ambient } from './ambient.js';
import { NightStats } from './stats.js';

const PSTATE = ['alive', 'downed', 'dead', 'escaped'];

export class GameSim {
  constructor(world, { seed = (Math.random() * 2 ** 31) | 0, log = () => {}, difficulty = 'ranger' } = {}) {
    this.world = world; this.seed = seed; this.log = log;
    // Update 0.9: the host's difficulty. 'ranger' is the owner's tuned default.
    const diff = CONFIG.DIFFICULTY[difficulty] ? difficulty : 'ranger';
    this.rules = { id: diff, ...CONFIG.DIFFICULTY[diff] };
    this.rng = makeRng(seed);
    this.time = 0; this.state = 'intro';
    this.players = new Map(); this.playerList = [];
    this.events = []; this.evSeq = 1;
    this.gas = [];
    this.pebbles=[];this.pebbleSeq=1;
    this.lures = []; this.lureSeq = 1;   // lit cigarettes left on the ground
    this.director = new Director(this);
    this.obj = new Objectives(this); this.obj.setup();
    this.hv = new HeliumVoiceAI(this); this.hv.spawn();
    this.sf = new SkunkAI(this); this.sf.spawn();
    this.mimic = new MimicDirector(this);
    this.wildlife = new Wildlife(this);
    this.balloons = new Balloons(this);
    this.ambient = new Ambient(this);
    this.stats = new NightStats(this);
    this.radio = { step: 0, at: 0 };
    this.dev = null;   // Developer mode options (shared/sim/dev.js), set by a local client
    this.result = null;
  }

  // ---------------------------------------------------------------- players
  spawnPoint(i) {
    const w = this.world;
    const kiosk = w.structures.find((structure) => structure.type === 'kiosk');
    if (kiosk) {
      // Gather beside the trailhead memo, with a clear route into the refuge.
      // Keep the kiosk off the walking line rather than placing it in front of W.
      const ahead = pointAtDistance(w.trail, w.trailCum, 20);
      const c = Math.cos(kiosk.rot), s = Math.sin(kiosk.rot);
      const startX = kiosk.x + 1.2 * c + 5.4 * s;
      const startZ = kiosk.z - 1.2 * s + 5.4 * c;
      const distance = Math.hypot(ahead.x - startX, ahead.z - startZ);
      const fx = (ahead.x - startX) / distance, fz = (ahead.z - startZ) / distance;
      const row = Math.floor(i / 2) * 1.6, column = (i % 2) * 1.4;
      const x = startX + fx * row - fz * column;
      const z = startZ + fz * row + fx * column;
      return { x, z, y: groundAt(w, x, z), yaw: Math.atan2(x - ahead.x, z - ahead.z) };
    }
    const p = pointAtDistance(w.trail, w.trailCum, 3 + i * 1.6);
    const left = p.dir - Math.PI / 2;
    const off = (i % 2 ? 1 : -1) * 0.9;
    const x = p.x + Math.sin(left) * off, z = p.z + Math.cos(left) * off;
    return { x, z, y: groundAt(w, x, z), yaw: Math.atan2(-Math.sin(p.dir), -Math.cos(p.dir)) };
  }

  addPlayer(id, name) {
    const sp = this.spawnPoint(this.players.size);
    const p = {
      id, name: String(name || 'Visitor').slice(0, 20), ...sp, pitch: 0, crouch: false, sprint: false, flash: true,
      noise: 0, voice: 0, use: null, revive: null, hidden: false, covered: false, breath: false, health: this.rules.health, state: 'alive',
      bleedT: 0, reviveT: 0, hurtT: -999, quietT: 0, moveDir: null, lastX: sp.x, lastZ: sp.z, escapeT: 0, interactNoise: false,
      pebbleReadyAt:0,paused:false,
      cigs: 0, beers: 0, bottles: 0, smoked: 0, smokeUntil: -1, buzzUntil: -1,
    };
    this.players.set(id, p);
    this.playerList = [...this.players.values()];
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.playerList = [...this.players.values()];
    this.mimic.clear(id);
    if (this.hv.target === id) this.hv.target = null;
    this.checkOutcome();
  }

  // client-reported state (movement is client-owned; clamp obvious nonsense)
  input(id, m) {
    const p = this.players.get(id);
    if (!p || (p.state !== 'alive' && p.state !== 'downed')) return;
    // held in his grab: the client's movement is ignored until he lets go
    const held = p.heldUntil != null && this.time < p.heldUntil;
    if (p.state === 'alive' && !held && Number.isFinite(m.x) && Number.isFinite(m.z)) {
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d < 12) { p.x = m.x; p.z = m.z; p.y = Number.isFinite(m.y) ? m.y : p.y; }
    }
    if (Number.isFinite(m.yaw)) p.yaw = m.yaw;
    if (Number.isFinite(m.pitch)) p.pitch = m.pitch;
    if (Number.isFinite(m.viewFov)) p.viewFov = clamp(m.viewFov, 40, 120);
    if (Number.isFinite(m.viewAspect)) p.viewAspect = clamp(m.viewAspect, 0.3, 5);
    p.crouch = !!m.crouch; p.sprint = !!m.sprint; p.flash = !!m.flash;
    p.lean = !held && p.state==='alive' && Number.isFinite(m.lean) ? clamp(m.lean,-1,1) : 0;
    p.noise = Math.min(1, Math.max(0, +m.noise || 0));
    p.voice = Math.min(1, Math.max(0, +m.voice || 0));
    p.hidden = !!m.hidden; p.covered = !!m.covered && this.obj.items.some((it) => it.kind === 'blanket' && it.holder === p.id);
    p.paused=!!m.paused;
    p.breath = !!m.breath && p.crouch && p.state === 'alive';   // holding their breath (client-owned lungs)
    if(p.covered)p.lean=0;
    p.use = typeof m.use === 'string' ? m.use : null;
    p.revive = m.revive != null ? m.revive : null;
  }

  action(id, a) {
    const p = this.players.get(id);
    if (!p) return;
    if(a.a==='pebble')this.throwPebble(p,a);
    else if (a.a === 'pickup' && p.state === 'alive') this.obj.pickup(p, a.id);
    else if (a.a === 'dial') this.obj.turn(p,a.id);
    else if (a.a === 'untie') this.balloons.untie(p, a.id);
    else if (a.a === 'ping') this.ping(p, a);
    else if (a.a === 'smoke') this.smoke(p, !!a.drop);
    else if (a.a === 'drink') this.drink(p);
    else if (a.a === 'phrase') this.mimic.addPhrase(id, a.id, +a.dur);
    else if (a.a === 'phrase_drop') this.mimic.dropPhrase(id, a.id);
    else if (a.a === 'mimic_off') this.mimic.clear(id);
  }

  nearestPlayer(x, z) {
    let best = null, bd = 1e9;
    for (const p of this.playerList) { if (p.state !== 'alive' && p.state !== 'downed') continue; const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = p; } }
    return best ? { p: best, d: bd } : null;
  }

  // co-op ping: a mark on the ground for the team (validated: near the player, rate-limited)
  ping(p, a) {
    const G = CONFIG.PING;
    if (p.state !== 'alive' && p.state !== 'downed') return false;
    if (![a.x, a.y, a.z].every(Number.isFinite) || this.time < (p.pingAt || 0)) return false;
    if (Math.hypot(a.x - p.x, a.z - p.z) > G.RANGE || Math.abs(a.y - p.y) > 25) return false;
    p.pingAt = this.time + G.COOLDOWN;
    this.emit({ type: 'ping', pid: p.id, x: +a.x.toFixed(2), y: +a.y.toFixed(2), z: +a.z.toFixed(2) });
    return true;
  }

  // ---- cigarettes and beer (CONFIG.VICE)
  viceState(p) { this.emit({ type: 'vice', pid: p.id, cigs: p.cigs, beers: p.beers, bottles: p.bottles, smoked: p.smoked, smoke: +p.smokeUntil.toFixed(1), buzz: +p.buzzUntil.toFixed(1) }); }
  viceOk(p) { return p.state === 'alive' && ['play', 'extract'].includes(this.state) && !p.covered && this.hv.grab?.pid !== p.id && !((p.heldUntil ?? -1) > this.time); }
  smoke(p, drop) {
    const V = CONFIG.VICE;
    if (!this.viceOk(p) || p.cigs <= 0 || !p.flash) return false;   // it takes a flame
    if (drop) {
      if (this.lures.length >= V.MAX_LURES) return false;
      p.cigs--;
      const l = { id: 'cg' + this.lureSeq++, pid: p.id, x: p.x, y: this.world.heightAt(p.x, p.z), z: p.z, until: this.time + V.LURE_TIME, smelt: false };
      this.lures.push(l);
      this.emit({ type: 'cig_drop', id: l.id, pid: p.id, x: +l.x.toFixed(2), y: +l.y.toFixed(2), z: +l.z.toFixed(2), dur: V.LURE_TIME });
    } else {
      if (p.smokeUntil > this.time) return false;
      p.cigs--; p.smoked++; p.smokeUntil = this.time + V.SMOKE_TIME;
      this.emit({ type: 'smoke', pid: p.id, dur: V.SMOKE_TIME });
    }
    this.viceState(p); return true;
  }
  drink(p) {
    if (!this.viceOk(p) || p.beers <= 0) return false;
    p.beers--; p.bottles++; p.buzzUntil = this.time + CONFIG.VICE.BUZZ_TIME;
    this.emit({ type: 'drink', pid: p.id, dur: CONFIG.VICE.BUZZ_TIME });
    this.viceState(p); return true;
  }
  updateLures() {
    const V = CONFIG.VICE;
    for (let i = this.lures.length - 1; i >= 0; i--) {
      const l = this.lures[i];
      if (this.time >= l.until) { this.lures.splice(i, 1); this.emit({ type: 'cig_out', id: l.id }); continue; }
      // he only follows it while he is searching, exactly like a pebble; once per cigarette
      if (!l.smelt && this.hv.hearLure(l, V.LURE_RANGE, Math.min(V.LURE_HOLD, l.until - this.time))) { l.smelt = true; this.emit({ type: 'lure', pid: l.pid, what: 'cig' }); }
    }
  }

  throwPebble(p,aim){
    let reason=null;
    if(p.state!=='alive'||!['play','extract'].includes(this.state))reason='unavailable';
    else if(p.paused||this.paused)reason='paused';
    else if((p.heldUntil!=null&&this.time<p.heldUntil)||this.hv.grab?.pid===p.id)reason='held';
    else if(p.covered)reason='covered';
    else if(!(p.bottles>0)&&this.time<(p.pebbleReadyAt||0))reason='cooldown';
    else if(!this.hv.canHearPebble())reason='search';
    else if(!Number.isFinite(aim.yaw)||!Number.isFinite(aim.pitch))reason='aim';
    else if(this.pebbles.length>=CONFIG.PEBBLE.MAX_ACTIVE)reason='busy';
    if(reason){this.emit({type:'pebble_status',pid:p.id,reason,readyAt:p.pebbleReadyAt||0});return false;}
    const arc=tracePebble(this.world,eyePosition(this.world,p),aim.yaw,aim.pitch);
    if(!arc){this.emit({type:'pebble_status',pid:p.id,reason:'aim',readyAt:p.pebbleReadyAt||0});return false;}
    const bottle=p.bottles>0;   // an empty bottle goes before a pebble, and needs no searching for
    if(bottle){p.bottles--;this.viceState(p);}else p.pebbleReadyAt=this.time+CONFIG.PEBBLE.COOLDOWN;
    const pebble={id:'pb'+this.pebbleSeq++,pid:p.id,startedAt:this.time,readyAt:p.pebbleReadyAt,bottle,...arc};
    this.pebbles.push(pebble);
    this.emit({type:'pebble_throw',id:pebble.id,pid:p.id,bottle,flight:arc.flight,duration:arc.duration,
      startedAt:this.time,readyAt:p.pebbleReadyAt});
    return true;
  }

  updatePebbles(){
    const pending=[];
    for(const pebble of this.pebbles){
      if(this.time<pebble.startedAt+pebble.duration){pending.push(pebble);continue;}
      if(!pebble.hit)continue;
      const at=pebble.impact,distracted=pebble.bottle?this.hv.hearLure(at,CONFIG.VICE.BOTTLE_RANGE,CONFIG.VICE.BOTTLE_HOLD):this.hv.hearPebble(at);
      this.balloons.pebble(at, pebble.pid);
      this.emit({type:'pebble_impact',id:pebble.id,pid:pebble.pid,...at,kind:pebble.kind,distracted,bottle:!!pebble.bottle});
    }
    this.pebbles=pending;
  }

  // Event ordering is separate from item/station IDs consumed by the client.
  emit(ev) { ev.seq = this.evSeq++; ev.t = +this.time.toFixed(2); this.events.push(ev); this.stats?.onEvent(ev); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  addGas(x, y, z) {
    this.gas.push({ x, y, z, r: CONFIG.SF.GAS_RADIUS, life: CONFIG.SF.GAS_LIFE, age: 0 });
    if (this.gas.length > 4) this.gas.shift();
    this.emit({ type: 'gas', x, y, z });
  }

  damagePlayer(p, by, src) {
    if (p.state !== 'alive') return;
    if (this.dev?.invincible) { this.emit({ type: 'hit', pid: p.id, by, x: src.x, z: src.z, health: p.health, dev: true }); return; }   // Developer mode: feel the hit, take no damage
    p.health -= 1; p.hurtT = this.time;
    const solo = this.playerList.length <= 1;
    if (p.health <= 0) {
      p.health = 0;
      p.state = solo ? 'dead' : 'downed';
      p.bleedT = CONFIG.SESSION.DOWNED_BLEEDOUT;
      this.emit({ type: solo ? 'dead' : 'downed', pid: p.id, by, x: src.x, z: src.z });
    } else this.emit({ type: 'hit', pid: p.id, by, x: src.x, z: src.z, health: p.health });
    this.checkOutcome();
  }

  // ---------------------------------------------------------------- tick
  step(dt) {
    if (this.state === 'won' || this.state === 'lost') return;
    this.time += dt;
    if (this.state === 'intro' && this.time > CONFIG.SESSION.INTRO_TIME) {
      this.state = 'play';
      this.hv.setState('roam'); this.sf.setState('lurk', { lurkFor: 30 });
      this.emit({ type: 'begin' });
    }
    for (const p of this.playerList) {
      p.interactNoise = false;
      const mdx = p.x - p.lastX, mdz = p.z - p.lastZ, md = Math.hypot(mdx, mdz);
      if (md > 0.05) p.moveDir = [mdx / md, mdz / md];
      // smoothed walking speed (teleports and respawns are ignored)
      if (md < 1) p.moveSpeed = (p.moveSpeed || 0) + (md / dt - (p.moveSpeed || 0)) * Math.min(1, dt * 1.5);
      p.lastX = p.x; p.lastZ = p.z;
      p.quietT = p.voice > CONFIG.VOICE.NOISE_THRESHOLD ? 0 : (p.quietT || 0) + dt;
      const heal = CONFIG.PLAYER.HEAL_AFTER; if (heal && p.state === 'alive' && p.health < CONFIG.PLAYER.MAX_HEALTH && this.time - p.hurtT > heal) p.health = CONFIG.PLAYER.MAX_HEALTH;
    }
    this.obj.update(dt);
    this.updateRevives(dt);
    this.updatePebbles();
    if (this.state !== 'intro') {
      this.director.update(dt);
      this.hv.update(dt);
      this.sf.update(dt);
      this.mimic.update(dt);
      this.wildlife.update(dt);
      this.balloons.update(dt);
      this.updateLures();
      this.ambient.update(dt);
      this.stats.update(dt);
      this.updateRadio();
    }
    for (const g of this.gas) { g.age += dt; }
    this.gas = this.gas.filter((g) => g.age < g.life);
    if (this.state === 'extract') this.updateExtraction(dt);
  }

  updateRevives(dt) {
    for (const p of this.playerList) {
      if (p.state !== 'downed') continue;
      let reviver = null;
      for (const q of this.playerList) if (q.state === 'alive' && q.revive === p.id && Math.hypot(q.x - p.x, q.z - p.z) < 2.4) reviver = q;
      if (reviver) {
        p.reviveT += dt;
        if (p.reviveT >= CONFIG.SESSION.REVIVE_TIME) {
          p.state = 'alive'; p.health = 1; p.reviveT = 0; p.hurtT = this.time;
          this.emit({ type: 'revived', pid: p.id, by: reviver.id });
        }
      } else {
        p.reviveT = Math.max(0, p.reviveT - dt);
        p.bleedT -= dt;
        if (p.bleedT <= 0) { p.state = 'dead'; this.emit({ type: 'dead', pid: p.id }); this.checkOutcome(); }
      }
    }
  }

  // The handheld from the mast cabinet: the county unit talks you in (subtitle beats; the
  // client owns the words). Timed from the distress call, then by distance to the bridge.
  updateRadio() {
    if (this.state !== 'extract') return;
    const r = this.radio, ex = this.obj.extract;
    if (r.step === 0) { r.step = 1; r.at = this.time; this.emit({ type: 'radio', id: 'call' }); return; }
    const alive = this.playerList.filter((p) => p.state === 'alive');
    if (!alive.length) return;
    const near = Math.min(...alive.map((p) => Math.hypot(p.x - ex.x, p.z - ex.z)));
    if (r.step === 1 && this.time - r.at > 55) { r.step = 2; r.at = this.time; this.emit({ type: 'radio', id: 'bridge' }); }
    else if (r.step === 2 && near < 150 && this.time - r.at > 12) { r.step = 3; r.at = this.time; this.emit({ type: 'radio', id: alive.some((p) => p.flash) ? 'see_light' : 'no_light' }); }
    else if (r.step === 3 && near < 45 && this.time - r.at > 8) { r.step = 4; this.emit({ type: 'radio', id: 'close' }); }
  }

  updateExtraction(dt) {
    const ex = this.obj.extract;
    const alive = this.playerList.filter((p) => p.state === 'alive');
    let inside = 0;
    for (const p of alive) {
      if (Math.hypot(p.x - ex.x, p.z - ex.z) < ex.r) { p.escapeT += dt; inside++; } else p.escapeT = 0;
    }
    if (!alive.length) return;
    const all = inside === alive.length;
    const longest = Math.max(...alive.map((p) => p.escapeT));
    if ((all && longest > 2.5) || longest > 25) {
      for (const p of alive) if (p.escapeT > 0) p.state = 'escaped';
      this.finish('won');
    }
  }

  checkOutcome() {
    if (this.state === 'won' || this.state === 'lost' || !this.playerList.length) return;
    const standing = this.playerList.filter((p) => p.state === 'alive');
    if (!standing.length) this.finish('lost');
  }

  finish(result) {
    this.state = result;
    this.result = {
      result, time: Math.round(this.time),
      objectives: this.obj.doneCount(), objectivesTotal: this.obj.stations.length, notes: this.obj.notesRead.length,
      difficulty: this.rules.id, stats: this.stats.summary(),
      players: this.playerList.map((p) => ({ id: p.id, name: p.name, state: p.state })),
    };
    this.emit({ type: 'end', ...this.result });
  }

  snapshot() {
    return {
      t: +this.time.toFixed(2), st: this.state,
      pl: this.playerList.map((p) => [p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.yaw.toFixed(3), +p.pitch.toFixed(3),
        (p.crouch ? 1 : 0) | (p.flash ? 2 : 0) | (p.sprint ? 4 : 0) | (p.hidden ? 8 : 0) | (p.voice > CONFIG.VOICE.NOISE_THRESHOLD ? 16 : 0),
        p.health, PSTATE.indexOf(p.state), +(p.reviveT / CONFIG.SESSION.REVIVE_TIME).toFixed(2), +Math.max(0, p.bleedT).toFixed(1),
        +(p.state === 'alive' && !p.covered ? (p.lean || 0) : 0).toFixed(3),+(p.pebbleReadyAt||0).toFixed(2)]),
      hv: this.hv.snapshot(), sf: this.sf.snapshot(),
      gas: this.gas.map((g) => [+g.x.toFixed(1), +g.y.toFixed(1), +g.z.toFixed(1), g.r, +(1 - g.age / g.life).toFixed(2)]),
      pebbles:this.pebbles.map(p=>({id:p.id,pid:p.pid,flight:p.flight,duration:p.duration,startedAt:p.startedAt,readyAt:p.readyAt})),
      obj: this.obj.snapshot(), ph: this.director.phase, bl: this.balloons.snapshot(),
    };
  }

  info() {
    return { seed: this.seed, rules: this.rules, layout: this.obj.layout(), players: this.playerList.map((p) => ({ id: p.id, name: p.name })) };
  }
}

export { PSTATE };
