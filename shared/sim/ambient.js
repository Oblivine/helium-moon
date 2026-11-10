// The world beyond the trees (Update 0.9, CONFIG.AMBIENT): a freight train on the line to the
// south, a farm dog past the fence, a dead branch coming down, a car alarm back at the lot.
// Scenery only. Events run on their own random stream and never depend on where Helium Voice
// is, so none of them is a tell (owner rule: no cue may broadcast his position).
import { CONFIG } from '../config.js';
import { makeRng } from '../math.js';
import { groundAt } from '../physics.js';
import { onScreen, playerActive } from './perception.js';

const A = CONFIG.AMBIENT;

export class Ambient {
  constructor(sim) {
    this.sim = sim; this.world = sim.world;
    const r = this.rng = makeRng((sim.seed ^ 0xa3b1e27) >>> 0);
    this.trainAt = r.range(A.TRAIN_FIRST[0], A.TRAIN_FIRST[1]);
    this.dogAt = r.range(60, A.DOG_GAP[1]);
    this.branchAt = CONFIG.DIRECTOR.DREAD_TIME * 0.6 + r.range(A.BRANCH_GAP[0], A.BRANCH_GAP[1]) * 0.5;
    this.alarm = r() < A.ALARM_CHANCE ? 'armed' : 'never';
  }

  update(dt) {
    const sim = this.sim, w = this.world, r = this.rng, t = sim.time;
    if (sim.state !== 'play' && sim.state !== 'extract') return;
    const players = sim.playerList.filter(playerActive);
    if (!players.length) return;
    if (t >= this.trainAt) {
      this.trainAt = t + r.range(A.TRAIN_GAP[0], A.TRAIN_GAP[1]);
      sim.emit({ type: 'ambient', kind: 'train', s: (r() * 1e6) | 0 });
    }
    if (t >= this.dogAt) {
      this.dogAt = t + r.range(A.DOG_GAP[0], A.DOG_GAP[1]);
      // somewhere out in the fields: far past the fence on the farm side of a random player
      const p = players[Math.floor(r() * players.length)], a = r.range(0, Math.PI * 2), d = r.range(120, 200);
      sim.emit({ type: 'ambient', kind: 'dog', x: +(p.x + Math.sin(a) * d).toFixed(1), z: +(p.z + Math.cos(a) * d).toFixed(1), s: (r() * 1e6) | 0 });
    }
    if (t >= this.branchAt) {
      this.branchAt = t + 6;
      if (!sim.director.chasing) {
        const p = players[Math.floor(r() * players.length)];
        for (let k = 0; k < 8; k++) {
          const a = r.range(0, Math.PI * 2), d = r.range(A.BRANCH_DIST[0], A.BRANCH_DIST[1]);
          const x = p.x + Math.sin(a) * d, z = p.z + Math.cos(a) * d;
          if (!w.isPlayable(x, z) || w.trailDistAt(x, z) < 6 || w.waterAt(x, z) !== null) continue;
          const y = groundAt(w, x, z);
          if (players.some((q) => onScreen(w, q, x, y, z, 2, 0.5))) continue;
          this.branchAt = t + r.range(A.BRANCH_GAP[0], A.BRANCH_GAP[1]);
          sim.emit({ type: 'ambient', kind: 'branch', x: +x.toFixed(1), y: +y.toFixed(1), z: +z.toFixed(1), s: (r() * 1e6) | 0 });
          break;
        }
      }
    }
    if (this.alarm === 'armed' && t > A.ALARM_AFTER && players.every((p) => w.trailAlongAt(p.x, p.z) > A.ALARM_ALONG)) {
      this.alarm = 'done';
      const lot = w.poi.trailhead, car = w.structures.find((o) => o.type === 'car') || lot;
      sim.emit({ type: 'ambient', kind: 'alarm', x: +car.x.toFixed(1), z: +car.z.toFixed(1), dur: A.ALARM_TIME });
    }
  }
}
