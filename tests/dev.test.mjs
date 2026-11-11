// Developer mode (owner, Oct 25): skip the opening dread, invincibility, start a hunt on demand.
//   node tests/dev.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../shared/world.js';
import { GameSim } from '../shared/sim/sim.js';
import { CONFIG } from '../shared/config.js';
import { pointAtDistance } from '../shared/math.js';
import { devSpawn, DEV_ITEMS, devHunt } from '../shared/sim/dev.js';

const world = new World({});
function game(dev) {
  const sim = new GameSim(world, { seed: 77 }); sim.addPlayer('p1', 'p1'); sim.dev = dev;
  const q = pointAtDistance(world.trail, world.trailCum, 300), p = sim.players.get('p1');
  p.x = p.lastX = q.x; p.z = p.lastZ = q.z; p.y = world.heightAt(q.x, q.z);
  for (let i = 0; i < (CONFIG.SESSION.INTRO_TIME + 1) / 0.05; i++) sim.step(0.05);
  return { sim, p };
}

test('without developer mode the opening dread is on', () => {
  const { sim } = game(null); assert.equal(sim.director.inDread(), true);
});
test('skip dread: no dread right after the intro', () => {
  const { sim } = game({ skipDread: true }); assert.equal(sim.director.inDread(), false);
});
test('test a hunt: a real hunt starts on the player', () => {
  const { sim } = game({ skipDread: true });
  assert.equal(devHunt(sim, 'p1'), true);
  assert.equal(sim.hv.state, 'chase'); assert.equal(sim.director.chasing, true);
});
test('a hunt is refused inside the protected spawn area', () => {
  const sim = new GameSim(world, { seed: 77 }); sim.addPlayer('p1', 'p1'); sim.dev = { skipDread: true };
  for (let i = 0; i < 220; i++) sim.step(0.05);
  assert.equal(typeof devHunt(sim, 'p1'), 'string');
});
test('invincible: hits register but do no damage', () => {
  const { sim, p } = game({ invincible: true });
  sim.damagePlayer(p, 'hv', sim.hv);
  assert.equal(p.health, CONFIG.PLAYER.MAX_HEALTH);
  assert.ok(sim.drainEvents().some((e) => e.type === 'hit' && e.dev));
});

test('spawn: every Developer item appears in front of the player and works like the real thing', () => {
  const { sim, p } = game({ skipDread: true });
  sim.drainEvents();
  for (const kind of Object.keys(DEV_ITEMS)) assert.equal(devSpawn(sim, 'p1', kind), true, kind);
  const ev = sim.drainEvents(), spawned = ev.filter((e) => e.type === 'item_spawn').map((e) => e.item);
  assert.equal(spawned.length, Object.keys(DEV_ITEMS).length - 2, 'the bottle goes to the hand and the balloon is a balloon');
  assert.equal(p.bottles, 1);
  assert.ok(ev.some((e) => e.type === 'balloon'));
  for (const it of spawned) {
    assert.ok(Math.hypot(it.x - p.x, it.z - p.z) < 2.6, `${it.kind} within reach`);
    assert.equal(sim.obj.pickup(p, it.id), true, `${it.kind} can be picked up`);
  }
  assert.equal(p.cigs, CONFIG.VICE.CIG_PACK); assert.equal(p.beers, 1);
  assert.equal(sim.obj.team.fuel && sim.obj.team.fuse && sim.obj.team.crank, true);
  assert.equal(sim.obj.notesRead.length, 1);
  assert.equal(typeof devSpawn(sim, 'p1', 'tank'), 'string');
});
