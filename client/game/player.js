// First-person controller: grounded movement with acceleration, sprint stamina,
// smooth crouch, jump, surface-aware speed and footsteps, head bob, camera shake,
// downed / injured states, hiding in dense brush.
import * as THREE from 'three';
import { CONFIG } from '../../shared/config.js';
import { clamp, lerp } from '../../shared/math.js';
import { moveCharacter, supportHeight, waterDepthAt, leanDistance, LEAN_REACH, LEAN_ROLL } from '../../shared/physics.js';
import { SURFACE } from '../../shared/world.js';

const P = CONFIG.PLAYER;

export class PlayerController {
  constructor(world, camera, settings) {
    this.world = world; this.camera = camera; this.settings = settings;
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.crouch = 0; this.crouching = false; this.sprinting = false;
    this.stamina = P.STAMINA_MAX; this.staminaDelay = 0; this.exhausted = false;
    this.grounded = true; this.stride = 0; this.bobT = 0; this.landDip = 0;
    this.shake = 0; this.shakeT = 0; this.tremor = 0;
    this.surface = SURFACE.DIRT; this.inWater = 0; this.inBrush = 0;
    this.onFootstep = null; this.onLand = null;
    this.speed = 0; this.noise = 0;
    this.injured = 0; this.slow = 1; this.downed = 0; this.hidden = false; this.covered = false; this.hasCamoBlanket = false; this.lean = 0;
    this.lookLock = null; this.leanIntent = 0;
  }

  spawn(x, z, yaw) {
    this.pos.set(x, supportHeight(this.world, x, z, 10), z);
    this.vel.set(0, 0, 0); this.yaw = yaw; this.pitch = -0.05;
    this.stamina = P.STAMINA_MAX; this.crouch = 0; this.downed = 0; this.covered = false; this.hasCamoBlanket = false; this.lean=0;this.inputLean=0;this.leanIntent=0;
  }

  update(dt, input, opts = {}) {
    const s = this.settings;
    const [dx, dy] = input.consumeLook();
    const frozen = opts.frozen || this.downed > 0.5;
    if (!opts.noLook) {
      const sens = 0.0022 * s.sensitivity;
      this.yaw -= dx * sens;
      this.pitch -= dy * sens * (s.invertY ? -1 : 1);
      this.pitch = clamp(this.pitch, -1.45, 1.45);
    }
    if (this.lookLock) {
      const l = this.lookLock;
      const ty = Math.atan2(-(l.x - this.pos.x), -(l.z - this.pos.z));
      let d = ty - this.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      const rate = l.rate || 7;
      this.yaw += d * Math.min(1, dt * rate);
      this.pitch = lerp(this.pitch, l.pitch ?? 0.05, Math.min(1, dt * rate * 0.7));
    }
    let fx = 0, fz = 0;
    if (!frozen) {
      if (input.down('forward')) fz -= 1;
      if (input.down('back')) fz += 1;
      if (input.down('left')) fx -= 1;
      if (input.down('right')) fx += 1;
    }
    const len = Math.hypot(fx, fz);
    if (len > 0) { fx /= len; fz /= len; }
    this.crouching = !frozen && input.down('crouch');
    this.crouch = lerp(this.crouch, this.crouching || this.downed > 0.5 ? 1 : 0, 1 - Math.exp(-dt * 9));
    this.inputLean = frozen ? 0 : (input.down('leanRight') ? 1 : 0) - (input.down('leanLeft') ? 1 : 0);
    this.covered = !frozen && this.hasCamoBlanket && this.crouching && input.down('camouflage') && this.speed < 0.35;
    const wantSprint = !frozen && input.down('sprint') && fz < 0 && !this.crouching && !this.exhausted;
    this.surface = this.world.surfaceAt(this.pos.x, this.pos.z);
    const depth = waterDepthAt(this.world, this.pos.x, this.pos.z);
    this.inWater = this.world.deckAt(this.pos.x, this.pos.z) !== null ? 0 : depth;
    this.inBrush = this.world.gridAt(this.world.gBrush, this.pos.x, this.pos.z);
    // Brush and dense grass both conceal a crouched, still player.  This deliberately
    // creates hiding options away from tree trunks and other hard objects.
    const grass = this._grassAt(this.pos.x, this.pos.z);
    this.hidden = this.covered || (this.crouching && this.speed < 1.2 && (this.inBrush > 0.35 || grass >= 3));
    let mul = 1;
    if (this.surface === SURFACE.MUD) mul *= P.MUD_SLOW;
    if (this.inWater > 0.12) mul *= lerp(1, P.WATER_SLOW, clamp(this.inWater / 0.6, 0, 1));
    if (this.inBrush > 0.3) mul *= lerp(1, P.BRUSH_SLOW, clamp((this.inBrush - 0.3) / 0.5, 0, 1));
    mul *= this.slow;
    if (this.injured > 0) mul *= 0.85;
    const target = (this.crouching ? P.CROUCH : wantSprint ? P.SPRINT : P.WALK) * mul;
    this.sprinting = wantSprint && len > 0 && this.grounded;
    if (this.sprinting) {
      this.stamina -= dt * (this.injured ? 1.3 : 1) * (this.staminaMul || 1); this.staminaDelay = P.STAMINA_REGEN_DELAY;
      if (this.stamina <= 0) { this.stamina = 0; this.exhausted = true; }
    } else {
      this.staminaDelay -= dt;
      if (this.staminaDelay <= 0) this.stamina = Math.min(P.STAMINA_MAX, this.stamina + dt * P.STAMINA_REGEN * (len > 0 ? 0.6 : 1));
      if (this.exhausted && this.stamina > P.STAMINA_MAX * 0.35) this.exhausted = false;
    }
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const wx = (fx * cy + fz * sy) * target, wz = (-fx * sy + fz * cy) * target;
    const acc = this.grounded ? P.ACCEL : P.AIR_ACCEL;
    const k = 1 - Math.exp(-acc * dt * (this.sprinting ? 0.55 : 1));
    this.vel.x = lerp(this.vel.x, wx, k); this.vel.z = lerp(this.vel.z, wz, k);
    if (this.grounded && !frozen && input.hit('jump') && !this.crouching && this.inWater < 0.4) {
      this.vel.y = P.JUMP; this.grounded = false; this.stamina = Math.max(0, this.stamina - 0.6);
    }
    this.vel.y -= P.GRAVITY * dt;
    const res = moveCharacter(this.world, this.pos, this.vel.x * dt, this.vel.z * dt, P.RADIUS, { boundary: true, cameraSafe: true });
    const movedX = res.x - this.pos.x, movedZ = res.z - this.pos.z;
    this.pos.x = res.x; this.pos.z = res.z;
    if (dt > 0) { this.vel.x = movedX / dt; this.vel.z = movedZ / dt; }
    this.pos.y += this.vel.y * dt;
    const support = supportHeight(this.world, this.pos.x, this.pos.z, this.pos.y);
    if (this.pos.y <= support + 0.02) {
      // A normal jump lands below 4 m/s after discrete gravity integration.
      // Include it without adding footfalls for tiny grounded height changes.
      if (!this.grounded && this.vel.y < -2) { this.landDip = Math.min(0.25, -this.vel.y * 0.025); this.onLand && this.onLand(-this.vel.y); }
      this.pos.y = this.grounded && support - this.pos.y < P.STEP_HEIGHT ? lerp(this.pos.y, support, Math.min(1, dt * 18)) : support;
      if (support > this.pos.y) this.pos.y = support;
      this.vel.y = 0; this.grounded = true;
    } else if (this.pos.y - support > 0.25) this.grounded = false;
    else if (this.grounded) { this.pos.y = lerp(this.pos.y, support, Math.min(1, dt * 14)); this.vel.y = 0; }
    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.speed = hs;
    this.noise = Math.max(0, this.noise - dt * 1.5);
    if (this.grounded && hs > 0.3) {
      const strideLen = this.sprinting ? 1.25 : this.crouching ? 0.55 : 0.78;
      this.stride += hs * dt;
      this.bobT += hs * dt / strideLen * Math.PI;
      if (this.stride > strideLen) {
        this.stride = 0;
        let loud = this.sprinting ? 1 : this.crouching ? 0.15 : 0.45;
        if (this.inWater > 0.1) loud = Math.min(1, loud + 0.3);
        if (this.inBrush > 0.4 && !this.crouching) loud = Math.min(1, loud + 0.15);
        this.noise = Math.max(this.noise, loud);
        this.onFootstep && this.onFootstep({ surface: this.surface, water: this.inWater, brush: this.inBrush, loud, speed: hs });
      }
    }
    this._camera(dt, hs);
  }

  _camera(dt, hs) {
    const s = this.settings;
    let eye = lerp(P.HEIGHT - 0.1, P.CROUCH_HEIGHT - 0.1, this.crouch);
    eye = lerp(eye, 0.35, this.downed);
    eye += this.eyeOffset || 0;   // e.g. lifted by the throat in his grab
    this.landDip = lerp(this.landDip, 0, 1 - Math.exp(-dt * 6));
    const bobAmt = s.headBob * (this.sprinting ? 0.055 : 0.028) * clamp(hs / 2, 0, 1.4);
    const bobY = Math.abs(Math.sin(this.bobT)) * bobAmt - bobAmt * 0.5;
    const bobX = Math.cos(this.bobT) * bobAmt * 0.5;
    this.shakeT += dt;
    const sh = (this.shake + this.tremor) * s.cameraShake;
    this.shake = Math.max(0, this.shake - dt * 1.5);
    const shx = sh * (Math.sin(this.shakeT * 37) * 0.6 + Math.sin(this.shakeT * 23) * 0.4) * 0.03;
    const shy = sh * (Math.sin(this.shakeT * 31 + 1) * 0.6 + Math.sin(this.shakeT * 17) * 0.4) * 0.03;
    const cam = this.camera;
    const right = (this._right || (this._right = new THREE.Vector3())).set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wantLean = this.downed > 0.5 || this.covered ? 0 : this.inputLean || 0;
    // Keep the smooth requested pose separate from the collision-limited eye.
    // Holding a lean against bark should reach full extension as cover clears.
    this.leanIntent = lerp(this.leanIntent || 0, wantLean, 1 - Math.exp(-dt * 14));
    if(this.downed>.5||this.covered||this.lookLock)this.leanIntent=0;
    const lean=leanDistance(this.world,{x:this.pos.x,y:this.pos.y,z:this.pos.z,yaw:this.yaw},this.leanIntent,eye);
    this.lean=lean/LEAN_REACH;
    cam.position.set(this.pos.x, this.pos.y + eye + bobY - this.landDip, this.pos.z).addScaledVector(right, bobX + lean);
    const breathe = Math.sin(performance.now() * 0.0012) * 0.004 * s.headBob;
    const roll = -(this.vel.x * Math.cos(this.yaw) - this.vel.z * Math.sin(this.yaw)) * 0.004 * s.headBob + shx * 0.5 + this.downed * 0.35 + this.lean * LEAN_ROLL + (this.extraRoll || 0);
    cam.rotation.set(this.pitch + shy + breathe, this.yaw + shx, roll, 'YXZ');
    cam.updateMatrixWorld();
  }

  _grassAt(x, z) {
    const w = this.world;
    if (!w.grass) return 0;
    if (!w._playerGrassCells) {
      w._playerGrassCells = new Map();
      for (const g of w.grass) {
        const key = Math.floor(g[0] / 4) + ',' + Math.floor(g[2] / 4);
        w._playerGrassCells.set(key, (w._playerGrassCells.get(key) || 0) + 1);
      }
    }
    return w._playerGrassCells.get(Math.floor(x / 4) + ',' + Math.floor(z / 4)) || 0;
  }
}
