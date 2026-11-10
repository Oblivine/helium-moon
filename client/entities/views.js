// Client-side views of networked state: snapshot interpolation, the two creatures,
// teammates' avatars, and the objective / item / extraction props.
import * as THREE from 'three';
import { groundAt } from '../../shared/physics.js';
import { loadCharacter } from './character.js';
import { HeliumAnimator, SkunkAnimator } from './animators.js';
import { angleDiff, clamp, lerp } from '../../shared/math.js';
import { makeTextTexture } from '../render/textures.js';
import { patchMaterial } from '../render/shaderlib.js';
import { NOTES } from '../../shared/sim/objectives.js';
import { CONFIG } from '../../shared/config.js';

// ------------------------------------------------------------------ interpolation
export class SnapBuffer {
  // jump: if x/z (indices 0, 2) move farther than this between two snapshots, it's a
  // relocation (e.g. Helium Voice's unseen reposition), not motion: hold, then snap.
  constructor(angles = [], discrete = [], jump = Infinity) { this.buf = []; this.angles = new Set(angles); this.discrete = new Set(discrete); this.jump = jump; this.out = []; }
  push(t, a) {
    if (!a) return;
    const b = this.buf;
    if (b.length && t <= b[b.length - 1].t) { if (t === b[b.length - 1].t) b[b.length - 1].a = a; else b.length = 0; }
    b.push({ t, a });
    if (b.length > 40) b.shift();
  }
  clear() { this.buf.length = 0; }
  latest() { return this.buf.length ? this.buf[this.buf.length - 1].a : null; }
  sample(rt) {
    const b = this.buf;
    if (!b.length) return null;
    if (rt <= b[0].t) return b[0].a;
    let i = b.length - 1;
    if (rt >= b[i].t) return b[i].a;   // no extrapolation: hold the last state
    while (i > 0 && b[i - 1].t > rt) i--;
    const A = b[i - 1], B = b[i], k = (rt - A.t) / Math.max(1e-6, B.t - A.t);
    if (this.jump < Infinity) { const dx = B.a[0] - A.a[0], dz = B.a[2] - A.a[2]; if (dx * dx + dz * dz > this.jump * this.jump) return k < 1 ? A.a : B.a; }
    const o = this.out; o.length = A.a.length;
    for (let j = 0; j < A.a.length; j++) {
      const x = A.a[j], y = B.a[j];
      if (typeof x !== 'number' || this.discrete.has(j)) o[j] = k < 0.5 ? x : y;
      else if (this.angles.has(j)) o[j] = x + angleDiff(x, y) * k;
      else o[j] = x + (y - x) * k;
    }
    return o;
  }
}

// ------------------------------------------------------------------ Helium Voice
export class HeliumView {
  static async create(scene, world) { const v = new HeliumView(); await v._load(scene); v.world = world; return v; }
  async _load(scene) {
    this.char = await loadCharacter('helium');
    // The current Helium model must never expose legacy rig helpers/control strings.
    // This also protects clients that receive a model revision containing those meshes.
    this.char.root.traverse((node) => {
      if (/string|puppet|control|crossbar/i.test(node.name || '')) node.visible = false;
    });
    this.root = this.char.root; this.root.visible = false;
    scene.add(this.root);
    // While prone in foliage, dull the material so a flashlight catches a vague shape rather
    // than a bright human-shaped target.  Restore the exact authored colours before he rises.
    this.lieMaterials = [];
    for (const mesh of Object.values(this.char.meshes)) {
      const material = mesh.material;
      if (material?.color) this.lieMaterials.push({ material, color: material.color.clone() });
    }
    this.anim = new HeliumAnimator(this.char);
    this.head = this.char.bones.head;
    this.pos = new THREE.Vector3(); this.state = 0; this.flags = 8; this.speed = 0; this.yaw = 0;
    this.stepAcc = 0; this.supportBlend = 1;
    this.ground = (x, z) => {
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      return (groundAt(this.world, this.pos.x + c * x + s * z, this.pos.z - s * x + c * z) - this.pos.y)*this.supportBlend;
    };
  }
  // s: [x,y,z,yaw,lookYaw,lookPitch,speed,flags,tilt,jaw,stateIdx, grabKind,grabPhase,peek]
  // flags: 1 run, 2 reach, 4 still, 8 hidden, 16 low (operated crawl), 128 frozen, 256 collapse,
  // 512 prone, 1024 rise, 2048 grab, 4096 backing away (see HeliumVoiceAI.snapshot)
  // camPos is accepted for the common entity-view update interface.
  update(dt, s, camPos = null) {
    if (!s) { this.root.visible = false; return; }
    const [x, y, z, yaw, lookYaw, lookPitch, speed, flags, tilt, jaw, st] = s;
    const wasVisible = this.root.visible;
    this.flags = flags; this.state = st; this.speed = speed;
    this.root.visible = !(flags & 8);
    // Always update at the render cadence.  His unnatural movement comes from the animation,
    // not an artificial low-frame-rate effect.
    const step = Math.max(0,Math.min(dt,.1));
    const prev = this.pos.clone();
    this.pos.set(x, y, z);
    const reset=!wasVisible || prev.distanceToSquared(this.pos)>64;
    // Keep authoritative/interpolated positions exact. Ease just the rendered
    // heading so a fresh route or an angle wrap cannot whip the whole rig.
    if(reset)this.yaw=yaw;
    else this.yaw+=clamp(angleDiff(this.yaw,yaw)*(1-Math.exp(-step*14)),-12*step,12*step);
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.moved = prev.distanceTo(this.pos);
    // whole-body tip about his feet: goes limp (falls forward), lying flat, the plank rise
    const collapse = !!(flags & 256), prone = !!(flags & 512), rise = !!(flags & 1024);
    const concealedLie = prone && !rise;
    for (const entry of this.lieMaterials) entry.material.color.copy(entry.color).multiplyScalar(concealedLie ? 0.42 : 1);
    if (rise) {
      if(this.riseT==null){
        this.riseT=0;this.riseFrom=reset?Math.PI/2*.97:(this.tip||0);
      }
      this.riseT+=step;
    } else this.riseT = null;
    let tipTo = 0;
    if (collapse || prone) tipTo = Math.PI / 2 * 0.97;
    if (rise) { const u = clamp(this.riseT / CONFIG.HV.RISE_TIME, 0, 1); tipTo = this.riseFrom * (1 - u * u * (3 - 2 * u)); this.tip = tipTo; }
    else if (collapse) { this.tipV = (this.tipV || 0) + step * 9; this.tip = Math.min(tipTo, (this.tip || 0) + this.tipV * step); }   // drops, accelerating
    else { this.tipV = 0; this.tip = lerp(this.tip || 0, tipTo, 1 - Math.exp(-step * (prone ? 12 : 6))); }
    this.root.rotation.set(this.tip, this.yaw, 0, 'YXZ');
    const tipped = this.tip > 0.05;
    this.supportBlend=1-clamp((this.tip-.03)/.17,0,1);
    if (this.root.visible) {
      this.anim.update(step, { speed: tipped ? 0 : speed, run: !!(flags & 1), reach: flags & 2 ? 1 : 0, still: !!(flags & 4), crawl: !!(flags & 16),
        frozen: !!(flags & 128), back: !!(flags & 4096), limp: collapse, rigid: prone || rise,
        grab: flags & 2048 ? (s[11] || 1) : 0, grabPhase: s[12] || 0, peek: s[13] || 0,
        crouch: s[13] === 2 ? 0.85 : (flags & 2048 && s[11] === 5 && s[12] === 2) ? 0.55 : collapse ? 0.9 : 0,
        lookYaw: angleDiff(this.yaw, lookYaw), lookPitch: -lookPitch, tilt, jaw, armSwing: 0.04, snap: !!(flags & 4), unnatural: true, yaw:this.yaw, state: st,
        ground: this.world ? this.ground : null });
    }
  }
  headPos(out = new THREE.Vector3()) { this.root.updateMatrixWorld(true); return this.head.getWorldPosition(out); }
}

// ------------------------------------------------------------------ Sulfur Hexafluoride
export class SkunkView {
  static async create(scene, world = null) { const v = new SkunkView(); v.world = world; await v._load(scene); return v; }
  async _load(scene) {
    this.char = await loadCharacter('sf6');
    this.root = this.char.root; this.root.visible = false;
    this.root.scale.setScalar(CONFIG.SF.MODEL_SCALE);
    scene.add(this.root);
    this.anim = new SkunkAnimator(this.char);
    this.pos = new THREE.Vector3(); this.flags = 16; this.state = 0; this.speed = 0;
    this.ground = (x, z) => {
      const c = Math.cos(this.root.rotation.y), s = Math.sin(this.root.rotation.y), scale = CONFIG.SF.MODEL_SCALE;
      return (groundAt(this.world, this.pos.x + (c * x + s * z) * scale,
        this.pos.z + (-s * x + c * z) * scale) - this.pos.y) / scale;
    };
    const eyes = this.char.meshes.eyes;
    if (eyes) { eyes.material = eyes.material.clone(); this.eyeMat = eyes.material; }
  }
  // s: [x,y,z,yaw,lookYaw,speed,flags,jaw,stateIdx]
  update(dt, s, shine = 0) {
    if (!s) { this.root.visible = false; return; }
    const [x, y, z, yaw, lookYaw, speed, flags, jaw, st] = s;
    this.pos.set(x, y, z); this.flags = flags; this.state = st; this.speed = speed;
    this.root.visible = !(flags & 16);
    this.root.position.copy(this.pos); this.root.rotation.y = yaw;
    if (this.root.visible) this.anim.update(dt, { speed: speed / CONFIG.SF.MODEL_SCALE, fast: !!(flags & 1), rear: !!(flags & 2), gas: !!(flags & 4), low: !!(flags & 8), lookYaw: angleDiff(yaw, lookYaw), jaw, ground: this.world ? this.ground : null });
    // tapetum eyeshine: the eyes throw the flashlight back
    if (this.eyeMat) { const k = 0.45 + shine * 9; this.eyeMat.color.setRGB(k * 0.9, k * 0.85, k * 0.55); }
  }
  headPos(out = new THREE.Vector3()) { return this.char.bones.head.getWorldPosition(out); }
}

// ------------------------------------------------------------------ teammates
export const PLAYER_COLORS = [0x2f6d8c, 0xb5652a, 0x6b7f2e, 0x7b3f8c, 0xa8962e, 0x8c2f45];

function labelSprite(text, color) {
  const tex = makeTextTexture([{ text, font: '500 34px Inter, sans-serif', color }], { w: 256, h: 64, bg: null, pad: 12 });
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.85, fog: false });
  const s = new THREE.Sprite(m); s.scale.set(0.9, 0.225, 1); s.renderOrder = 5;
  return s;
}

export class PlayerAvatar {
  static async create(scene, id, name, idx, world = null) { const v = new PlayerAvatar(); v.world = world; await v._load(scene, id, name, idx); return v; }
  async _load(scene, id, name, idx) {
    this.id = id; this.name = name; this.color = PLAYER_COLORS[idx % PLAYER_COLORS.length];
    this.char = await loadCharacter('hiker', { tint: this.color });
    this.root = this.char.root; scene.add(this.root);
    this.anim = new HeliumAnimator(this.char);
    this.label = labelSprite(name, '#' + this.color.toString(16).padStart(6, '0'));
    this.label.position.y = 2.05; this.root.add(this.label);
    this.pos = new THREE.Vector3(); this.prev = new THREE.Vector3(); this.speed = 0; this.yaw = 0; this.pitch = 0;
    this.flags = 0; this.state = 0; this.health = 2; this.stride = 0; this.lie = 0; this.first = true;
    this.ground = (x, z) => {
      const yaw = this.root.rotation.y, c = Math.cos(yaw), s = Math.sin(yaw);
      return groundAt(this.world, this.pos.x + c * x + s * z, this.pos.z - s * x + c * z) - this.pos.y;
    };
    // Cosmetic remote reaction only: it never changes the authoritative player
    // yaw, position or input. The game uses lightYaw solely for that avatar's
    // rendered flashlight.
    this.fearT = 0; this.recoil = 0; this.fearYaw = 0; this.lightYaw = 0;
  }
  reactToThreat(at, hit = false) {
    if (!at) return;
    this.fearYaw = Math.atan2(at.x - this.pos.x, at.z - this.pos.z);
    this.fearT = Math.max(this.fearT, hit ? 1.05 : 0.62);
    this.recoil = Math.max(this.recoil, hit ? 1 : 0.45);
  }
  // s: [id,x,y,z,yaw,pitch,flags,health,stateIdx,reviveProg,bleedT,lean?]
  update(dt, s, cameraPos) {
    const [, x, y, z, yaw, pitch, flags, health, st] = s;
    this.prev.copy(this.pos);
    this.pos.set(x, y, z);
    if (this.first) { this.prev.copy(this.pos); this.first = false; }
    const sp = dt > 0 ? Math.hypot(this.pos.x - this.prev.x, this.pos.z - this.prev.z) / dt : 0;
    this.speed = lerp(this.speed, Math.min(sp, 7), 1 - Math.exp(-dt * 8));
    this.yaw = yaw; this.pitch = pitch; this.flags = flags; this.state = st; this.health = health;
    this.fearT = Math.max(0, this.fearT - dt);
    this.recoil = Math.max(0, this.recoil - dt * 1.8);
    const fear = clamp(this.fearT * 1.7, 0, 1);
    this.lightYaw = yaw + angleDiff(yaw, this.fearYaw) * fear;
    this.root.visible = st !== 3;
    const down = st === 1 || st === 2;
    this.lie = lerp(this.lie, down ? 1 : 0, 1 - Math.exp(-dt * 4));
    this.root.position.set(x, y + this.lie * 0.18, z);
    this.root.rotation.set(-this.lie * 1.45, yaw + Math.PI, 0, 'YXZ');
    this.anim.update(dt, { speed: down ? 0 : this.speed, run: !!(flags & 4) && this.speed > 3, crouch: flags & 1 ? 1 : 0,
      lookYaw: angleDiff(yaw, this.lightYaw), lookPitch: pitch * 0.8, reach: this.recoil * 0.25, snap: fear > 0.75, armSwing: 0.35,
      sideLean: down ? 0 : (s[11] || 0), ground: this.world && !down ? this.ground : null });
    const d = cameraPos ? cameraPos.distanceTo(this.pos) : 0;
    this.label.material.opacity = clamp(1 - (d - 6) / 14, 0, 0.85) * (st === 2 ? 0.4 : 1);
    this.label.visible = this.label.material.opacity > 0.02;
  }
  handPos(out = new THREE.Vector3()) {
    const f = -Math.sin(this.yaw), g = -Math.cos(this.yaw);
    const h = lerp(this.flags & 1 ? 1.05 : 1.4, 0.3, this.lie);
    return out.set(this.pos.x + f * 0.35 + g * -0.18, this.pos.y + h, this.pos.z + g * 0.35 - f * -0.18);
  }
  dispose(scene) { scene.remove(this.root); }
}

// ------------------------------------------------------------------ objectives, items, extraction
const ORANGE = 0xc2581a;

function std(o, key) { return patchMaterial(new THREE.MeshStandardMaterial({ envMapIntensity: 0.35, ...o }), { key }); }

function glintTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.15, 'rgba(255,250,235,0.6)'); grd.addColorStop(1, 'rgba(255,240,220,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  g.globalCompositeOperation = 'lighter'; g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(32, 4); g.lineTo(32, 60); g.moveTo(4, 32); g.lineTo(60, 32); g.stroke();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class ObjectiveViews {
  constructor(scene, mats) {
    this.scene = scene; this.m = mats;
    this.group = new THREE.Group(); this.group.name = 'objectives'; scene.add(this.group);
    this.items = new Map(); this.stations = new Map();
    this.glintTex = glintTexture();
    // lights are created once (stable light count -> no shader recompiles)
    this.workLight = new THREE.PointLight(0xffc68a, 0, 14, 2); scene.add(this.workLight);
    this.extractLight = new THREE.PointLight(0xff2020, 0, 45, 1.6); scene.add(this.extractLight);
    this.mats = {
      redPlastic: std({ color: 0xa3170e, roughness: 0.45 }, 'redplastic'),
      orange: std({ color: ORANGE, roughness: 0.5 }, 'orangeplastic'),
      black: std({ color: 0x151515, roughness: 0.6 }, 'blackplastic'),
      gold: std({ color: 0xb08a3a, roughness: 0.35, metalness: 0.7 }, 'gold'),
      grey: std({ color: 0x8b8f92, roughness: 0.45, metalness: 0.6 }, 'greymetal'),
      ledOff: new THREE.MeshBasicMaterial({ color: 0x220806 }),
      paper: null,
    };
  }

  clear() {
    for (const c of [...this.group.children]) this.group.remove(c);
    this.items.clear(); this.stations.clear();
    this.workLight.intensity = 0; this.extractLight.intensity = 0; this.extract = null;
  }

  build(layout, world) {
    this.clear();
    this.layout = layout;
    for (const s of layout.stations) this._station(s, world);
    for (const it of layout.items) this._item(it, world);
    this._extract(layout.extract, world);
  }

  _place(obj, x, y, z, rot) { obj.position.set(x, y, z); obj.rotation.y = rot || 0; this.group.add(obj); obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); return obj; }

  _station(s, world) {
    const g = new THREE.Group(), M = this.m, X = this.mats;
    let rotor=null,handwheel=null;
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), new THREE.MeshBasicMaterial({ color: 0x300404 }));
    if (s.kind === 'generator') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.44, 0.46), X.redPlastic); body.position.y = 0.32; g.add(body);
      const tank = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.36), X.black); tank.position.y = 0.6; g.add(tank);
      const frame = new THREE.CylinderGeometry(0.018, 0.018, 0.72, 6);
      for (const [x, z] of [[-0.34, -0.26], [0.34, -0.26], [-0.34, 0.26], [0.34, 0.26]]) { const f = new THREE.Mesh(frame, X.black); f.position.set(x, 0.36, z); g.add(f); }
      const bar = new THREE.CylinderGeometry(0.018, 0.018, 0.68, 6); bar.rotateZ(Math.PI / 2);
      for (const z of [-0.26, 0.26]) { const b = new THREE.Mesh(bar, X.black); b.position.set(0, 0.72, z); g.add(b); }
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.2, 0.3), M.dark); panel.position.set(0.32, 0.35, 0); g.add(panel);
      led.position.set(0.335, 0.42, 0.1); g.add(led);
      this.workLight.position.set(s.x, s.y + 1.6, s.z);
    } else if (s.kind === 'relay') {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.3, 0.1), M.wood); post.position.y = 0.65; g.add(post);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.52, 0.2), X.grey); box.position.set(0, 1.05, 0.11); g.add(box);
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.48, 0.015), X.grey); door.position.set(0, 1.05, 0.22); g.add(door);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.1), new THREE.MeshStandardMaterial({ map: makeTextTexture([{ text: 'DANGER 240V', font: 'bold 40px Inter' }], { w: 384, h: 128, bg: '#c9a51c', fg: '#111' }), roughness: 0.6 }));
      sign.position.set(0, 1.2, 0.229); g.add(sign);
      led.position.set(0.15, 0.85, 0.23); g.add(led);
    } else if(s.kind==='antenna') {
      const pole=new THREE.Mesh(new THREE.CylinderGeometry(.045,.065,1.85,12),M.metal);
      pole.position.y=.925;g.add(pole);
      for(const angle of [0,Math.PI*2/3,Math.PI*4/3]){
        const foot=new THREE.Mesh(new THREE.BoxGeometry(.06,.07,.8),M.metal);
        foot.position.set(Math.sin(angle)*.35,.06,Math.cos(angle)*.35);foot.rotation.y=angle;g.add(foot);
      }
      const panel=new THREE.Mesh(new THREE.BoxGeometry(.42,.45,.22),X.grey);panel.position.set(0,.78,.12);g.add(panel);
      const compass=new THREE.Mesh(new THREE.PlaneGeometry(.34,.18),new THREE.MeshStandardMaterial({map:makeTextTexture([
        {text:'RIVER AERIAL',font:'bold 34px Arial'},{text:'N  NE  E  SE  S  SW  W  NW',font:'22px Arial'},
      ],{w:512,h:180,bg:'#d5cead',fg:'#202820'}),roughness:.9}));compass.position.set(0,.91,.235);g.add(compass);
      handwheel=new THREE.Mesh(new THREE.TorusGeometry(.13,.018,8,20),X.orange);
      handwheel.position.set(0,.67,.26);handwheel.visible=false;g.add(handwheel);
      rotor=new THREE.Group();rotor.position.y=1.62;g.add(rotor);
      const reflectorMaterial=M.metal.clone();reflectorMaterial.side=THREE.DoubleSide;
      const reflector=new THREE.Mesh(new THREE.LatheGeometry([new THREE.Vector2(.02,0),new THREE.Vector2(.12,.012),
        new THREE.Vector2(.25,.045),new THREE.Vector2(.42,.12)],24),reflectorMaterial);
      reflector.rotation.x=Math.PI/2-.12;rotor.add(reflector);
      const feed=new THREE.Mesh(new THREE.CylinderGeometry(.012,.012,.4,8),X.grey);
      feed.rotation.x=Math.PI/2;feed.position.z=.2;rotor.add(feed);
      const cap=new THREE.Mesh(new THREE.BoxGeometry(.07,.07,.1),X.black);cap.position.z=.4;rotor.add(cap);
      led.position.set(.15,.7,.24);g.add(led);
      rotor.rotation.y=Math.PI-(s.dial||0)*Math.PI/4;
    } else {
      const cab = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.45, 0.42), X.grey); cab.position.y = 0.72; g.add(cab);
      const vent = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.01), M.dark); vent.position.set(0, 1.25, 0.215); g.add(vent);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.18), new THREE.MeshStandardMaterial({ map: makeTextTexture([{ text: 'EMERGENCY', font: 'bold 44px Inter' }, { text: 'REPEATER CH.4', font: '30px Inter' }], { w: 384, h: 160, bg: '#d9d4c8', fg: '#7a1010' }), roughness: 0.6 }));
      sign.position.set(0, 0.95, 0.215); g.add(sign);
      led.position.set(0.22, 1.35, 0.22); g.add(led);
    }
    this._place(g, s.x, s.y, s.z, s.kind==='antenna'?0:(s.rot || 0) + Math.PI);
    this.stations.set(s.id, { def: s, obj: g, led, done: false,rotor,handwheel,dial:s.dial||0 });
  }

  _item(it, world) {
    const X = this.mats;
    let g = new THREE.Group();
    if (it.kind === 'fuel') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.3, 0.32), X.redPlastic); body.position.y = 0.15; g.add(body);
      const h = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.014, 6, 12, Math.PI), X.redPlastic); h.position.set(0, 0.3, -0.04); h.rotation.y = Math.PI / 2; g.add(h);
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.12, 8), X.black); sp.position.set(0, 0.33, 0.12); sp.rotation.x = 0.6; g.add(sp);
      g.rotation.z = 0.0;
    } else if (it.kind === 'fuse') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.11, 0.24), X.orange); body.position.y = 0.055; g.add(body);
      const lab = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.08), new THREE.MeshStandardMaterial({ map: makeTextTexture([{ text: 'FUSE KIT', font: 'bold 44px Inter' }], { w: 256, h: 96, bg: '#efe9db', fg: '#222' }) }));
      lab.rotation.x = -Math.PI / 2; lab.position.y = 0.111; g.add(lab);
    } else if(it.kind==='crank') {
      const rim=new THREE.Mesh(new THREE.TorusGeometry(.16,.022,8,24),X.orange);
      rim.rotation.x=Math.PI/2;rim.position.y=.035;g.add(rim);
      for(const yaw of [0,Math.PI/2]){
        const spoke=new THREE.Mesh(new THREE.BoxGeometry(.29,.025,.025),X.grey);
        spoke.position.y=.035;spoke.rotation.y=yaw;g.add(spoke);
      }
      const hub=new THREE.Mesh(new THREE.CylinderGeometry(.035,.035,.065,6),X.grey);hub.position.y=.035;g.add(hub);
    } else if (it.kind === 'battery') {
      // a spare disposable lighter lying on its side
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.012, 0.068), new THREE.MeshStandardMaterial({ color: 0x1d5c8c, roughness: 0.45 }));
      body.position.y = 0.006; g.add(body);
      const top = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.011, 0.012), X.grey); top.position.set(0, 0.006, 0.04); g.add(top);
    } else if (it.kind === 'cigs') {
      // a soft pack lying flat, one cigarette shaken half out
      const pack = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.022, 0.085), new THREE.MeshStandardMaterial({ color: 0xc9c2b2, roughness: 0.8 }));
      pack.position.y = 0.011; g.add(pack);
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.023, 0.03), new THREE.MeshStandardMaterial({ color: 0x8c1b14, roughness: 0.7 })); band.position.set(0, 0.011, -0.012); g.add(band);
      const cig = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.07, 6), new THREE.MeshStandardMaterial({ color: 0xe6e2d6, roughness: 0.9 }));
      cig.rotation.x = Math.PI / 2; cig.position.set(0.012, 0.016, 0.06); g.add(cig);
    } else if (it.kind === 'beer') {
      // a brown longneck standing in the dirt
      const glass = new THREE.MeshStandardMaterial({ color: 0x4a2a0e, roughness: 0.25, metalness: 0.1 });
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.13, 10), glass); b.position.y = 0.065; g.add(b);
      const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.03, 0.035, 10), glass); sh.position.y = 0.147; g.add(sh);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.012, 0.06, 8), glass); neck.position.y = 0.195; g.add(neck);
      const lab = new THREE.Mesh(new THREE.CylinderGeometry(0.0305, 0.0305, 0.055, 10), new THREE.MeshStandardMaterial({ color: 0xb89a55, roughness: 0.8 })); lab.position.y = 0.07; g.add(lab);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0125, 0.0125, 0.008, 8), X.grey); cap.position.y = 0.228; g.add(cap);
    } else if (it.kind === 'blanket') {
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.36, 5, 4), new THREE.MeshStandardMaterial({ color: 0x3b4a2c, roughness: 1, side: THREE.DoubleSide }));
      cloth.rotation.x = -Math.PI / 2; cloth.rotation.z = 0.28; cloth.position.y = 0.025;
      const folds = cloth.geometry.attributes.position;
      for (let i = 0; i < folds.count; i++) folds.setY(i, Math.sin(i * 5.7) * 0.012);
      folds.needsUpdate = true; g.add(cloth);
    } else if (it.kind === 'note') {
      const n = NOTES.find((q) => q.id === it.note);
      const lines = (n ? n.text : '').split('\n').slice(0, 7).map((t) => ({ text: t.length > 34 ? t.slice(0, 33) + '…' : t, font: 'italic 19px "Cormorant Garamond", Georgia, serif', lh: 1.4 }));
      const tex = makeTextTexture(lines, { w: 320, h: 420, bg: '#d8d1bd', fg: '#2a2620', align: 'left', pad: 22 });
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.21, 0.28), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, side: THREE.DoubleSide }));
      if (it.wall) { paper.position.set(0, 0, 0.02); }
      else { paper.rotation.x = -Math.PI / 2; paper.rotation.z = 0.4; paper.position.y = 0.012; }
      g.add(paper);
    }
    const y = it.wall ? it.y : (world ? world.heightAt(it.x, it.z) : it.y);
    this._place(g, it.x, y, it.z, it.rot || 0);
    if (it.wall) g.rotation.y = (it.rot || 0);
    const glint = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glintTex, color: 0xfff4e0, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    glint.scale.setScalar(0.35); glint.position.y = it.kind === 'fuel' ? 0.3 : 0.12;
    g.add(glint);
    this.items.set(it.id, { def: it, obj: g, glint, held: false, y });
  }

  _extract(ex, world) {
    if (!ex) return;
    const g = new THREE.Group(), M = this.m;
    const paint = std({ color: 0xe8e8e6, roughness: 0.3, metalness: 0.5, envMapIntensity: 0.9 }, 'policepaint');
    const s = new THREE.Shape();
    s.moveTo(-2.4, 0.32); s.lineTo(-2.45, 0.74); s.quadraticCurveTo(-2.4, 0.9, -2.1, 0.92); s.lineTo(-1.2, 0.97);
    s.quadraticCurveTo(-0.8, 1.45, -0.45, 1.47); s.lineTo(0.9, 1.47); s.quadraticCurveTo(1.25, 1.45, 1.6, 1.0);
    s.lineTo(2.3, 0.92); s.quadraticCurveTo(2.46, 0.87, 2.46, 0.64); s.lineTo(2.4, 0.32); s.closePath();
    const body = new THREE.ExtrudeGeometry(s, { depth: 1.8, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 3, curveSegments: 8 });
    body.translate(0, 0, -0.9);
    const car = new THREE.Mesh(body, paint); car.rotation.y = Math.PI / 2; g.add(car);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.42, 1.9), M.dark); door.position.set(0.97, 0.62, 0); g.add(door);
    const door2 = door.clone(); door2.position.x = -0.97; g.add(door2);
    const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 16); wheel.rotateZ(Math.PI / 2);
    for (const [x, z] of [[0.86, 1.5], [-0.86, 1.5], [0.86, -1.45], [-0.86, -1.45]]) { const w = new THREE.Mesh(wheel, M.rubber); w.position.set(x, 0.34, z); g.add(w); }
    const barMat = new THREE.MeshBasicMaterial({ color: 0x220000 }), barMat2 = new THREE.MeshBasicMaterial({ color: 0x000022 });
    const lb1 = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.1, 0.25), barMat); lb1.position.set(-0.3, 1.58, 0.1); g.add(lb1);
    const lb2 = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.1, 0.25), barMat2); lb2.position.set(0.3, 1.58, 0.1); g.add(lb2);
    const hl = new THREE.MeshBasicMaterial({ color: 0x111111 });
    for (const x of [-0.6, 0.6]) { const h = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.12, 0.04), hl); h.position.set(x, 0.74, 2.47); g.add(h); }
    const y = world ? world.heightAt(ex.x + 4, ex.z + 3) : ex.y;
    this._place(g, ex.x + 4, y, ex.z + 3, 2.3);
    g.visible = false;
    // road flare
    const flare = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.22, 8), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    flare.rotation.z = 1.3;
    this._place(flare, ex.x, (world ? world.heightAt(ex.x, ex.z) : ex.y) + 0.03, ex.z, 0);
    flare.visible = false;
    this.extract = { def: ex, car: g, lb1, lb2, barMat, barMat2, flare, hl, open: false, t: 0 };
  }

  setHeld(id, held) { const it = this.items.get(id); if (it) { it.held = held; it.obj.visible = !held; } }

  // obj snapshot: {st:[[id,done,prog]], it:[heldIds], team, ex}
  apply(o) {
    if (!o) return;
    const held = new Set(o.it);
    for (const [id, it] of this.items) if (it.held !== held.has(id)) this.setHeld(id, held.has(id));
    for (const [id, done, prog, dial] of o.st) {
      const s = this.stations.get(id); if (!s) continue;
      s.prog = prog;
      if(Number.isFinite(dial))s.dial=dial;
      if(s.handwheel)s.handwheel.visible=!!o.team.crank;
      if (done && !s.done) { s.done = true; s.led.material.color.setRGB(0.2, 3, 0.4); }
    }
    if (this.extract && o.ex && !this.extract.open) { this.extract.open = true; this.extract.car.visible = true; this.extract.flare.visible = true; this.extract.hl.color.setRGB(3, 3, 2.6); }
  }

  update(dt, time, flash) {
    for(const s of this.stations.values())if(s.rotor){
      const turn=angleDiff(s.rotor.rotation.y,Math.PI-s.dial*Math.PI/4)*(1-Math.exp(-dt*7));
      s.rotor.rotation.y+=turn;
      if(s.handwheel)s.handwheel.rotation.z-=turn*2;
    }
    // glints: an item's shiny parts catch your lighter's flame when you are close and facing it
    const R = flash?.range || 32;
    for (const it of this.items.values()) {
      if (it.held) continue;
      let k = 0;
      if (flash && flash.on) {
        const dx = it.def.x - flash.pos.x, dy = it.y + 0.15 - flash.pos.y, dz = it.def.z - flash.pos.z;
        const d = Math.hypot(dx, dy, dz);
        if (d < R && d > 0.6) {
          const c = (dx * flash.dir.x + dy * flash.dir.y + dz * flash.dir.z) / d;
          k = clamp((c - (flash.range ? 0.5 : 0.93)) / (flash.range ? 0.4 : 0.05), 0, 1) * clamp(1 - d / R, 0, 1) * flash.k;
          k *= 0.55 + 0.45 * Math.sin(time * 9 + it.def.x);
        }
      }
      it.glint.material.opacity = lerp(it.glint.material.opacity, k, 1 - Math.exp(-dt * 12));
      it.glint.visible = it.glint.material.opacity > 0.01;
    }
    const gen = this.stations.get('gen');
    this.workLight.intensity = gen && gen.done ? 9 * (0.93 + 0.07 * Math.sin(time * 37)) : 0;
    const e = this.extract;
    if (e && e.open) {
      e.t += dt;
      const ph = (e.t * 2.4) % 2, red = ph < 1, strobe = Math.sin(e.t * 40) > 0;
      e.barMat.color.setRGB(red && strobe ? 8 : 0.15, 0.02, 0.02);
      e.barMat2.color.setRGB(0.02, 0.05, !red && strobe ? 9 : 0.15);
      this.extractLight.position.set(e.car.position.x, e.car.position.y + 2, e.car.position.z);
      this.extractLight.color.setRGB(red ? 1 : 0.15, 0.08, red ? 0.06 : 1);
      this.extractLight.intensity = strobe ? 55 : 8;
      e.flare.material.color.setRGB(9 + Math.random() * 3, 1.2, 0.6);
    }
  }
}
