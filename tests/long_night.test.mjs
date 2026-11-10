// Update 0.9 "The Long Night": difficulty rules, hold-your-breath, balloons, ambient events,
// co-op ping, the night report and the expanded notes. Real simulation throughout.
//   node tests/long_night.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../shared/world.js';
import { GameSim } from '../shared/sim/sim.js';
import { CONFIG } from '../shared/config.js';
import { NOTES } from '../shared/sim/objectives.js';
import { nightRank } from '../shared/sim/stats.js';
import { pointAtDistance } from '../shared/math.js';
import { onScreen } from '../shared/sim/perception.js';
import { inSpawnZone } from '../shared/sim/zones.js';

const base = new World(), dt = 0.05;
const at = (a) => pointAtDistance(base.trail, base.trailCum, a);
function quiet(sim) { sim.sf.update = sim.mimic.update = sim.wildlife.update = () => {}; }
function put(world, p, q, extra = {}) { Object.assign(p, { x: q.x, z: q.z, y: world.heightAt(q.x, q.z), lastX: q.x, lastZ: q.z, noise: 0, voice: 0, ...extra }); }

// a hunt in its search phase with the player hidden (crouched, dark, still, no line of sight)
function searching(seed = 31, difficulty = 'ranger') {
  const world = Object.create(base);
  world.lineOfSight = () => 0;
  const sim = new GameSim(world, { seed, difficulty });
  sim.state = 'play'; sim.time = 400;
  sim.director.update = () => {}; sim.director.enter('build'); quiet(sim);
  sim.balloons.update = sim.ambient.update = () => {};
  const p = sim.addPlayer('one', 'One'), hv = sim.hv;
  put(world, p, at(500), { flash: false, crouch: true, hidden: true });
  const h = at(465); hv.place(h.x, h.z); hv.target = p.id; hv.spotted.add(p.id); hv.awareness.set(p.id, 2); hv.setState('stalk');
  hv.startChase(p);
  while (sim.time < hv.huntHideUntil + 0.2) sim.step(dt);
  assert.equal(hv.huntPhase, 'search');
  return { sim, p, hv, world };
}

test('difficulty: rules reach health, the post-hunt cooldown, the search length and session info', () => {
  const mk = (d) => { const s = new GameSim(base, { seed: 5, difficulty: d }); return s; };
  const v = mk('visitor'), r = mk('ranger'), m = mk('moon'), x = mk('nonsense');
  assert.equal(x.rules.id, 'ranger', 'unknown difficulty falls back to the owner default');
  assert.equal(r.addPlayer('a', 'A').health, CONFIG.PLAYER.MAX_HEALTH, 'Ranger keeps the owner rule: two grabs survived, the third kills');
  assert.equal(v.addPlayer('a', 'A').health, 4); assert.equal(m.addPlayer('a', 'A').health, 2);
  assert.equal(r.info().rules.id, 'ranger'); assert.equal(m.info().rules.lungs, 8);
  for (const [s, mul] of [[v, 1.25], [r, 1], [m, 0.72]]) {
    s.time = 100; s.director.onChaseEnd(false);
    assert.ok(Math.abs(s.director.nextChaseAt - (100 + CONFIG.DIRECTOR.POST_CHASE_COOLDOWN * mul)) < 1e-6);
  }
  const a = searching(31, 'ranger').hv, b = searching(31, 'moon').hv;
  assert.ok(Math.abs((b.huntEndsAt - b.huntHideUntil) / (a.huntEndsAt - a.huntHideUntil) - 1.2) < 1e-6, 'Helium Moon searches 20% longer');
});

test('hold your breath: breathing within earshot of his search is heard; holding it is not', () => {
  // he is placed 3 m from the hidden player and kept there (search movement stubbed)
  for (const holding of [false, true]) {
    const { sim, p, hv, world } = searching(41);
    hv.updateHuntSearch = function (d) { this.stop(d); };
    const q = at(497); hv.x = q.x; hv.z = q.z; hv.y = world.heightAt(q.x, q.z);
    hv.lastSeenChase = { x: at(540).x, z: at(540).z, t: sim.time - 5 };
    const before = { ...hv.lastSeenChase };
    p.breath = holding;
    const ev = [];
    for (let t = 0; t < 4; t += dt) { p.breath = holding; sim.step(dt); ev.push(...sim.drainEvents()); }
    const heard = ev.filter((e) => e.type === 'hv_heard');
    if (holding) { assert.equal(heard.length, 0); assert.deepEqual(hv.lastSeenChase, before, 'held breath: his evidence is unchanged'); }
    else {
      assert.ok(heard.length >= 1 && heard[0].what === 'breath' && heard[0].pid === p.id);
      assert.ok(Math.hypot(hv.lastSeenChase.x - p.x, hv.lastSeenChase.z - p.z) <= CONFIG.BREATH.ERROR * 1.5, 'he now searches about where they are');
    }
    assert.ok(ev.some((e) => e.type === 'hv_close_pass' && e.pid === p.id), 'the close pass is recorded for the night report');
    assert.equal(p.health, CONFIG.PLAYER.MAX_HEALTH);
  }
});

test('hold your breath: out of earshot nothing is heard, and it takes more than a moment', () => {
  const { sim, p, hv, world } = searching(42);
  hv.updateHuntSearch = function (d) { this.stop(d); };
  const far = at(500 - (CONFIG.DIFFICULTY.ranger.breathHear + 2)); hv.x = far.x; hv.z = far.z; hv.y = world.heightAt(far.x, far.z);
  const ev = [];
  for (let t = 0; t < 6; t += dt) { sim.step(dt); ev.push(...sim.drainEvents()); }
  assert.equal(ev.filter((e) => e.type === 'hv_heard').length, 0);
  const near = at(497); hv.x = near.x; hv.z = near.z;
  for (let t = 0; t < CONFIG.BREATH.GRACE - 0.3; t += dt) { sim.step(dt); ev.push(...sim.drainEvents()); }
  assert.equal(ev.filter((e) => e.type === 'hv_heard').length, 0, 'a breath or two is not enough');
});

test('balloons: the omen appears ahead beside the trail, unseen, outside spawn', () => {
  let placed = 0;
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const sim = new GameSim(base, { seed }); quiet(sim); sim.hv.update = () => {}; sim.director.update = () => {};
    const p = sim.addPlayer('one', 'One');
    let along = 60; const ev = [];
    for (let t = 0; t < 200; t += dt) {
      along += 1.6 * dt; const q = at(along);
      sim.input('one', { x: q.x, z: q.z, y: base.heightAt(q.x, q.z), yaw: Math.atan2(-Math.sin(q.dir), -Math.cos(q.dir)), pitch: 0, flash: true, viewFov: 75, viewAspect: 16 / 9 });
      sim.step(dt);
      for (const e of sim.drainEvents()) if (e.type === 'balloon') ev.push({ ...e, seenNow: onScreen(base, p, e.x, e.y, e.z, 1.9, 0.3), d: Math.hypot(e.x - p.x, e.z - p.z), pa: base.trailAlongAt(p.x, p.z) });
    }
    if (!ev.length) continue;
    placed++;
    const b = ev[0];
    assert.equal(b.reason, 'omen'); assert.equal(b.seenNow, false, 'never placed in view'); assert.ok(b.d > 10);
    assert.ok(base.trailAlongAt(b.x, b.z) > b.pa + 20, 'ahead of the player');
    assert.ok(base.trailDistAt(b.x, b.z) < 4.5, 'beside the trail'); assert.equal(inSpawnZone(base, b.x, b.z, CONFIG.ZONES.SPAWN_MARGIN), false);
    assert.deepEqual(sim.snapshot().bl[0].slice(1), [b.x, b.y, b.z], 'clients receive it');
  }
  assert.ok(placed >= 4, `${placed}/6 nights got their omen in the first 200 s`);
});

function balloonFixture() {
  const sim = new GameSim(base, { seed: 77 }); sim.state = 'play'; sim.time = 300; quiet(sim);
  sim.director.update = () => {}; sim.hv.update = () => {}; sim.ambient.update = () => {};
  const p = sim.addPlayer('one', 'One'); put(base, p, at(400), { flash: true });
  sim.balloons.omenDone = true;
  const q = at(403), b = sim.balloons.place(q.x, q.z, 'test'); sim.drainEvents();
  return { sim, p, b };
}

test('balloons: walking into one pops it and he hears it; crouching passes under; E unties it silently', () => {
  { // upright: pop
    const { sim, p, b } = balloonFixture(); const hv = sim.hv; const far = at(425); hv.x = far.x; hv.z = far.z; hv.stimulus = null;
    put(base, p, { x: b.x, z: b.z }); sim.step(dt);
    const ev = sim.drainEvents();
    assert.ok(ev.some((e) => e.type === 'balloon_pop' && e.pid === 'one' && e.how === 'walk'));
    assert.equal(sim.balloons.list.length, 0);
    assert.ok(hv.stimulus && Math.hypot(hv.stimulus.x - b.x, hv.stimulus.z - b.z) < 0.01 && hv.stimulus.pid === 'one', 'he heard where it was');
    assert.equal(sim.stats.summary().players.one.balloonsPopped, 1);
  }
  { // crouched: nothing
    const { sim, p, b } = balloonFixture(); put(base, p, { x: b.x, z: b.z }, { crouch: true });
    for (let i = 0; i < 20; i++) sim.step(dt);
    assert.equal(sim.balloons.list.length, 1); assert.equal(sim.drainEvents().filter((e) => e.type === 'balloon_pop').length, 0);
  }
  { // untie: silent, needs to be close
    const { sim, p, b } = balloonFixture(); sim.hv.stimulus = null;
    sim.action('one', { a: 'untie', id: b.id }); assert.equal(sim.balloons.list.length, 1, 'too far to reach');
    put(base, p, { x: b.x + 1.2, z: b.z }, { crouch: true }); sim.action('one', { a: 'untie', id: b.id });
    assert.equal(sim.balloons.list.length, 0); assert.equal(sim.hv.stimulus, null, 'no noise');
    assert.ok(sim.drainEvents().some((e) => e.type === 'balloon_untie'));
    assert.equal(sim.stats.summary().players.one.balloonsUntied, 1);
  }
  { // far from him: the pop is out of earshot
    const { sim, p, b } = balloonFixture(); const hv = sim.hv; const far = at(403 + CONFIG.BALLOON.POP_HEAR + 30); hv.x = far.x; hv.z = far.z; hv.stimulus = null;
    put(base, p, { x: b.x, z: b.z }); sim.step(dt);
    assert.equal(hv.stimulus, null);
  }
});

test('balloons: a pebble landing on one pops it; marks wait until nobody can see the spot', () => {
  const { sim, p, b } = balloonFixture();
  assert.equal(sim.balloons.pebble({ x: b.x + 5, y: b.y, z: b.z }, 'one'), false);
  assert.equal(sim.balloons.pebble({ x: b.x + 0.5, y: b.y, z: b.z }, 'one'), true);
  assert.ok(sim.drainEvents().some((e) => e.type === 'balloon_pop' && e.how === 'pebble'));
  // a mark right in front of the player, lit and watched: not placed until they turn away
  const q = at(408); put(base, p, at(400), { yaw: Math.atan2(-(q.x - at(400).x), -(q.z - at(400).z)), pitch: 0, flash: true, viewFov: 75, viewAspect: 16 / 9 });
  const far = at(460); sim.hv.x = far.x; sim.hv.z = far.z;
  sim.balloons.mark(q.x, q.z, 'watched');
  for (let i = 0; i < 40; i++) sim.step(dt);
  assert.equal(sim.balloons.list.length, 0, 'watched spot: he does not tie it while you look');
  const away = at(380); put(base, p, away, { yaw: p.yaw + Math.PI });
  for (let i = 0; i < 10; i++) sim.step(dt);
  assert.equal(sim.balloons.list.length, 1); assert.equal(sim.balloons.list[0].reason, 'watched');
});

test('ambient events run on their own stream and never depend on where he is', () => {
  const run = (hvAlong) => {
    const sim = new GameSim(base, { seed: 909 }); sim.state = 'play'; quiet(sim); sim.director.update = () => {};
    sim.balloons.update = () => {};
    const h = at(hvAlong); sim.hv.update = () => {}; sim.hv.x = h.x; sim.hv.z = h.z;
    const p = sim.addPlayer('one', 'One'); put(base, p, at(600), { flash: true, yaw: 0, pitch: 0, viewFov: 75, viewAspect: 16 / 9 });
    const out = [];
    for (let t = 0; t < 1500; t += dt) { sim.step(dt); for (const e of sim.drainEvents()) if (e.type === 'ambient') out.push([e.kind, e.t, e.x ?? 0, e.z ?? 0]); }
    return out;
  };
  const a = run(620), b = run(1500);
  assert.deepEqual(a, b, 'identical with him near or far');
  const kinds = new Set(a.map((e) => e[0]));
  assert.ok(kinds.has('train') && kinds.has('dog') && kinds.has('branch'), [...kinds].join(','));
  for (const e of a) if (e[0] === 'branch') { const d = Math.hypot(e[2] - at(600).x, e[3] - at(600).z); assert.ok(d >= CONFIG.AMBIENT.BRANCH_DIST[0] - 0.1 && d <= CONFIG.AMBIENT.BRANCH_DIST[1] + 0.1); }
});

test('ping: validated and rate-limited', () => {
  const sim = new GameSim(base, { seed: 3 }); sim.state = 'play'; sim.time = 100;
  const p = sim.addPlayer('one', 'One'); put(base, p, at(300));
  const ok = { a: 'ping', x: p.x + 10, y: p.y, z: p.z + 5 };
  sim.action('one', ok); sim.action('one', ok);
  sim.action('one', { a: 'ping', x: NaN, y: 0, z: 0 });
  sim.time += CONFIG.PING.COOLDOWN + 0.1;
  sim.action('one', { a: 'ping', x: p.x + 500, y: p.y, z: p.z });
  sim.action('one', ok);
  const pings = sim.drainEvents().filter((e) => e.type === 'ping');
  assert.equal(pings.length, 2); assert.equal(pings[0].pid, 'one');
  assert.equal(sim.stats.summary().players.one.pings, 2);
});

test('night report: stats, result fields and ranks', () => {
  const sim = new GameSim(base, { seed: 8, difficulty: 'visitor' }); sim.state = 'play'; sim.time = 100; quiet(sim);
  sim.director.update = () => {}; sim.hv.update = () => {}; sim.balloons.update = sim.ambient.update = () => {};
  const p = sim.addPlayer('one', 'One'); let along = 300; put(base, p, at(along), { flash: false, sprint: true });
  for (let t = 0; t < 10; t += dt) { along += 5 * dt; const q = at(along); p.x = q.x; p.z = q.z; sim.step(dt); }
  sim.emit({ type: 'chase', on: true, pid: 'one' }); sim.emit({ type: 'hv_hunt_phase', phase: 'end', reason: 'timeout', pid: 'one' });
  sim.emit({ type: 'hit', pid: 'one', by: 'hv', x: 0, z: 0 });
  sim.finish('lost');
  const r = sim.result, s = r.stats.players.one;
  assert.equal(r.difficulty, 'visitor'); assert.equal(r.objectivesTotal, 4);
  assert.ok(s.dist > 45 && s.dist < 55, `${s.dist} m`); assert.ok(s.sprintT > 9.5 && s.darkT > 9.5);
  assert.equal(s.hunted, 1); assert.equal(s.survived, 1); assert.equal(s.grabs, 1); assert.equal(r.stats.team.hunts, 1);
  const me = (state) => ({ id: 'one', state });
  assert.equal(nightRank(r, me('dead'), sim.rules).id, 'hid_once');
  const won = (time, grabs) => ({ result: 'won', time, objectives: 4, objectivesTotal: 4, stats: { players: { one: { grabs } } } });
  assert.equal(nightRank(won(800, 0), me('escaped'), CONFIG.DIFFICULTY.ranger).id, 'ghost');
  assert.equal(nightRank(won(1400, 0), me('escaped'), CONFIG.DIFFICULTY.ranger).id, 'untouched');
  assert.equal(nightRank(won(1400, 2), me('escaped'), CONFIG.DIFFICULTY.ranger).id, 'last_breath');
  assert.equal(nightRank(won(700, 1), me('escaped'), CONFIG.DIFFICULTY.ranger).id, 'runner');
  assert.equal(nightRank(won(1400, 1), me('escaped'), CONFIG.DIFFICULTY.ranger).id, 'survivor');
  assert.equal(nightRank(won(700, 0), me('dead'), CONFIG.DIFFICULTY.ranger).id, 'so_close', 'the team won but you did not get out');
});

test('notes: fourteen in the archive, four scattered a night, the memo always on the kiosk', () => {
  assert.equal(NOTES.length, 14); assert.equal(new Set(NOTES.map((n) => n.id)).size, 14);
  const seen = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const sim = new GameSim(base, { seed });
    const notes = sim.obj.items.filter((i) => i.kind === 'note');
    assert.equal(notes.filter((n) => n.note === 'memo').length, 1);
    assert.equal(notes.length, 1 + CONFIG.NOTES_PER_NIGHT, `seed ${seed}`);
    for (const n of notes) seen.add(n.note);
  }
  assert.equal(seen.size, 14, 'every note turns up across nights');
});

test('the main random stream is unchanged by the new systems (seeded nights keep their layout)', () => {
  // gas can / fuse kit / spare lighters come from the main stream: same seed, same places as before 0.9
  const sim = new GameSim(base, { seed: 2001 });
  const key = sim.obj.items.filter((i) => ['fuel', 'fuse', 'battery', 'blanket'].includes(i.kind)).map((i) => `${i.id}:${i.x.toFixed(1)},${i.z.toFixed(1)}`).join(' ');
  const again = new GameSim(base, { seed: 2001, difficulty: 'moon' });
  const key2 = again.obj.items.filter((i) => ['fuel', 'fuse', 'battery', 'blanket'].includes(i.kind)).map((i) => `${i.id}:${i.x.toFixed(1)},${i.z.toFixed(1)}`).join(' ');
  assert.equal(key, key2, 'difficulty does not move supplies');
});

test('radio: the county unit talks the survivors in after the distress call', () => {
  const sim = new GameSim(base, { seed: 4 }); sim.state = 'play'; sim.time = 500; quiet(sim);
  sim.director.update = () => {}; sim.hv.update = () => {}; sim.balloons.update = sim.ambient.update = () => {};
  const p = sim.addPlayer('one', 'One'); put(base, p, at(1467), { flash: true });
  sim.obj.extractOpen = true; sim.state = 'extract';
  const ids = [];
  const run = (s) => { for (let t = 0; t < s; t += dt) { sim.step(dt); for (const e of sim.drainEvents()) if (e.type === 'radio') ids.push(e.id); } };
  run(1); assert.deepEqual(ids, ['call']);
  run(60); assert.deepEqual(ids, ['call', 'bridge']);
  const ex = sim.obj.extract; put(base, p, { x: ex.x + 100, z: ex.z }, { flash: false }); run(14);
  assert.deepEqual(ids, ['call', 'bridge', 'no_light']);
  put(base, p, { x: ex.x + 30, z: ex.z }); run(10);
  assert.deepEqual(ids, ['call', 'bridge', 'no_light', 'close']);
});
