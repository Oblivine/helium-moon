// The night report (Update 0.9): what each player did, recorded by the authoritative sim.
// Everything here is bookkeeping; nothing reads it back into the game.
import { CONFIG } from '../config.js';

const blank = () => ({
  dist: 0, sprintT: 0, crouchT: 0, darkT: 0, aliveT: 0, hiddenT: 0, breathT: 0,
  hunted: 0, survived: 0, grabs: 0, closePasses: 0, bites: 0,
  pebbles: 0, distractions: 0, notes: 0, lighters: 0, objectives: 0, steps: 0,
  balloonsPopped: 0, balloonsUntied: 0, revives: 0, downs: 0, pings: 0,
});

export class NightStats {
  constructor(sim) { this.sim = sim; this.by = new Map(); this.team = { hunts: 0, hides: 0, balloons: 0, sightings: 0 }; this.huntTarget = null; }
  of(pid) { let s = this.by.get(pid); if (!s) { s = blank(); this.by.set(pid, s); } return s; }

  update(dt) {
    const sim = this.sim, hunting = sim.director.chasing;
    for (const p of sim.playerList) {
      const s = this.of(p.id);
      if (p.state !== 'alive') { s._x = p.x; s._z = p.z; continue; }
      s.aliveT += dt;
      const d = s._x === undefined ? 0 : Math.hypot(p.x - s._x, p.z - s._z);
      if (d < 3) s.dist += d;
      s._x = p.x; s._z = p.z;
      if (p.sprint) s.sprintT += dt;
      if (p.crouch) s.crouchT += dt;
      if (!p.flash) s.darkT += dt;
      if (hunting && sim.hv.target === p.id && sim.hv.hidden?.(p)) s.hiddenT += dt;
      if (p.breath) s.breathT += dt;
    }
  }

  onEvent(e) {
    const P = (id) => (id != null && this.sim.players.has(id) ? this.of(id) : null);
    switch (e.type) {
      case 'chase': if (e.on) { this.team.hunts++; this.huntTarget = e.pid; const s = P(e.pid); if (s) s.hunted++; } break;
      case 'hv_hunt_phase':
        if (e.phase === 'end' && e.reason !== 'grab') { const s = P(e.pid ?? this.huntTarget); if (s && this.sim.players.get(e.pid ?? this.huntTarget)?.state === 'alive') { s.survived++; this.team.hides++; } }
        break;
      case 'hit': case 'downed': case 'dead': {
        const s = P(e.pid); if (!s || e.dev) break;
        if (e.by === 'hv') s.grabs++; else if (e.by === 'sf') s.bites++;
        if (e.type !== 'hit') s.downs++;
        break;
      }
      case 'hv_close_pass': { const s = P(e.pid); if (s) s.closePasses++; break; }
      case 'pebble_throw': { const s = P(e.pid); if (s) s.pebbles++; break; }
      case 'pebble_impact': if (e.distracted) { const s = P(e.pid); if (s) s.distractions++; } break;
      case 'pickup': { const s = P(e.pid); if (!s) break; if (e.kind === 'note') s.notes++; else if (e.kind === 'battery') s.lighters++; break; }
      case 'objective': { const s = P(e.pid); if (s) s.objectives++; break; }
      case 'objective_step': { const s = P(e.pid); if (s) s.steps++; break; }
      case 'balloon': this.team.balloons++; break;
      case 'balloon_pop': { const s = P(e.pid); if (s) s.balloonsPopped++; break; }
      case 'balloon_untie': { const s = P(e.pid); if (s) s.balloonsUntied++; break; }
      case 'revived': { const s = P(e.by); if (s) s.revives++; break; }
      case 'ping': { const s = P(e.pid); if (s) s.pings++; break; }
      default: break;
    }
  }

  summary() {
    const players = {};
    for (const [id, s] of this.by) {
      const o = {};
      for (const k of Object.keys(s)) if (k[0] !== '_') o[k] = typeof s[k] === 'number' ? +s[k].toFixed(1) : s[k];
      players[id] = o;
    }
    return { players, team: { ...this.team } };
  }
}

// One rank for the night, the same on every client. Lost nights are ranked by how far they got.
export function nightRank(result, mine, rules) {
  const won = result.result === 'won', out = mine?.state === 'escaped';
  const st = result.stats?.players?.[mine?.id] || {};
  const total = result.objectivesTotal || 4;
  if (!won || !out) {
    if (result.objectives >= total) return { id: 'so_close', title: 'So Close', line: 'The call went out. You did not.' };
    if (result.objectives >= 2) return { id: 'unfinished', title: 'Unfinished Business', line: 'Half the work is still out there in the dark.' };
    if ((st.survived || 0) >= 1) return { id: 'hid_once', title: 'Hid Once', line: 'It worked the first time.' };
    return { id: 'missing', title: 'Missing', line: 'The refuge opens at dawn. Somebody will find the car.' };
  }
  const mins = result.time / 60, grabs = st.grabs || 0, health = rules?.health || CONFIG.PLAYER.MAX_HEALTH;
  if (grabs === 0 && mins <= 16) return { id: 'ghost', title: 'Ghost', line: 'He never laid a hand on you.' };
  if (grabs === 0) return { id: 'untouched', title: 'Untouched', line: 'Slow, careful, and whole.' };
  if (grabs >= health - 1) return { id: 'last_breath', title: 'Last Breath', line: 'One more and you would not be reading this.' };
  if (mins <= 14) return { id: 'runner', title: 'Night Runner', line: 'Fast enough to get away with it.' };
  return { id: 'survivor', title: 'Survivor', line: 'You walked out. That is the whole job.' };
}
