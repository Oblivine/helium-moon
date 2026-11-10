// HELIUM VOICE - stalker AI.
// A predator that prefers not to be seen: it scores concealed observation spots
// around its target, paths around players' view cones, freezes when watched,
// slips away from flashlight beams, flanks and repositions ahead, occasionally
// reveals itself on purpose, and only sometimes commits to a chase.
import { CONFIG } from '../config.js';
import { clamp, lerp, angleDiff, pointAtDistance, makeRng } from '../math.js';
import { moveCharacter, groundAt } from '../physics.js';
import { inSpawnZone, spawnZoneCost, spawnStepBlocked } from './zones.js';
import { eyeHeight, eyePosition, observedBy, onScreen, sightOf, noiseRadius, viewCost, playerActive, playerAlive, playerFwd } from './perception.js';

const C = CONFIG.HV;
export const HV_STATES = ['dormant', 'roam', 'investigate', 'stalk', 'watch', 'freeze', 'retreat', 'reveal', 'chase', 'search', 'still', 'collapse', 'lie'];
// grab variations (owner, Puppet rework): index travels in the snapshot
export const GRAB_KINDS = ['none', 'shoulders', 'throat', 'face', 'turn', 'drag', 'final'];
const EYE = 1.78, HEIGHT = 1.9;
const RELOC_JITTER = [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]];

export class HeliumVoiceAI {
  constructor(sim) {
    this.sim = sim; this.world = sim.world; this.rng = sim.rng;
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0; this.lookYaw = 0; this.lookPitch = 0;
    this.speed = 0; this.motionSpeed = 0; this.vx = 0; this.vz = 0;
    this.state = 'dormant'; this.stateT = 0;
    this.path = null; this.pathI = 0; this.goal = null; this.replanT = 0;
    this.awareness = new Map(); this.lastSeen = new Map(); this.spotted = new Set();
    this.target = null; this.lookAt = null;
    this.anim = { run: 0, reach: 0, still: 0, tilt: 0, jaw: 0, crouch: 0, windup: 0, strike: 0, frozen: 0, low: 0, collapse: 0, prone: 0, rise: 0, back: 0, grab: 0, peek: 0 };
    this.grab = null; this.freeze = null; this.lbUntil = -1; this.lbNext = -1; this.lbWatched = false; this.lowPose = false;
    this.sigT = -999; this.vocalT = -999; this.chaseT = 0; this.attackT = -999;
    this.observedT = 0; this.litT = 0; this.watchDur = 6; this.reveal = null;this.observers=[];
    this.searchPts = []; this.stimulus = null; this.lastRetreatT = -999; this.falseRetreat = false;
    this.snapT = 0;
    this.closeCommitted = false;
    // Sound variation must not consume the director/navigation random stream.
    this.searchSoundRng = makeRng((sim.seed || 0) ^ 0x63726163);
    this.resetSearchSound();
  }

  spawn() {
    // start far up the trail, deep in cover, ~230 m ahead of the trailhead
    const w = this.world, rng = this.rng;
    for (let k = 0; k < 80; k++) {
      const p = pointAtDistance(w.trail, w.trailCum, rng.range(220, 420));
      const a = rng.range(0, Math.PI * 2), d = rng.range(25, 60);
      const x = p.x + Math.sin(a) * d, z = p.z + Math.cos(a) * d;
      if (w.navWalkable(x, z) && this.outsideSpawn(x,z) && w.sampleGrid(w.gCover, x, z) > 0.25) { this.place(x, z); return; }
    }
    const p = pointAtDistance(w.trail, w.trailCum, 300);
    const i = w.nearestNav(p.x + 20, p.z, 30); const [x, z] = w.cellPos(i); this.place(x, z);
  }
  place(x, z) { if (this.withdrawal || !this.outsideSpawn(x,z)) return false; this.x = x; this.z = z; this.y = groundAt(this.world, x, z); this.path = null; this.finalGoal = null; }

  setState(s, info) {
    if(s==='chase' && (this.withdrawal || this.sim.time<(this.sim.director?.nextChaseAt||0)))return false;
    this.pebbleDecoy=null;
    this.state = s; this.stateT = 0; this.path = null; this.goal = null; this.finalGoal = null;
    this.avoidHeading = null; this.avoidSign = 0; this.avoidT = 0; this.routeProgress = null;
    if (s !== 'retreat') this.fleeAfterGrab = false;
    if (s !== 'chase') this.closeCommitted = false;
    if (s === 'chase') {
      this.huntStartedAt = this.sim.time;
      this.huntHideUntil = this.sim.time + this.rng.range(...C.HUNT_HIDE_WINDOW);
      this.huntEndsAt = this.huntHideUntil + this.rng.range(...C.HUNT_SEARCH_TIME) * (this.sim.rules?.search ?? 1);
      this.huntPhase = 'stalk'; this.huntContactAt = -999; this.huntHeardAt = this.sim.time;
      this.huntSearchGoal = null; this.stalkBackingOff = false;
    } else this.huntPhase = null;
    if (info) Object.assign(this, info);
  }

  dist(p) { return Math.hypot(p.x - this.x, p.z - this.z); }

  outsideSpawn(x,z) { return !this.world.trail || !inSpawnZone(this.world,x,z,0.4); }

  focusPlayer() {
    const preferred=this.sim.director.focusPlayer();
    if(preferred && playerActive(preferred) && this.outsideSpawn(preferred.x,preferred.z))return preferred;
    let best=null,distance=Infinity;
    for(const p of this.sim.playerList){
      if(!playerActive(p)||!this.outsideSpawn(p.x,p.z))continue;
      const d=this.dist(p);if(d<distance){best=p;distance=d;}
    }
    return best;
  }

  openingDistance() {
    const d = this.sim.director?.minDistance?.() || 0;
    // Stay beyond the simulation's lit visibility range, while still entering
    // the outer cold ring. This does not hide the rendered character.
    return d > 0 ? Math.max(d, 70) : 0;   // was flashlight range + 18 (70 m); kept when the light became a lighter
  }
  openingClear(x, z) {
    const distance = this.openingDistance();
    return this.outsideSpawn(x,z) && (!distance || this.sim.playerList.every(p => !playerActive(p) || Math.hypot(x-p.x,z-p.z) >= distance));
  }


  // ---------------------------------------------------------------- perception
  perceive(dt) {
    const sim = this.sim;
    let best = null, bestVis = 0;
    this.observers = []; this.litBy = null;
    for (const p of sim.playerList) {
      if (!playerAlive(p)) continue;
      const vis = this.outsideSpawn(p.x,p.z) ? sightOf(this.world, this, EYE, this.lookYaw, p, C) : 0;
      let aw = this.awareness.get(p.id) || 0;
      if (vis > 0.05) {
        const d = this.dist(p);
        aw = Math.min(3, aw + vis * dt * (d < 15 ? 3 : 1.4) * (p.flash ? 1.3 : 1));
        this.lastSeen.set(p.id, { x: p.x, z: p.z, t: sim.time });
      } else aw = Math.max(0, aw - dt * 0.07);
      this.awareness.set(p.id, aw);
      if (aw >= 1 && !this.spotted.has(p.id)) { this.spotted.add(p.id); this.onSpotted(p); }
      if (aw < 0.2 && this.spotted.has(p.id) && sim.time - (this.lastSeen.get(p.id)?.t || 0) > 45) this.spotted.delete(p.id);
      if (vis > bestVis) { bestVis = vis; best = p; }
      // being watched?
      if (playerActive(p)) {
        const ob = observedBy(this.world, p, this.x, this.y, this.z, HEIGHT);
        const visible = onScreen(this.world, p, this.x, this.y, this.z, this.state === 'collapse' || this.state === 'lie' ? 0.45 : this.lowPose ? 0.95 : HEIGHT);
        if (visible) this.observers.push({ p, ob });
        if (visible && ob.lit && (!this.litBy || ob.d < this.litBy.ob.d)) this.litBy = { p, ob };
      }
    }
    this.observedT = this.observers.length ? this.observedT + dt : 0;
    this.litT = this.litBy ? this.litT + dt : 0;
    // hearing
    for (const p of sim.playerList) {
      if (!playerAlive(p) || !this.outsideSpawn(p.x,p.z)) continue;
      const r = noiseRadius(p, C);
      if (r <= 0) continue;
      const d = this.dist(p);
      if (d > r) continue;
      const loud = 1 - d / r;
      if (!this.stimulus || loud > this.stimulus.loud || sim.time - this.stimulus.t > 4) {
        const err = d * 0.18;
        this.stimulus = { x: p.x + this.rng.range(-err, err), z: p.z + this.rng.range(-err, err), t: sim.time, loud, pid: p.id, voice: p.voice > CONFIG.VOICE.NOISE_THRESHOLD };
      }
    }
    return best;
  }

  onSpotted(p) {
    const sim = this.sim;
    if(this.pebbleDecoy&&this.lastSeen.get(p.id)?.t!==sim.time)return;
    if (this.withdrawal || this.fastRetreat || this.fleeAfterGrab || this.state === 'chase' || this.state === 'reveal' || this.state === 'lie' || this.state === 'collapse') return;
    this.target = p.id;
    if (this.concealedAt(this.x, this.z)) this.setState('still', { stillFor: this.rng.range(2, 4.5) });
    else { this.setState('stalk'); this.replanT = 0; }
  }

  // ---------------------------------------------------------------- movement
  planTo(x, z, mode = 'cover') {
    if (!this.openingClear(x,z)) { this.path=null;this.finalGoal=null;return false; }
    const w = this.world, sim = this.sim, R = CONFIG.GRID_RES, gw = w.gw, x0 = w.minX, z0 = w.minZ;
    // long trips are planned in legs of <=110 m (bounded A* cost per tick; re-planned on arrival)
    const D = Math.hypot(x - this.x, z - this.z);
    let gx = x, gz = z; this.finalGoal = null;
    if (D > 110 && mode !== 'direct') { const k = 110 / D; gx = this.x + (x - this.x) * k; gz = this.z + (z - this.z) * k; this.finalGoal = [x, z, mode]; }
    let costFn = null;
    if (mode === 'cover' || mode === 'quiet') {
      // flatten the players' view cones once per plan (no allocation per grid cell)
      const eyes = [];
      for (const p of sim.playerList) { if (!playerActive(p)) continue; const [fx, fz] = playerFwd(p); eyes.push(p.x, p.z, fx, fz, p.flash ? 1 : 0); }
      const strength = mode === 'cover' ? 5 : 2, cover = mode === 'cover', gC = w.gCover;
      costFn = (i) => {
        const cx = x0 + (i % gw) * R, cz = z0 + ((i / gw) | 0) * R;
        let c = cover ? (1 - gC[i]) * 0.6 : 0;
        for (let k = 0; k < eyes.length; k += 5) {
          const dx = cx - eyes[k], dz = cz - eyes[k + 1], dd = dx * dx + dz * dz;
          if (dd > 4900 || dd < 0.25) continue;
          const d = Math.sqrt(dd), cosA = (dx * eyes[k + 2] + dz * eyes[k + 3]) / d;
          if (cosA < 0.4) continue;
          c += strength * (cosA - 0.4) * (1 - d / 70) * (eyes[k + 4] && cosA > 0.86 && d < 50 ? 2.5 : 1);
        }
        return c;
      };
    }
    const coverCost = costFn, opening = this.openingDistance();
    const openingPlayers = opening ? sim.playerList.filter(playerActive).map(p => [p.x,p.z]) : [];
    const safetyCost = i => {
      const cx=x0+(i%gw)*R,cz=z0+((i/gw)|0)*R;
      let cost=spawnZoneCost(w,cx,cz);
      for(let k=0;k<openingPlayers.length;k++){
        const ox=cx-openingPlayers[k][0],oz=cz-openingPlayers[k][1],distance=Math.sqrt(ox*ox+oz*oz);
        if(distance<opening)return cost+1e5;
        if(distance<opening+8)cost+=8*Math.pow(1-(distance-opening)/8,2);
      }
      return cost;
    };
    // Spots where he recently got physically stuck (gaps narrower than his body, which the
    // 2 m nav grid can't see) are avoided for NAV_BLOCK_TIME s so the new plan goes around.
    const blocks = (this.navBlocks || []).filter((b) => sim.time - b.t < C.NAV_BLOCK_TIME); this.navBlocks = blocks;
    costFn = i => {
      let c = safetyCost(i) + (coverCost ? coverCost(i) : 0);
      if (blocks.length) for (const b of blocks) if (b.i === i) c += 80;
      return c;
    };
    this.path = w.findPath(this.x, this.z, gx, gz, { costFn, maxExpand: mode === 'direct' ? 9000 : 14000 });
    // leg target unreachable (e.g. across the river): try a short plain leg instead of an unbounded search
    if (!this.path && this.finalGoal) { const k = 45 / D; this.path = w.findPath(this.x, this.z, this.x + (x - this.x) * k, this.z + (z - this.z) * k, { costFn: safetyCost, maxExpand: 5000 }); if (!this.path) this.finalGoal = null; }
    // The straight-line leg can end outside the refuge where the map boundary bends (no nav
    // cell there: seed 1003 froze 20 s+ in roam). Plan the whole trip instead; it's rare.
    if (!this.path && D > 110 && mode !== 'direct') this.path = w.findPath(this.x, this.z, x, z, { costFn: safetyCost, maxExpand: 24000 });
    this.pathI = 1; this.goal = [x, z]; this.pathMode = mode;
    return !!this.path;
  }

  // Probe the actual cylinder, not just the coarse nav cells or an eye ray.
  // This also catches logs/fences below eye level and protects water/spawn edges.
  walkLineClear(x, z, limit = 3) {
    const d = Math.hypot(x-this.x,z-this.z); if(d<1e-5)return true;
    const length=Math.min(d,limit),count=Math.ceil(length/.3),dx=(x-this.x)/d,dz=(z-this.z)/d;
    const opts={nav:!this.freeLunge,slope:false,step:C.STEP_OVER};
    let p={x:this.x,y:this.y,z:this.z};
    for(let i=1;i<=count;i++){
      const tx=this.x+dx*length*i/count,tz=this.z+dz*length*i/count;
      const q=moveCharacter(this.world,p,tx-p.x,tz-p.z,.32,opts);
      if(Math.hypot(q.x-tx,q.z-tz)>.015 || spawnStepBlocked(this.world,p.x,p.z,q.x,q.z))return false;
      p={...q,y:groundAt(this.world,q.x,q.z)};
    }
    return true;
  }

  rememberBlocked(x,z) {
    if(this.world.cellOf)(this.navBlocks ||= []).push({i:this.world.cellOf(x,z),t:this.sim.time});
    if(this.navBlocks?.length>8)this.navBlocks.shift();
  }

  followPath(dt, speed) {
    this.motionSpeed = 0;
    if (this.path && this.pathI >= this.path.length && this.finalGoal) { const fg = this.finalGoal; this.planTo(fg[0], fg[1], fg[2]); }
    if (!this.path || this.pathI >= this.path.length) { this.speed = lerp(this.speed, 0, 1 - Math.exp(-dt * 8)); return true; }
    if (this.operated) speed *= C.OPERATED_MUL;
    // Consume reached points in this tick. Returning at every point created
    // recurring full-tick pauses, especially when pursuit replans frequently.
    const arrival=this.state==='chase' ? .3 : .8;
    while(this.pathI<this.path.length && Math.hypot(this.path[this.pathI][0]-this.x,this.path[this.pathI][1]-this.z)<arrival)this.pathI++;
    if(this.pathI>=this.path.length)return !this.finalGoal;
    // Round only direct pursuit paths. Quiet/cover paths retain their costs.
    if(this.state==='chase' && this.pathMode==='direct' && !this.freeLunge){
      for(let i=Math.min(this.path.length-1,this.pathI+3);i>this.pathI;i--){
        const [x,z]=this.path[i];
        if(Math.hypot(x-this.x,z-this.z)<=4 && this.walkLineClear(x,z,4)){this.pathI=i;break;}
      }
    }
    const [tx, tz] = this.path[this.pathI];
    const dx = tx - this.x, dz = tz - this.z, d = Math.hypot(dx, dz);
    // Sideways collision corrections are not progress toward a waypoint.
    // Keep this check across replans to the same point, so a chase cannot
    // orbit an unreachable grid center indefinitely while its legs keep moving.
    let progress=this.routeProgress;
    if(!progress || Math.hypot(progress.x-tx,progress.z-tz)>.5)
      progress=this.routeProgress={x:tx,z:tz,best:d,stalled:0};
    if(d<progress.best-.05){progress.best=d;progress.stalled=0;}
    else if(this.speed>.1)progress.stalled+=dt;
    if(progress.stalled>1.4){this.rememberBlocked(tx,tz);this.path=null;this.routeProgress=null;return false;}
    // Brake unseen stalking at eight feet. A committed chase is allowed
    // to close and hit without waiting for the player to look back.
    const tp = this.target != null ? this.sim.players.get(this.target) : null;
    if (tp && this.state !== 'retreat' && this.state !== 'chase' && !this.closeCommitted
        && this.dist(tp) <= C.CREEP_DISTANCE + Math.max(speed, this.speed) * dt
        && !this.observers?.some(o => o.p.id === tp.id)) {
      speed = this.dist(tp) <= C.CREEP_STOP ? 0 : C.CREEP_SPEED;
      this.speed = Math.min(this.speed, speed);
    }
    this.speed = lerp(this.speed, speed, 1 - Math.exp(-dt * (this.state === 'retreat' ? 18 : speed > 3 ? 3 : 5)));
    const step = Math.min(d, this.speed * dt);
    const nx = dx / d, nz = dz / d;
    const opts={nav:!this.freeLunge,slope:false,step:C.STEP_OVER};
    let r = moveCharacter(this.world, this, nx * step, nz * step, 0.32, opts);
    const forward=(r.x-this.x)*nx+(r.z-this.z)*nz;
    const obstructed=step>1e-5 && (forward<step*.55
      || ((this.avoidHeading!=null || speed>3) && !this.walkLineClear(tx,tz,this.avoidHeading!=null?3:1.1)));
    if(obstructed){
      // Keep one side around local obstacles instead of choosing alternating
      // corrections into the same trunk on each freshly planned chase path.
      const heading=this.avoidHeading??Math.atan2(dx,dz),preferred=this.avoidSign||1;
      let found=false;
      for(const sign of [preferred,-preferred]){
        for(const angle of [.45,.8,1.2,1.55,1.85]){
          const a=heading+sign*angle;
          const q=moveCharacter(this.world,this,Math.sin(a)*step,Math.cos(a)*step,.32,opts);
          const travel=Math.hypot(q.x-this.x,q.z-this.z);
          if(travel<step*.65 || travel>step*1.5 || spawnStepBlocked(this.world,this.x,this.z,q.x,q.z))continue;
          r=q;this.avoidHeading=heading;this.avoidSign=sign;found=true;break;
        }
        if(found)break;
      }
      this.avoidT=(this.avoidT||0)+dt;
      if(this.avoidT>4){this.rememberBlocked(tx,tz);this.path=null;this.avoidHeading=null;this.avoidSign=-preferred;this.avoidT=0;return false;}
    }else if(forward>step*.9){this.avoidHeading=null;this.avoidSign=0;this.avoidT=0;}
    // Stalking paths can detour toward the player. Never cut through their body en route
    // to cover; when already close, only an outward step is allowed in the opening phase.
    if (this.state === 'chase' && !this.grab && this.sim.playerList.some(p => {
      if (!playerActive(p)) return false;
      const was = this.dist(p), next = Math.hypot(p.x-r.x,p.z-r.z);
      return next < (this.huntPhase === 'stalk' ? Math.min(8,was-.001) : .85);
    })) { this.path = null; this.stop(dt); return false; }
    const minimum = this.openingDistance();
    if (minimum && this.sim.playerList.some(p => playerActive(p)
        && this.dist(p) >= minimum && Math.hypot(p.x-r.x,p.z-r.z) < minimum)) {
      this.path = null; this.stop(dt); return false;
    }
    if (spawnStepBlocked(this.world,this.x,this.z,r.x,r.z)) { this.path=null;this.stop(dt);return false; }
    const moved = Math.hypot(r.x - this.x, r.z - this.z);
    // A tight waypoint beside solid geometry can return a large penetration
    // correction. Replan instead of snapping the creature through the obstacle.
    if (moved > Math.max(0.08, step * 1.5)) {
      // The nav grid can place a cylinder slightly inside a trunk. Discarding
      // every correction traps it forever. Recover only existing penetration
      // (zero requested movement), gradually and within this tick's speed cap.
      const out=moveCharacter(this.world,this,0,0,.32,{nav:true,slope:false,step:C.STEP_OVER});
      const distance=Math.hypot(out.x-this.x,out.z-this.z);
      if(distance>1e-5) {
        const k=Math.min(step,distance)/distance;
        const x=this.x+(out.x-this.x)*k,z=this.z+(out.z-this.z)*k;
        const crossesOpening=minimum && this.sim.playerList.some(p=>playerActive(p)
          && this.dist(p)>=minimum && Math.hypot(p.x-x,p.z-z)<minimum);
        if(!crossesOpening && !spawnStepBlocked(this.world,this.x,this.z,x,z)) {
          this.x=x;this.z=z;this.y=groundAt(this.world,x,z);
          this.motionSpeed=dt>0?Math.min(this.speed,Math.min(step,distance)/dt):0;
        }
      }
      this.path=null;return false;
    }
    const facing=moved>1e-5?Math.atan2(r.x-this.x,r.z-this.z):this.yaw;
    this.x = r.x; this.z = r.z; this.y = groundAt(this.world, this.x, this.z);
    this.motionSpeed=dt>0?Math.min(this.speed,moved/dt):0;
    const back = this.state === 'retreat' && this.backwards;
    const desired = facing + (back ? Math.PI : 0);
    this.yaw += angleDiff(this.yaw, desired) * (1-Math.exp(-dt*(this.state === 'retreat'?22:speed>3?8:4)));
    if (moved < step * 0.2) {
      this.stuckT = (this.stuckT || 0) + dt;
      if (this.stuckT > 1.2) {
        this.stuckT = 0; this.path = null;
        // remember the grid cell he couldn't get into so the replan routes around it (see planTo)
        this.rememberBlocked(tx,tz);
      }
    } else this.stuckT = 0;
    return false;
  }

  stop(dt) { this.motionSpeed=0;this.speed = lerp(this.speed, 0, 1 - Math.exp(-dt * 10)); }

  lookAtPoint(x, y, z) {
    this.lookYaw = Math.atan2(x - this.x, z - this.z);
    this.lookPitch = Math.atan2(y - (this.y + EYE), Math.hypot(x - this.x, z - this.z));
  }

  // ---------------------------------------------------------------- spot selection
  concealedAt(x, z) {
    const w = this.world;
    if (w.trailDistAt(x, z) < 3 || w.sampleGrid(w.gCover, x, z) < 0.2) return false;
    const y = groundAt(w, x, z);
    for (const p of this.sim.playerList) {
      if (!playerActive(p) || Math.hypot(p.x - x, p.z - z) > 100) continue;
      // Cover must hide the silhouette, not just darken its center. Brush alone
      // can attenuate LOS but is not solid concealment.
      const a = Math.atan2(p.x - x, p.z - z), rx = Math.cos(a) * 0.32, rz = -Math.sin(a) * 0.32;
      for (const height of [1.8, 1.0, 0.25]) for (const side of [0, -1, 1]) {
        if (w.lineOfSight(p.x, p.y + eyeHeight(p), p.z, x + rx * side, y + height, z + rz * side, { brushK: 0 }) > 0) return false;
      }
    }
    return true;
  }

  // concealed observation spot around player p. mode: 'behind' | 'flank' | 'ahead'
  observationSpot(p, mode = 'behind', minD = C.OBSERVE_MIN, maxD = C.OBSERVE_MAX) {
    const w = this.world, rng = this.rng, sim = this.sim;
    const [fx, fz] = p.moveDir || playerFwd(p);
    const baseA = Math.atan2(fx, fz);
    let best = null, bestS = -1e9;
    for (let k = 0; k < 36; k++) {
      let rel;
      if (mode === 'ahead') rel = rng.range(-0.7, 0.7);
      else if (mode === 'flank') rel = (rng() < 0.5 ? -1 : 1) * rng.range(1.1, 2.0);
      else rel = Math.PI + rng.range(-1.3, 1.3);
      const a = baseA + rel, d = rng.range(minD, maxD);
      const x = p.x + Math.sin(a) * d, z = p.z + Math.cos(a) * d;
      if (!w.navWalkable(x, z) || !this.openingClear(x, z)) continue;
      if (w.trailDistAt(x, z) < 3) continue;
      if (!this.concealedAt(x, z)) continue;
      const cover = w.sampleGrid(w.gCover, x, z);
      const y = groundAt(w, x, z);
      const vis = w.lineOfSight(p.x, p.y + eyeHeight(p), p.z, x, y + 1.7, z, { brushK: 0.3 });
      let s = cover * 2.2;
      s += (1 - vis) * 2; // concealed watching; deliberate reveals are handled separately
      s -= viewCost(sim.playerList, x, z, 1) * 0.8;
      s -= Math.hypot(x - this.x, z - this.z) / 90;
      for (const q of sim.playerList) if (q !== p && playerActive(q) && Math.hypot(q.x - x, q.z - z) < 20) s -= 2;
      if (s > bestS) { bestS = s; best = [x, z]; }
    }
    return best;
  }

  // nearest point that breaks line of sight from the threatening player(s), away from them
  coverAway(from, minD = 12, maxD = 32) {
    const w = this.world, rng = this.rng;
    const away = Math.atan2(this.x - from.x, this.z - from.z);
    const candidates = [];
    for (let k = 0; k < 30; k++) {
      const a = away + rng.range(-1.2, 1.2), d = rng.range(minD, maxD);
      const x = this.x + Math.sin(a) * d, z = this.z + Math.cos(a) * d;
      if (!w.navWalkable(x, z) || !this.openingClear(x, z)) continue;
      const y = groundAt(w, x, z);
      const vis = w.lineOfSight(from.x, from.y + eyeHeight(from), from.z, x, y + 1.6, z, { brushK: 0.35 });
      const score = (1 - vis) * 3 + w.sampleGrid(w.gCover, x, z) - d / 60;
      candidates.push({ x, z, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    // Full silhouette occlusion is expensive with several teammates. Rank by
    // the cheap center ray first, then fully verify at most three finalists.
    // Actual hiding poses still recheck every silhouette sample; a fallback
    // destination is only a movement goal, never permission to stand exposed.
    for (const candidate of candidates.slice(0, 3)) {
      if (this.concealedAt(candidate.x, candidate.z)) return [candidate.x, candidate.z];
    }
    return candidates.length ? [candidates[0].x, candidates[0].z] : null;
  }

  roamGoal() {
    const w = this.world, rng = this.rng, sim = this.sim;
    const tp = this.focusPlayer();
    for (let k = 0; k < 40; k++) {
      let x, z;
      if (tp) {
        // drift into the outer terror ring of the focus player
        const a = rng.range(0, Math.PI * 2), minimum = this.openingDistance();
        const escalation=sim.director.escalation?.()||0;
        const d = minimum ? rng.range(minimum + 3, Math.max(minimum + 4, CONFIG.TERROR.OUTER - 3))
          : sim.director.wantsPresence()
            ? rng.range(lerp(28,18,escalation),lerp(48,32,escalation))
            : rng.range(55,85);
        x = tp.x + Math.sin(a) * d; z = tp.z + Math.cos(a) * d;
      } else {
        // wander the stretch of trail around whoever he is following, never the whole map
        const ref = tp ? w.trailInfo(tp.x, tp.z).along : w.trailInfo(this.x, this.z).along;
        const p = pointAtDistance(w.trail, w.trailCum, Math.max(0, Math.min(w.trailLength, ref + rng.range(-120, 160))));
        const a = rng.range(0, Math.PI * 2), d = rng.range(15, 90);
        x = p.x + Math.sin(a) * d; z = p.z + Math.cos(a) * d;
      }
      if (w.navWalkable(x, z) && this.openingClear(x, z) && Math.hypot(x - this.x, z - this.z) > 25) return [x, z];
    }
    return null;
  }

  // ---------------------------------------------------------------- main update
  update(dt) {
    const sim = this.sim, dir = sim.director;
    const moveFromX = this.x, moveFromZ = this.z, wasSearching = this.isSearching();
    this.motionSpeed=0;
    const escalation = dir.escalation?.() || 0;
    this.stateT += dt;
    if (this.state === 'dormant') { this.stop(dt); return; }
    this.perceive(dt);
    if(this.pebbleDecoy&&sim.time>=this.pebbleDecoy.until){
      this.pebbleDecoy=null;this.path=null;this.huntSearchGoal=null;this.replanT=0;
    }
    // Withdrawal survives cover, loss of the target and any incidental state
    // request. Only real physical travel can complete it.
    if(this.withdrawal && this.state!=='retreat')this.setState('retreat',{fastRetreat:true});
    const minimum = this.openingDistance();
    if (minimum > 0 && this.state !== 'retreat') {
      const near = sim.nearestPlayer(this.x, this.z);
      if (near && near.d < minimum) this.retreatFrom(near.p, false, true);
    }

    let tp = this.target != null ? sim.players.get(this.target) : null;
    if (tp && (!playerAlive(tp) || !this.outsideSpawn(tp.x,tp.z))) {
      if(this.state==='chase')this.retreatFrom(tp,false,true);
      this.target=null;tp=null;
    }
    const anim = this.anim;
    anim.run = 0; anim.reach = 0; anim.still = 0; anim.windup = 0; anim.strike = 0;
    anim.frozen = 0; anim.low = 0; anim.collapse = 0; anim.prone = 0; anim.rise = 0; anim.back = 0; anim.grab = 0; anim.peek = 0;
    let lookP = tp && playerAlive(tp) && (this.awareness.get(tp.id) || 0) > 0.6 ? tp : null;
    if(this.pebbleDecoy)lookP=null;
    const watched = this.observers.length > 0;
    // Puppet (docs/HV_PUPPET_REWORK.md): unwatched he is "operated" - low and faster
    this.operated = !watched && (this.state === 'roam' || this.state === 'stalk' || this.state === 'investigate');

    // A recognized nearby player can be pursued from any direction. Seeing
    // him encourages concealment; it is no longer permission to deal damage.
    const close = tp && playerActive(tp) && this.dist(tp) <= C.CREEP_DISTANCE;
    if (tp && playerActive(tp) && this.dist(tp) < CONFIG.TERROR.CRITICAL
        && sim.state !== 'intro' && !dir.inDread?.() && !['chase', 'retreat', 'collapse', 'lie'].includes(this.state)
        && (this.awareness.get(tp.id) || 0) >= 1
        && this.lastSeen.get(tp.id)?.t === sim.time
        && sim.time - this.attackT >= C.ATTACK_COOLDOWN
        && (dir.allowChase(tp) || close || this.dist(tp) < C.ATTACK_RANGE * 2)) this.startChase(tp);

    // Concealment prevents discovery throughout the search. The timed hunt keeps going
    // around the last evidence rather than collapsing six seconds into its opening.
    if (this.state === 'chase' && !this.grab && tp) this.updateHide(dt, tp);
    if (watched && !['chase', 'retreat', 'collapse', 'lie'].includes(this.state)) {
      // Watched outside a hunt: hold the pose briefly, head locked on the
      // observer, then flee. The shared scare deadline caps every new freeze.
      const observer = this.litBy || this.observers[0];
      // A single short exposure budget applies across watch/freeze/reveal.
      // Looking away briefly or changing poses cannot renew the same scare.
      if(this.scareVisibleUntil==null)this.scareVisibleUntil=sim.time+this.rng.range(...C.SCARE_VISIBLE);
      const deliberate = this.state === 'reveal' && this.reveal;
      if (deliberate) {
        this.reveal.exposureT = (this.reveal.exposureT || 0) + dt;
        if (!this.reveal.counted && this.reveal.exposureT >= .2) {
          this.reveal.counted = true; dir.onReveal(this.reveal.kind); this.presenceReportT = sim.time;
          sim.balloons?.mark(this.x, this.z, 'watched');   // his calling card, left once nobody is looking
        }
      }
      if(sim.time>=this.scareVisibleUntil || (deliberate?.kind==='shadow' && deliberate.exposureT>=.2)){
        this.retreatFrom(observer.p,!!this.litBy,true);
      } else {
        const od = observer.ob?.d ?? this.dist(observer.p);
        if (!this.freeze || sim.time - this.freeze.seen > C.FREEZE_RESET) {
          const r = od < C.STARE_MIN_DIST ? C.FREEZE_CLOSE : this.litBy ? C.FREEZE_LIT : C.FREEZE;
          // peeking from his cover at the wrong height (1: leaning out, 2: low, head sideways)
          const cover = this.world.sampleGrid ? this.world.sampleGrid(this.world.gCover, this.x, this.z) : 0;
          const peek = od > 12 && cover > 0.3 ? 1 + (this.rng() < 0.5 ? 1 : 0) : 0;
          this.freeze = { start: sim.time, end: Math.min(this.scareVisibleUntil,sim.time + this.rng.range(r[0], r[1])), pid: observer.p.id, peek, seen: sim.time };
        }
        this.freeze.seen = sim.time;
        if (sim.time < this.freeze.end) {
          this.holdStare = observer.p; anim.peek = this.freeze.peek;
        } else {
          this.retreatFrom(observer.p, !!this.litBy, true);
        }
      }
    }

    // Reactions above can start a chase of a player who was not the previous
    // target. Resolve again before executing that new state: otherwise the
    // first chase tick sees null/an old teammate and immediately retreats.
    tp = this.target != null ? sim.players.get(this.target) : null;
    if (this.state === 'chase' && tp) lookP = tp;

    if (this.holdStare) {
      // frozen mid-pose, staring back at whoever is looking at him
      this.stop(dt); anim.still = 1; anim.frozen = 1; lookP = this.holdStare; this.holdStare = null;
    } else switch (this.state) {
      case 'still': {
        if (tp && !this.concealedAt(this.x, this.z)) { this.retreatFrom(tp, false, true); break; }
        this.stop(dt); anim.still = 1;
        if (this.stateT > (this.stillFor || 3)) this.decideAfterSpotting(tp);
        break;
      }
      case 'roam': {
        const fpl = this.focusPlayer();
        if (this.path && this.goal && fpl && dir.wantsPresence() && Math.hypot(this.goal[0] - fpl.x, this.goal[1] - fpl.z) > lerp(85,55,escalation)) this.path = null;
        if (!this.path && (minimum || sim.time >= (this.roamPlanAt || 0))) {
          this.roamPlanAt = sim.time + .75;
          const g = this.roamGoal(); if (g) this.planTo(g[0], g[1], 'cover');
        }
        const near = fpl ? {p:fpl,d:this.dist(fpl)} : sim.nearestPlayer(this.x, this.z);
        // unseen and far away he covers ground quickly; near people he slows to a creep
        const roamSpd = !near || near.d > 130 ? C.RELOCATE : near.d > 75 ? C.STALK : C.WALK * (0.8 + 0.4 * Math.sin(sim.time * 0.37 + 1.3));
        const approachSpd = near && dir.wantsPresence() && near.d > 25 ? C.STALK * (1 + .15 * escalation) : roamSpd;
        if (this.followPath(dt, approachSpd)) this.path = null;
        // stimuli
        if (this.stimulus && sim.time - this.stimulus.t < 1) this.setState('investigate', { inv: this.stimulus, stimulus: null });
        if (tp && (this.awareness.get(tp.id) || 0) > 1 && this.stateT > 2) this.setState('stalk');
        lookP = dir.wantsPresence() ? fpl : null;
        break;
      }
      case 'investigate': {
        const inv = this.inv;
        if (!this.path && this.stateT < 1) this.planTo(inv.x, inv.z, 'cover');
        const fast = inv.voice ? C.STALK * 1.15 : C.STALK;
        const done = this.followPath(dt, Math.hypot(inv.x - this.x, inv.z - this.z) > 30 ? fast : C.WALK);
        if (this.stimulus && this.stimulus.t > inv.t + 2 && this.stimulus.loud > 0.2) { this.inv = this.stimulus; this.stimulus = null; this.path = null; this.stateT = 0.5; }
        if (done || this.stateT > 45) this.setState('search', { searchAt: { x: inv.x, z: inv.z }, searchPts: [] });
        if (tp && (this.awareness.get(tp.id) || 0) > 1) this.setState('stalk');
        break;
      }
      case 'stalk': {
        if (!tp) { this.setState('roam'); break; }
        const aw = this.awareness.get(tp.id) || 0;
        const ls = this.lastSeen.get(tp.id);
        const d = this.dist(tp);
        // Closing in for a hunt (owner, Oct 25): approach unseen through cover until
        // within HUNT_START_RANGE, then commit if the director still allows a chase.
        const closing = this.closingOn && this.closingOn.pid === tp.id && sim.time - this.closingOn.t < C.HUNT_CLOSE_TIMEOUT;
        if (this.closingOn && !closing) this.closingOn = null;
        if (closing) {
          if (d <= C.HUNT_START_RANGE) {
            // learned: they flash him off -> don't commit while they're facing him; wait for them to turn
            if (this.counters(tp.id, 'flash') && sim.time - (this.closingOn.waitFrom ??= sim.time) < C.LEARN_WAIT) {
              const [fx, fz] = playerFwd(tp), ex = this.x - tp.x, ez = this.z - tp.z, el = Math.hypot(ex, ez) || 1;
              if ((fx * ex + fz * ez) / el > 0.35) { this.stop(dt); anim.still = 1; this.usedCounter(tp.id, 'flash'); break; }
            }
            if (dir.allowChase(tp)) { this.startChase(tp); break; }
            this.closingOn = null;
          } else {
            this.closeReplanT = (this.closeReplanT || 0) - dt;
            // Getting ahead: they're moving away out of reach -> reappear ahead of them, unseen
            if (d > C.RELOCATE_AHEAD_TRIGGER && this.tryRelocate(tp, 'ahead')) { this.path = null; this.closeReplanT = 0; break; }
            // In the grass (rare): instead of closing from behind, lie flat beside the trail ahead
            if (this.closingOn.lieRoll == null) this.closingOn.lieRoll = this.rng();
            if (this.closingOn.lieRoll < C.LIE_CHANCE && d > 30 && d < 90 && this.tryLie(tp)) break;
            if (!this.path || this.closeReplanT <= 0) {
              const spot = this.observationSpot(tp, 'behind', 12, 24);
              this.planTo(spot ? spot[0] : tp.x, spot ? spot[1] : tp.z, 'cover');
              this.closeReplanT = 2.5;
            }
            this.followPath(dt, (d > 60 ? C.RELOCATE : C.STALK * 1.3) * (1 + .15 * escalation));
            this.maybeHush(tp, d);
            break;
          }
        }
        if (aw < 0.25 && ls && sim.time - ls.t > 25) { this.setState('search', { searchAt: { x: ls.x, z: ls.z }, searchPts: [] }); break; }
        if (!this.path || this.replanT <= 0) {
          const mode = this.falseRetreat ? 'ahead' : (this.rng() < 0.35 ? 'flank' : 'behind');
          const spot = this.observationSpot(tp, mode, lerp(C.OBSERVE_MIN,15,escalation), lerp(C.OBSERVE_MAX,35,escalation));
          if (spot) this.planTo(spot[0], spot[1], 'cover');
          this.falseRetreat = false;
          this.replanT = this.rng.range(5, 9) * (1 - .35 * escalation);
        }
        this.replanT -= dt;
        const done = this.followPath(dt, (d > 75 ? C.STALK * 1.4 : d > 40 ? C.STALK : C.WALK) * (1 + .2 * escalation));
        if (done) this.setState('watch', { watchDur: this.rng.range(4, 12) * (1 - .5 * escalation) });
        if (dir.wantsChase(tp, d) && aw > 1) this.startChase(tp);
        break;
      }
      case 'watch': {
        if (!tp) { this.setState('roam'); break; }
        if (this.lingerUntil != null && sim.time < this.lingerUntil) {
          // standing over the player he just struck, staring
          this.stop(dt); anim.still = 1; lookP = tp; break;
        }
        if (this.lingerUntil != null) { this.lingerUntil = null; this.retreatFrom(tp, false); break; }
        if (!this.concealedAt(this.x, this.z)) { this.retreatFrom(tp, false, true); break; }
        this.stop(dt); anim.still = 1;
        if (this.stateT > this.watchDur) { this.setState('stalk'); this.replanT = 0; }
        const d = this.dist(tp);
        if (d < 22 && (this.awareness.get(tp.id) || 0) > 1.4 && dir.wantsChase(tp, d)) this.startChase(tp);
        // a deliberate twig snap while watching from behind the player
        if (this.stateT > 2 && sim.time - this.snapT > 50 && d < 35 && this.rng() < dt * 0.05) {
          const ob = observedBy(this.world, tp, this.x, this.y, this.z, HEIGHT);
          if (ob.cos < 0) { this.snapT = sim.time; sim.emit({ type: 'snap', x: this.x, y: this.y, z: this.z }); }
        }
        break;
      }
      case 'freeze': {
        // completely motionless while watched; head keeps tracking
        this.stop(dt); anim.still = 1;
        const w = this.watcher != null ? sim.players.get(this.watcher) : null;
        if (w) lookP = w;
        if (!this.observers.length && this.stateT > 0.4) {
          // the moment they look away, he moves
          this.retreatFrom(w || tp || { x: this.x + 1, y: this.y, z: this.z }, false, true);
        } else if (this.stateT > this.freezeFor) {
          this.retreatFrom(w || tp, false);
        }
        break;
      }
      case 'retreat': {
        if(this.withdrawal){this.updateWithdrawal(dt);break;}
        // Keep escaping until genuinely occluded; an exposed route endpoint
        // must never become a prolonged stationary hiding pose.
        if (!this.path && tp && (minimum || sim.time >= (this.retreatPlanAt || 0))) {
          this.retreatPlanAt = sim.time + .4;
          const away = this.coverAway(tp, 8, 24); if (away) this.planTo(...away, 'cover');
        }
        // Puppet: watched, he backs away upright facing them (worn); unwatched he turns and
        // goes low and fast on all fours (operated)
        // A completed grab always gets a fast escape, even while the released
        // player is looking at him. Ordinary watched retreats still back away.
        const backing = watched && !this.fleeAfterGrab && !this.fastRetreat;
        this.backwards = backing;
        if (backing) { anim.back = 1; lookP = this.observers[0].p; } else anim.low = 1;
        const done = this.followPath(dt, backing ? C.SLOW_RETREAT : C.RETREAT);
        if (tp && this.stateT > 0.45 && this.concealedAt(this.x, this.z)) {
          this.scareVisibleUntil=null;this.fastRetreat=false;
          this.lastRetreatT = sim.time; this.setState('still', { stillFor: this.rng.range(2, 6) }); break;
        }
        if (done && this.fleeAfterGrab && this.stateT < 14) {
          // An exposed endpoint is another escape leg, not a return to stalking.
          this.path = null; break; // retain the replan time; do not postpone it every tick
        }
        if (done || this.stateT > 14) {
          this.scareVisibleUntil=null;this.fastRetreat=false;
          this.lastRetreatT = sim.time;
          if (this.fleeAfterGrab) { this.falseRetreat = false; this.setState('roam'); break; }
          if (tp && (this.awareness.get(tp.id) || 0) > 0.5) {
            // false retreat: reappear further ahead along their route
            this.falseRetreat = this.rng() < 0.45;
            if (this.concealedAt(this.x, this.z)) this.setState('still', { stillFor: this.rng.range(2, 6) });
            else { this.setState('stalk'); this.replanT = 0; }
          } else this.setState('roam');
        }
        break;
      }
      case 'reveal': this.updateReveal(dt); lookP = this.reveal && sim.players.get(this.reveal.pid); break;
      case 'chase': {
        lookP = null;
        if (!tp || !playerActive(tp)) { this.finishHunt(tp, 'target'); break; }
        // The entire encounter has one deadline. Neither noise, sight nor another request
        // can keep resetting it. Cancel even a pending grab at the deadline.
        if (sim.time >= this.huntEndsAt) { this.finishHunt(tp, 'timeout'); break; }
        if (this.grab) { this.updateGrab(dt, tp); lookP = tp; break; }
        if (sim.time < this.huntHideUntil) {
          this.updateHuntStalk(dt, tp);
          break;
        }
        if (this.huntPhase === 'stalk') {
          this.huntPhase = 'search'; this.path = null; this.huntSearchGoal = null; this.replanT = 0;
          sim.emit({ type: 'hv_hunt_phase', phase: 'search', pid: tp.id });
        }
        const concealed = this.dist(tp) > C.HIDE_MIN_DIST && this.hidden(tp);
        const vis = concealed ? 0 : sightOf(this.world, this, EYE, this.lookYaw, tp, C);
        if (vis > 0.02) {
          this.pebbleDecoy=null;
          this.lastSeenChase = { x: tp.x, z: tp.z, t: sim.time };
          this.huntContactAt = sim.time; this.huntSearchGoal = null;
        } else if (this.stimulus?.pid === tp.id && this.stimulus.t > (this.huntHeardAt ?? this.huntStartedAt)
            && (!this.pebbleDecoy||this.stimulus.t>=this.pebbleDecoy.t)) {
          this.pebbleDecoy=null;
          // Hearing reveals an approximate source, never the player's current position.
          this.huntHeardAt = this.stimulus.t;
          this.lastSeenChase = { x: this.stimulus.x, z: this.stimulus.z, t: this.stimulus.t };
          this.huntSearchGoal = null; this.replanT = 0;
        }
        const contact = !concealed && sim.time - (this.huntContactAt ?? -999) < C.HUNT_CONTACT_MEMORY;
        if (concealed) this.listenForBreath(dt, tp); else this.breathHeard = 0;
        if (!contact) {
          this.updateHuntSearch(dt, tp);
          break;
        }
        // Actual discovery leads to a rush. Once sight is broken, that rush only follows
        // the remembered point briefly; it cannot chase a hidden player's live coordinates.
        anim.run = 1;
        if (vis > 0.02) { lookP = tp; this.lookAtPoint(tp.x, tp.y + eyeHeight(tp), tp.z); }
        const d = this.dist(tp), seenByTarget = this.observers.some(o => o.p.id === tp.id);
        if (seenByTarget && !this.lbWatched && sim.time >= this.lbNext && d > C.LOOKBACK_MIN_DIST) {
          this.lbUntil = sim.time + this.rng.range(...C.LOOKBACK_FREEZE);
          this.lbNext = this.lbUntil + C.LOOKBACK_GAP;
          sim.emit({ type: 'hv_freeze', pid: tp.id, x: +this.x.toFixed(2), z: +this.z.toFixed(2) });
        }
        this.lbWatched = seenByTarget;
        if (sim.time < this.lbUntil) { this.stop(dt); anim.run = 0; anim.still = 1; anim.frozen = 1; break; }
        if (!watched) anim.low = 1;
        this.replanT -= dt;
        const ls = this.lastSeenChase;
        if (!this.path || this.pathMode !== 'direct' || this.replanT <= 0) { this.planTo(ls.x, ls.z, 'direct'); this.replanT = d < 15 ? .3 : .7; }
        // A visible final lunge uses physical collision around the coarse nav-grid cells.
        if (vis > .02 && d < C.HUNT_LUNGE_DIST
            && this.world.lineOfSight(this.x, this.y + 1, this.z, tp.x, tp.y + eyeHeight(tp), tp.z, { brushK: 0 }) > .5) {
          this.path = [[this.x, this.z], [tp.x, tp.z]]; this.pathI = 1; this.freeLunge = true;
        }
        if (sim.time >= this.huntPaceAt) {
          this.huntPace = this.rng.range(...C.HUNT_PACE);
          this.huntPaceAt = sim.time + this.rng.range(...C.HUNT_PACE_INTERVAL);
        }
        const tempo = d < 7 ? Math.max(1, this.huntPace || 1) : (this.huntPace || 1);
        this.followPath(dt, (d < 12 ? C.BURST : C.CHASE) * tempo * dir.chaseSpeedMul() * (1 + .12 * escalation));
        this.freeLunge = false;
        if (d < 4 && watched) anim.reach = 1;
        if (sim.time < (this.missPauseUntil ?? -1)) { this.stop(dt); anim.still = 1; break; }
        if (vis > .02 && d < C.GRAB_REACH && Math.abs(this.y - tp.y) < 1.8
            && sim.time - this.attackT > C.ATTACK_COOLDOWN
            && this.world.lineOfSight(this.x, this.y + 1, this.z, tp.x, tp.y + eyeHeight(tp), tp.z, { brushK: 0 }) > .2) {
          this.startGrab(tp); lookP = tp;
        }
        break;
      }
      case 'search': {
        if(this.pebbleDecoy){
          const decoy=this.pebbleDecoy;
          const sight=tp&&this.lastSeen.get(tp.id)?.t>=decoy.t;
          const sound=this.stimulus&&this.stimulus.t>=decoy.t&&this.stimulus.loud>.25;
          if(sight||sound){this.pebbleDecoy=null;this.path=null;this.huntSearchGoal=null;}
          else{this.updateHuntSearch(dt,tp);this.lookAtPoint(decoy.x,decoy.y,decoy.z);break;}
        }
        const c = this.searchAt;
        if (!this.searchPts.length && this.stateT < 1) {
          for (let k = 0; k < 4; k++) { const a = this.rng.range(0, 6.28), r = this.rng.range(4, 16); this.searchPts.push([c.x + Math.sin(a) * r, c.z + Math.cos(a) * r]); }
        }
        if (!this.path && this.searchPts.length) { const p = this.searchPts.shift(); this.planTo(p[0], p[1], 'quiet'); this.pauseT = this.rng.range(1.5, 4); }
        const done = this.followPath(dt, C.WALK);
        if (done) { this.pauseT -= dt; if (this.pauseT > 0) { this.stop(dt); anim.still = 0.5; this.lookYaw += dt * 0.8 * Math.sin(this.stateT * 0.7); } else this.path = null; }
        if (this.stimulus && sim.time - this.stimulus.t < 1 && this.stimulus.loud > 0.25) this.setState('investigate', { inv: this.stimulus, stimulus: null });
        if (this.stateT > C.SEARCH_TIME || (!this.searchPts.length && !this.path)) this.setState('roam');
        if (tp && (this.awareness.get(tp.id) || 0) > 1.2) this.setState('stalk');
        break;
      }
      case 'collapse': {
        // strings cut: limp on the ground. Look away, look back: gone.
        this.stop(dt); anim.collapse = 1;
        this.unseenT = watched ? 0 : (this.unseenT || 0) + dt;
        const from = sim.players.get(this.collapsePid) || tp;
        if (this.stateT > C.COLLAPSE_MIN && this.unseenT >= C.COLLAPSE_GONE_AFTER && this.vanish(from)) break;
        if (this.stateT > C.COLLAPSE_MAX) { anim.collapse = 0; this.retreatFrom(from, false); }
        break;
      }
      case 'lie': {
        // in the grass beside the trail, flat; unfolds when they come close
        this.stop(dt); anim.prone = 1;
        const lp = sim.players.get(this.lieFor);
        if(watched || this.riseAt!=null){
          if(this.scareVisibleUntil==null)this.scareVisibleUntil=sim.time+this.rng.range(...C.SCARE_VISIBLE);
          if(sim.time>=this.scareVisibleUntil){this.riseAt=null;this.retreatFrom(lp,false,true);break;}
        }
        if (this.riseAt != null) {
          anim.rise = 1; anim.prone = 0; if (lp) lookP = lp;
          if (sim.time - this.riseAt >= C.RISE_TIME) {
            this.riseAt = null;
            if (lp && playerActive(lp) && !dir.inDread?.() && dir.allowChase(lp)) { this.target = lp.id; this.startChase(lp); }
            else this.retreatFrom(lp, false,true);
          }
          break;
        }
        if (!lp || !playerActive(lp) || !this.outsideSpawn(lp.x, lp.z)) { this.retreatFrom(lp,false,true); break; }
        const d = this.dist(lp);
        this.lieMin = Math.min(this.lieMin ?? 1e9, d);
        const lit = this.litBy && this.litBy.ob.d < 9;
        if (d <= C.LIE_WAKE || lit) {
          this.riseAt = sim.time; this.yaw = this.lookYaw = Math.atan2(lp.x - this.x, lp.z - this.z);
          sim.emit({ type: 'hv_rise', pid: lp.id, x: +this.x.toFixed(2), z: +this.z.toFixed(2) });
          break;
        }
        // They went another way or passed him: break line of sight at speed.  Do not return
        // to a close stalk here, which previously made him hover around 12 feet after a lie.
        if (!watched && (this.stateT > C.LIE_TIMEOUT || (this.lieMin < 14 && d > this.lieMin + 10))) {
          this.target = lp.id; this.retreatFrom(lp, false, true);
        }
        break;
      }
      default: this.setState('roam');
    }
    // operated (unwatched) movement is low, on all fours: players only glimpse it
    if (this.operated && this.speed > 0.6) anim.low = 1;
    this.lowPose = !!anim.low;

    // head: locked on whoever he is aware of, otherwise looks where he walks with a slow scan
    if (lookP) this.lookAtPoint(lookP.x, lookP.y + 1.5, lookP.z);
    else if (this.state !== 'search') { this.lookYaw += angleDiff(this.lookYaw, this.yaw + Math.sin(sim.time * 0.3) * 0.5) * Math.min(1, dt * 2); this.lookPitch = lerp(this.lookPitch, -0.05, dt); }
    anim.tilt = anim.frozen || this.state === 'watch' || (this.state === 'reveal' && this.reveal?.phase === 'show') ? 0.35 * Math.sin(sim.time * 0.13 + 0.7) + (anim.peek === 2 ? 1.1 : 0) : 0;
    anim.jaw = this.grab ? (this.grab.kind === 'final' ? 1 : 0.35) : sim.time - this.vocalT < 1.4 ? 0.6 + 0.4 * Math.sin(sim.time * 17) : 0;
    this.searchMovementSound(dt, moveFromX, moveFromZ, wasSearching);
    this.vocals(dt);
  }

  isSearching() {
    return this.state === 'search' || (this.state === 'chase' && this.huntPhase === 'search');
  }

  canHearPebble(){
    const sim=this.sim;
    if(this.withdrawal||this.fleeAfterGrab||this.fastRetreat||this.grab||!['play','extract'].includes(sim.state))return false;
    if(this.state!=='search'&&!(this.state==='chase'&&this.huntPhase==='search'
        &&sim.time>=this.huntHideUntil&&sim.time<this.huntEndsAt))return false;
    // A phase flag alone is insufficient: clear discovery/rush memory wins.
    const target=sim.players.get(this.target);
    const concealed=target&&this.dist(target)>C.HIDE_MIN_DIST&&this.hidden(target);
    if(this.state==='chase'&&!concealed&&sim.time-(this.huntContactAt??-999)<C.HUNT_CONTACT_MEMORY)return false;
    for(const p of sim.playerList){
      if(!playerActive(p))continue;
      if(this.dist(p)>C.HIDE_MIN_DIST&&this.hidden(p))continue;
      if(sightOf(this.world,this,EYE,this.lookYaw,p,C)>.02)return false;
    }
    return true;
  }

  hearPebble(at){
    if(!this.canHearPebble()||![at.x,at.y,at.z].every(Number.isFinite)
        ||Math.hypot(at.x-this.x,at.y-this.y-EYE,at.z-this.z)>CONFIG.PEBBLE.HEAR_RANGE)return false;
    this.pebbleDecoy={x:at.x,y:at.y,z:at.z,t:this.sim.time,until:this.sim.time+CONFIG.PEBBLE.DISTRACTION_TIME};
    this.path=null;this.huntSearchGoal=null;this.huntSearchedAt=-Infinity;this.replanT=0;
    return true;
  }

  resetSearchSound() {
    this.searchSoundTravel = 0;
    this.searchSoundDistance = this.searchSoundRng.range(...C.SEARCH_CRACK_TRAVEL);
    this.searchSoundAt = Math.max(this.searchSoundAt || 0, this.sim.time + .65);
  }

  searchMovementSound(dt, fromX, fromZ, wasSearching) {
    // Use physical displacement, not an animation/speed flag. Waiting, blocked
    // legs, a look-back freeze, a grab and a hidden relocation cannot crack.
    const distance = Math.hypot(this.x - fromX, this.z - fromZ);
    if (!wasSearching || !this.isSearching() || this.grab || this.anim.run || this.anim.frozen
        || distance < dt * .15 || distance > C.WALK * 1.35 * dt * 1.5 + .03) {
      this.resetSearchSound(); return;
    }
    this.searchSoundTravel += distance;
    if (this.searchSoundTravel < this.searchSoundDistance || this.sim.time < this.searchSoundAt) return;
    this.sim.emit({ type: 'hv_search_move', x: +this.x.toFixed(2), y: +(this.y + 1.15).toFixed(2), z: +this.z.toFixed(2),
      s: this.searchSoundRng.int(0, 65535) });
    this.searchSoundTravel = 0;
    this.searchSoundDistance = this.searchSoundRng.range(...C.SEARCH_CRACK_TRAVEL);
    this.searchSoundAt = this.sim.time + this.searchSoundRng.range(...C.SEARCH_CRACK_INTERVAL);
  }

  decideAfterSpotting(tp) {
    const dir = this.sim.director;
    if (!tp) { this.setState('roam'); return; }
    const d = this.dist(tp);
    if (dir.wantsChase(tp, d) && d < 28) this.startChase(tp);
    else if (this.rng() < 0.3) this.retreatFrom(tp, false);
    else { this.setState('stalk'); this.replanT = 0; }
  }

  retreatFrom(p, lit = false, quick = false, afterGrab = false) {
    this.windup = null; this.grab = null; this.backwards = !afterGrab && !!this.observers?.length;
    const countedReveal=this.state==='reveal' && this.reveal?.counted;
    if (this.state === 'chase' && this.sim.director.chasing) this.sim.director.onChaseEnd(false);
    p ||= this.sim.players.get(this.target) || { x: this.x + 1, y: this.y, z: this.z };
    const minimum = Math.max(lit ? 14 : 10, this.openingDistance() - this.dist(p) + 10);
    const away = this.coverAway(p, minimum, Math.max(minimum + 20, lit ? 34 : 26));
    this.closingOn=null;this.freeze=null;this.holdStare=null;
    this.setState('retreat', { fleeAfterGrab: afterGrab, fastRetreat:quick||afterGrab||!!this.withdrawal });
    if (afterGrab) {
      this.falseRetreat = false;
      this.anim.grab = 0; this.anim.run = 0; this.anim.reach = 0; this.anim.back = 0; this.anim.still = 0; this.anim.low = 1;
    }
    if (away) this.planTo(away[0], away[1], 'cover');
    if (this.path?.length > 1) this.yaw = Math.atan2(this.path[1][0] - this.x, this.path[1][1] - this.z) + (this.backwards ? Math.PI : 0);
    // Only perceived escapes add tension. Unseen repositioning must not
    // keep the director in permanent recovery while the player hears nothing.
    if (!countedReveal && this.sim.time-(this.presenceReportT??-999)>=5
        && (this.observers?.length || this.dist(p) <= C.FOOTSTEP_MAX_DISTANCE || this.sim.time-this.attackT < .2)){
      this.sim.director.onReveal('retreat');this.presenceReportT=this.sim.time;
    }
  }

  beginWithdrawal(p) {
    if(this.withdrawal)return;
    this.withdrawal={x:this.x,z:this.z,pid:p?.id??this.target,startedAt:this.sim.time,goal:null,planAt:0};
    this.closingOn=null;this.reveal=null;this.freeze=null;this.holdStare=null;
    this.lingerUntil=null;this.falseRetreat=false;
  }

  planWithdrawal() {
    const r=this.withdrawal,w=this.world,sim=this.sim;
    const target=sim.players.get(r.pid),away=Math.atan2(this.x-(target?.x??r.x),this.z-(target?.z??r.z));
    const candidates=[];
    for(const radius of [C.WITHDRAW_DISTANCE+24,C.WITHDRAW_DISTANCE+65])for(let k=0;k<24;k++){
      const a=away+k*Math.PI/12;
      let x=r.x+Math.sin(a)*radius,z=r.z+Math.cos(a)*radius;
      if(!w.navWalkable(x,z) && w.nearestNav){
        const i=w.nearestNav(x,z,18);if(i<0)continue;[x,z]=w.cellPos(i);
      }
      if(!w.navWalkable(x,z)||!this.openingClear(x,z))continue;
      const originDistance=Math.hypot(x-r.x,z-r.z),targetDistance=target?Math.hypot(x-target.x,z-target.z):originDistance;
      if(Math.min(originDistance,targetDistance)<C.WITHDRAW_DISTANCE+5)continue;
      // Other teammates influence the exit without imposing an impossible
      // 200m exclusion circle around every spread-out co-op player.
      let penalty=0;
      for(const p of sim.playerList)if(playerActive(p)){
        const d=Math.hypot(x-p.x,z-p.z);penalty+=Math.max(0,35-d)*3;
      }
      const travel=Math.hypot(x-this.x,z-this.z);
      candidates.push({x,z,score:travel+penalty+Math.abs(angleDiff(away,a))*10});
    }
    candidates.sort((a,b)=>a.score-b.score);
    for(const c of candidates.slice(0,10))if(this.planTo(c.x,c.z,'cover')){r.goal=[c.x,c.z];return true;}
    return false;
  }

  updateWithdrawal(dt) {
    const r=this.withdrawal,sim=this.sim,target=sim.players.get(r.pid);
    const distance=Math.hypot(this.x-r.x,this.z-r.z),targetDistance=target?this.dist(target):distance;
    if(Math.min(distance,targetDistance)>=C.WITHDRAW_DISTANCE){
      this.lastWithdrawal={...r,completedAt:sim.time,distance,targetDistance};this.withdrawal=null;
      this.fleeAfterGrab=false;this.fastRetreat=false;this.scareVisibleUntil=null;
      this.setState('roam');this.roamPlanAt=sim.time+.5;this.lastRetreatT=sim.time;return;
    }
    if(r.goal && target && Math.hypot(r.goal[0]-target.x,r.goal[1]-target.z)<C.WITHDRAW_DISTANCE+3){
      this.path=null;r.goal=null;
    }
    if(!this.path && sim.time>=r.planAt){
      r.planAt=sim.time+.8;
      if(r.goal && this.planTo(...r.goal,'cover')){}else this.planWithdrawal();
    }
    // Flee the sightline at full speed, then walk out physically. Cover is a
    // pace change, never completion of the 200m withdrawal.
    const escaping=!!this.observers?.length || !this.concealedAt(this.x,this.z);
    this.backwards=false;this.anim.back=0;this.anim.low=escaping?1:0;
    if(this.followPath(dt,escaping?C.RETREAT:C.WITHDRAW_SPEED))this.path=null;
  }

  startChase(p) {
    if (this.withdrawal || this.fleeAfterGrab || this.fastRetreat) return false;
    if (!p || !playerActive(p) || p.state !== 'alive') return false;          // never on a downed/dead player (PLAYTESTS_50 P0)
    if (!this.outsideSpawn(p.x,p.z) || this.sim.director.inDread?.()) return false;
    if (this.sim.time < (p.hideGraceUntil ?? -1) && !this.sim.dev) return false;  // just hid from him: a breather
    if (this.state === 'chase') return this.target === p.id; // never reset an active encounter
    if(this.sim.time<(this.sim.director.nextChaseAt||0))return false;
    // Hunts start close (owner, Oct 25): farther out, mark the player and close in
    // unseen first (stalk handles the approach and commits inside the range).
    if (this.dist(p) > C.HUNT_START_RANGE) {
      if (this.closingOn?.pid !== p.id) {
        this.closingOn = { pid: p.id, t: this.sim.time }; this.closeReplanT = 0;
        // the mark: his joints crack, far off and quiet (Puppet)
        this.sim.emit({ type: 'hv_pops', pid: p.id, x: +this.x.toFixed(1), y: +this.y.toFixed(1), z: +this.z.toFixed(1) });
      }
      this.target = p.id;
      if (this.state !== 'stalk') { this.setState('stalk'); this.replanT = 0; }
      return false;
    }
    this.closingOn = null; this.trackT = 0; this.huntStall = null; this.huntUnseenT = 0; this.huntRelocated = false; this.huntSprintT = 0; this.huntSprintNoted = false; this.counterSaid = null;
    this.huntPace = this.rng.range(...C.HUNT_PACE);
    this.huntPaceAt = this.sim.time + this.rng.range(...C.HUNT_PACE_INTERVAL);
    this.huntCutMul = this.rng.range(...C.HUNT_CUTOFF_JITTER);
    this.hide = { t: 0 };
    this.target = p.id; this.lastSeenChase = { x: p.x, z: p.z, t: this.sim.time }; this.windup = null; this.lingerUntil = null; this.grab = null; this.lbWatched = false; this.lbNext = this.sim.time + 0.4;
    this.setState('chase'); this.replanT = 0;
    this.closeCommitted = true;
    this.sim.director.onChaseStart(p);
  }

  // A distant opening stalk gives players time to choose a hiding place. Replan on a
  // cadence, including when no cover is available, so failed searches cannot run every tick.
  updateHuntStalk(dt, tp) {
    this.anim.run = 0; this.huntStall = null;
    this.replanT -= dt;
    const tooClose = this.dist(tp) < C.HUNT_STALK_DIST[0] - 4;
    if (this.replanT <= 0 || (tooClose && !this.stalkBackingOff)) {
      const spot = this.observationSpot(tp, 'behind', ...C.HUNT_STALK_DIST)
        || (tooClose ? this.coverAway(tp, ...C.HUNT_STALK_DIST) : null);
      if (spot) this.planTo(...spot, 'cover'); else this.path = null;
      this.stalkBackingOff = tooClose;
      this.replanT = tooClose ? 1.2 : this.rng.range(4, 7);
    }
    if (this.path) { if (this.followPath(dt, tooClose ? C.STALK * 1.3 : C.STALK * .9)) this.path = null; }
    else this.stop(dt);
    // Remember sightings/sounds acquired during stalking, not an invisible live target.
    const seen = this.lastSeen.get(tp.id);
    if (seen?.t === this.sim.time) this.lastSeenChase = { ...seen };
    else if (this.stimulus?.pid === tp.id && this.stimulus.t > this.huntHeardAt) {
      this.huntHeardAt = this.stimulus.t;
      this.lastSeenChase = { x: this.stimulus.x, z: this.stimulus.z, t: this.stimulus.t };
    }
  }

  updateHuntSearch(dt, tp) {
    this.anim.run = 0; this.anim.low = 0; this.huntStall = null;
    this.lbWatched = false;
    const known = this.pebbleDecoy||this.lastSeenChase;
    if (!known) { this.stop(dt); return; }
    this.replanT -= dt;
    // First examine the last sight/sound. Then check separate points around it, stop
    // briefly and listen. Search points never overwrite the last real evidence.
    if (!this.huntSearchGoal && this.replanT <= 0) {
      if (this.huntSearchedAt !== known.t) {
        this.huntSearchedAt = known.t; this.huntSearchGoal = [known.x, known.z];
      } else for (let i = 0; i < 8; i++) {
        const a = this.rng.range(0,Math.PI*2), r = this.rng.range(...C.HUNT_SEARCH_RADIUS);
        const x = known.x+Math.sin(a)*r, z=known.z+Math.cos(a)*r;
        if (this.world.navWalkable(x,z) && this.openingClear(x,z)) { this.huntSearchGoal=[x,z]; break; }
      }
      if (this.huntSearchGoal && !this.planTo(...this.huntSearchGoal,'quiet')) this.huntSearchGoal=null;
      this.replanT = 1.5;
    }
    if (this.path && this.followPath(dt, C.WALK * 1.35)) {
      this.path = null; this.huntSearchGoal = null; this.replanT = this.rng.range(.7,1.6);
    } else if (!this.path && this.huntSearchGoal) this.huntSearchGoal = null;
    if (!this.path) { this.stop(dt); this.anim.still = .5; }
    this.lookYaw = this.yaw + Math.sin(this.sim.time * .85) * .8;
  }

  // Update 0.9 "hold your breath": searching within earshot of a concealed player who is
  // breathing, he notices after BREATH.GRACE s and walks to (about) where they are. Holding
  // their breath, or being further than rules.breathHear, lets it drain away again.
  listenForBreath(dt, tp) {
    const B = CONFIG.BREATH, sim = this.sim, d = this.dist(tp), hear = sim.rules?.breathHear ?? 4.5;
    // for the night report: a search pass this close to a hidden player
    if (d < B.CLOSE_PASS) { if (!this.closePass) { this.closePass = true; sim.emit({ type: 'hv_close_pass', pid: tp.id }); } }
    else if (d > B.CLOSE_PASS + 3) this.closePass = false;
    if (d < hear && !tp.breath) this.breathHeard = (this.breathHeard || 0) + dt;
    else this.breathHeard = Math.max(0, (this.breathHeard || 0) - dt);
    if (this.breathHeard < B.GRACE) return;
    this.breathHeard = 0;
    const e = B.ERROR;
    this.pebbleDecoy = null;
    this.lastSeenChase = { x: tp.x + this.rng.range(-e, e), z: tp.z + this.rng.range(-e, e), t: sim.time };
    this.huntSearchGoal = null; this.huntSearchedAt = -Infinity; this.replanT = 0; this.path = null;
    sim.emit({ type: 'hv_heard', what: 'breath', pid: tp.id });
  }

  // A loud noise in the world (a popped balloon): he hears where it came from. `pid` is who
  // caused it, so a hunt on that player takes it as evidence of them.
  hearNoise(x, z, radius, pid = null) {
    const d = Math.hypot(x - this.x, z - this.z);
    if (d > radius || !this.outsideSpawn(x, z)) return false;
    this.stimulus = { x, z, t: this.sim.time, loud: 1 - d / radius, pid, voice: false };
    return true;
  }

  finishHunt(tp, reason = 'timeout') {
    if (this.grab) {
      const kind = this.grab.kind;
      this.releaseGrab(tp, false);
      this.sim.emit({ type: 'hv_attack', phase: 'release', kind, pid: tp?.id, x: this.x, z: this.z });
    }
    const caught = reason === 'grab';
    const hidden = !caught && tp && this.hidden(tp);
    if (!caught) this.sim.balloons?.mark(this.x, this.z, 'gave_up');
    this.breathHeard = 0; this.closePass = false;
    if (tp && playerActive(tp)) {
      tp.hideGraceUntil = this.sim.time + C.HIDE_GRACE[this.sim.playerList.filter(playerActive).length <= 1 ? 0 : 1];
      if (hidden) {
        this.noteTactic(tp.id,'hide');
        this.sim.emit({ type:'hv_lost', pid:tp.id, x:this.x, y:this.y, z:this.z });
      }
    }
    this.sim.emit({ type:'hv_hunt_phase', phase:'end', reason, pid:tp?.id });
    if (hidden) this.collapseFrom(tp); else this.retreatFrom(tp,false,true,caught);
  }

  // ---- the grab (owner, Puppet rework): replaces the swing. Survive two; the third kills.
  startGrab(tp, around = false) {
    const sim = this.sim;
    if (this.state !== 'chase' || this.huntPhase === 'stalk' || sim.time >= this.huntEndsAt || !playerActive(tp)) return false;
    const [fx, fz] = playerFwd(tp);
    const ex = this.x - tp.x, ez = this.z - tp.z, el = Math.hypot(ex, ez) || 1;
    const facing = (fx * ex + fz * ez) / el;            // > 0: they are facing him
    let kind;
    if (tp.health <= 1) kind = 'final';
    else {
      const set = facing < -0.2 ? ['turn', 'drag'] : ['shoulders', 'throat', 'face'];
      const options = set.filter((k) => k !== this.lastGrabKind);
      kind = options[Math.floor(this.rng() * options.length) % options.length];
    }
    this.grab = { kind, phase: 'reach', t: sim.time, pid: tp.id, around };
    this.anim.grab = 1;
    sim.emit({ type: 'hv_attack', phase: 'reach', kind, pid: tp.id, x: +this.x.toFixed(2), z: +this.z.toFixed(2) });
  }

  updateGrab(dt, tp) {
    const sim = this.sim, g = this.grab, w = this.world;
    this.anim.grab = 1; this.anim.run = 0;
    const d = this.dist(tp);
    this.yaw += angleDiff(this.yaw, Math.atan2(tp.x - this.x, tp.z - this.z)) * Math.min(1, dt * 12);
    this.lookAtPoint(tp.x, tp.y + 1.5, tp.z);
    if (g.phase === 'reach') {
      if (d > 0.9) moveCharacter(w, this, Math.sin(this.yaw) * 2.4 * dt, Math.cos(this.yaw) * 2.4 * dt, 0.32, { nav: true, slope: false, step: C.STEP_OVER });
      if (sim.time - g.t < C.GRAB_WINDUP) return;
      const lands = this.dist(tp) < (g.around ? C.GRAB_AROUND + 0.3 : C.GRAB_LAND) && Math.abs(this.y - tp.y) < 1.8 && tp.state === 'alive'
        && (g.around || w.lineOfSight(this.x, this.y + 1, this.z, tp.x, tp.y + 1, tp.z, { brushK: 0 }) > 0.2);
      if (!lands) {
        sim.emit({ type: 'hv_attack', phase: 'miss', kind: g.kind, pid: tp.id, x: +this.x.toFixed(2), z: +this.z.toFixed(2) });
        this.grab = null; this.attackT = sim.time; this.missPauseUntil = sim.time + C.MISS_PAUSE; return;
      }
      g.phase = 'hold'; g.t = sim.time; g.dur = C.GRAB_HOLD[g.kind] || 1.6;
      // drag: he yanks them a couple of metres toward him first
      let px = tp.x, pz = tp.z;
      if (g.kind === 'drag') {
        const ux = (this.x - tp.x) / (d || 1), uz = (this.z - tp.z) / (d || 1), pull = Math.max(0, Math.min(2.2, d - 0.6));
        const nx = tp.x + ux * pull, nz = tp.z + uz * pull;
        if (w.navWalkable(nx, nz) && this.outsideSpawn(nx, nz)) { px = nx; pz = nz; }
      }
      tp.x = px; tp.z = pz; tp.y = groundAt(w, px, pz); tp.lastX = px; tp.lastZ = pz;
      tp.heldUntil = sim.time + g.dur;
      // he pulls in face to face, GRAB_STAND in front of them (moved over the next ticks)
      const a = Math.atan2(this.x - px, this.z - pz);
      g.stand = [px + Math.sin(a) * C.GRAB_STAND, pz + Math.cos(a) * C.GRAB_STAND];
      sim.emit({ type: 'hv_attack', phase: 'grab', kind: g.kind, pid: tp.id, dur: g.dur,
        x: +this.x.toFixed(2), z: +this.z.toFixed(2), px: +px.toFixed(2), pz: +pz.toFixed(2) });
      return;
    }
    this.stop(dt);
    if (g.stand) {
      const dx = g.stand[0] - this.x, dz = g.stand[1] - this.z, dd = Math.hypot(dx, dz), k = Math.min(1, 5 * dt / (dd || 1));
      if (dd > 0.03) {
        const r = moveCharacter(w, this, dx * k, dz * k, 0.32, { nav: true, slope: false, step: C.STEP_OVER });
        if (!spawnStepBlocked(w, this.x, this.z, r.x, r.z)) { this.x = r.x; this.z = r.z; this.y = groundAt(w, r.x, r.z); }
      }
    }
    if (sim.time - g.t >= g.dur) this.releaseGrab(tp, true);
  }

  releaseGrab(tp, landed) {
    const sim = this.sim, g = this.grab;
    this.grab = null; this.anim.grab = 0; this.attackT = sim.time;
    if (tp) tp.heldUntil = null;
    if (!landed || !tp || !g) return;
    this.lastGrabKind = g.kind;
    sim.emit({ type: 'hv_attack', phase: 'release', kind: g.kind, pid: tp.id, x: +this.x.toFixed(2), z: +this.z.toFixed(2) });
    if (playerAlive(tp)) sim.damagePlayer(tp, 'hv', this);
    sim.director.onAttack(tp);
    this.awareness.set(tp.id, 0.5);
    this.finishHunt(tp, 'grab');
  }

  // Concealment during a timed search: crouched/covered, lighter off, still and quiet.
  // It prevents discovery; the hunt's shared deadline determines when he gives up.
  hidden(tp) {
    // standing upright in the open is not hiding, however far he is: crouch, get in brush or under cover
    if (!tp.flash && (tp.crouch || tp.hidden || tp.covered) && (tp.moveSpeed || 0) < C.HIDE_STILL && !tp.sprint && noiseRadius(tp, C) <= C.HIDE_NOISE) {
      // A deployed blanket removes the need for hard cover, but only while the player is
      // crouched, motionless, dark and quiet; moving or leaving the light on exposes them.
      // sight is tested toward them, not along wherever his head happens to point: otherwise looking
      // away while they paused counted as 'hidden' and he collapsed mid-chase
      return (tp.covered || this.trunkShield(tp) || sightOf(this.world, this, EYE, Math.atan2(tp.x - this.x, tp.z - this.z), tp, C) < 0.02)
        && !this.observers.some((o) => o.p.id === tp.id && o.ob?.lit);
    }
    return false;
  }

  // Collision keeps a player just outside a trunk, which can leave a grazing visual ray.
  // Treat that trunk as hard cover when it is physically between Helium and a crouched player.
  trunkShield(tp) {
    const eye=eyePosition(this.world,tp,this._trunkEye||(this._trunkEye={}));
    const dx = this.x - eye.x, dz = this.z - eye.z, d = Math.hypot(dx, dz);
    if (d < 1 || !this.world.queryColliders) return false;
    const refs = this.world.queryColliders(eye.x, eye.z, 1.5, this._shieldRefs || (this._shieldRefs = []));
    for (const ref of refs) {
      if (ref >= 100000) continue;
      const c = this.world.circles[ref]; if (!c || c[2] < 0.1) continue;
      const tx = c[0] - eye.x, tz = c[1] - eye.z;
      const along = (tx * dx + tz * dz) / d;
      if (along <= 0 || along > Math.min(1.6, d - 0.1)) continue;
      const side = Math.abs(tx * dz - tz * dx) / d;
      if (side < c[2] + 0.14) return true;
    }
    return false;
  }

  updateHide(dt, tp) {
    const h = this.hide ||= { t: 0 };
    const need = C.HIDE_TIME * (this.counters(tp.id, 'hide') ? C.HIDE_LEARNED : 1);
    if (this.dist(tp) > C.HIDE_MIN_DIST && this.hidden(tp)) h.t = Math.min(need,h.t + dt); else h.t = Math.max(0, h.t - dt * 2);
    if (h.t >= need) return tp;
    return null;
  }

  slipAround(tp) {
    const w = this.world; this.slipT = this.sim.time;
    // A close slip is only frightening if both ends are unseen.  Lighting changes can make
    // `watched` false while his body still sits on the edge of a player's screen.
    if (this.sim.playerList.some((p) => playerActive(p) && onScreen(w, p, this.x, this.y, this.z, HEIGHT, 0.6))) return false;
    const base = Math.atan2(this.x - tp.x, this.z - tp.z);
    for (let k = 1; k < 12; k++) {
      const a = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 6), r = 1.3;
      const x = tp.x + Math.sin(a) * r, z = tp.z + Math.cos(a) * r;
      if (!this.outsideSpawn(x, z) || !w.isPlayable?.(x, z)) continue;
      const fit = moveCharacter(w, { x, y: groundAt(w, x, z), z }, 0, 0, 0.32, { nav: false, slope: false, step: C.STEP_OVER });
      if (Math.hypot(fit.x - x, fit.z - z) > 0.05) continue;     // inside a trunk
      if (w.lineOfSight(x, groundAt(w, x, z) + 1, z, tp.x, tp.y + 1, tp.z, { brushK: 0 }) < 0.5) continue;
      const y = groundAt(w, x, z);
      if (this.sim.playerList.some((p) => playerActive(p) && onScreen(w, p, x, y, z, HEIGHT, 0.6))) continue;   // never pops into view
      const fx = this.x, fz = this.z;
      if (this.place(x, z) === false) continue;
      this.yaw = this.lookYaw = Math.atan2(tp.x - x, tp.z - z); this.path = null; this.huntStall = null;
      this.sim.emit({ type: 'hv_relocate', reason: 'slip', pid: tp.id, x: +x.toFixed(1), z: +z.toFixed(1), fx: +fx.toFixed(1), fz: +fz.toFixed(1) });
      return true;
    }
    return false;
  }

  // ---- collapse is a non-hunt scare; ended hunts must withdraw physically
  collapseFrom(p) {
    const sim = this.sim, dir = sim.director;
    if (this.state === 'chase' && dir.chasing) dir.onChaseEnd(false);
    if(this.withdrawal){this.retreatFrom(p,false,true);return;}
    this.grab = null; this.closingOn = null; this.lingerUntil = null;
    this.setState('collapse', { collapsePid: p?.id ?? null, unseenT: 0 });
    this.lastRetreatT = sim.time;
    sim.emit({ type: 'hv_collapse', x: +this.x.toFixed(2), y: +this.y.toFixed(2), z: +this.z.toFixed(2) });
    if (sim.time - (this.presenceReportT ?? -999) >= 5) { dir.onReveal('retreat'); this.presenceReportT = sim.time; }
  }

  // gone while nobody was looking: reappears far off, concealed, never where anyone can see
  vanish(p) {
    if(this.withdrawal)return false;
    const sim = this.sim;
    p ||= sim.nearestPlayer(this.x, this.z)?.p;
    if (!p) return false;
    const spot = this.coverAway(p, C.COLLAPSE_AWAY[0], C.COLLAPSE_AWAY[1]);
    if (!spot || !this.unseenSpot(spot[0], spot[1])) return false;
    const fx = this.x, fz = this.z;
    if (this.place(spot[0], spot[1]) === false) return false;
    this.speed = 0;
    sim.emit({ type: 'hv_relocate', reason: 'collapse', pid: p.id, x: +this.x.toFixed(1), z: +this.z.toFixed(1), fx: +fx.toFixed(1), fz: +fz.toFixed(1) });
    this.setState('still', { stillFor: this.rng.range(3, 7) });
    return true;
  }

  unseenSpot(x, z, h = HEIGHT) {
    for (const p of this.sim.playerList) {
      if (!playerActive(p)) continue;
      if (Math.hypot(p.x - x, p.z - z) < C.RELOCATE_MIN_DIST) return false;
      for (const [ox, oz] of RELOC_JITTER) {
        const jx = x + ox, jz = z + oz;
        if (onScreen(this.world, p, jx, groundAt(this.world, jx, jz), jz, h, 0.6) || onScreen(this.world, p, jx, this.world.heightAt(jx, jz), jz, h, 0.6)) return false;
      }
    }
    return true;
  }

  // ---- in the grass: lie flat beside the trail ahead of them (placed unseen)
  grassAt(x, z) {
    const w = this.world;
    if (!w.grass) return 0;
    if (!w._grassCells) {
      w._grassCells = new Map();
      for (const g of w.grass) { const k = Math.floor(g[0] / 4) + ',' + Math.floor(g[2] / 4); w._grassCells.set(k, (w._grassCells.get(k) || 0) + 1); }
    }
    return w._grassCells.get(Math.floor(x / 4) + ',' + Math.floor(z / 4)) || 0;
  }

  tryLie(tp) {
    const sim = this.sim, w = this.world, rng = this.rng;
    // only for someone actually walking the trail (they have to come to him)
    if (this.withdrawal || sim.director.inDread?.() || this.observers?.length || !w.trail || !tp.moveDir || (tp.moveSpeed || 0) < 0.8) return false;
    if (sim.time - (this.lieT ?? -1e9) < C.LIE_COOLDOWN || sim.time < (this.lieTryAt ?? 0)) return false;
    this.lieTryAt = sim.time + 2;
    const info = w.trailInfo(tp.x, tp.z), here = pointAtDistance(w.trail, w.trailCum, info.along);
    const sgn = tp.moveDir[0] * Math.sin(here.dir) + tp.moveDir[1] * Math.cos(here.dir) >= 0 ? 1 : -1;
    let best = null, bestScore = -Infinity;
    // Search broadly enough that declining an exposed patch simply cancels the scare.
    // A visible lie is worse than no lie: its purpose is a delayed double-take.
    for (let k = 0; k < 24; k++) {
      const along = info.along + sgn * rng.range(C.LIE_AHEAD[0], C.LIE_AHEAD[1]);
      if (along < 0 || along > w.trailLength) continue;
      const q = pointAtDistance(w.trail, w.trailCum, along), side = rng() < 0.5 ? -1 : 1, off = rng.range(C.LIE_OFF[0], C.LIE_OFF[1]);
      const left = q.dir - Math.PI / 2, x = q.x + Math.sin(left) * off * side, z = q.z + Math.cos(left) * off * side;
      if (!w.navWalkable(x, z) || !this.openingClear(x, z) || !this.outsideSpawn(x, z)) continue;
      if (!this.unseenSpot(x, z)) continue;
      const grass = this.grassAt(x, z), cover = w.sampleGrid(w.gCover, x, z);
      if (grass < C.LIE_MIN_GRASS || cover < C.LIE_MIN_COVER) continue;
      // Prefer dense grass and brush, then a little extra distance from the trail.
      const score = grass * 1.6 + cover * 5 + off * 0.2;
      if (score > bestScore) { bestScore = score; best = [x, z, q]; }
    }
    if (!best) return false;
    const [x, z, q] = best, fx = this.x, fz = this.z;
    if (this.place(x, z) === false) return false;
    this.speed = 0; this.lieT = sim.time;
    // lying along the trail edge, head toward where they will come from
    this.yaw = this.lookYaw = q.dir + (sgn > 0 ? Math.PI : 0);
    sim.emit({ type: 'hv_relocate', reason: 'lie', pid: tp.id, x: +x.toFixed(1), z: +z.toFixed(1), fx: +fx.toFixed(1), fz: +fz.toFixed(1) });
    this.closingOn = null;
    this.setState('lie', { lieFor: tp.id, lieMin: null, riseAt: null });
    return true;
  }

  // ---- "He learns your escapes" (SCARE_RESEARCH C2): per-player tactic memory with decay
  tactic(pid, kind) {
    const m = (this.learn ||= new Map()).get(pid); if (!m || !m[kind]) return 0;
    return m[kind].n * Math.pow(0.5, (this.sim.time - m[kind].t) / C.LEARN_HALF_LIFE);
  }
  noteTactic(pid, kind) {
    const L = (this.learn ||= new Map()); const m = L.get(pid) || {}; L.set(pid, m);
    m[kind] = { n: this.tactic(pid, kind) + 1, t: this.sim.time };
    this.sim.emit({ type: 'hv_learn', pid, kind, n: +m[kind].n.toFixed(2) });
  }
  counters(pid, kind) { return this.tactic(pid, kind) >= C.LEARN_COUNTER; }
  // first time in a hunt that a counter is used on someone: sometimes he says "Again."
  usedCounter(pid, kind) {
    const k = pid + ':' + kind;
    if ((this.counterSaid ||= new Set()).has(k)) return;
    this.counterSaid.add(k);
  }

  // "The forest holds its breath" (SCARE_RESEARCH C1): once per closing-in attempt, inside
  // HUSH_DIST, the wildlife around the hunted player goes quiet. Silence is a threat signal
  // that isn't a warning sound. A deterministic hash (not this.rng) skips ~HUSH_SKIP of
  // attempts, so this cosmetic cue never changes his decisions.
  maybeHush(tp, d) {
    const co = this.closingOn;
    if (!co || d > C.HUSH_DIST || this.hushFor === co.t) return;
    this.hushFor = co.t;
    let h = Math.imul((co.t * 1000) | 0, 2654435761) ^ (this.sim.seed | 0);
    h = Math.imul(h ^ (h >>> 15), 2246822519); h ^= h >>> 13;
    if (((h >>> 0) % 1000) / 1000 < C.HUSH_SKIP) return;
    this.sim.emit({ type: 'hush', pid: tp.id, x: +this.x.toFixed(1), z: +this.z.toFixed(1) });
  }

  // Unseen relocation ("teleport", owner Oct 25; OWNER_DECISIONS_2026-10-25b): he vanishes
  // and reappears ahead of the player. Never while anyone has him on screen (departure), never
  // to a spot any player can see (arrival), never during the opening dread, never into spawn or
  // within RELOCATE_MIN_DIST of a player. Cooldown shortens with escalation. The client snaps
  // across the jump (SnapBuffer jump threshold) instead of drawing a slide.
  tryRelocate(tp, reason) {
    const sim = this.sim, dir = sim.director;
    if (this.withdrawal || !tp || !playerActive(tp) || sim.state === 'intro' || dir.inDread?.()) return false;
    if (this.observers?.length) return false;
    const esc = dir.escalation?.() || 0;
    if (sim.time - (this.relocateT ?? -1e9) < lerp(C.RELOCATE_COOLDOWN[0], C.RELOCATE_COOLDOWN[1], esc)) return false;
    const spot = this.observationSpot(tp, 'ahead', C.RELOCATE_AHEAD[0], C.RELOCATE_AHEAD[1]);
    if (!spot) return false;
    // Validate and place the same tenth-metre position sent in the event. A
    // previously safe point could round across a narrow screen/cover boundary.
    const x = +spot[0].toFixed(1), z = +spot[1].toFixed(1), y = groundAt(this.world, x, z);
    if (!this.world.navWalkable(x, z) || !this.openingClear(x, z)) return false;
    for (const p of sim.playerList) {
      if (!playerActive(p)) continue;
      if (Math.hypot(p.x - x, p.z - z) < C.RELOCATE_MIN_DIST) return false;
      // conservative: test at both the walk surface and the bare terrain height (decks/bridges)
      // conservative: a borderline sightline (LOS flips within a few cm) counts as seen
      for (const [ox, oz] of RELOC_JITTER) {
        const jx = x + ox, jz = z + oz;
        if (onScreen(this.world, p, jx, groundAt(this.world, jx, jz), jz, HEIGHT, 0.6) || onScreen(this.world, p, jx, this.world.heightAt(jx, jz), jz, HEIGHT, 0.6)) return false;
      }
    }
    const fx = this.x, fz = this.z;
    if (this.place(x, z) === false) return false;
    this.relocateT = sim.time; this.speed = 0;
    this.yaw = this.lookYaw = Math.atan2(tp.x - x, tp.z - z);
    sim.emit({ type: 'hv_relocate', reason, pid: tp.id, x, z, fx: +fx.toFixed(1), fz: +fz.toFixed(1) });
    return true;
  }

  // ---------------------------------------------------------------- deliberate reveals
  revealPlan(kind,p) {
    const w = this.world, rng = this.rng;
    const [fx, fz] = playerFwd(p);
    const baseA = Math.atan2(fx, fz);
    let plan = null;
    for (let k = 0; k < 40 && !plan; k++) {
      if (kind === 'watcher') {
        const a = baseA + rng.range(-0.35, 0.35), d = rng.range(32, 46);
        const x = p.x + Math.sin(a) * d, z = p.z + Math.cos(a) * d;
        if (!w.navWalkable(x, z) || !this.openingClear(x, z)) continue;
        const vis = w.lineOfSight(p.x, p.y + eyeHeight(p), p.z, x, groundAt(w, x, z) + 1.6, z, { brushK: 0.25 });
        if (vis < 0.45) continue;
        plan = { kind, pid: p.id, spot: [x, z], phase: 'approach' };
      } else if (kind === 'crossing') {
        const a = baseA + rng.range(-0.25, 0.25), d = rng.range(45, 70);
        const cx = p.x + Math.sin(a) * d, cz = p.z + Math.cos(a) * d;
        const pa = a + Math.PI / 2, half = rng.range(9, 14);
        const A = [cx + Math.sin(pa) * half, cz + Math.cos(pa) * half], B = [cx - Math.sin(pa) * half, cz - Math.cos(pa) * half];
        if (!w.navWalkable(A[0], A[1]) || !w.navWalkable(B[0], B[1]) || !w.navWalkable(cx, cz)
            || !this.openingClear(A[0],A[1]) || !this.openingClear(B[0],B[1]) || !this.openingClear(cx,cz)) continue;
        const vis = w.lineOfSight(p.x, p.y + eyeHeight(p), p.z, cx, groundAt(w, cx, cz) + 1.6, cz, { brushK: 0.2 });
        if (vis < 0.4) continue;
        plan = rng() < 0.5 ? { kind, pid: p.id, spot: A, end: B, phase: 'approach' } : { kind, pid: p.id, spot: B, end: A, phase: 'approach' };
      } else if(kind==='shadow') {
        const spot=this.observationSpot({...p,moveDir:null},'behind',...C.SHADOW_DIST);
        if(spot)plan={kind,pid:p.id,spot,phase:'approach',followFor:rng.range(...C.SHADOW_FOLLOW)};
      }
    }
    return plan ? {...plan,origin:[p.x,p.z],lastPlanAt:this.sim.time} : null;
  }

  requestReveal(kind, p) {
    if(this.withdrawal)return false;
    if (!this.outsideSpawn(p.x,p.z) || this.openingDistance()) return false;
    if (!['roam', 'stalk', 'watch', 'search'].includes(this.state)) return false;
    if (this.dist(p) > 150) return false;
    const plan=this.revealPlan(kind,p);
    if (!plan) return false;
    this.reveal = plan; this.target = p.id;this.scareVisibleUntil=null;
    this.setState('reveal');
    if (!this.planTo(plan.spot[0], plan.spot[1], 'cover')) { this.reveal = null; this.setState('roam'); return false; }
    return true;
  }

  updateReveal(dt) {
    const r = this.reveal, sim = this.sim;
    const p = r ? sim.players.get(r.pid) : null;
    if (!r || !p || !playerActive(p)) { this.setState('roam'); return; }
    const C2 = C;
    if (r.phase === 'approach') {
      // A walker can pass the original reveal location while he travels there.
      // Refresh only unseen plans, at most every three seconds, while retaining
      // the original overall approach deadline and accumulated exposure.
      if(!r.counted && r.origin && sim.time-r.lastPlanAt>=3
          && Math.hypot(p.x-r.origin[0],p.z-r.origin[1])>12){
        r.lastPlanAt=sim.time;
        const fresh=this.revealPlan(r.kind,p);
        if(fresh && this.planTo(fresh.spot[0],fresh.spot[1],'cover'))Object.assign(r,fresh);
      }
      const far = Math.hypot(r.spot[0] - this.x, r.spot[1] - this.z) > 25 && !this.observers.length;
      const done = this.followPath(dt, far ? C2.RELOCATE : C2.STALK);
      if (this.stateT > 40 || (done && Math.hypot(r.spot[0] - this.x, r.spot[1] - this.z) > 3)) {
        this.retreatFrom(p, false, true); this.reveal = null; return;
      }
      if (done) { r.phase = r.kind === 'shadow'?'follow':r.kind === 'watcher' ? 'show' : 'cross'; r.t = 0; if (r.kind === 'crossing') this.planTo(r.end[0], r.end[1], 'direct'); }
    } else if (r.phase === 'show') {
      // stand motionless between the trees, facing them, until seen (or bored)
      r.t += dt; this.stop(dt); this.anim.still = 1;
      this.yaw += angleDiff(this.yaw,Math.atan2(p.x-this.x,p.z-this.z))*Math.min(1,dt*3);
      if (this.observers.some((o) => o.p.id === p.id)) r.seenT = (r.seenT || 0) + dt;
      if (sim.time>=(this.scareVisibleUntil??Infinity) || (this.litBy && (r.exposureT || 0) >= 2) || r.t > 30) {
        this.retreatFrom(p, false, true); this.reveal = null;
      }
    } else if (r.phase === 'slip') {
      this.retreatFrom(p, false, true); this.reveal = null;
    } else if (r.phase === 'cross') {
      r.t = (r.t || 0) + dt;
      const done = this.followPath(dt, C2.WALK * 1.25);
      if (done || r.t > 25) { this.retreatFrom(p, false, true); this.reveal = null; }
    } else if(r.phase==='follow') {
      r.t=(r.t||0)+dt;
      if(r.t>(r.followFor||C.SHADOW_FOLLOW[1]) || this.dist(p)<C.SHADOW_DIST[0]-3){
        this.retreatFrom(p,false,true);this.reveal=null;return;
      }
      // Follow behind the player's current VIEW, not a stale movement vector.
      // A turn reveals him briefly and immediately triggers his fast escape.
      r.replan=(r.replan||0)-dt;
      if(r.replan<=0){
        const spot=this.observationSpot({...p,moveDir:null},'behind',...C.SHADOW_DIST);
        if(spot)this.planTo(...spot,'cover');
        r.replan=2;
      }
      this.followPath(dt,C.STALK);
    }
  }

  // ---------------------------------------------------------------- vocal events (synthesised identically on every client from the seed)
  vocals(dt) {
    const sim = this.sim, dir = sim.director;
    if (sim.time - this.vocalT < 14) return;
    const nearest = sim.nearestPlayer(this.x, this.z);
    if (!nearest) return;
    const d = nearest.d;
    let kind = null;
    const r = this.rng;
    const rate = dir.vocalRate(this.state, d);
    if (r() > rate * dt) return;
    if (this.state === 'stalk' || this.state === 'watch') kind = r.pick(['breath', 'inhale', 'hum']);
    else if (this.state === 'roam' || this.state === 'search') kind = 'hum';
    else if (this.state === 'retreat') kind = 'breath';
    else if (this.state === 'freeze') kind = r.chance(0.5) ? 'inhale' : null;
    if (kind) this.vocal(kind);
  }

  vocal(kind, force = false) {
    const sim = this.sim;
    if (!force && sim.time - this.vocalT < 10) return;
    this.vocalT = sim.time;
    sim.emit({ type: 'hv_vocal', k: kind, x: this.x, y: this.y + EYE, z: this.z, s: (this.rng() * 1e9) | 0 });
    sim.director.onVocal();
  }

  snapshot() {
    const a = this.anim;
    return [+this.x.toFixed(2), +this.y.toFixed(2), +this.z.toFixed(2), +this.yaw.toFixed(3), +this.lookYaw.toFixed(3), +this.lookPitch.toFixed(3),
      +this.motionSpeed.toFixed(2), (a.run ? 1 : 0) | (a.reach > 0.5 ? 2 : 0) | (a.still > 0.5 ? 4 : 0) | (this.state === 'dormant' ? 8 : 0) | (a.low ? 16 : 0) | (a.windup ? 32 : 0) | (a.strike ? 64 : 0)
        | (a.frozen ? 128 : 0) | (a.collapse ? 256 : 0) | (a.prone ? 512 : 0) | (a.rise ? 1024 : 0) | (a.grab ? 2048 : 0) | (a.back ? 4096 : 0),
      +a.tilt.toFixed(2), +a.jaw.toFixed(2), HV_STATES.indexOf(this.state),
      // 11: grab kind (GRAB_KINDS index), 12: grab phase 0 none / 1 reach / 2 hold, 13: peek kind
      a.grab ? GRAB_KINDS.indexOf(this.grab?.kind) : 0, a.grab ? (this.grab?.phase === 'hold' ? 2 : 1) : 0, a.peek || 0];
  }

}
