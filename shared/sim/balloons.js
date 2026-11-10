// Balloons: Helium Voice's calling cards (Update 0.9, CONFIG.BALLOON).
// One appears beside the trail ahead during the dread period. After that he leaves one where a
// player watched him stand and where he gave up a hunt. They are placed only when no player can
// see the spot. An upright player who walks into one pops it (loud: he hears it); crouching
// passes under; E unties it without a sound; a pebble pops one from range.
// Own random stream: balloons never change his decisions except through the noise of a pop.
import { CONFIG } from '../config.js';
import { makeRng, pointAtDistance } from '../math.js';
import { groundAt } from '../physics.js';
import { onScreen, playerActive } from './perception.js';
import { inSpawnZone } from './zones.js';

const B = CONFIG.BALLOON;

export class Balloons {
  constructor(sim) {
    this.sim = sim; this.world = sim.world;
    this.rng = makeRng((sim.seed ^ 0xba1100) >>> 0);
    this.list = []; this.marks = []; this.seq = 1;
    this.omenAt = this.rng.range(B.OMEN_AT[0], B.OMEN_AT[1]); this.omenDone = false; this.omenTry = 0;
  }

  // he stood here (seen), or gave up a hunt here: leave one once it can be done unseen
  mark(x, z, reason) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (this.marks.length >= 3) this.marks.shift();
    this.marks.push({ x, z, reason, t: this.sim.time });
  }

  ok(x, z) {
    const w = this.world;
    if (!w.isPlayable(x, z) || !w.navWalkable(x, z) || w.waterAt(x, z) !== null) return false;
    if (inSpawnZone(w, x, z, CONFIG.ZONES.SPAWN_MARGIN)) return false;
    for (const b of this.list) if (Math.hypot(b.x - x, b.z - z) < B.MIN_GAP) return false;
    return true;
  }

  unseen(x, z) {
    const y = groundAt(this.world, x, z);
    for (const p of this.sim.playerList) {
      if (!playerActive(p)) continue;
      if (Math.hypot(p.x - x, p.z - z) < 10) return false;
      if (onScreen(this.world, p, x, y, z, B.HEIGHT + 0.4, 0.3)) return false;
    }
    return true;
  }

  place(x, z, reason) {
    const y = groundAt(this.world, x, z);
    const b = { id: 'bl' + this.seq++, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), reason, t: this.sim.time };
    this.list.push(b);
    // the oldest one nobody is looking at goes when there are too many
    if (this.list.length > B.MAX) {
      const i = this.list.findIndex((o) => o !== b && this.unseen(o.x, o.z));
      if (i >= 0) this.list.splice(i, 1);
    }
    this.sim.emit({ type: 'balloon', id: b.id, x: b.x, y: b.y, z: b.z, reason });
    return b;
  }

  update(dt) {
    const sim = this.sim, w = this.world;
    if (sim.state !== 'play' && sim.state !== 'extract') return;
    // ---- the omen: beside the trail, ahead of whoever is furthest along
    if (!this.omenDone && sim.time >= this.omenAt && sim.time >= this.omenTry) {
      this.omenTry = sim.time + 4;
      let lead = null, best = -1;
      for (const p of sim.playerList) { if (!playerActive(p)) continue; const a = w.trailAlongAt(p.x, p.z); if (a > best) { best = a; lead = p; } }
      if (lead) for (let k = 0; k < 6; k++) {
        const along = best + this.rng.range(B.OMEN_AHEAD[0], B.OMEN_AHEAD[1]);
        if (along > w.trailLength - 20) break;
        const q = pointAtDistance(w.trail, w.trailCum, along), side = this.rng() < 0.5 ? -1 : 1, off = this.rng.range(B.OMEN_OFF[0], B.OMEN_OFF[1]);
        const x = q.x + Math.cos(q.dir) * off * side, z = q.z - Math.sin(q.dir) * off * side;
        if (this.ok(x, z) && this.unseen(x, z)) { this.place(x, z, 'omen'); this.omenDone = true; break; }
      }
    }
    // ---- marks he left
    const hv = sim.hv;
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const m = this.marks[i];
      if (sim.time - m.t > B.MARK_WAIT) { this.marks.splice(i, 1); continue; }
      if (Math.hypot(hv.x - m.x, hv.z - m.z) < B.MARK_CLEAR) continue;
      if (!this.ok(m.x, m.z)) { this.marks.splice(i, 1); continue; }
      if (!this.unseen(m.x, m.z)) continue;
      this.place(m.x, m.z, m.reason); this.marks.splice(i, 1);
    }
    // ---- walking into one
    for (const p of sim.playerList) {
      if (p.state !== 'alive' || p.crouch) continue;
      for (const b of this.list) {
        if (Math.abs(p.x - b.x) > B.POP_RADIUS || Math.abs(p.z - b.z) > B.POP_RADIUS) continue;
        if (Math.hypot(p.x - b.x, p.z - b.z) <= B.POP_RADIUS && Math.abs(p.y - b.y) < 1.5) { this.pop(b, p, 'walk'); break; }
      }
    }
  }

  // a pebble landed: pops any balloon it hit. Returns true if one popped.
  pebble(at, pid) {
    for (const b of this.list) {
      if (Math.hypot(at.x - b.x, at.z - b.z) <= B.PEBBLE_RADIUS && Math.abs((at.y ?? b.y) - b.y) < B.HEIGHT + 1.2) {
        this.pop(b, this.sim.players.get(pid), 'pebble'); return true;
      }
    }
    return false;
  }

  pop(b, p, how) {
    const i = this.list.indexOf(b); if (i < 0) return;
    this.list.splice(i, 1);
    this.sim.emit({ type: 'balloon_pop', id: b.id, pid: p?.id ?? null, how, x: b.x, y: +(b.y + B.HEIGHT).toFixed(2), z: b.z });
    // loud: he hears where it was (and whose it was, so a hunt treats it as evidence of them)
    this.sim.hv.hearNoise?.(b.x, b.z, B.POP_HEAR, p?.id ?? null);
  }

  // E: untie it quietly
  untie(p, id) {
    const b = this.list.find((o) => o.id === id);
    if (!b || !p || p.state !== 'alive' || (p.heldUntil ?? -1) > this.sim.time || p.covered) return false;
    if (Math.hypot(p.x - b.x, p.z - b.z) > B.UNTIE_RANGE) return false;
    this.list.splice(this.list.indexOf(b), 1);
    this.sim.emit({ type: 'balloon_untie', id: b.id, pid: p.id, x: b.x, y: +(b.y + B.HEIGHT).toFixed(2), z: b.z });
    return true;
  }

  snapshot() { return this.list.map((b) => [b.id, b.x, b.y, b.z]); }
}
