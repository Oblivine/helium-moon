// Audio engine: Web Audio graph, HRTF-positional emitters with occlusion and a
// forest reverb, natural night ambience, subdued player physiology, footsteps
// and creature vocals. Breathing, night crickets and foliage wind
// use recordings; other effects are synthesized at load. Cold is the proximity cue.
import * as S from './synth.js';
import { NIGHT_CRICKETS_FILE, TREE_LEAVES_FILE, nearbyCanopies } from './nightAmbience.js';
import { PLAYER_BREATH_FILE, recordedBreathPhrase } from './playerBreath.js';
import { impulse, rngFor } from './dsp.js';
import { assetUrl } from '../render/textures.js';
import { clamp, lerp, smoothstep } from '../../shared/math.js';
import { horrorCues, distanceGain, creatureFootstepCue, teammateFootstepCue, skunkVocalCue } from '../../shared/horror.js';
import { SURFACE } from '../../shared/world.js';
import { CONFIG } from '../../shared/config.js';
import { groundAt } from '../../shared/physics.js';

const SURF_NAME = { [SURFACE.LITTER]: 'litter', [SURFACE.DIRT]: 'dirt', [SURFACE.MUD]: 'mud', [SURFACE.GRASS]: 'grass', [SURFACE.SILT]: 'silt', [SURFACE.WATER]: 'water', [SURFACE.GRAVEL]: 'gravel', [SURFACE.WOOD]: 'wood', [SURFACE.ASPHALT]: 'asphalt' };
// Keep Helium Voice nonverbal.  The server only requests these three sounds, and
// limiting the client here prevents an old event or cached replay from restoring dialogue.
const HV_KINDS = ['breath', 'inhale', 'hum'];
const SF_KINDS = ['rumble', 'chitter', 'breath', 'rustle', 'growl', 'warn', 'gas', 'bite'];
const yieldUI = () => new Promise((r) => setTimeout(r, 0));

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ready = false; this.lib = {}; this.var = {};
    this.world = null; this.listener = { x: 0, y: 0, z: 0, fx: 0, fz: -1 };
    this.treeEmitters = new Map(); this.treeRefreshAt = 0;
    this.breathT = 0; this.breathIn = true; this.heartT = 0; this.onExhale = null;
    this.state = { terror: 0, fear: 0, cold: 0, exert: 0, gas: 0, downed: 0, inGame: false, critical: 0 };
    this.loops = {};
    this.active = new Set();
  }

  // ---------------------------------------------------------------- setup
  async init(world, progress = () => {}) {
    this.world = world;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { console.warn('Web Audio unavailable'); return; }
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.master = g(); this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.ratio.value = 4; this.comp.attack.value = 0.005; this.comp.release.value = 0.25;
    this.master.connect(this.comp); this.comp.connect(ctx.destination);
    this.hear = ctx.createBiquadFilter(); this.hear.type = 'lowpass'; this.hear.frequency.value = 20000; this.hear.Q.value = 0.5;
    this.hear.connect(this.master);
    this.bus = { amb: g(), sfx: g(), mon: g(), voice: g(), ui: g() };
    this.bus.amb.connect(this.hear); this.bus.sfx.connect(this.hear); this.bus.mon.connect(this.hear); this.bus.voice.connect(this.hear);
    this.bus.ui.connect(this.master);
    this.reverb = ctx.createConvolver();
    const [L, R] = impulse(ctx.sampleRate, 2.6, 2.4, rngFor(77), 3800);
    this.reverb.buffer = this.toBuffer([L, R], ctx.sampleRate);
    this.revIn = g(0.9); this.revIn.connect(this.reverb); this.reverb.connect(this.hear);
    this.applyVolumes();
    this.settings.onChange(() => this.applyVolumes());
    // ---- synthesis (yielding so the loading bar keeps moving)
    const jobs = [];
    const add = (key, fn) => jobs.push([key, fn]);
    add('wind', () => S.wind(13)); add('river', () => S.river(14)); add('traffic', () => S.traffic(15));
    for (const k of ['litter', 'dirt', 'mud', 'grass', 'silt', 'water', 'gravel', 'wood', 'asphalt', 'brush']) for (let i = 0; i < 4; i++) add(`fs_${k}${i}`, () => S.footstep(k, 100 + i * 7 + k.length));
    add('heart', () => S.heartbeat()); add('clickOn', () => S.click(1, true)); add('clickOff', () => S.click(2, false)); add('paper', () => S.paper(3)); add('clink', () => S.clink(4));
    for (const k of ['gen', 'relay', 'mast']) add('work_' + k, () => S.work(k, 5));
    add('genLoop', () => S.generatorLoop(6)); add('hum', () => S.humLoop()); add('siren', () => S.sirenLoop()); add('radio', () => S.radioCall(7));
    for (const k of ['reveal', 'snap', 'chase']) add('st_' + k, () => S.stinger(k, 8));
    add('hurt', () => S.hurt(9, false)); add('down', () => S.hurt(10, true));
    // real-animal false alarms (wildlife.js)
    for (let i = 0; i < 3; i++) add('swing' + i, () => S.swing(70 + i));
    // Update 0.9: balloons, the world beyond the trees, ping, radio, held breath
    for (let i = 0; i < 2; i++) { add('balloonPop' + i, () => S.balloonPop(400 + i)); add('farmDog' + i, () => S.farmDog(410 + i)); add('branchFall' + i, () => S.branchFall(420 + i)); }
    add('balloonSqueak', () => S.balloonSqueak(430)); add('train', () => S.distantTrain(431)); add('carAlarm', () => S.carAlarmLoop());
    add('pingTick', () => S.pingTick(432)); add('radioBlip', () => S.radioBlip(433)); add('gasp', () => S.gasp(434));
    add('lighterOn', () => S.lighterStrike(280, true)); add('lighterSpark', () => S.lighterStrike(281, false)); add('lighterOff', () => S.lighterRelease(282));
    // the Puppet: joints, crawl, knuckles, the collapse and the grab
    for (let i = 0; i < 4; i++) { add('pop' + i, () => S.jointPop(200 + i)); add('crawl' + i, () => S.crawlPatter(210 + i)); }
    for (let i = 0; i < 4; i++) add('searchCrack' + i, () => S.searchJointCrack(240 + i));
    for (let i = 0; i < 3; i++) add('pebble' + i, () => S.pebbleImpact(300 + i));
    for (let i = 0; i < 3; i++) { add('knuckle' + i, () => S.knuckleWood(220 + i)); }
    for (let i = 0; i < 2; i++) { add('bodyDrop' + i, () => S.bodyDrop(250 + i)); add('cloth' + i, () => S.clothGrab(260 + i)); add('choke' + i, () => S.choke(270 + i)); }
    for (let i = 0; i < 3; i++) { add('deerBlow' + i, () => S.deerBlow(40 + i)); add('owlHoot' + i, () => S.owl(50 + i)); add('wings' + i, () => S.wingFlap(60 + i)); }
    let t0 = performance.now();
    for (let i = 0; i < jobs.length; i++) {
      const [k, fn] = jobs[i];
      this.lib[k] = this.toBuffer(fn());
      if (performance.now() - t0 > 40) { progress(i / jobs.length); await yieldUI(); t0 = performance.now(); }
    }
    await this.loadPlayerBreathing();
    for (const [key,file] of [['crickets',NIGHT_CRICKETS_FILE],['treeLeaves',TREE_LEAVES_FILE]]) {
      const response=await fetch(assetUrl(file));
      if(!response.ok)throw new Error(`Night ambience recording is missing: ${file}`);
      this.lib[key]=await this.ctx.decodeAudioData(await response.arrayBuffer());
    }
    this.ready = true;
    this._buildLoops();
  }

  async loadPlayerBreathing() {
    const response = await fetch(assetUrl(PLAYER_BREATH_FILE));
    if (!response.ok) throw new Error('Player breathing recording is missing');
    const recording = await this.ctx.decodeAudioData(await response.arrayBuffer());
    const pcm = recording.getChannelData(0);
    for (let i = 0; i < S.PLAYER_BREATH_VARIANTS; i++) for (let half = 0; half < 2; half++) {
      const clip = this.toBuffer(recordedBreathPhrase(pcm, recording.sampleRate, i * 2 + half), recording.sampleRate);
      const phase = half ? 'out' : 'in';
      this.lib[phase + i] = clip;
      this.lib[phase + 'H' + i] = clip;
    }
    this.playerBreathSource = 'recorded';
  }

  toBuffer(data, sr = S.SR) {
    const chans = Array.isArray(data) ? data : [data];
    const b = this.ctx.createBuffer(chans.length, chans[0].length, sr);
    chans.forEach((c, i) => b.copyToChannel ? b.copyToChannel(c, i) : b.getChannelData(i).set(c));
    return b;
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.settings, t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.masterVolume, t, 0.05);
    this.bus.amb.gain.setTargetAtTime(s.ambienceVolume, t, 0.05);
    this.bus.sfx.gain.setTargetAtTime(s.sfxVolume, t, 0.05);
    this.bus.mon.gain.setTargetAtTime(s.sfxVolume * 1.1, t, 0.05);
    this.bus.voice.gain.setTargetAtTime(s.voiceVolume, t, 0.05);
    this.bus.ui.gain.setTargetAtTime(s.sfxVolume * 0.8, t, 0.05);
  }

  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }

  // ---------------------------------------------------------------- emitters
  // A positional chain: input -> occlusion lowpass -> gain -> HRTF panner -> bus (+ reverb send)
  emitter({ bus = 'sfx', ref = 4, rolloff = 1.15, max = 400, reverb = 0.25, gain = 1 } = {}) {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 18000; lp.Q.value = 0.6;
    const out = ctx.createGain(); out.gain.value = gain;
    const pan = ctx.createPanner();
    pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = ref; pan.rolloffFactor = rolloff; pan.maxDistance = max;
    input.connect(lp); lp.connect(out); out.connect(pan); pan.connect(this.bus[bus]);
    const send = ctx.createGain(); send.gain.value = reverb; pan.connect(send); send.connect(this.revIn);
    const e = {
      input, lp, out, pan, send, x: 0, y: 0, z: 0, baseRev: reverb,
      setPos: (x, y, z, smooth = 0) => {
        e.x = x; e.y = y; e.z = z;
        if (pan.positionX) {
          const t = ctx.currentTime;
          if (smooth) { pan.positionX.setTargetAtTime(x, t, smooth); pan.positionY.setTargetAtTime(y, t, smooth); pan.positionZ.setTargetAtTime(z, t, smooth); } else { pan.positionX.value = x; pan.positionY.value = y; pan.positionZ.value = z; }
        } else pan.setPosition(x, y, z);
      },
      occlude: (vis, smooth = 0.08) => {
        const t = ctx.currentTime, d = Math.hypot(e.x - this.listener.x, e.z - this.listener.z);
        const f = lerp(650, 18000, vis * vis) * lerp(1, 0.35, clamp(d / 250, 0, 1));
        lp.frequency.setTargetAtTime(f, t, smooth);
        send.gain.setTargetAtTime(e.baseRev * (0.6 + clamp(d / 60, 0, 1.6)) * (1.3 - vis * 0.3), t, smooth);
      },
      dispose: () => { try { input.disconnect(); lp.disconnect(); out.disconnect(); pan.disconnect(); send.disconnect(); } catch (er) { /* ignore */ } },
    };
    return e;
  }

  visibility(x, y, z) {
    const l = this.listener;
    if (!this.world) return 1;
    const v = this.world.lineOfSight(l.x, l.y, l.z, x, y, z, { brushK: 0.3 });
    return 0.3 + 0.7 * v;
  }

  // play a buffer; pos = {x,y,z} for positional, otherwise stereo/mono direct
  play(buf, o = {}) {
    if (!this.ready || !buf || !this.ctx) return null;
    const ctx = this.ctx;
    const rangeGain = o.pos && o.range ? distanceGain(Math.hypot(o.pos.x - this.listener.x, o.pos.y - this.listener.y, o.pos.z - this.listener.z), o.range) : 1;
    if (rangeGain === 0) return null;
    const src = ctx.createBufferSource(); src.buffer = buf;
    src.playbackRate.value = o.rate || 1; src.loop = !!o.loop;
    let h;
    if (o.pos) {
      const e = this.emitter({ bus: o.bus || 'sfx', ref: o.ref || 4, rolloff: o.rolloff ?? 1.15, reverb: o.reverb ?? 0.25, gain: (o.gain ?? 1) * rangeGain });
      e.setPos(o.pos.x, o.pos.y, o.pos.z);
      e.occlude(o.occlude === false ? 1 : this.visibility(o.pos.x, o.pos.y, o.pos.z), 0.001);
      if (o.roughness) {
        // nonlinear "voice past its limits" (Blumstein): irregular 30-60 Hz amplitude roughness
        const am = ctx.createGain(); am.gain.value = 1 - o.roughness;
        const lfo = ctx.createOscillator(); lfo.frequency.value = 30 + Math.random() * 25;
        lfo.frequency.setValueAtTime(lfo.frequency.value, ctx.currentTime);
        lfo.frequency.linearRampToValueAtTime(30 + Math.random() * 30, ctx.currentTime + (buf.duration || 1));
        const depth = ctx.createGain(); depth.gain.value = o.roughness;
        lfo.connect(depth); depth.connect(am.gain); src.connect(am); am.connect(e.input);
        lfo.start(); lfo.stop(ctx.currentTime + (buf.duration || 1) / (o.rate || 1) + 0.2);
      } else src.connect(e.input);
      h = { src, e, range: o.range, baseGain: o.gain ?? 1 };
    } else {
      const gn = ctx.createGain(); gn.gain.value = o.gain ?? 1;
      let node = src;
      if (o.pan) { const p = ctx.createStereoPanner(); p.pan.value = o.pan; src.connect(p); node = p; }
      node.connect(gn); gn.connect(this.bus[o.bus || 'sfx']);
      if (o.reverb) { const s = ctx.createGain(); s.gain.value = o.reverb; gn.connect(s); s.connect(this.revIn); }
      h = { src, gn };
    }
    h.stop = (fadeT = 0.05) => {
      h.stopping = true;
      try {
        const g = h.e ? h.e.out.gain : h.gn.gain; g.setTargetAtTime(0, ctx.currentTime, fadeT / 3);
        src.stop(ctx.currentTime + fadeT + 0.05);
      } catch (er) { /* already stopped */ }
    };
    src.onended = () => { this.active.delete(h); if (h.e) h.e.dispose(); else try { h.gn.disconnect(); } catch (er) { /* */ } };
    src.start(ctx.currentTime + (o.delay || 0));
    this.active.add(h);
    return h;
  }

  pick(prefix, n, seed) { return this.lib[prefix + (((seed % n) + n) % n)] || this.lib[prefix + '0']; }

  // ---------------------------------------------------------------- listener
  setListener(cam) {
    if (!this.ctx) return;
    const L = this.ctx.listener, p = cam.position;
    const f = cam.getWorldDirection(this._f || (this._f = new cam.position.constructor()));
    const up = this._u || (this._u = new cam.position.constructor());
    up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    this.listener.x = p.x; this.listener.y = p.y; this.listener.z = p.z; this.listener.fx = f.x; this.listener.fz = f.z;
    if (L.positionX) {
      const t = this.ctx.currentTime;
      L.positionX.setValueAtTime(p.x, t); L.positionY.setValueAtTime(p.y, t); L.positionZ.setValueAtTime(p.z, t);
      L.forwardX.setValueAtTime(f.x, t); L.forwardY.setValueAtTime(f.y, t); L.forwardZ.setValueAtTime(f.z, t);
      L.upX.setValueAtTime(up.x, t); L.upY.setValueAtTime(up.y, t); L.upZ.setValueAtTime(up.z, t);
    } else { L.setPosition(p.x, p.y, p.z); L.setOrientation(f.x, f.y, f.z, up.x, up.y, up.z); }
    // Re-evaluate range for already-playing creature sounds too: walking away
    // should not leave a loud step or skunk call hanging beyond its cutoff.
    for (const h of this.active) {
      if (!h.e || !h.range || h.stopping) continue;
      const e = h.e, t = this.ctx.currentTime;
      const gain = distanceGain(Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z), h.range) * h.baseGain;
      if (gain === 0) { e.out.gain.cancelScheduledValues(t); e.out.gain.setValueAtTime(0, t); }
      else e.out.gain.setTargetAtTime(gain, t, 0.025);
    }
  }

  // ---------------------------------------------------------------- loops (ambience + fear layer)
  _buildLoops() {
    const ctx = this.ctx;
    const loop = (name, bus, gain = 0) => { const h = this.play(this.lib[name], { loop: true, bus, gain }); return h; };
    this.loops.crickets = loop('crickets', 'amb');
    this.loops.wind = loop('wind', 'amb'); this.loops.river = loop('river', 'amb'); this.loops.traffic = loop('traffic', 'amb');
    // cold wind: band-passed noise whose centre wanders
    const nb = ctx.createBuffer(1, S.SR * 4, S.SR); const nd = nb.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const ns = ctx.createBufferSource(); ns.buffer = nb; ns.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 7;
    const bp2 = ctx.createBiquadFilter(); bp2.type = 'bandpass'; bp2.frequency.value = 2600; bp2.Q.value = 11;
    const cg = ctx.createGain(); cg.gain.value = 0;
    ns.connect(bp); ns.connect(bp2); bp.connect(cg); bp2.connect(cg); cg.connect(this.bus.amb); cg.connect(this.revIn);
    ns.start();
    this.cold = { bp, bp2, g: cg };
    // drone: two detuned saws a minor second apart, filtered; plus a glassy high pair
    const dg = ctx.createGain(); dg.gain.value = 0;
    const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 180; dlp.Q.value = 2;
    const oscs = [];
    for (const f of [43.65, 46.25, 87.3]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; const og = ctx.createGain(); og.gain.value = f > 80 ? 0.25 : 0.5; o.connect(og); og.connect(dlp); o.start(); oscs.push(o); }
    dlp.connect(dg); dg.connect(this.bus.amb);
    const hg = ctx.createGain(); hg.gain.value = 0;
    for (const f of [1864, 1975]) { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; const og = ctx.createGain(); og.gain.value = 0.5; o.connect(og); og.connect(hg); o.start(); oscs.push(o); }
    hg.connect(this.bus.amb); hg.connect(this.revIn);
    const tin = ctx.createOscillator(); tin.type = 'sine'; tin.frequency.value = 6900; const tg = ctx.createGain(); tg.gain.value = 0; tin.connect(tg); tg.connect(this.master); tin.start();
    this.drone = { g: dg, lp: dlp, high: hg, tin: tg, oscs };
    // HUNT HUM (owner, Oct 25): a Hereditary-style sub-bass pressure that swells only
    // while Helium Voice is actively hunting someone. 25/31/33 Hz tones beat against each
    // other (felt more than heard); 50/62/93 Hz harmonics carry it on laptop/phone speakers; a slow
    // 0.11 Hz "breathing" swell; filtered sub rumble. Silent outside hunts.
    const hh = ctx.createGain(); hh.gain.value = 0;
    const hlp = ctx.createBiquadFilter(); hlp.type = 'lowpass'; hlp.frequency.value = 140; hlp.Q.value = 0.9;
    const swell = ctx.createGain(); swell.gain.value = 0.95;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11; const lfoG = ctx.createGain(); lfoG.gain.value = 0.32;
    lfo.connect(lfoG); lfoG.connect(swell.gain); lfo.start(); oscs.push(lfo);
    for (const [f, a] of [[23, 0.95], [31, 0.9], [33, 0.9], [46, 0.36], [62, 0.52], [93.5, 0.28]]) { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; const og = ctx.createGain(); og.gain.value = a; o.connect(og); og.connect(swell); o.start(); oscs.push(o); }
    const rs = ctx.createBufferSource(); rs.buffer = nb; rs.loop = true; rs.playbackRate.value = 0.5;
    const rlp = ctx.createBiquadFilter(); rlp.type = 'lowpass'; rlp.frequency.value = 55; rlp.Q.value = 0.7;
    const rg = ctx.createGain(); rg.gain.value = 1.25; rs.connect(rlp); rlp.connect(rg); rg.connect(swell); rs.start();
    swell.connect(hlp); hlp.connect(hh); hh.connect(this.bus.amb);
    this.huntHum = { g: hh, lp: hlp, level: 0 };
    // objective loops are created on demand
  }

  setLoopGain(h, v, tc = 0.4) { if (h && h.gn) h.gn.gain.setTargetAtTime(v, this.ctx.currentTime, tc); }

  // ---------------------------------------------------------------- per-frame
  // st: {terror, fear, cold, exert, gas, downed, inGame, critical, menu}
  update(dt, st) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime, w = this.world, L = this.listener;
    Object.assign(this.state, st);
    const terr = st.terror || 0;
    const cues = horrorCues(terr);
    // Background insects stay independent of enemy *distance*. They only fall silent when he
    // is actually closing in on someone nearby ("the forest holds its breath", SCARE_RESEARCH
    // C1): ~2 s to near-silence, then a slow, uneven return once the threat has passed.
    const insects = cues.insects * (st.menu ? 0.6 : 1);
    const hushed = st.hush ? 1 : 0;
    if (this.hushLevel === undefined) this.hushLevel = 0;
    if (hushed !== this.hushLevel) { this.hushLevel = hushed; this.setLoopGain(this.loops.crickets, 0.27 * insects * (hushed ? 0.06 : 1), hushed ? 0.6 : (st.hushRelease || 6)); }
    else if (!hushed) this.setLoopGain(this.loops.crickets, 0.27 * insects, this.hushReleaseT > t ? (st.hushRelease || 6) : 0.6);
    if (hushed) this.hushReleaseT = t + 4 * (st.hushRelease || 6);
    const rd = w ? w.riverDistAt(L.x, L.z) : 100;
    this.setLoopGain(this.loops.river, 0.55 * Math.pow(clamp(1 - rd / 75, 0, 1), 2), 0.5);
    this.setLoopGain(this.loops.wind, 0.36 + 0.14 * Math.sin(t * 0.13), 0.8);
    const hw = w?.poi?.highway;
    const hd = hw ? Math.hypot(L.x - hw.x, L.z - hw.z) : 800;
    this.setLoopGain(this.loops.traffic, 0.1 + 0.4 * clamp(1 - hd / 500, 0, 1), 1);
    // fear layer
    const cold = st.cold || 0;
    this.cold.g.gain.setTargetAtTime(0, t, 0.5);
    this.cold.bp.frequency.setTargetAtTime(1500 + 700 * Math.sin(t * 0.37) + 300 * Math.sin(t * 1.1), t, 0.3);
    this.cold.bp2.frequency.setTargetAtTime(2500 + 600 * Math.sin(t * 0.23 + 1), t, 0.3);
    this.drone.g.gain.setTargetAtTime(0.065 * cues.drone, t, 0.8);
    this.drone.lp.frequency.setTargetAtTime(120 + 260 * terr, t, 0.5);
    this.drone.high.gain.setTargetAtTime(0.004 * cues.highTone, t, 1.2);
    this.drone.tin.gain.setTargetAtTime(0.006 * (st.gas || 0), t, 0.6);
    // hunt hum: a clearly audible bass pressure when a hunt starts, abrupt cut when it ends (the
    // silence after is part of the scare). Opens its filter as he closes in.
    const hunt = st.hunt ? 1 : 0, hm = this.huntHum;
    if (hunt !== hm.level) { hm.level = hunt; hm.g.gain.cancelScheduledValues(t); hm.g.gain.setTargetAtTime(hunt ? 0.42 : 0, t, hunt ? 0.35 : 0.08); }
    if (hunt) hm.lp.frequency.setTargetAtTime(90 + 160 * clamp(st.huntNear || 0, 0, 1), t, 0.35);
    const muffle = Math.max(st.gas || 0, (st.downed || 0) * 0.6);
    this.hear.frequency.setTargetAtTime(lerp(20000, 650, muffle), t, 0.3);
    if (!st.inGame) return;
    // breathing (also drives breath-condensation visuals through onExhale)
    const exert = st.exert || 0, fear = st.fear || 0;
    // holding your breath (Update 0.9): no breath sounds, no condensation, until you let go
    if (st.holdBreath) { this.breathT = Math.max(this.breathT, 0.25); this.breathIn = true; }
    this.breathT -= dt;
    if (this.breathT <= 0) {
      const mix = S.playerBreathMix(exert, fear, st.downed || 0);
      const k = (Math.random() * S.PLAYER_BREATH_VARIANTS) | 0;
      const name = (this.breathIn ? 'in' : 'out') + (mix.heavy ? 'H' : '') + k;
      this.play(this.lib[name], { bus: 'sfx', gain: mix.gain, rate: mix.rate });
      if (!this.breathIn && this.onExhale) this.onExhale(mix.visualStrength);
      const dur = this.lib[name].duration / mix.rate;
      const gap = this.breathIn ? mix.inhaleGap : mix.exhaleGap;
      this.breathT = (dur + gap) * (0.94 + Math.random() * 0.12);
      this.breathIn = !this.breathIn;
    }
    // heartbeat
    const heart = S.playerHeartbeatMix(exert, st.downed || 0);
    if (heart.gain > 0) {
      this.heartT -= dt;
      if (this.heartT <= 0) {
        this.heartT = 60 / heart.bpm;
        this.play(this.lib.heart, { bus: 'sfx', gain: heart.gain, rate: heart.rate });
        if (this.onBeat) this.onBeat();
      }
    }
    this._treeRustle(t);
  }

  _treeRustle(t) {
    if (t < this.treeRefreshAt) return;
    this.treeRefreshAt = t + 2;
    const trees=nearbyCanopies(this.world,this.listener.x,this.listener.z);
    for(const [tree,h] of this.treeEmitters) if(!trees.includes(tree)) {
      h.stop(.8);this.treeEmitters.delete(tree);
    }
    for(const tree of trees) {
      let h=this.treeEmitters.get(tree);
      if(!h) {
        h=this.play(this.lib.treeLeaves,{bus:'amb',loop:true,gain:0,
          pos:{x:tree.x,y:tree.y+Math.min(tree.height*.65,10),z:tree.z},
          ref:7,rolloff:1.6,reverb:.08,occlude:false,rate:.94+Math.random()*.12});
        if(h)this.treeEmitters.set(tree,h);
      }
      // Slow gusts share the wind rhythm; enemy distance never affects leaves.
      if(h)h.e.out.gain.setTargetAtTime(.16+.07*Math.sin(t*.13+tree.x*.08),t,.8);
    }
  }

  // ---------------------------------------------------------------- game sounds
  footstep(info, pos = null) {
    const name = info.water > 0.12 ? 'water' : SURF_NAME[info.surface] || 'dirt';
    const k = (Math.random() * 4) | 0;
    // Own footsteps/landings are close to the listener and need a softer mix
    // than positional sounds. Include brush so it cannot dominate the dry step.
    const localGain = pos ? 1 : 0.25;
    const g = (0.25 + info.loud * 0.55) * (pos ? 1.3 : 0.75) * localGain;
    const cue = pos ? (info.teammate ? teammateFootstepCue() : creatureFootstepCue(info.creature, info.speed)) : null;
    const sourceGain = cue ? cue.gain : 1;
    const rate = 0.92 + Math.random() * 0.16;
    if (pos) this.play(this.lib[`fs_${name}${k}`], { pos, gain: g * sourceGain, rate, ref: 3, reverb: cue ? 0.07 : 0.15, range: cue });
    else this.play(this.lib[`fs_${name}${k}`], { gain: g, rate, pan: (this._foot = !this._foot) ? -0.12 : 0.12 });
    if (info.brush > 0.35 && info.speed > 0.6) {
      const b = this.lib[`fs_brush${(Math.random() * 4) | 0}`];
      const bg = clamp((info.brush - 0.3) * 1.2, 0, 1) * (0.25 + info.loud * 0.5);
      if (pos) this.play(b, { pos, gain: bg * 1.3 * sourceGain, rate, ref: 3, ...(cue ? { reverb: 0.07, range: cue } : {}) }); else this.play(b, { gain: bg * 0.7 * localGain, rate });
    }
  }

  hvVocal(kind, seed, pos) {
    const key = `hv_${kind}_${seed % 5}`;
    if (!this.var[key]) this.var[key] = this.toBuffer(S.hvVocal(HV_KINDS.includes(kind) ? kind : 'hum', seed % 5 + 1));
    const loud = { breath: 0.6, inhale: 0.7, hum: 0.8 }[kind] || 0.8;
    return this.play(this.var[key], { pos, bus: 'mon', gain: loud, ref: 1.5, reverb: 0.1, range: creatureFootstepCue('hv', 0) });
  }

  // his breath, close, in time with yours (Puppet search beat): audible to ~8 m
  hvBreath(pos, seed = 0) {
    const key = `hv_breath_${seed % 5}`;
    if (!this.var[key]) this.var[key] = this.toBuffer(S.hvVocal('breath', seed % 5 + 1));
    return this.play(this.var[key], { pos, bus: 'mon', gain: 0.75, ref: 1.5, reverb: 0.05, range: { fadeStart: 3, maxDistance: 8 } });
  }

  sfVocal(kind, seed, pos) {
    const cue = skunkVocalCue(kind);
    if (pos && distanceGain(Math.hypot(pos.x - this.listener.x, pos.y - this.listener.y, pos.z - this.listener.z), cue) === 0) return null;
    const key = `sf_${kind}_${seed % 4}`;
    if (!this.var[key]) this.var[key] = this.toBuffer(S.sfVocal(SF_KINDS.includes(kind) ? kind : 'breath', seed % 4 + 1));
    const loud = { rumble: 2.0, growl: 1.5, warn: 1.4, gas: 1.6, bite: 1.6, chitter: 0.8, breath: 0.6, rustle: 0.9 }[kind] || 1;
    return this.play(this.var[key], { pos, bus: 'mon', gain: loud * cue.gain, ref: kind === 'rumble' ? 5 : 3, reverb: 0.15, range: cue });
  }

  stinger(kind, gain = 0.8) { return this.play(this.lib['st_' + kind], { bus: 'sfx', gain, reverb: 0.3 }); }
  ui(name, gain = 0.6) { return this.play(this.lib[name], { bus: 'ui', gain }); }
  hvSearchMove(seed, pos) {
    const C = CONFIG.HV;
    return this.at('searchCrack' + ((seed >>> 0) % 4), pos, {
      bus: 'mon', gain: C.SEARCH_CRACK_GAIN, ref: 4, rolloff: .75, reverb: .08,
      range: { fadeStart: C.SEARCH_CRACK_FADE_START, maxDistance: C.SEARCH_CRACK_MAX_DISTANCE },
      rate: .94 + ((seed >>> 2) % 9) * .015,
    });
  }

  pebbleImpact(pos,seed) {
    const water=this.world?.waterAt(pos.x,pos.z);
    if(water!=null&&water>groundAt(this.world,pos.x,pos.z)+.02)
      return this.play(this.pick('fs_water',4,seed),{pos,bus:'sfx',gain:.16,rate:1.6,ref:3,reverb:.06,range:{fadeStart:8,maxDistance:24}});
    return this.at('pebble'+((Number(seed)>>>0)%3),pos,{bus:'sfx',gain:.55,ref:3,rolloff:.8,reverb:.08,
      range:{fadeStart:8,maxDistance:24}});
  }

  at(name, pos, o = {}) { return this.play(this.lib[name], { pos, ...o }); }

  // looping positional sound owned by the caller (generators, siren, …)
  loopAt(id, name, pos, o = {}) {
    if (this.loops[id]) return this.loops[id];
    const h = this.play(this.lib[name], { pos, loop: true, ...o });
    this.loops[id] = h;
    return h;
  }
  stopLoop(id) { const h = this.loops[id]; if (h) { h.stop(0.5); delete this.loops[id]; } }

  // stop transient game sounds (session end / restart); ambience keeps running
  stopAll() {
    for (const h of [...this.active]) if (!Object.values(this.loops).includes(h)) h.stop(0.2);
    for (const id of ['gen', 'relay', 'siren', 'alarm']) this.stopLoop(id);
    this.treeEmitters.clear(); this.treeRefreshAt = 0;
  }
}
