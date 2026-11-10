// First-person arms (owner, Nov 10 2026: "add arm models and animations", then "higher quality hands").
// The hands are the WebXR "generic hand" models (assets/models/hand_*.bin, see HANDS_NOTICE.md): a real
// sculpted hand with 25 joints each. Those files store every joint flat, in one space, because a headset
// drives each one directly; here the fingers are posed by forward kinematics down each finger chain.
// Right hand: grips the lighter (it is a child of the lighter's view model, so it goes where the flame goes).
// Left hand: rests out of view and comes up to smoke, drink, throw, reach for a pickup, work on a repair,
// or cover your mouth while you hold your breath.
// Nothing here is lit by scene lights (a lit mesh this close to the flame's light blows out): the
// shading is a matcap, and its brightness follows the flame, with a trace of moonlight when it is out.
import * as THREE from 'three';
import { clamp, lerp } from '../../shared/math.js';
import { assetUrl } from '../render/textures.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
// The game's night grade pulls everything toward grey-blue, so these are pushed warm to land on skin.
const SKIN = [1.3, 0.6, 0.34], SLEEVE = [0.26, 0.33, 0.17], CUFF = [0.4, 0.47, 0.28];

function matcapTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); g.fillStyle = '#4e4e4e'; g.fillRect(0, 0, 128, 128);
  const r = g.createRadialGradient(50, 40, 3, 64, 64, 66);   // lit from above and a little left: the flame
  r.addColorStop(0, '#ffffff'); r.addColorStop(0.3, '#ececec'); r.addColorStop(0.62, '#bdbdbd'); r.addColorStop(0.88, '#7c7c7c'); r.addColorStop(1, '#4e4e4e');
  g.fillStyle = r; g.beginPath(); g.arc(64, 64, 64, 0, 7); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function puffTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  r.addColorStop(0, 'rgba(255,255,255,0.9)'); r.addColorStop(0.5, 'rgba(255,255,255,0.35)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------------------------------------------------------------- a minimal GLB reader (one skinned mesh)
function parseGLB(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  let off = 12, json = null, bin = null;
  while (off < dv.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true); off += 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off, len)));
    else if (type === 0x004e4942) bin = buf.slice(off, off + len);
    off += len;
  }
  if (!json || !bin) throw new Error('GLB is missing a chunk');
  return { json, bin };
}
function accessor(g, i) {
  const a = g.json.accessors[i], v = g.json.bufferViews[a.bufferView];
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
  const T = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[a.componentType];
  const start = (v.byteOffset || 0) + (a.byteOffset || 0), bytes = size * T.BYTES_PER_ELEMENT;
  if (v.byteStride && v.byteStride !== bytes) throw new Error('interleaved GLB buffers are not supported');
  return { array: new T(g.bin.slice(start, start + a.count * bytes)), size, count: a.count };
}

const FINGERS = ['index', 'middle', 'ring', 'pinky'].map((f) => ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map((s) => `${f}-finger-${s}`));
const THUMB = ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'];
const SPREAD = [-1, -0.25, 0.45, 1];

// One hand. Its group's frame: palm centre at the origin, fingers along +Y, palm facing +Z.
class Hand {
  constructor(glb, side, material) {
    const j = glb.json, prim = j.meshes[0].primitives[0], skin = j.skins[0], A = prim.attributes;
    const geo = new THREE.BufferGeometry(), at = (i) => accessor(glb, i);
    const pos = at(A.POSITION), nor = at(A.NORMAL), ji = at(A.JOINTS_0), jw = at(A.WEIGHTS_0), idx = at(prim.indices);
    geo.setAttribute('position', new THREE.BufferAttribute(pos.array, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor.array, 3));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(Uint16Array.from(ji.array), 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(jw.array, 4));
    geo.setIndex(new THREE.BufferAttribute(idx.array, 1));
    const names = skin.joints.map((n) => j.nodes[n].name);
    this.rest = skin.joints.map((n) => { const nd = j.nodes[n]; return new THREE.Matrix4().compose(V(...(nd.translation || [0, 0, 0])), new THREE.Quaternion(...(nd.rotation || [0, 0, 0, 1])), V(1, 1, 1)); });
    this.p = this.rest.map((m) => new THREE.Vector3().setFromMatrixPosition(m));
    const ib = at(skin.inverseBindMatrices).array, inverses = names.map((_, i) => new THREE.Matrix4().fromArray(ib, i * 16));
    this.bones = names.map((n) => { const b = new THREE.Bone(); b.name = n; return b; });
    const arm = this.armature = new THREE.Group();
    for (const b of this.bones) arm.add(b);
    this.mesh = new THREE.SkinnedMesh(geo, material); this.mesh.frustumCulled = false; this.mesh.renderOrder = 8;
    arm.add(this.mesh);
    this.mesh.bind(new THREE.Skeleton(this.bones, inverses), new THREE.Matrix4());
    // In the file the fingers run along -Y, the thumb is at -Z and the palm faces -X (right) or +X (left).
    const r = side === 'right';
    this.palmN = V(r ? -1 : 1, 0, 0);
    const id = (n) => names.indexOf(n);
    this.chains = FINGERS.map((c) => c.map(id)); this.thumb = THUMB.map(id);
    const wrist = this.p[id('wrist')], knuckle = this.p[this.chains[1][1]];
    const centre = wrist.clone().lerp(knuckle, 0.62);
    arm.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(V(0, 0, r ? -1 : 1), V(0, -1, 0), V(r ? -1 : 1, 0, 0)));
    arm.position.copy(centre).applyQuaternion(arm.quaternion).negate();
    this.group = new THREE.Group(); this.group.add(arm);
    this.wrist = wrist.clone().applyQuaternion(arm.quaternion).add(arm.position);   // in the group's frame
    // curl axes: each finger joint bends toward the palm; the thumb folds across it toward the little finger
    const axis = (chain, toward) => chain.map((b, n) => {
      const d = (n < chain.length - 1 ? this.p[chain[n + 1]].clone().sub(this.p[b]) : this.p[b].clone().sub(this.p[chain[n - 1]])).normalize();
      return d.cross(toward).normalize();
    });
    this.axes = this.chains.map((c) => axis(c, this.palmN));
    this.thumbAxes = axis(this.thumb, this.palmN.clone().multiplyScalar(0.75).add(V(0, -0.25, 0.6)).normalize());
    this._T = new THREE.Matrix4(); this._R = new THREE.Matrix4(); this._M = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3();
    for (let i = 0; i < this.bones.length; i++) this.rest[i].decompose(this.bones[i].position, this.bones[i].quaternion, this._s);   // the wrist stays here
    this.pose([0.15, 0.15, 0.18, 0.2], [0.1, 0.1], 0);
  }

  _about(p, a, angle) {   // rotate about the axis a through the point p
    const R = this._R.makeRotationAxis(a, angle);
    R.setPosition(p.x - (R.elements[0] * p.x + R.elements[4] * p.y + R.elements[8] * p.z), p.y - (R.elements[1] * p.x + R.elements[5] * p.y + R.elements[9] * p.z), p.z - (R.elements[2] * p.x + R.elements[6] * p.y + R.elements[10] * p.z));
    return R;
  }
  _chain(chain, axes, angles, spread) {
    const T = this._T.identity();
    for (let n = 0; n < chain.length; n++) {
      const b = chain[n];
      if (n === 1 && spread) T.multiply(this._about(this.p[b], this.palmN, spread));
      if (angles[n]) T.multiply(this._about(this.p[b], axes[n], angles[n]));
      this._M.multiplyMatrices(T, this.rest[b]).decompose(this.bones[b].position, this.bones[b].quaternion, this._s);
    }
  }
  // curls: [index, middle, ring, pinky] 0 (straight) .. 1 (fist); thumb: [across the palm, bend]; spread: fingers apart
  pose(curls, thumb, spread = 0) {
    for (let f = 0; f < 4; f++) { const k = curls[f]; this._chain(this.chains[f], this.axes[f], [0, 1.4 * k, 1.7 * k, 1.05 * k, 0], spread * SPREAD[f] * 0.22 * (this.palmN.x < 0 ? 1 : -1)); }
    this._chain(this.thumb, this.thumbAxes, [thumb[0] * 0.75, thumb[1] * 0.7, thumb[1] * 1.0, 0], 0);
  }
}

// poses for the left hand in camera space (camera looks down -Z, +X right, +Y up):
//   p palm centre · f where the fingers point · n where the palm faces · c finger curls · t thumb · s spread
const POSE = {
  rest:  { p: [-0.3, -0.7, -0.2], f: [0.2, 0.6, -0.8], n: [0.7, 0.3, 0.6], c: [0.3, 0.3, 0.35, 0.4], t: [0.2, 0.2] },
  carry: { p: [-0.2, -0.235, -0.38], f: [0.3, 0.62, -0.72], n: [0.72, 0.2, 0.66], c: [0.1, 0.16, 0.8, 0.9], t: [0.55, 0.4] },   // a cigarette, low on the left
  mouth: { p: [-0.035, -0.135, -0.19], f: [0.5, 0.82, -0.25], n: [0.25, -0.1, 0.96], c: [0.12, 0.18, 0.8, 0.9], t: [0.55, 0.4] }, // a drag
  flame: { p: [0.045, -0.165, -0.3], f: [0.75, 0.5, -0.43], n: [0.15, 0.3, 0.94], c: [0.1, 0.16, 0.8, 0.9], t: [0.55, 0.4] },    // lighting it off the lighter
  use:   { p: [-0.07, -0.15, -0.4], f: [0.15, 0.3, -0.94], n: [0.1, -0.94, -0.3], c: [0.28, 0.33, 0.4, 0.46], t: [0.25, 0.25] },      // hand on the work
  hush:  { p: [0.0, -0.09, -0.17], f: [0.96, 0.2, -0.15], n: [0, -0.45, 0.89], c: [0.1, 0.12, 0.14, 0.18], t: [0.25, 0.1] }, // hand over your mouth
  wind:  { p: [-0.3, -0.04, -0.14], f: [-0.2, 0.9, 0.35], n: [0.1, 0.2, -0.97], c: [0.95, 0.95, 0.95, 0.95], t: [0.8, 0.6] },    // throw: back
  loose: { p: [-0.1, -0.07, -0.5], f: [0.1, 0.3, -0.95], n: [0, -0.95, -0.3], c: [0, 0, 0.05, 0.1], t: [0, 0], s: 0.6 },         // throw: release
  reach: { p: [-0.04, -0.2, -0.44], f: [0.5, -0.12, -0.86], n: [0.1, -0.95, 0.2], c: [0.25, 0.25, 0.3, 0.3], t: [0.1, 0.1], s: 0.3 }, // pick something up
  sip0:  { p: [-0.08, -0.16, -0.33], f: [0.4, 0.15, -0.9], n: [0.9, 0, 0.42], c: [0.62, 0.64, 0.66, 0.7], t: [0.75, 0.3] },       // bottle up
  sip1:  { p: [-0.02, -0.075, -0.2], f: [0.05, 0.85, 0.1], n: [0.97, 0, 0.05], c: [0.62, 0.64, 0.66, 0.7], t: [0.75, 0.3] },    // bottle tipped back
  held:  { p: [-0.25, 0.0, -0.32], f: [-0.25, 0.94, -0.2], n: [0.1, 0.25, -0.96], c: [0.12, 0.05, 0.1, 0.2], t: [0, 0], s: 1 },   // grabbed: thrown up, fingers spread
};
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4();
function frame(f, n, out) {   // quaternion for a hand whose fingers point along f and whose palm faces n
  _y.set(f[0], f[1], f[2]).normalize(); _z.set(n[0], n[1], n[2]); _z.addScaledVector(_y, -_z.dot(_y)).normalize(); _x.crossVectors(_y, _z);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}
for (const k in POSE) POSE[k].q = frame(POSE[k].f, POSE[k].n, new THREE.Quaternion());

export class Arms {
  constructor(camera, flashlight) {
    this.camera = camera; this.fl = flashlight; this.ready = false;
    const cap = matcapTexture(), M = () => new THREE.MeshMatcapMaterial({ matcap: cap });
    this.skin = M(); this.sleeve = M(); this.cuff = M(); this.white = M(); this.glass = M(); this.label = M();
    this.t = 0; this.phase = 0; this.act = null; this.smoke = 0; this.smokeT = 0; this.dragGlow = 0; this.puffs = [];
    this.sprintK = 0; this.lum = 0.1; this.puffTex = puffTexture();
    this.cur = { p: V(...POSE.rest.p), q: POSE.rest.q.clone(), c: POSE.rest.c.slice(), t: POSE.rest.t.slice(), s: 0 };
    this.rc = [0.76, 0.8, 0.85, 0.9]; this.rt = [0.1, 0.2];
    this.base = flashlight.model.position.clone();
    this.left = new THREE.Group(); this.left.visible = false; camera.add(this.left);
    this.right = new THREE.Group(); flashlight.model.add(this.right);
    this._props();
  }

  // the two hand models; without them the game still runs, with sleeves only
  async load() {
    const get = async (side) => parseGLB(await (await fetch(assetUrl(`assets/models/hand_${side}.bin${(typeof window !== 'undefined' && window.HM_BIN_SUFFIX) || ''}`))).arrayBuffer());
    const [l, r] = await Promise.all([get('left'), get('right')]);
    this.lh = new Hand(l, 'left', this.skin); this.rh = new Hand(r, 'right', this.skin);
    this.left.add(this.lh.group); this._forearm(this.left, this.lh.wrist, V(0, -1, 0));
    // The lighter stands along the right hand's knuckle line, thumb side up: fingers point away from
    // you, the palm faces the middle of the view, and the lighter sits in the curl of the fingers.
    const g = this.right;
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(V(0, 1, 0), V(0, 0, -1), V(-1, 0, 0)));
    g.position.copy(V(0, -0.016, 0)).sub(V(0.004, 0.034, 0.036).applyQuaternion(g.quaternion));
    g.add(this.rh.group);
    // the forearm runs down and back out of frame, so the wrist is cocked the way it is when you hold a flame up
    this._forearm(g, this.rh.wrist, V(0.16, -0.5, 0.85).normalize().applyQuaternion(g.quaternion.clone().invert()));
    this.ready = true;
  }

  _limb(a, b, r0, r1, mat, parent, flat = 1) {
    const d = new THREE.Vector3().subVectors(b, a), len = d.length();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 14), mat);
    m.position.copy(a).addScaledVector(d, 0.5); m.quaternion.setFromUnitVectors(UP, d.normalize()); m.scale.z = flat;
    m.frustumCulled = false; m.renderOrder = 8; parent.add(m); return m;
  }
  // wrist skin, a jacket cuff and the sleeve, from the wrist joint along dir (in the hand group's frame)
  _forearm(parent, wrist, dir) {
    const f = new THREE.Group(); f.position.copy(wrist); f.quaternion.setFromUnitVectors(V(0, -1, 0), dir); parent.add(f);
    this._limb(V(0, 0.01, 0), V(0, -0.05, 0), 0.029, 0.0255, this.skin, f, 0.7);
    this._limb(V(0, -0.035, 0), V(0, -0.062, 0), 0.04, 0.041, this.cuff, f, 0.8);
    this._limb(V(0, -0.058, 0), V(0, -0.52, 0), 0.058, 0.037, this.sleeve, f, 0.86);
    return f;
  }
  // what the left hand holds
  _props() {
    const g = this.left;
    // a cigarette between the first two fingers: filter on the palm side, ember past the knuckles
    const cig = this.cig = new THREE.Group(); cig.position.set(-0.005, 0.07, 0.012); cig.rotation.set(-Math.PI / 2 + 0.25, 0, 0.15);
    this._limb(V(0, -0.012, 0), V(0, 0.05, 0), 0.0037, 0.0037, this.white, cig);
    this._limb(V(0, -0.034, 0), V(0, -0.012, 0), 0.0038, 0.0038, this.label, cig);
    this.ember = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTexture(), color: 0xff5a1a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this.ember.position.set(0, 0.052, 0); this.ember.scale.setScalar(0.014); this.ember.renderOrder = 11; cig.add(this.ember); g.add(cig);
    // a longneck in the fist, neck out past the thumb
    const bot = this.bottle = new THREE.Group(); bot.position.set(0.012, 0.03, 0.04); bot.rotation.z = Math.PI / 2;
    this._limb(V(0, -0.085, 0), V(0, 0.035, 0), 0.029, 0.029, this.glass, bot);
    this._limb(V(0, 0.035, 0), V(0, 0.065, 0), 0.029, 0.012, this.glass, bot);
    this._limb(V(0, 0.065, 0), V(0, 0.125, 0), 0.012, 0.011, this.glass, bot);
    this._limb(V(0, -0.055, 0), V(0, 0.005, 0), 0.0296, 0.0296, this.label, bot).geometry = new THREE.CylinderGeometry(0.0296, 0.0296, 0.06, 14, 1, true);
    g.add(bot);
    cig.visible = bot.visible = false;
  }

  reset() {
    this.act = null; this.smoke = 0; this.smokeT = 0;
    this.cur.p.set(...POSE.rest.p); this.cur.q.copy(POSE.rest.q);
    for (const p of this.puffs) this.camera.remove(p.s); this.puffs = []; this.left.visible = false;
  }

  // one-shot animations: 'throw' | 'reach' | 'drink' | 'light'
  play(kind) { const dur = { throw: 0.55, reach: 0.5, drink: 3.0, light: 1.5 }[kind]; if (dur) this.act = { kind, t: 0, dur }; }
  startSmoke(seconds) { this.smoke = seconds; this.smokeT = 0; this.play('light'); }
  busy() { return !!this.act && (this.act.kind === 'drink' || this.act.kind === 'light'); }

  _puff() {
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.puffTex, transparent: true, depthWrite: false, depthTest: false, opacity: 0, fog: false }));
      s.position.set((Math.random() - 0.5) * 0.03, -0.1, -0.2 - i * 0.03); s.renderOrder = 12; this.camera.add(s);
      this.puffs.push({ s, t: -i * 0.09, v: V((Math.random() - 0.5) * 0.05, 0.05 + Math.random() * 0.04, -0.22 - Math.random() * 0.1), life: 2.2 + Math.random() * 0.8 });
    }
  }

  // o: { speed, sprint, using, breath, grabbed, lighterOn, hidden (dead, spectating), pose (preview only) }
  update(dt, o) {
    this.t += dt; this.phase += Math.min(o.speed || 0, 7) * dt * 1.9;
    // ---- brightness follows the flame
    const lv = clamp(this.fl.bodyMat.color.r / 0.55, 0, 1);
    this.lum = lerp(this.lum, Math.max(0.05, lv * 0.9), 1 - Math.exp(-dt * 18));
    const L = this.lum, set = (m, c) => m.color.setRGB(c[0] * L, c[1] * L, c[2] * L);
    set(this.skin, SKIN); set(this.sleeve, SLEEVE); set(this.cuff, CUFF); set(this.white, [0.9, 0.88, 0.82]); set(this.glass, [0.42, 0.21, 0.07]); set(this.label, [0.75, 0.6, 0.32]);
    // ---- right arm: the lighter hand bobs with your step, drops when you run, shakes when he has you
    this.sprintK = lerp(this.sprintK, o.sprint ? 1 : 0, 1 - Math.exp(-dt * 7));
    const bob = Math.min(1, (o.speed || 0) / 3), sw = Math.sin(this.phase), sw2 = Math.sin(this.phase * 2);
    const m = this.fl.model, b = this.base, shake = o.grabbed ? 0.012 : 0;
    m.position.set(
      b.x + sw * 0.006 * bob + this.sprintK * 0.03 + (Math.random() - 0.5) * shake,
      b.y - Math.abs(sw2) * 0.004 * bob - this.sprintK * (0.045 + 0.02 * sw) + Math.sin(this.t * 1.3) * 0.0015 + (Math.random() - 0.5) * shake,
      b.z + this.sprintK * 0.02 * sw);
    if (this.rh) {   // thumb down on the wheel while it burns, lifted when it is out
      const k = 1 - Math.exp(-dt * 12); this.rt[1] = lerp(this.rt[1], o.lighterOn ? 0.36 : 0.08, k); this.rt[0] = lerp(this.rt[0], o.lighterOn ? 0.16 : 0.06, k);
      this.rh.pose(this.rc, this.rt, 0);
    }
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
    if (o.pose) { target = POSE[o.pose]; rate = 1e3; showCig = ['carry', 'mouth', 'flame'].includes(o.pose); showBottle = o.pose.startsWith('sip'); }
    const k = 1 - Math.exp(-dt * rate), c = this.cur;
    c.p.x = lerp(c.p.x, target.p[0], k); c.p.y = lerp(c.p.y, target.p[1], k); c.p.z = lerp(c.p.z, target.p[2], k);
    c.q.slerp(target.q, k);
    for (let i = 0; i < 4; i++) c.c[i] = lerp(c.c[i], target.c[i], k);
    c.t[0] = lerp(c.t[0], target.t[0], k); c.t[1] = lerp(c.t[1], target.t[1], k); c.s = lerp(c.s, target.s || 0, k);
    const g = this.left, w = wig ? Math.sin(this.t * 9) * 0.008 : 0, sh = o.grabbed ? (Math.random() - 0.5) * 0.02 : 0;
    g.position.set(c.p.x - sw * 0.004 * bob + w + sh, c.p.y - Math.abs(sw2) * 0.004 * bob + (wig ? Math.cos(this.t * 7) * 0.006 : 0) + sh, c.p.z);
    g.quaternion.copy(c.q);
    if (wig) g.rotateX(Math.sin(this.t * 5) * 0.06);
    g.visible = !o.hidden && c.p.y > POSE.rest.p[1] + 0.04;
    if (this.lh && g.visible) this.lh.pose(c.c, c.t, c.s);
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
