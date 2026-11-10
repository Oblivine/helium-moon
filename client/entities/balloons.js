// Balloons (Update 0.9): Helium Voice's calling cards, and the co-op ping markers.
// The sim owns where balloons are (snapshot `bl`); this draws them: pale yellow latex on white
// string tied off to a stake, nodding in the night air. Pop: shreds and a falling string.
// Untied: it rises into the canopy and is gone.
import * as THREE from 'three';
import { CONFIG } from '../../shared/config.js';
import { clamp, lerp } from '../../shared/math.js';

const H = CONFIG.BALLOON.HEIGHT;

export class BalloonViews {
  constructor(scene) {
    this.scene = scene; this.items = new Map(); this.fx = []; this.t = 0;
    this.geo = new THREE.SphereGeometry(0.15, 18, 14);
    // a balloon is a little taller than it is wide, narrowing to the knot
    const p = this.geo.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i); const k = y < 0 ? 1 - 0.28 * (y / -0.15) ** 2 : 1; p.setXYZ(i, p.getX(i) * k, y * 1.22, p.getZ(i) * k); }
    this.geo.computeVertexNormals();
    this.mat = new THREE.MeshStandardMaterial({ color: 0xd9c35a, roughness: 0.28, metalness: 0, emissive: 0x15120a });
    this.knotGeo = new THREE.ConeGeometry(0.018, 0.035, 6);
    this.stringMat = new THREE.LineBasicMaterial({ color: 0xcfcabd, transparent: true, opacity: 0.75 });
    this.stakeGeo = new THREE.CylinderGeometry(0.012, 0.016, 0.3, 5);
    this.stakeMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.9 });
    this.shredGeo = new THREE.PlaneGeometry(0.07, 0.05);
  }

  _make(id, x, y, z) {
    const g = new THREE.Group(); g.position.set(x, y, z);
    const ball = new THREE.Mesh(this.geo, this.mat); ball.position.y = H; g.add(ball);
    const knot = new THREE.Mesh(this.knotGeo, this.mat); knot.position.y = -0.195; ball.add(knot);
    const stake = new THREE.Mesh(this.stakeGeo, this.stakeMat); stake.position.y = 0.1; stake.rotation.z = 0.12; g.add(stake);
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(7 * 3), 3));
    const string = new THREE.Line(sg, this.stringMat); string.frustumCulled = false; g.add(string);
    const seed = (x * 13.1 + z * 7.7) % 6.28;
    const it = { id, g, ball, string, x, y, z, seed, born: this.t };
    this.scene.add(g); this.items.set(id, it);
    return it;
  }

  // snapshot rows [id, x, y, z]
  sync(rows) {
    if (!rows) return;
    const seen = new Set();
    for (const [id, x, y, z] of rows) { seen.add(id); if (!this.items.has(id)) this._make(id, x, y, z); }
    for (const [id, it] of this.items) if (!seen.has(id)) this._remove(it);   // gone without an event (replaced unseen)
  }

  _remove(it) { this.scene.remove(it.g); it.string.geometry.dispose(); this.items.delete(it.id); }

  nearest(pos, range) {
    let best = null, bd = range;
    for (const it of this.items.values()) { const d = Math.hypot(it.x - pos.x, it.z - pos.z); if (d < bd) { bd = d; best = it; } }
    return best;
  }

  pop(id, pos) {
    const it = this.items.get(id);
    const at = it ? new THREE.Vector3(it.x + it.ball.position.x, it.y + it.ball.position.y, it.z + it.ball.position.z) : new THREE.Vector3(pos.x, pos.y, pos.z);
    if (it) this._remove(it);
    for (let i = 0; i < 7; i++) {
      const m = new THREE.Mesh(this.shredGeo, new THREE.MeshBasicMaterial({ color: 0x8f7f38, side: THREE.DoubleSide, transparent: true }));
      m.position.copy(at); m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      const a = Math.random() * 6.28, s = 1.5 + Math.random() * 2.5;
      this.scene.add(m);
      this.fx.push({ m, v: new THREE.Vector3(Math.cos(a) * s, 1 + Math.random() * 2, Math.sin(a) * s), life: 0.9, spin: (Math.random() - 0.5) * 20 });
    }
  }

  untie(id) {
    const it = this.items.get(id); if (!it) return;
    this.items.delete(id); it.rise = 0; this.rising = this.rising || []; this.rising.push(it);
  }

  update(dt) {
    this.t += dt;
    for (const it of this.items.values()) this._pose(it, 0);
    if (this.rising) for (let i = this.rising.length - 1; i >= 0; i--) {
      const it = this.rising[i]; it.rise += dt;
      this._pose(it, it.rise);
      if (it.rise > 4) { this.scene.remove(it.g); it.string.geometry.dispose(); this.rising.splice(i, 1); }
    }
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i]; f.life -= dt; f.v.y -= 7 * dt; f.v.multiplyScalar(1 - dt * 2.2);
      f.m.position.addScaledVector(f.v, dt); f.m.rotation.x += f.spin * dt; f.m.material.opacity = clamp(f.life / 0.4, 0, 1);
      if (f.life <= 0) { this.scene.remove(f.m); f.m.material.dispose(); this.fx.splice(i, 1); }
    }
  }

  _pose(it, rise) {
    const t = this.t + it.seed, grow = clamp((this.t - it.born) / 0.01, 0, 1);
    // tethered: it leans with the air and nods; released: it climbs and drifts
    const sx = Math.sin(t * 0.7) * 0.07 + Math.sin(t * 1.9) * 0.02, sz = Math.cos(t * 0.53) * 0.06;
    const up = rise ? rise * rise * 0.9 + rise * 0.4 : 0;
    it.ball.position.set(sx + (rise ? rise * 0.25 : 0), H + Math.sin(t * 1.3) * 0.015 + up, sz);
    it.ball.rotation.set(sz * 1.5, 0, -sx * 1.5);
    it.ball.scale.setScalar(grow);
    const p = it.string.geometry.attributes.position, bx = it.ball.position.x, by = it.ball.position.y - 0.21, bz = it.ball.position.z;
    const y0 = rise ? by - 1.25 : 0.24;                         // released: the string trails under it
    for (let i = 0; i < 7; i++) {
      const u = i / 6, sag = Math.sin(Math.PI * u) * (rise ? 0.02 : 0.035);
      p.setXYZ(i, lerp(rise ? bx : 0.03, bx, u) + sag, lerp(y0, by, u), lerp(rise ? bz : 0, bz, u));
    }
    p.needsUpdate = true;
    if (rise) it.g.children[1].visible = false;   // the stake stays in the ground; hide it under the rising one
  }

  clear() {
    for (const it of [...this.items.values()]) this._remove(it);
    for (const it of this.rising || []) { this.scene.remove(it.g); }
    this.rising = [];
    for (const f of this.fx) this.scene.remove(f.m); this.fx = [];
  }
}

// ---------------------------------------------------------------- co-op ping markers
export class PingViews {
  constructor(scene) {
    this.scene = scene; this.list = [];
    this.ringGeo = new THREE.RingGeometry(0.28, 0.36, 28); this.ringGeo.rotateX(-Math.PI / 2);
    this.beamGeo = new THREE.CylinderGeometry(0.015, 0.015, 2.2, 6); this.beamGeo.translate(0, 1.1, 0);
  }
  add(pos, color) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, fog: false, side: THREE.DoubleSide });
    const g = new THREE.Group(); g.position.set(pos.x, pos.y + 0.06, pos.z);
    g.add(new THREE.Mesh(this.ringGeo, mat)); g.add(new THREE.Mesh(this.beamGeo, mat));
    g.renderOrder = 5; this.scene.add(g);
    this.list.push({ g, mat, t: 0 });
    if (this.list.length > 8) this._drop(0);
  }
  _drop(i) { const p = this.list[i]; this.scene.remove(p.g); p.mat.dispose(); this.list.splice(i, 1); }
  update(dt) {
    const L = CONFIG.PING.LIFE;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i]; p.t += dt;
      const pulse = 1 + 0.25 * Math.sin(p.t * 5) * Math.exp(-p.t);
      p.g.children[0].scale.setScalar(pulse * (1 + Math.min(1, p.t * 4) * 0.4));
      p.mat.opacity = 0.55 * clamp((L - p.t) / 1.5, 0, 1);
      if (p.t >= L) this._drop(i);
    }
  }
  clear() { while (this.list.length) this._drop(0); }
}
