// First-person arms (owner, Nov 10 2026: "add arm models and animations").
// Right arm: holds the lighter (it is a child of the lighter's view model, so it goes where the flame goes).
// Left arm: everything else. It rests out of view and comes up to smoke, drink, throw, reach for a pickup,
// work on a repair, or cover your mouth while you hold your breath.
// The arms are unlit like the lighter (a lit mesh this close to the flame's light blows out); their
// brightness follows the flame, with a trace of moonlight when it is out.
import * as THREE from 'three';
import { clamp, lerp } from '../../shared/math.js';

const Y = new THREE.Vector3(0, 1, 0);
const SKIN = [0.78, 0.4, 0.24], SLEEVE = [0.13, 0.16, 0.1], CUFF = [0.19, 0.22, 0.15];
// Unlit meshes look like paper cut-outs, so the shading is baked into vertex colours: light from the
// flame above and a little toward the middle of the view, falling off on the far side of each form.
const LIGHT = new THREE.Vector3(-0.25, 0.85, -0.2).normalize();
function bake(mesh) {
  const g = mesh.geometry, n = g.attributes.normal, col = new Float32Array(n.count * 3), v = new THREE.Vector3();
  for (let i = 0; i < n.count; i++) {
    v.fromBufferAttribute(n, i).applyQuaternion(mesh.quaternion);
    const s = 0.34 + 0.66 * Math.max(0, v.dot(LIGHT) * 0.6 + 0.4) ** 1.2;
    col[i * 3] = s; col[i * 3 + 1] = s * 0.97; col[i * 3 + 2] = s * 0.93;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

function puffTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  r.addColorStop(0, 'rgba(255,255,255,0.9)'); r.addColorStop(0.5, 'rgba(255,255,255,0.35)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// poses for the left arm in camera space: [x, y, z, rx, ry, rz, curl]
const POSE = {
  rest:   [-0.26, -0.66, -0.2, -0.5, 0.2, -0.4, 0.3],
  carry:  [-0.21, -0.25, -0.36, -0.75, 0.35, -0.5, 0.55],     // holding a cigarette low on the left
  mouth:  [-0.05, -0.15, -0.2, -0.55, 0.9, -0.75, 0.55],      // a drag
  flame:  [0.07, -0.17, -0.3, -0.7, 0.5, -0.9, 0.55],         // lighting it off the lighter
  use:    [-0.1, -0.2, -0.44, -1.15, 0.1, -0.3, 0.35],        // hand on the work
  hush:   [0.0, -0.135, -0.15, -0.25, 0.25, -1.3, 0.12],      // hand over your mouth
  wind:   [-0.3, -0.02, -0.12, 0.5, 0.3, -0.5, 0.9],          // throw: back
  loose:  [-0.1, -0.06, -0.5, -1.2, 0.2, -0.35, 0.0],         // throw: release
  reach:  [-0.08, -0.25, -0.46, -1.0, 0.2, -0.3, 0.1],        // pick something up
  sip0:   [-0.08, -0.2, -0.3, -0.5, 0.5, -0.5, 0.85],         // bottle up
  sip1:   [-0.04, -0.1, -0.2, 0.55, 0.7, -0.6, 0.85],         // bottle tipped back
  held:   [-0.24, 0.02, -0.3, -0.2, 0.3, -0.9, 0.0],          // grabbed: thrown up, fingers spread
};

export class Arms {
  constructor(camera, flashlight) {
    this.camera = camera; this.fl = flashlight;
    const M = (o = {}) => new THREE.MeshBasicMaterial({ vertexColors: true, ...o });
    this.skin = M(); this.sleeve = M(); this.cuff = M();
    this.white = M(); this.glass = M(); this.label = M();
    this.t = 0; this.phase = 0; this.act = null; this.smoke = 0; this.smokeT = 0; this.dragGlow = 0; this.puffs = [];
    this.cur = POSE.rest.slice(); this.sprintK = 0; this.lum = 0.1;
    this._buildRight(); this._buildLeft();
    this.puffTex = puffTexture();
    this.base = flashlight.model.position.clone();
  }

  _limb(a, b, r0, r1, mat, parent) {
    const d = new THREE.Vector3().subVectors(b, a), len = d.length();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 10), mat);
    m.position.copy(a).addScaledVector(d, 0.5); m.quaternion.setFromUnitVectors(Y, d.normalize());
    m.frustumCulled = false; m.renderOrder = 8; bake(m); parent.add(m); return m;
  }
  _ball(p, s, mat, parent) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), mat); m.position.copy(p); m.scale.set(s[0], s[1], s[2]);
    m.frustumCulled = false; m.renderOrder = 8; bake(m); parent.add(m); return m;
  }

  // a fist around the lower half of the lighter, thumb up on the wheel, forearm running out of frame
  _buildRight() {
    const g = this.right = new THREE.Group(), V = (x, y, z) => new THREE.Vector3(x, y, z);
    this._ball(V(0.008, -0.04, 0.008), [0.03, 0.033, 0.027], this.skin, g);                      // the fist
    for (let i = 0; i < 4; i++) this._limb(V(-0.03, -0.012 - i * 0.017, -0.012), V(0.02, -0.01 - i * 0.017, -0.026), 0.0085, 0.0085, this.skin, g);   // fingers across the front
    this.thumb = new THREE.Group(); this.thumb.position.set(0.02, -0.02, 0.02); g.add(this.thumb);
    this._limb(V(0, 0, 0), V(-0.012, 0.036, -0.004), 0.0095, 0.0085, this.skin, this.thumb);
    this._limb(V(-0.012, 0.036, -0.004), V(-0.02, 0.06, -0.016), 0.0085, 0.0075, this.skin, this.thumb);
    const wrist = V(0.014, -0.068, 0.016), elbow = V(0.15, -0.36, 0.34);
    const mid = wrist.clone().lerp(elbow, 0.12);
    this._limb(wrist.clone().lerp(V(0.006, -0.04, 0.006), 0.4), mid, 0.027, 0.03, this.skin, g);
    this._limb(mid, mid.clone().lerp(elbow, 0.06), 0.041, 0.04, this.cuff, g);
    this._limb(mid.clone().lerp(elbow, 0.05), elbow, 0.036, 0.055, this.sleeve, g);
    this.fl.model.add(g);
  }

  // an open hand: fingers along +Y, palm toward +Z; forearm down -Y. Props sit in the hand.
  _buildLeft() {
    const g = this.left = new THREE.Group(), V = (x, y, z) => new THREE.Vector3(x, y, z);
    this._ball(V(0, 0, 0), [0.04, 0.045, 0.016], this.skin, g);                                  // palm
    this.fingers = [];
    for (let i = 0; i < 4; i++) {
      const k = new THREE.Group(); k.position.set(-0.028 + i * 0.019, 0.04 - Math.abs(i - 1.4) * 0.004, 0);
      const len = [0.036, 0.042, 0.04, 0.032][i];
      this._limb(V(0, 0, 0), V(0, len, 0), 0.0088, 0.0082, this.skin, k);
      const k2 = new THREE.Group(); k2.position.set(0, len, 0); k.add(k2);
      this._limb(V(0, 0, 0), V(0, len * 0.8, 0), 0.0082, 0.007, this.skin, k2);
      g.add(k); this.fingers.push([k, k2]);
    }
    this.lthumb = new THREE.Group(); this.lthumb.position.set(0.036, -0.012, 0.004); g.add(this.lthumb);
    this._limb(V(0, 0, 0), V(0.028, 0.03, 0.01), 0.0105, 0.009, this.skin, this.lthumb);
    this._limb(V(0.028, 0.03, 0.01), V(0.036, 0.058, 0.016), 0.009, 0.0078, this.skin, this.lthumb);
    this._limb(V(0, -0.03, 0), V(0, -0.075, 0), 0.03, 0.027, this.skin, g);                      // wrist
    this._limb(V(0, -0.07, 0), V(0, -0.095, 0), 0.04, 0.041, this.cuff, g);
    this._limb(V(0, -0.09, 0), V(0, -0.5, 0), 0.055, 0.036, this.sleeve, g);
    // a cigarette between the first two fingers, ember toward the middle of the view
    const cig = this.cig = new THREE.Group(); cig.position.set(0.0, 0.082, 0.012); cig.rotation.set(0.25, 0, -1.2);
    this._limb(V(0, 0, 0), V(0, 0.05, 0), 0.0036, 0.0036, this.white, cig);
    this._limb(V(0, -0.022, 0), V(0, 0, 0), 0.0037, 0.0037, this.label, cig);                    // the filter
    this.ember = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTexture(), color: 0xff5a1a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this.ember.position.set(0, 0.052, 0); this.ember.scale.setScalar(0.014); this.ember.renderOrder = 11; cig.add(this.ember); g.add(cig);
    // a longneck
    const bot = this.bottle = new THREE.Group(); bot.position.set(0.004, 0.012, 0.04);
    this._limb(V(0, -0.075, 0), V(0, 0.04, 0), 0.029, 0.029, this.glass, bot);
    this._limb(V(0, 0.04, 0), V(0, 0.07, 0), 0.029, 0.012, this.glass, bot);
    this._limb(V(0, 0.07, 0), V(0, 0.13, 0), 0.012, 0.011, this.glass, bot);
    this._limb(V(0, -0.045, 0), V(0, 0.012, 0), 0.0295, 0.0295, this.label, bot);
    g.add(bot);
    g.traverse((o) => { o.frustumCulled = false; });
    g.visible = false; this.camera.add(g);
  }

  reset() { this.act = null; this.smoke = 0; this.smokeT = 0; this.cur = POSE.rest.slice(); for (const p of this.puffs) this.camera.remove(p.s); this.puffs = []; this.left.visible = false; }

  // one-shot animations: 'throw' | 'reach' | 'drink' | 'light'
  play(kind) { const dur = { throw: 0.55, reach: 0.5, drink: 3.0, light: 1.5 }[kind]; if (dur) this.act = { kind, t: 0, dur }; }
  startSmoke(seconds) { this.smoke = seconds; this.smokeT = 0; this.play('light'); }
  busy() { return !!this.act && (this.act.kind === 'drink' || this.act.kind === 'light'); }

  _puff() {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.puffTex, transparent: true, depthWrite: false, depthTest: false, opacity: 0, fog: false }));
      s.position.set((Math.random() - 0.5) * 0.03, -0.1, -0.2 - i * 0.03); s.renderOrder = 12; this.camera.add(s);
      this.puffs.push({ s, t: -i * 0.09, v: new THREE.Vector3((Math.random() - 0.5) * 0.05, 0.05 + Math.random() * 0.04, -0.22 - Math.random() * 0.1), life: 2.2 + Math.random() * 0.8 });
    }
  }

  // o: { speed, sprint, crouch, using, breath, grabbed, lighterOn, hidden (no arms: dead, reading) }
  update(dt, o) {
    this.t += dt; this.phase += Math.min(o.speed || 0, 7) * dt * 1.9;
    // ---- brightness follows the flame
    const lv = clamp(this.fl.bodyMat.color.r / 0.55, 0, 1);
    this.lum = lerp(this.lum, Math.max(0.04, lv * 0.8), 1 - Math.exp(-dt * 18));
    const L = this.lum, set = (m, c, k = 1) => m.color.setRGB(c[0] * L * k, c[1] * L * k, c[2] * L * k);
    set(this.skin, SKIN); set(this.sleeve, SLEEVE); set(this.cuff, CUFF); set(this.white, [0.85, 0.83, 0.78]); set(this.glass, [0.32, 0.17, 0.06]); set(this.label, [0.62, 0.5, 0.27]);
    // ---- right arm: the lighter hand bobs with your step, drops when you run, shakes when he has you
    this.sprintK = lerp(this.sprintK, o.sprint ? 1 : 0, 1 - Math.exp(-dt * 7));
    const bob = Math.min(1, (o.speed || 0) / 3), sw = Math.sin(this.phase), sw2 = Math.sin(this.phase * 2);
    const m = this.fl.model, b = this.base, shake = o.grabbed ? 0.012 : 0;
    m.position.set(
      b.x + sw * 0.006 * bob + this.sprintK * 0.03 + (Math.random() - 0.5) * shake,
      b.y - Math.abs(sw2) * 0.004 * bob - this.sprintK * (0.045 + 0.02 * sw) + Math.sin(this.t * 1.3) * 0.0015 + (Math.random() - 0.5) * shake,
      b.z + this.sprintK * 0.02 * sw);
    this.thumb.rotation.x = o.lighterOn ? 0 : -0.35;       // thumb comes off the wheel when the flame is out
    // ---- left arm: pick the pose
    let target = POSE.rest, rate = 9, wig = 0, showCig = false, showBottle = false;
    if (this.smoke > 0) {
      this.smoke -= dt; this.smokeT += dt; showCig = true;
      const c = this.smokeT % 8;                            // a drag every eight seconds
      if (c > 5.4 && c < 7.2) { target = POSE.mouth; rate = 7; this.dragGlow = lerp(this.dragGlow, c > 5.9 && c < 6.9 ? 1 : 0, 1 - Math.exp(-dt * 6)); }
      else { target = POSE.carry; rate = 6; this.dragGlow = lerp(this.dragGlow, 0, 1 - Math.exp(-dt * 3)); if (c >= 7.2 && c - dt < 7.2) this._puff(); }
      if (this.smoke <= 0) showCig = false;
    }
    if (o.using) { target = POSE.use; rate = 8; wig = 1; showCig = false; }
    if (o.breath) { target = POSE.hush; rate = 11; showCig = false; }
    const a = this.act;
    if (a) {
      a.t += dt; const u = a.t / a.dur;
      if (a.kind === 'throw') { target = u < 0.35 ? POSE.wind : POSE.loose; rate = u < 0.35 ? 22 : 30; showCig = false; }
      else if (a.kind === 'reach') { target = POSE.reach; rate = 16; }
      else if (a.kind === 'drink') { target = u < 0.22 ? POSE.sip0 : u < 0.8 ? POSE.sip1 : POSE.sip0; rate = 7; showBottle = true; showCig = false; }
      else if (a.kind === 'light') { target = POSE.flame; rate = 9; showCig = true; this.dragGlow = u > 0.6 ? 1 : 0; }
      if (u >= 1) { if (a.kind === 'light') this._puff(); this.act = null; }
    }
    if (o.grabbed) { target = POSE.held; rate = 18; showCig = false; showBottle = false; }
    if (o.hidden) target = POSE.rest;
    const k = 1 - Math.exp(-dt * rate), c = this.cur;
    for (let i = 0; i < 7; i++) c[i] = lerp(c[i], target[i], k);
    const g = this.left, w = wig ? Math.sin(this.t * 9) * 0.008 : 0, sh = o.grabbed ? (Math.random() - 0.5) * 0.02 : 0;
    g.position.set(c[0] - sw * 0.004 * bob + w + sh, c[1] - Math.abs(sw2) * 0.004 * bob + (wig ? Math.cos(this.t * 7) * 0.006 : 0) + sh, c[2]);
    g.rotation.set(c[3] + (wig ? Math.sin(this.t * 5) * 0.06 : 0), c[4], c[5]);
    g.visible = !o.hidden && c[1] > POSE.rest[1] + 0.03;
    const curl = showBottle ? 0.85 : c[6];
    for (let i = 0; i < 4; i++) { const [k1, k2] = this.fingers[i]; const cc = showCig && i < 2 ? 0.12 : curl; k1.rotation.x = cc * 1.25; k2.rotation.x = cc * 1.4; }
    this.lthumb.rotation.z = showBottle ? 0.5 : 0;
    this.cig.visible = showCig; this.bottle.visible = showBottle;
    if (showCig) { const e = 0.5 + this.dragGlow * 1.3 + Math.sin(this.t * 11) * 0.05; this.ember.material.opacity = clamp(e, 0, 1); this.ember.scale.setScalar(0.012 + this.dragGlow * 0.012); }
    // ---- exhaled smoke, drifting off ahead of you
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]; p.t += dt;
      if (p.t < 0) continue;
      p.s.position.addScaledVector(p.v, dt); p.v.multiplyScalar(1 - dt * 0.9); p.v.y += dt * 0.012;
      const u = p.t / p.life; p.s.scale.setScalar(0.05 + u * 0.22);
      p.s.material.opacity = Math.sin(Math.PI * clamp(u, 0, 1)) * 0.2 * (0.25 + L);
      if (u >= 1) { this.camera.remove(p.s); p.s.material.dispose(); this.puffs.splice(i, 1); }
    }
  }
}

// ---------------------------------------------------------------- a lit cigarette left on the ground (everyone sees it)
export class Smoulders {
  constructor(scene) { this.scene = scene; this.items = new Map(); this.tex = puffTexture(); this.t = 0; }
  add(id, x, y, z, dur) {
    const g = new THREE.Group(); g.position.set(x, y + 0.02, z);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.07, 6), new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.9 }));
    stick.rotation.z = Math.PI / 2; g.add(stick);
    const ember = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, color: 0xff5a1a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    ember.position.set(0.036, 0.004, 0); ember.scale.setScalar(0.03); g.add(ember);
    const wisps = [];
    for (let i = 0; i < 4; i++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false, opacity: 0 })); g.add(s); wisps.push({ s, o: i / 4 }); }
    this.scene.add(g); this.items.set(id, { g, ember, wisps, left: dur });
  }
  remove(id) { const it = this.items.get(id); if (!it) return; this.scene.remove(it.g); this.items.delete(id); }
  update(dt) {
    this.t += dt;
    for (const [id, it] of this.items) {
      it.left -= dt; if (it.left < -1) { this.remove(id); continue; }
      it.ember.material.opacity = 0.7 + 0.3 * Math.sin(this.t * 6 + it.g.position.x);
      for (const w of it.wisps) { const u = (this.t * 0.22 + w.o) % 1; w.s.position.set(0.036 + Math.sin(u * 5 + w.o * 9) * 0.05 * u, 0.02 + u * 0.9, Math.cos(u * 4 + w.o * 5) * 0.04 * u); w.s.scale.setScalar(0.03 + u * 0.22); w.s.material.opacity = Math.sin(Math.PI * u) * 0.13; }
    }
  }
  clear() { for (const id of [...this.items.keys()]) this.remove(id); }
}
