// The player's light (owner, Oct 25 2026: "replace the flashlight with a small lighter ... only
// light nearby the player and not be a beam"). A disposable lighter held low in the right hand:
// an omni flame light with a few metres of reach, a visible flame on the view model, flicker
// and gutter (stronger near him and when he runs at you), fuel, and a strike that can fail.
// The class keeps the old Flashlight interface (on, light, dir, battery, toggle, snap, update)
// so the rest of the game - and the simulation's `flash` flag - did not have to change.
import * as THREE from 'three';
import { CONFIG } from '../../shared/config.js';
import { clamp, lerp } from '../../shared/math.js';
import { horrorCues } from '../../shared/horror.js';

const F = CONFIG.FLASHLIGHT;

function flameTexture() {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128;
  const g = cv.getContext('2d');
  // a teardrop: blue root, white-yellow core, orange edge
  const grd = g.createRadialGradient(32, 84, 2, 32, 74, 46);
  grd.addColorStop(0, 'rgba(255,255,235,1)'); grd.addColorStop(0.25, 'rgba(255,214,120,0.95)');
  grd.addColorStop(0.55, 'rgba(255,128,32,0.55)'); grd.addColorStop(1, 'rgba(255,90,10,0)');
  g.fillStyle = grd;
  g.beginPath(); g.moveTo(32, 6); g.bezierCurveTo(54, 52, 50, 118, 32, 120); g.bezierCurveTo(14, 118, 10, 52, 32, 6); g.fill();
  const root = g.createRadialGradient(32, 114, 1, 32, 114, 12);
  root.addColorStop(0, 'rgba(90,140,255,0.9)'); root.addColorStop(1, 'rgba(60,90,255,0)');
  g.fillStyle = root; g.fillRect(16, 100, 32, 28);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function glowTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,190,110,0.55)'); grd.addColorStop(0.35, 'rgba(255,150,60,0.18)'); grd.addColorStop(1, 'rgba(255,120,30,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class Flashlight {
  constructor(scene, preset, camera = null) {
    // omni: lights all round you, falls off within RANGE m (no cone, no beam, no cookie)
    const L = this.light = new THREE.PointLight(0xffa54d, 0, F.RANGE, 2);
    L.castShadow = false;
    // legacy cone fields some shaders read (an omni light: the full sphere)
    L.angle = Math.PI / 2; L.penumbra = 1;
    scene.add(L);
    this.on = true; this.battery = 1;
    this.handQ = new THREE.Quaternion(); this.handPos = new THREE.Vector3();
    this.flicker = 1; this.flickerT = 0; this.flame = 1; this.lean = 0;
    this.dir = new THREE.Vector3(0, 0, -1);
    this.clickCb = null;
    this._off = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._last = new THREE.Vector3();
    // the view model: a small plastic lighter low in the right hand, flame on top
    const m = this.model = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.068, 0.012), this.bodyMat = new THREE.MeshBasicMaterial({ color: 0x8c1b14 }));
    m.add(body);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 0.011), this.guardMat = new THREE.MeshBasicMaterial({ color: 0xa8a8ac }));
    guard.position.y = 0.04; m.add(guard);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.009, 10), new THREE.MeshBasicMaterial({ color: 0x18181a }));
    wheel.rotation.z = Math.PI / 2; wheel.position.set(0, 0.047, -0.004); m.add(wheel);
    const fl = this.flameSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    fl.material.color.setScalar(0.5);
    fl.center.set(0.5, 0.05); fl.position.set(0, 0.05, 0); fl.scale.set(0.014, 0.03, 1); fl.renderOrder = 10;
    m.add(fl);
    // The view model is unlit (Update 0.9): the flame's point light sits a few centimetres from it,
    // and lit metal that close blew out into a bright square of bloom. Its brightness follows the flame.
    const glow = this.glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false }));
    glow.position.set(0, 0.062, 0); glow.scale.set(0.09, 0.09, 1); glow.renderOrder = 9; m.add(glow);
    m.traverse((o) => { o.frustumCulled = false; });
    if (camera) { camera.add(m); m.position.set(0.16, -0.15, -0.3); m.rotation.set(0.12, -0.25, 0.05); }
    else scene.add(m);
    this.camera = camera;
  }

  snap(camera) { this.handQ.copy(camera.quaternion); this._last.copy(camera.position); }

  // flick the wheel. Striking can fail (a spark, no flame), more often when he is coming for you.
  toggle(rush = 0) {
    if (this.on) { this.on = false; this.clickCb && this.clickCb(false, false); return 'off'; }
    if (this.battery <= 0) { this.clickCb && this.clickCb(false, true); return 'empty'; }
    if (Math.random() < F.STRIKE_FAIL + rush * 0.45) { this.spark = 0.12; return 'spark'; }
    this.on = true; this.flame = 0.2;
    this.clickCb && this.clickCb(true, false);
    return 'on';
  }

  addBattery(frac) { this.battery = Math.min(1, this.battery + frac); }

  update(dt, camera, terror, opts = {}) {
    this.handQ.slerp(camera.quaternion, 1 - Math.exp(-dt * 14));
    // the flame sits just above the lighter, low and to the right of your view
    const off = this._off.set(0.16, -0.1, -0.3).applyQuaternion(camera.quaternion);
    this.handPos.copy(camera.position).add(off);
    this.dir.set(0, 0, -1).applyQuaternion(this.handQ);
    this.light.position.copy(this.handPos);
    if (this.on) {
      this.battery = Math.max(0, this.battery - dt / F.BATTERY_SECONDS);
      if (this.battery <= 0) { this.on = false; this.clickCb && this.clickCb(false, true); }
    }
    // gutter: low fuel, his closeness, gas, and (owner) him running at you
    this.flickerT -= dt;
    if (this.flickerT <= 0) {
      const low = this.battery < F.LOW ? (1 - this.battery / F.LOW) : 0;
      const rush = opts.rush || 0;
      const p = low * 0.3 + horrorCues(terror).flicker * 0.14 + (opts.gas || 0) * 0.2 + rush * 0.6;
      if (Math.random() < p) {
        this.flicker = rush > 0.3 || low > 0 || opts.gas > 0.1 ? (Math.random() < 0.35 + rush * 0.3 ? 0.08 : 0.3 + Math.random() * 0.4) : 0.6 + Math.random() * 0.25;
        this.flickerT = 0.04 + Math.random() * 0.12;
      } else { this.flicker = 1; this.flickerT = 0.06 + Math.random() * 0.25; }
    }
    // moving fast bends the flame back and dims it
    const moved = dt > 0 ? this._last.distanceTo(camera.position) / dt : 0; this._last.copy(camera.position);
    this.lean = lerp(this.lean, clamp(moved / 6, 0, 1), 1 - Math.exp(-dt * 6));
    const lit = this.on && !opts.off;
    const t = performance.now() * 0.001;
    const dance = 0.86 + 0.08 * Math.sin(t * 23) + 0.05 * Math.sin(t * 37 + 1.3) + 0.04 * Math.sin(t * 61 + 0.4);
    this.flame = lerp(this.flame, lit ? this.flicker * dance * (1 - 0.35 * this.lean) : 0, 1 - Math.exp(-dt * (lit ? 18 : 30)));
    const fuel = this.battery < 0.25 ? lerp(0.55, 1, this.battery / 0.25) : 1;
    this.light.intensity = F.INTENSITY * this.flame * fuel;
    this.light.distance = F.RANGE * (0.75 + 0.25 * this.flame);
    this.light.color.setRGB(1, 0.6 + 0.08 * this.flame, 0.26 + 0.06 * this.flame);
    // the visible flame
    const s = this.flameSprite;
    this.spark = Math.max(0, (this.spark || 0) - dt);
    s.visible = this.flame > 0.03 || this.spark > 0;
    const h = this.spark > 0 && this.flame < 0.05 ? 0.012 : 0.034 * this.flame * fuel;
    s.scale.set(0.014 * (0.8 + 0.2 * this.flame), Math.max(0.006, h * 0.88), 1);
    s.material.rotation = -0.5 * this.lean + 0.06 * Math.sin(t * 9);
    s.material.opacity = this.spark > 0 && this.flame < 0.05 ? 0.9 : clamp(this.flame * 1.1, 0, 1);
    const lv = 0.035 + 0.5 * this.flame * fuel;   // the lighter itself: barely visible unlit, warm when lit
    this.bodyMat.color.setRGB(0.55 * lv, 0.1 * lv, 0.08 * lv); this.guardMat.color.setRGB(0.66 * lv, 0.6 * lv, 0.5 * lv);
    this.glowSprite.visible = this.flame > 0.03; this.glowSprite.material.opacity = clamp(this.flame * 0.8, 0, 1);
    this.model.visible = !opts.off;
  }
}
