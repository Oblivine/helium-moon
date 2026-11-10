// HELIUM MOON - central tunables. Shared by the browser client and the Node server.
// Distances are metres, times are seconds, speeds are m/s.

export const CONFIG = {
  // ---------------------------------------------------------------- world
  // Metres per pixel of the user's top-down reference image. The real image is
  // ~8.2 m/px; 3.7 keeps the real shape of the trail but compresses it so a full
  // run fits a 15-25 minute session. Raise toward 8.2 for a 1:1 scale map.
  MAP_SCALE: 3.7,
  WORLD_SEED: 19740522,          // fixed: the map itself is the same every game
  HEIGHT_RES: 1.0,               // metres per heightfield sample
  GRID_RES: 2.0,                 // metres per cell for masks / density / nav
  TRAIL_HALF_WIDTH: 1.75,        // old 'River Road' two-track, half width at the south trailhead
  TRAIL_HALF_WIDTH_NORTH: 1.1,   // ...narrowing and overgrown toward the north end
  CORRIDOR_WIDTH: 165,           // playable forest depth on the refuge side of the trail
  FENCE_OFFSET: 13,              // farm fence distance on the field side of the trail
  RIVER_HALF_WIDTH: 9.5,
  RIVER_BANK: 7,
  WATER_LEVEL: -2.1,             // river surface relative to the floodplain
  SWAMP_WATER_LEVEL: -0.55,
  DEEP_WATER: 0.75,              // water deeper than this blocks players

  // ---------------------------------------------------------------- time / sky
  START_CLOCK: 22 * 60,          // 10:00 PM in minutes
  CLOCK_RATE: 1.0,               // in-game minutes per real minute
  MOON_PHASE: 0.78,              // waxing gibbous illuminated fraction
  MOON_AZIMUTH_DEG: 162,         // SSE, near transit at 10 PM for a ~10-day waxing gibbous
  MOON_ELEVATION_DEG: 36,
  MOON_ANGULAR_SIZE: 2.3,        // degrees (exaggerated ~4x for presence, still believable)

  // ---------------------------------------------------------------- player
  PLAYER: {
    WALK: 1.75, SPRINT: 5.4, CROUCH: 0.95, ACCEL: 11, AIR_ACCEL: 2,
    JUMP: 4.1, GRAVITY: 18, HEIGHT: 1.72, CROUCH_HEIGHT: 1.05, RADIUS: 0.3,
    STAMINA_MAX: 9, STAMINA_REGEN: 1.15, STAMINA_REGEN_DELAY: 1.2,
    STEP_HEIGHT: 0.42, MUD_SLOW: 0.72, WATER_SLOW: 0.55, BRUSH_SLOW: 0.78,
    // owner (Oct 25, Puppet rework): you survive two of his grabs; the third kills. No
    // automatic healing, so the count holds for the whole night.
    MAX_HEALTH: 3, HEAL_AFTER: 0,
    // Teammates remain locatable nearby without sounding like another threat.
    REMOTE_STEP_FADE_START: 4, REMOTE_STEP_MAX_DISTANCE: 11, REMOTE_STEP_GAIN: 0.45,
  },
  PEBBLE: {
    COOLDOWN: 20, SPEED: 13, UP_BOOST: 3.4, GRAVITY: 12, RADIUS: .035,
    MAX_FLIGHT: 4, MAX_RANGE: 30, MAX_ACTIVE: 12,
    HEAR_RANGE: 32, DISTRACTION_TIME: 12,
  },
  // The player's light is a small lighter now (owner, Oct 25 2026): omni, lights only RANGE m
  // round you, no beam. BATTERY_* is its fuel; a strike fails STRIKE_FAIL of the time (more
  // when he is coming for you). Kept under the old name so the sim's `flash` flag is unchanged.
  FLASHLIGHT: {
    BATTERY_SECONDS: 600, BATTERY_PICKUP: 0.55, LOW: 0.18,
    ANGLE_DEG: 90, RANGE: 6.5, INTENSITY: 9, STRIKE_FAIL: 0.15,
  },

  // ---------------------------------------------------------------- Helium Voice terror radius
  TERROR: {
    OUTER: 80, MIDDLE: 50, INNER: 25, CRITICAL: 10,
    SMOOTH_IN: 0.35,               // how fast the felt terror rises (per second, exponential)
    SMOOTH_OUT: 0.2,               // recover after moving away rather than carrying every cue far out
    BASE_TEMP_C: 14,               // late October night
    MIN_TEMP_C: -4,                // temperature felt at the critical ring
    STRONG_CUE_START: 0.68,        // distant proximity should suggest cold, not broadcast a location
    FLICKER_START: 0.78,
    ANOMALY_START: 0.84,
    SIGHT_STINGER_DISTANCE: 25, SIGHT_STINGER_COOLDOWN: 50,
  },

  // ---------------------------------------------------------------- monsters
  HV: {
    WALK: 1.35, STALK: 2.3, CHASE: 5.15, BURST: 6.6, RELOCATE: 4.2,
    NAV_BLOCK_TIME: 60,            // s a spot where he got physically stuck is avoided by the planner
    STEP_OVER: 0.75,               // obstacle height he steps over: every fallen log (max 0.67 m) - 0.6 left 17% of logs as walls nav couldn't see
    CREEP_DISTANCE: 2.4, CREEP_SPEED: 0.38, CREEP_STOP: 1.8,
    RETREAT: 10.5,                 // fast, physical reverse bear crawl to cover
    WITHDRAW_DISTANCE: 200, WITHDRAW_SPEED: 2.3, // after each hunt: physically leave before returning
    SCARE_VISIBLE: [1, 2], SHADOW_FOLLOW: [18, 32], SHADOW_DIST: [12, 22],
    SIGHT_FLASHLIGHT: 95, SIGHT_DARK: 24, SIGHT_FOV_DEG: 150,
    HEAR_SPRINT: 42, HEAR_WALK: 16, HEAR_CROUCH: 5, HEAR_INTERACT: 55, HEAR_VOICE: 38,
    ATTACK_RANGE: 1.7, ATTACK_COOLDOWN: 2.4, LOSE_TIME: 6.5, SEARCH_TIME: 24,
    OBSERVE_MIN: 35, OBSERVE_MAX: 70, // preferred observation distance band
    SIGNATURE_PROB: 0.4, SIGNATURE_FIRST_PROB: 0.75, SIGNATURE_COOLDOWN: 95, // uploaded .ogg on first sighting
    FOOTSTEP_FADE_START: 1.8, FOOTSTEP_MAX_DISTANCE: 2.4, // roughly 6-8 feet
    FOOTSTEP_STALK_GAIN: 0.45, FOOTSTEP_CHASE_GAIN: 0.8,
    // Movement-only joint cracks during searching, separate from close footsteps.
    SEARCH_CRACK_FADE_START: 4, SEARCH_CRACK_MAX_DISTANCE: 18, SEARCH_CRACK_GAIN: 0.65,
    SEARCH_CRACK_TRAVEL: [1.2, 2.1], SEARCH_CRACK_INTERVAL: [1.4, 2.3],
    // Owner Oct 26: a bounded hunt opens with a concealed stalk, then a search of
    // the last sight/sound. Actual discovery can become a damaging rush. Without a
    // catch, the hunt ends after both phases; no exact-position tracking through cover.
    // Farther than HUNT_START_RANGE he first closes in unseen (HUNT_CLOSE_TIMEOUT max).
    // The client's hunt hum plays only within HUNT_HUM_RANGE of him.
    HUNT_STALK_DIST: [30, 45],   // owner: the opening stalk of a hunt holds this far out, concealed
    HUNT_START_RANGE: 42, HUNT_CLOSE_TIMEOUT: 45,
    HUNT_BREAK_LIT_DIST: 2.13, HUNT_TRACK_EVERY: 2.5,   // HUNT_BREAK_LIT_DIST: legacy 7-ft rule (unused); hunts now end by hiding (HIDE_* below)
    // Crouch in cover, lighter off, still and quiet: he searches the last evidence.
    // HIDE_TIME tracks settled concealment; it no longer cancels the opening stalk.
    // Survive the deadline and HIDE_GRACE gives a breather before the next hunt.
    HIDE_TIME: 6, HIDE_STILL: 0.6, HIDE_NOISE: 6, HIDE_MIN_DIST: 2.5, HIDE_LEARNED: 1.5, HIDE_GRACE: [45, 25],
    // A hunt opens with an escape window. He searches and closes pressure, but cannot grab;
    // this gives players time to kill the light and settle into brush or a broken sightline.
    HUNT_HIDE_WINDOW: [15, 20],
    HUNT_SEARCH_TIME: [30, 40], HUNT_SEARCH_RADIUS: [4, 14], HUNT_CONTACT_MEMORY: 1.8,
    HUNT_PACE: [0.88, 1.18], HUNT_PACE_INTERVAL: [0.9, 2.3],
    HUNT_CUTOFF_JITTER: [0.65, 1.25],
    HUNT_LUNGE_DIST: 4,   // within this (clear line), the final lunge uses real collision, not the 2 m nav grid
    HUNT_STALL_TIME: 8,   // fail-safe: stuck (moved <1.5 m in 8 s, not in attack range) ends a hunt
    HUNT_HUM_RANGE: 50,
    // Unseen relocation ("teleport", owner Oct 25): reappears RELOCATE_AHEAD m ahead of the
    // player, concealed. Triggers: mid-hunt after RELOCATE_CUTOFF_UNSEEN s without sight (once
    // per hunt), or while closing in on a player more than RELOCATE_AHEAD_TRIGGER m away.
    RELOCATE_COOLDOWN: [150, 60], RELOCATE_AHEAD: [35, 60], RELOCATE_MIN_DIST: 12,
    RELOCATE_CUTOFF_UNSEEN: 4, RELOCATE_AHEAD_TRIGGER: 70,
    // "The forest holds its breath" (docs/SCARE_RESEARCH.md C1): when he closes in on a
    // player inside HUSH_DIST, the night ambience around them goes quiet. Skipped on about
    // HUSH_SKIP of approaches so silence is never a guaranteed tell.
    HUSH_DIST: 55, HUSH_SKIP: 0.25,
    // "He learns your escapes" (SCARE_RESEARCH C2; Alien: Isolation's illusion of learning).
    // Per player he remembers how they got away; memories fade with LEARN_HALF_LIFE s.
    // At LEARN_COUNTER (weighted) uses of a tactic, he counters it:
    //  flash  -> won't commit a hunt while they are facing him; waits (<= LEARN_WAIT s) for them to turn
    //  sprint -> cuts them off sooner (cut-off after LEARN_CUTOFF_UNSEEN s instead of RELOCATE_CUTOFF_UNSEEN)
    LEARN_HALF_LIFE: 420, LEARN_COUNTER: 1.7, LEARN_WAIT: 7, LEARN_CUTOFF_UNSEEN: 2,
    // Attack (owner, Oct 25 midday): no more hit-and-run. He stops, screams and winds up
    // (WINDUP s, arms raised), swings, and if it lands he stays over you for LINGER s
    // staring before backing off at walking pace. The 7-ft flashlight still breaks the windup.
    WINDUP: 0.6, STRIKE_REACH: 2.3, LINGER: 1.6, MISS_PAUSE: 0.5,
    // Seen from a distance (owner): he doesn't vanish instantly. Beyond STARE_MIN_DIST he holds
    // still and stares back for STARE s (shorter if lit: STARE_LIT), then leaves at SLOW_RETREAT.
    STARE_MIN_DIST: 10, STARE: [3, 6], STARE_LIT: [1.8, 3.2], STARE_REFRACTORY: 8, SLOW_RETREAT: 2.4,
    // ---- "The Puppet" rework (owner, Oct 25 2026 afternoon; docs/HV_PUPPET_REWORK.md)
    // Watched he is "worn": he freezes mid-pose and holds (FREEZE s; shorter lit or close),
    // then backs away upright, facing you. Unwatched he is "operated": low, on all fours,
    // OPERATED_MUL faster. A new look after FREEZE_RESET s unwatched starts a new freeze.
    FREEZE: [4, 7], FREEZE_LIT: [2.5, 4.5], FREEZE_CLOSE: [2, 3.5], FREEZE_RESET: 0.6, OPERATED_MUL: 1.3,
    // In a hunt, each time the target looks back he freezes for a beat (owner), at most every
    // LOOKBACK_GAP s after the last beat ended, and never inside LOOKBACK_MIN_DIST.
    LOOKBACK_FREEZE: [0.55, 0.85], LOOKBACK_GAP: 1.8, LOOKBACK_MIN_DIST: 3,
    // The grab replaces the swing (owner): reach (GRAB_WINDUP s, the 7-ft flashlight still
    // breaks it), then he holds you for GRAB_HOLD[kind] s and lets go. Damage lands on release.
    // MAX_HEALTH 3: two grabs survived, the third kills (the 'final' grab).
    GRAB_REACH: 1.8, GRAB_LAND: 2.3, GRAB_AROUND: 3.1, GRAB_WINDUP: 0.45, GRAB_STAND: 0.75,
    GRAB_HOLD: { shoulders: 1.7, throat: 2.0, face: 1.4, turn: 1.6, drag: 1.5, final: 3.2 },
    // Flashlight within 7 ft: he collapses like his strings were cut. Once nobody has watched
    // him for COLLAPSE_GONE_AFTER s he is gone (unseen, COLLAPSE_AWAY m off). Watched for
    // COLLAPSE_MAX s, he gets up and backs away instead.
    COLLAPSE_MIN: 1.2, COLLAPSE_GONE_AFTER: 0.3, COLLAPSE_AWAY: [35, 70], COLLAPSE_MAX: 25,
    // In the grass (rare ambush): while closing in he may instead lie flat beside the trail
    // ahead (LIE_AHEAD m along it, LIE_OFF m off it) and unfold when they come within LIE_WAKE.
    // A lie may only occupy dense grass/cover: it must read as a shape in the undergrowth,
    // never a body laid on bare trail dirt.
    LIE_CHANCE: 0.3, LIE_COOLDOWN: 240, LIE_AHEAD: [55, 75], LIE_OFF: [3.8, 6.2], LIE_WAKE: 6.5, LIE_TIMEOUT: 60, RISE_TIME: 1.1,
    LIE_MIN_GRASS: 3, LIE_MIN_COVER: 0.28,
  },
  SF: {
    MODEL_SCALE: 0.6,               // keep the creature low and partially concealed in undergrowth
    SNEAK: 1.1, SCURRY: 4.6, DART: 7.0,
    SENSE_RADIUS: 26, AMBUSH_RADIUS: 7.5, GAS_RADIUS: 9, GAS_LIFE: 24, GAS_COOLDOWN: 28,
    BITE_RANGE: 1.4,
    FOOTSTEP_FADE_START: 1.8, FOOTSTEP_MAX_DISTANCE: 2.4, FOOTSTEP_GAIN: 0.6,
    VOCAL_FADE_START: 6, VOCAL_MAX_DISTANCE: 18, VOCAL_GAIN: 0.6,
    DANGER_FADE_START: 12, DANGER_MAX_DISTANCE: 26,
  },

  // ---------------------------------------------------------------- voice chat + mimicry
  VOICE: {
    CLEAR: 5, FADE_END: 20, MUFFLE: 32, MAX: 46,   // proximity falloff (metres)
    NOISE_THRESHOLD: 0.02,                         // mic RMS that counts as audible speech to monsters
  },
  MIMIC: {
    MIN_COOLDOWN: 80, PER_PLAYER_COOLDOWN: 140,    // seconds between mimicry events
    CHECK_INTERVAL: 6, BASE_CHANCE: 0.08,          // per check, scaled by conditions
    MIN_DELAY: 2, MAX_DELAY: 55,                   // phrase age when replayed
    BEHIND_MIN: 15, BEHIND_MAX: 35,
    HUNT_CHANCE: 0.58, HUNT_MIN_COOLDOWN: 45, HUNT_DELAY: [0.6, 2.0],
    HUNT_DECOY_MIN: 16, HUNT_DECOY_MAX: 30,
    PHRASE_MIN: 0.9, PHRASE_MAX: 4.0, MAX_PHRASES: 6, PHRASE_TTL: 120,
    PITCH: 1.5,
  },

  // ---------------------------------------------------------------- session
  // Creature no-go zones (owner, Oct 25 2026): never in the spawn area (see shared/sim/zones.js)
  ZONES: { SPAWN_RADIUS: 40, SPAWN_MARGIN: 12, SPAWN_PLAYERS: 6 },
  // Session pacing (owner, Oct 25 2026): dread builds longer before he shows himself, then
  // he grows steadily more aggressive as the night goes on.
  DIRECTOR: {
    DREAD_TIME: 210,          // s after the intro: cold/sounds only - no chases, reveals or skunk ambush; he keeps his distance
    DREAD_MIN_DIST: 55,       // m he is asked to stay beyond during the dread period (inside the outer cold ring)
    ESCALATE_TIME: 840,       // s after the dread period to reach full escalation (~18 min into the session)
    ESCALATE_AGGRESSION: 0.35,// added to base aggression at full escalation
    // Owner Oct 26: four minutes after a hunt ENDS, including extraction and close contact.
    POST_CHASE_COOLDOWN: 240,
    CHASE_COOLDOWN: [240, 240],
    CHASE_COOLDOWN_JITTER: [1, 1],
    ATTACK_COOLDOWN: [14, 7],
    RELAX_LEN: [[16, 28], [8, 14]],   // relax phase length range: start -> full escalation
    BUILD_LEN: [[45, 80], [22, 40]],
    REVEAL_GAP: [[26, 45], [15, 30]],
    REVEAL_RETRY: [6, 12], // failed/unseen plans retry soon; only perceived encounters earn the full gap
    REVEAL_RESOLVE: 48,    // maximum time reserved for a requested appearance before another may be planned
    SKUNK_REVEAL_CHANCE: 0.18, // Helium Voice remains the main source of deliberate appearances
    GLIMPSES_BEFORE_HUNT: 1, GLIMPSE_HUNT_DELAY: [10, 28],
    PRESENCE_SAFE: [12, 4],  // s of safety before he deliberately comes closer
    VOCAL_MUL: [2, 3.5],
  },
  // ================================================================ Update 0.9 "The Long Night"
  // Difficulty (host's choice; default ranger = the owner's tuned rules). health: grabs you can
  // take; chaseCooldown: multiplier on the post-hunt cooldown; search: multiplier on his search
  // time; fuel: lighter fuel multiplier; breathHear: metres at which he hears a hiding player
  // breathe during a search; lungs: seconds you can hold your breath.
  DIFFICULTY: {
    visitor: { label: 'Visitor', blurb: 'A gentler night. Four grabs, longer quiet between hunts.', health: 4, chaseCooldown: 1.25, search: 0.8, fuel: 1.4, breathHear: 3.2, lungs: 13 },
    ranger: { label: 'Ranger', blurb: 'The night as it was meant to be.', health: 3, chaseCooldown: 1, search: 1, fuel: 1, breathHear: 4.5, lungs: 10 },
    moon: { label: 'Helium Moon', blurb: 'Two grabs. He comes back sooner, searches longer and hears better.', health: 2, chaseCooldown: 0.72, search: 1.2, fuel: 0.75, breathHear: 5.5, lungs: 8 },
  },
  // Hold your breath: during his search, a concealed player within rules.breathHear of him who
  // is breathing for GRACE s (cumulative; drains at the same rate when out of range or holding)
  // is heard: he walks to within ERROR m of where they are. Holding is client-owned like stamina:
  // lungs drain 1/s, refill at REFILL/s after REFILL_DELAY; emptied lungs force a GASP s gasp
  // (audible to him out to GASP_HEAR). CLOSE_PASS: a search pass this near counts for the report.
  BREATH: { GRACE: 1.6, ERROR: 1.2, REFILL: 0.7, REFILL_DELAY: 1.0, GASP: 2.2, GASP_HEAR: 14, CLOSE_PASS: 3.2 },
  // Balloons: his calling cards. OMEN: one appears beside the trail ahead during the dread
  // period. After that he leaves one where a player watched him stand, and where he gave up a
  // hunt (placed only once nobody can see the spot and he has moved MARK_CLEAR m away; a mark
  // waits at most MARK_WAIT s). MAX at once; never within MIN_GAP m of another or in spawn.
  // An upright player within POP_RADIUS pops it (crouch to pass under); a pebble landing within
  // PEBBLE_RADIUS pops it; E unties it silently. A pop is heard by him out to POP_HEAR.
  BALLOON: { MAX: 7, HEIGHT: 1.5, OMEN_AT: [70, 130], OMEN_AHEAD: [55, 95], OMEN_OFF: [1.6, 2.6], MARK_CLEAR: 9, MARK_WAIT: 90, MIN_GAP: 14,
    POP_RADIUS: 0.5, PEBBLE_RADIUS: 1.1, POP_HEAR: 45, UNTIE_RANGE: 2.4 },
  // The refuge is next to farms, a rail line and a highway. Ambient events are scenery, never
  // a tell: they are scheduled on their own random stream and ignore where he is.
  AMBIENT: { TRAIN_FIRST: [150, 420], TRAIN_GAP: [420, 720], DOG_GAP: [170, 380], BRANCH_GAP: [260, 520], BRANCH_DIST: [24, 46],
    ALARM_CHANCE: 0.5, ALARM_AFTER: 330, ALARM_ALONG: 420, ALARM_TIME: 26 },
  PING: { RANGE: 45, COOLDOWN: 1.5, LIFE: 7 },
  // Notes scattered per night (the kiosk memo is always there as well)
  NOTES_PER_NIGHT: 4,

  SESSION: {
    INTRO_TIME: 9,
    REVIVE_TIME: 4.5, DOWNED_BLEEDOUT: 50,
    STATION_WORK_TIME: 9,
    EXTRACT_RADIUS: 9,
  },
  NET: { SNAPSHOT_HZ: 15, INPUT_HZ: 20, INTERP_DELAY: 0.15, MAX_PLAYERS: 6 },
};

export const QUALITY_PRESETS = {
  low:    { label: 'Low',    renderScale: 0.7,  shadowMap: 1024, shadowDist: 40, treeLod0: 18, treeLod1: 45, treeFar: 220, grassDist: 22, bushDist: 40, msaa: 0, spotShadow: false, fogSteps: 6,  volumetric: false, maxTrees: 1600, treeShareLod: 1 },
  medium: { label: 'Medium', renderScale: 0.85, shadowMap: 2048, shadowDist: 55, treeLod0: 26, treeLod1: 80, treeFar: 300, grassDist: 32, bushDist: 55, msaa: 2, spotShadow: true,  fogSteps: 8,  volumetric: true,  maxTrees: 2600, treeShareLod: 1 },
  high:   { label: 'High',   renderScale: 1.0,  shadowMap: 2048, shadowDist: 70, treeLod0: 34, treeLod1: 100, treeFar: 380, grassDist: 42, bushDist: 70, msaa: 4, spotShadow: true,  fogSteps: 10, volumetric: true,  maxTrees: 3800, treeShareLod: 2 },
  ultra:  { label: 'Ultra',  renderScale: 1.0,  shadowMap: 4096, shadowDist: 90, treeLod0: 45, treeLod1: 130, treeFar: 480, grassDist: 55, bushDist: 90, msaa: 4, spotShadow: true,  fogSteps: 14, volumetric: true,  maxTrees: 5200, treeShareLod: 2 },
};
