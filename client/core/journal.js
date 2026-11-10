// The field journal (Update 0.9): what carries over between nights, kept in this browser only
// (localStorage, guarded: it can be unavailable). Records per difficulty, feats, every note
// found, and which first-time hints have been shown. Nothing here leaves the device.
import { CONFIG } from '../../shared/config.js';
import { NOTES } from '../../shared/sim/objectives.js';
import { nightRank } from '../../shared/sim/stats.js';

const KEY = 'heliummoon.journal.v1';

// test(ctx) -> true when earned. ctx: { r: result, me: {id,state}, s: my stats, team, rules, j: journal (after this night), players }
export const FEATS = [
  { id: 'first_light', name: 'First Light', text: 'Make it out of the refuge.', test: (c) => c.out },
  { id: 'untouched', name: 'Untouched', text: 'Escape without being grabbed.', test: (c) => c.out && !c.s.grabs },
  { id: 'held_breath', name: 'Not a Sound', text: 'Survive a hunt in which he searched within ten feet of you.', test: (c) => (c.s.survived || 0) >= 1 && (c.s.closePasses || 0) >= 1 },
  { id: 'long_night', name: 'The Long Night', text: 'Survive three hunts in one night.', test: (c) => (c.s.survived || 0) >= 3 },
  { id: 'dark_walker', name: 'Dark Walker', text: 'Escape having kept the lighter out for more than half the night.', test: (c) => c.out && c.s.aliveT > 60 && c.s.darkT / c.s.aliveT > 0.5 },
  { id: 'quiet_feet', name: 'Quiet Feet', text: 'Escape having sprinted for less than fifteen seconds.', test: (c) => c.out && (c.s.sprintT || 0) < 15 },
  { id: 'stone_thrower', name: 'Stone Thrower', text: 'Draw him off with a pebble twice in one night.', test: (c) => (c.s.distractions || 0) >= 2 },
  { id: 'party_over', name: 'Party’s Over', text: 'Untie three balloons in one night without popping any.', test: (c) => (c.s.balloonsUntied || 0) >= 3 && !(c.s.balloonsPopped || 0) },
  { id: 'night_runner', name: 'Night Runner', text: 'Escape in under thirteen minutes.', test: (c) => c.out && c.r.time < 13 * 60 },
  { id: 'reader', name: 'Reader', text: 'Find every note left on the trail in a single night.', test: (c) => (c.r.notes || 0) >= 1 + CONFIG.NOTES_PER_NIGHT },
  { id: 'archivist', name: 'Archivist', text: `Find all ${NOTES.length} notes across your nights.`, test: (c) => c.j.notes.length >= NOTES.length },
  { id: 'nobody_left', name: 'Nobody Left Behind', text: 'Co-op: everyone who walked in walks out.', test: (c) => c.players.length >= 2 && c.players.every((p) => p.state === 'escaped') },
  { id: 'medic', name: 'On Your Feet', text: 'Co-op: revive a teammate.', test: (c) => (c.s.revives || 0) >= 1 },
  { id: 'helium_moon', name: 'Helium Moon', text: 'Escape on the Helium Moon difficulty.', test: (c) => c.out && c.r.difficulty === 'moon' },
];

const blank = () => ({ nights: 0, escapes: 0, best: {}, feats: {}, notes: [], hints: {}, totals: { dist: 0, hunts: 0, survived: 0, grabs: 0, balloons: 0 }, last: null });

export class Journal {
  constructor() { Object.assign(this, blank()); }
  static load() {
    const j = new Journal();
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) { const v = JSON.parse(raw); for (const k of Object.keys(blank())) if (v[k] !== undefined && v[k] !== null) j[k] = v[k]; }
    } catch (e) { /* storage unavailable: a fresh journal each visit */ }
    if (!Array.isArray(j.notes)) j.notes = [];
    j.totals = { ...blank().totals, ...(j.totals || {}) };
    return j;
  }
  save() {
    try { const o = {}; for (const k of Object.keys(blank())) o[k] = this[k]; window.localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* ignore */ }
  }
  reset() { Object.assign(this, blank()); this.save(); }

  noteFound(id) { if (id && !this.notes.includes(id) && NOTES.some((n) => n.id === id)) { this.notes.push(id); this.save(); return true; } return false; }

  // first-time hints: true the first time (and remembers), false after
  hint(id) { if (this.hints[id]) return false; this.hints[id] = 1; this.save(); return true; }

  // file a finished night. Returns what the end screen shows.
  record(result, myId, rules, extraNotes = []) {
    const me = result.players.find((p) => p.id === myId) || { id: myId, state: 'dead' };
    const s = result.stats?.players?.[myId] || {};
    const out = result.result === 'won' && me.state === 'escaped';
    const diff = result.difficulty || 'ranger';
    this.nights++; if (out) this.escapes++;
    for (const id of extraNotes) if (id && !this.notes.includes(id) && NOTES.some((n) => n.id === id)) this.notes.push(id);
    const T = this.totals;
    T.dist += s.dist || 0; T.hunts += s.hunted || 0; T.survived += s.survived || 0; T.grabs += s.grabs || 0; T.balloons += (s.balloonsUntied || 0) + (s.balloonsPopped || 0);
    let newBest = false;
    const prev = this.best[diff];
    if (out && (!prev || result.time < prev.time)) { newBest = !!prev || true; this.best[diff] = { time: result.time, players: result.players.length, grabs: s.grabs || 0, at: Date.now() }; }
    const ctx = { r: result, me, s, team: result.stats?.team || {}, rules, j: this, out, players: result.players };
    const earned = [];
    for (const f of FEATS) {
      if (this.feats[f.id]) continue;
      let ok = false; try { ok = !!f.test(ctx); } catch (e) { ok = false; }
      if (ok) { this.feats[f.id] = Date.now(); earned.push(f); }
    }
    const rank = nightRank(result, me, rules);
    this.last = { result: result.result, out, time: result.time, diff, rank: rank.id, at: Date.now() };
    this.save();
    return { rank, earned, newBest: out && newBest, previousBest: prev ? prev.time : null, out, stats: s, me };
  }
}

// One line of advice for the death screen, chosen from how the night actually went.
export function nightTip(result, s = {}, me = {}) {
  if (result.result === 'won' && me.state === 'escaped') return null;
  if (!(s.hunted > 0) && (s.bites || 0) > 0) return 'The low brush by the water is where the other one lives. If the air smells like a struck match, back away from it.';
  if ((s.grabs || 0) > 0 && !(s.survived > 0) && (s.hiddenT || 0) < 4) return 'When the low hum starts he is hunting you. Do not run. Get out of his sight, crouch behind a trunk or in thick brush, put the lighter out and stay still.';
  if ((s.grabs || 0) > 0 && (s.closePasses || 0) > 0 && (s.breathT || 0) < 2) return 'When he searches close to your hiding place he can hear you breathe. Hold Jump while crouched to hold your breath until he moves on.';
  if ((s.sprintT || 0) > 60) return 'Sprinting carries a long way in the dark. Walk, and save your wind for when it matters.';
  if ((s.balloonsPopped || 0) > 0) return 'A popped balloon is the loudest thing in the refuge. Crouch under them, or untie them.';
  if ((s.darkT || 0) < (s.aliveT || 1) * 0.1) return 'He sees your lighter from much further away than you can see by it. Put it out when you do not need it.';
  if ((s.pebbles || 0) === 0 && (s.hunted || 0) > 0) return 'While he searches, a pebble thrown away from your hiding place sends him to look where it landed.';
  return 'He only moves freely when nobody is looking at him. He hunts by sight first, then by sound.';
}
