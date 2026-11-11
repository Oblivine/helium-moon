// Developer mode (owner, Oct 25): test tools for a locally simulated game (single player or
// a hosted room's local sim). Nothing here runs unless the player turned Developer mode on.
//   sim.dev = { skipDread, invincible }   - read by the director and damagePlayer
//   devHunt(sim, pid)    - skip any wait and start a real hunt on that player right now
//   devReveal(sim, pid)  - make him deliberately show himself to that player
//   devRelocate(sim, pid) - unseen relocation ahead of that player (ignores the cooldown)
//   devSpawn(sim, pid, kind) - put an item on the ground in front of that player (owner, Nov 10)
import { CONFIG } from '../config.js';
import { NOTES } from './objectives.js';
import { inSpawnZone } from './zones.js';

function ready(sim) {
  if (sim.state === 'intro') { sim.time = Math.max(sim.time, CONFIG.SESSION.INTRO_TIME + 0.01); sim.step(0.001); }
  return sim.state === 'play' || sim.state === 'extract';
}

// a spot 18-28 m behind/beside the player, in cover if possible
function behind(sim, p) {
  const hv = sim.hv;
  const s = hv.observationSpot?.(p, 'behind', 18, 28);
  if (s) return s;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  for (const d of [24, 18, 30, 12]) {
    const x = p.x - fx * d, z = p.z - fz * d;
    if (sim.world.isPlayable(x, z)) return [x, z];
  }
  return [p.x + 20, p.z];
}

// returns true, or a short reason string when it can't
export function devHunt(sim, pid) {
  const p = sim.players.get(pid);
  if (!p || p.state !== 'alive' || !ready(sim)) return 'not playing';
  if (inSpawnZone(sim.world, p.x, p.z, CONFIG.ZONES?.SPAWN_MARGIN ?? 12)) return 'you are in the safe spawn area - walk out onto the trail first';
  const hv = sim.hv, dir = sim.director;
  if (hv.withdrawal || sim.time < (dir.nextChaseAt || 0)) return 'Helium is withdrawing or recovering from the last hunt';
  const [x, z] = behind(sim, p);
  hv.place(x, z);
  hv.yaw = hv.lookYaw = Math.atan2(p.x - hv.x, p.z - hv.z);
  hv.reveal = null; hv.windup = null; hv.lingerUntil = null; hv.closingOn = null;
  hv.target = p.id; hv.awareness.set(p.id, 2); hv.lastSeen.set(p.id, { x: p.x, z: p.z, t: sim.time });
  dir.lastChase = -999; dir.lastAttack = -999; hv.attackT = -999;
  if (dir.phase === 'relax') dir.enter('build');
  dir.chasing = false;
  hv.setState('stalk');
  hv.startChase(p);
  sim.emit({ type: 'dev', what: 'hunt', pid });
  return hv.state === 'chase' || 'he could not reach you from there';
}

export function devReveal(sim, pid) {
  const p = sim.players.get(pid);
  if (!p || p.state !== 'alive' || !ready(sim)) return false;
  const ok = sim.hv.requestReveal?.('watcher', p);
  if (ok) sim.emit({ type: 'dev', what: 'reveal', pid });
  return !!ok;
}

export function devRelocate(sim, pid) {
  const p = sim.players.get(pid);
  if (!p || p.state !== 'alive' || !ready(sim)) return false;
  const hv = sim.hv, keep = hv.relocateT;
  if (hv.withdrawal) return false;
  hv.relocateT = -1e9;
  const ok = hv.tryRelocate(p, 'dev');
  if (!ok) hv.relocateT = keep;
  return ok;
}

// Everything the Developer menu can spawn. Real items: they are picked up, carried and used
// exactly like the ones the night scatters.
export const DEV_ITEMS = {
  battery: 'Spare lighter', cigs: 'Pack of cigarettes', beer: 'Bottle of beer', bottle: 'Empty bottle (in hand)',
  blanket: 'Camouflage blanket', fuel: 'Gas can', fuse: 'Orange fuse kit', crank: 'Antenna handwheel',
  note: 'A note you have not found', balloon: 'Balloon',
};

// returns true, or a short reason string when it can't
export function devSpawn(sim, pid, kind) {
  const p = sim.players.get(pid);
  if (!p || p.state !== 'alive' || !ready(sim)) return 'not playing';
  if (!Object.hasOwn(DEV_ITEMS, kind)) return 'unknown item';
  if (kind === 'bottle') { p.bottles++; sim.viceState(p); sim.emit({ type: 'dev', what: 'spawn', kind, pid }); return true; }
  // on the ground in front of you; each one a little to the side of the last so they do not stack
  const n = sim.devSpawned = (sim.devSpawned || 0) + 1;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), side = ((n % 5) - 2) * 0.3, d = kind === 'balloon' ? 3 : 1.5;
  let x = p.x + fx * d + fz * side, z = p.z + fz * d - fx * side;
  if (!sim.world.isPlayable(x, z)) { x = p.x; z = p.z; }
  if (kind === 'balloon') { sim.balloons.place(x, z, 'dev'); sim.emit({ type: 'dev', what: 'spawn', kind, pid }); return true; }
  let note = null;
  if (kind === 'note') {
    note = NOTES.slice(1).find((q) => !sim.obj.notesRead.includes(q.id) && !sim.obj.items.some((i) => i.kind === 'note' && i.note === q.id && !i.holder));
    if (!note) return 'every note is already found or lying out somewhere';
  }
  const it = { id: `dev_${kind}_${n}`, kind, name: note ? note.title : DEV_ITEMS[kind], note: note ? note.id : undefined, label: 'dev',
    x: +x.toFixed(2), y: +sim.world.heightAt(x, z).toFixed(2), z: +z.toFixed(2), rot: p.yaw, holder: null };
  sim.obj.items.push(it);
  const { id, name, label, y, rot } = it;
  sim.emit({ type: 'item_spawn', pid, item: { id, kind, name, note: it.note, label, x: it.x, y, z: it.z, rot } });
  return true;
}
