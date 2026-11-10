// Horror pacing director. Tracks how long players have been safe, whether they are
// grouped or isolated, recent chases/attacks, objective progress and how
// predictable the night has become - and steers both entities accordingly.
import { CONFIG } from '../config.js';
import { clamp, lerp } from '../math.js';
import { playerActive } from './perception.js';

export class Director {
  constructor(sim) {
    this.sim = sim; this.rng = sim.rng;
    this.phase = 'build'; this.phaseT = 0;
    this.intensity = 0;          // short-term stress (0..1+)
    this.presenceT = 0;
    this.safeT = 0;              // seconds since anything threatening happened near anyone
    this.lastChase = -999; this.lastAttack = -999; this.lastReveal = -999; this.lastVocal = -999; this.lastSkunk = -999;
    // first deliberate reveal is scheduled 20-45 s after the dread period actually ends (see update)
    this.nextReveal = null;
    this.revealPendingUntil = 0;
    this.revealKinds = ['watcher', 'crossing', 'shadow'];
    this.recentKinds = [];
    this.glimpsePressure = 0;
    this.huntDueAt = 0;
    this.chaseGapMul = 1;
    this.chasing = false;
    this.lastChaseEnd = -999; this.nextChaseAt = 0;
    this.focus = null;
  }

  get progress() { return this.sim.obj ? this.sim.obj.doneCount() : 0; }
  get extraction() { return this.sim.obj ? this.sim.obj.extractOpen : false; }

  // ---- session arc (owner): dread first, then escalating aggression as the night goes on
  get D() { return CONFIG.DIRECTOR; }
  // seconds of active play since the intro ended
  get playT() { return Math.max(0, this.sim.time - CONFIG.SESSION.INTRO_TIME); }
  // true during the opening dread period: cold and sounds only, he keeps his distance
  inDread() { return !this.sim.dev?.skipDread && this.playT < this.D.DREAD_TIME; }   // Developer mode can skip it
  // 0 at the end of the dread period -> 1 at full escalation; objectives push it along too
  escalation() { return clamp((this.playT - (this.sim.dev?.skipDread ? 0 : this.D.DREAD_TIME)) / this.D.ESCALATE_TIME + this.progress * 0.08, 0, 1); }
  // distance he should keep from every player right now (0 = no limit); for roam/observation-spot choice
  minDistance() { return this.inDread() ? this.D.DREAD_MIN_DIST : 0; }
  _esc(pair) { return lerp(pair[0], pair[1], this.escalation()); }
  _escRange(pair) { const e = this.escalation(); return this.rng.range(lerp(pair[0][0], pair[1][0], e), lerp(pair[0][1], pair[1][1], e)); }

  aggression() {
    let a = 0.2 + 0.11 * this.progress + (this.extraction ? 0.25 : 0) + this.D.ESCALATE_AGGRESSION * this.escalation();
    if (this.phase === 'peak') a += 0.25;
    if (this.phase === 'relax') a *= 0.2;
    return clamp(a, 0, 0.85);
  }

  // the player the monsters should pay most attention to: the isolated, the quiet, the one in front
  focusPlayer() {
    const p = this.focus ? this.sim.players.get(this.focus) : null;
    return playerActive(p) ? p : null;
  }

  wantsPresence() {
    const safe = this._esc(this.D.PRESENCE_SAFE) / (1 + this.glimpsePressure * 0.25);
    return !this.inDread() && this.phase !== 'relax' && (this.presenceT > safe || this.phase === 'peak');
  }

  allowChase(p) {
    const t = this.sim.time;
    // never open a hunt on someone downed, dead or gone (PLAYTESTS_50 P0)
    if (!playerActive(p) || p.state !== 'alive') return false;
    if (t < this.nextChaseAt || this.sim.hv?.withdrawal) return false;
    if (this.phase === 'relax' || this.sim.state === 'intro' || this.inDread()) return false;
    const baseGap = this._esc(this.D.CHASE_COOLDOWN) * this.chaseGapMul * (this.sim.rules?.chaseCooldown ?? 1);
    const chaseGap = baseGap;
    if (t - this.lastChase < chaseGap || t - this.lastAttack < this._esc(this.D.ATTACK_COOLDOWN)) return false;
    return true;
  }

  wantsChase(p, d) {
    if (!this.allowChase(p)) return false;
    const iso = p.isolation || 0;
    const chance = this.aggression() * (d < 20 ? 1.4 : d < 35 ? 0.8 : 0.3) * (iso > 25 ? 1.4 : 1)
      * (this.phase === 'peak' ? 1.3 : 1) * (1 + this.glimpsePressure * 0.55);
    return this.rng() < chance * 0.14;   // evaluated every tick -> per-second hazard ~2.8*chance (owner: 2-3x more active)
  }

  chaseSpeedMul() { return this.extraction ? 1.06 : 1; }
  allowSkunkAmbush() { return !this.inDread() && this.phase !== 'relax' && this.sim.time - this.lastSkunk > 35 && this.sim.state !== 'intro'; }

  vocalRate(state, d) {
    // long silences are the default; vocals cluster in build-up and drop during relax
    let r = 0.025;
    if (this.phase === 'relax') r *= 0.25;
    if (this.phase === 'peak') r *= 1.6;
    if (d < 25) r *= 0.6;            // close by he mostly goes quiet
    if (this.sim.time - this.lastVocal < 30) r *= 0.3;
    return r * this._esc(this.D.VOCAL_MUL);
  }

  onVocal() { this.lastVocal = this.sim.time; }
  onChaseStart(p) {
    this.chasing = true; this.lastChase = this.sim.time; this.intensity += 0.6; this.safeT = 0;
    this.glimpsePressure = 0;
    this.huntDueAt = 0;
    this.chaseGapMul = this.rng.range(...this.D.CHASE_COOLDOWN_JITTER);
    this.sim.emit({ type: 'chase', pid: p.id, on: true });
    this.sim.mimic?.queueHuntDecoy(p.id);
  }
  onChaseEnd(caught) {
    this.chasing = false; this.lastChaseEnd = this.sim.time;
    this.nextChaseAt = this.sim.time + this.D.POST_CHASE_COOLDOWN * (this.sim.rules?.chaseCooldown ?? 1);
    this.huntDueAt = 0;
    const hv=this.sim.hv;
    hv?.beginWithdrawal?.(this.sim.players.get(hv.target));
    this.sim.emit({ type: 'chase', on: false }); this.enter('relax');
  }
  onAttack(p) { this.lastAttack = this.sim.time; this.intensity += 1; this.onChaseEnd(true); }
  onReveal(kind) {
    if (kind !== 'retreat') {
      this.lastReveal = this.sim.time;
      this.recentKinds.push(kind); if (this.recentKinds.length > 3) this.recentKinds.shift();
      if (kind !== 'skunk') this.glimpsePressure = Math.min(3, this.glimpsePressure + 1);
      if (kind !== 'skunk' && this.glimpsePressure >= this.D.GLIMPSES_BEFORE_HUNT && !this.huntDueAt)
        this.huntDueAt = this.sim.time + this.rng.range(...this.D.GLIMPSE_HUNT_DELAY);
      // Cool down from what the player actually perceived. A requested reveal
      // can spend tens of seconds travelling and still time out behind cover;
      // that must not buy a full quiet interval for an encounter that never happened.
      this.nextReveal = this.sim.time + this._escRange(this.D.REVEAL_GAP);
      this.revealPendingUntil = 0;
    }
    this.intensity += 0.25; this.safeT = 0;
  }
  onSkunk() { this.lastSkunk = this.sim.time; this.intensity += 0.4; this.safeT = 0; }

  enter(phase) { this.phase = phase; this.phaseT = 0; this.phaseLen = phase === 'relax' ? this._escRange(this.D.RELAX_LEN) : phase === 'peak' ? this.rng.range(50, 90) : this._escRange(this.D.BUILD_LEN); }

  update(dt) {
    const sim = this.sim;
    this.phaseT += dt;
    if (!this.phaseLen) this.enter('build');
    this.intensity = Math.max(0, this.intensity - dt * 0.035);
    // proximity of danger -> resets the safe timer
    const hv = sim.hv;
    let closest = 1e9;
    const active = sim.playerList.filter(playerActive);
    for (const p of active) {
      closest = Math.min(closest, Math.hypot(p.x - hv.x, p.z - hv.z));
      // isolation from teammates
      let iso = 1e9;
      for (const q of active) if (q !== p) iso = Math.min(iso, Math.hypot(q.x - p.x, q.z - p.z));
      p.isolation = active.length > 1 ? iso : 0;
    }
    if (closest < CONFIG.TERROR.MIDDLE) this.safeT = 0; else this.safeT += dt;
    // Being hidden 40 m away is not a player encounter. Keep approaching
    // until a glimpse, committed pursuit or genuinely close cold presence.
    if (hv.observers?.length || this.chasing || closest < CONFIG.TERROR.INNER) this.presenceT = 0;
    else this.presenceT += dt;
    if (closest < CONFIG.TERROR.INNER) this.intensity += dt * 0.01;
    // focus: most isolated player, else the one furthest along the trail, rotating occasionally
    if (!this.focusT || this.focusT <= 0) {
      let best = null, bs = -1e9;
      for (const p of active) {
        const s = (p.isolation || 0) * 0.05 + (p.quietT || 0) * 0.01 + this.rng() * 1.5;
        if (s > bs) { bs = s; best = p; }
      }
      this.focus = best ? best.id : null;
      this.focusT = this.rng.range(30, 70);
    }
    this.focusT -= dt;
    // phase machine
    if (this.phase === 'relax' && this.phaseT > this.phaseLen) this.enter('build');
    else if (this.phase === 'build' && this.phaseT > this.phaseLen && !this.chasing) this.enter('peak');
    else if (this.phase === 'peak' && this.phaseT > this.phaseLen && !this.chasing) this.enter(this.intensity > 1 ? 'relax' : 'build');
    if (this.intensity > 2.4 && this.phase !== 'relax' && !this.chasing) this.enter('relax');   // owner: more active -> tolerates more before forcing a break
    // Harmless sightings must not teach players that appearances are
    // always safe. After a variable delay, ask the real AI to close for a hunt;
    // startChase still requires physical travel and all ordinary safeguards.
    if (this.huntDueAt && sim.time >= this.huntDueAt && !this.chasing && !this.inDread() && this.phase !== 'relax') {
      const p = sim.hv.focusPlayer?.() || this.focusPlayer();
      if (p && this.allowChase(p)) {
        sim.hv.startChase(p);
        if (sim.hv.state === 'chase' || sim.hv.closingOn?.pid === p.id) this.huntDueAt = 0;
        else this.huntDueAt = sim.time + 8;
      }
    }
    // deliberate reveals - rare, varied, never the same twice in a row
    if (sim.state === 'play' || sim.state === 'extract') {
      if (this.nextReveal === null && !this.inDread()) this.nextReveal = sim.time + this.rng.range(20, 45);
      if (this.nextReveal !== null && sim.time > this.nextReveal && sim.time >= this.revealPendingUntil
          && !this.chasing && this.phase !== 'relax' && !this.inDread()) {
        const p = sim.hv.focusPlayer?.() || this.focusPlayer();
        if (p) {
          let kinds = this.revealKinds.filter((k) => !this.recentKinds.slice(-2).includes(k));
          if (!kinds.length) kinds = this.revealKinds;
          // A skunk appearance is occasional variety. When the night owes the
          // players presence, Helium Voice resolves it himself.
          // One draw keeps the rest of the seeded AI stream stable. Remap the
          // non-skunk part of that draw across Helium Voice's available forms.
          const roll = this.rng(), last = this.recentKinds[this.recentKinds.length - 1];
          const skunk = this.presenceT <= 90 && last !== 'skunk' && roll < this.D.SKUNK_REVEAL_CHANCE;
          const hi = Math.min(kinds.length - 1, Math.floor(Math.max(0, roll - this.D.SKUNK_REVEAL_CHANCE)
            / (1 - this.D.SKUNK_REVEAL_CHANCE) * kinds.length));
          const kind = skunk ? 'skunk' : kinds[hi];
          const ok = kind === 'skunk' ? sim.sf.requestEmerge(p) : sim.hv.requestReveal(kind, p);
          if (ok) {
            this.revealPendingUntil = sim.time + this.D.REVEAL_RESOLVE;
            this.nextReveal = this.revealPendingUntil;
          } else this.nextReveal = sim.time + this.rng.range(...this.D.REVEAL_RETRY);
        }
      }
    }
  }
}
