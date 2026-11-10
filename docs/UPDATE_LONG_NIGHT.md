# Update 0.9 "The Long Night" — design review and plan

Owner request (Nov 10 2026): "take the game under your wing and do every improvement you
could possibly think of to make it more engaging ... like a major update ... playtest and
create ideas like a game design team, imagine there are like 30 of you."

Claude ran the review as a studio would: each discipline played the build at `3e95536`
(8 scripted 25-minute sessions through the real simulation, plus a rendered walk of the
trailhead, trail, map, all four stations) and filed findings. Status column is filled in
as work lands; **As built** at the end is the source of truth.

## Playtest findings (build 3e95536)

| # | Discipline | Finding |
|---|---|---|
| 1 | Systems design | 1–2 hunts per 11–20 min night. Between hunts there are minutes of walking with nothing to decide. The night needs more small decisions and discoveries between the big beats. |
| 2 | Systems design | Hiding is passive: crouch, light off, wait 30–40 s. Correct, but the player has nothing to *do* at the most frightening moment of the game. |
| 3 | Onboarding / UX | Nothing in play tells a new player how a hunt works or how to survive one. Every scripted player who did not already know to hide was caught. |
| 4 | UX | In the dark there is no heading cue; the map is behind Tab. New players lose the trail and the objective. |
| 5 | Meta / retention | A night ends with time, objectives and notes. Nothing carries over: no records, no goals for the next attempt, no reason to try another way. |
| 6 | Narrative | Six notes, three per night. No voice of the outside world after the distress call. The creature has no physical signature in the world beyond himself. |
| 7 | World / ambient | The refuge is next to farms, a rail line and a highway, yet the night soundscape has no distant human world; nothing unexpected happens that is not him. |
| 8 | Art / lighting | The lighter's flame blooms into a bright square on screen. Displays differ; there is no brightness control. |
| 9 | Platform | Unplayable on phones (owner request Oct 25, unfinished): no touch controls. |
| 10 | Co-op | Without a microphone there is no way to point at something. |
| 11 | Difficulty | One fixed difficulty. First-timers die on the first hunt; experts have nothing harder. |
| 12 | QA | Baseline `npm test` passes at 3e95536. |

## What the team chose to build

Owner rules kept throughout: creatures never enter spawn; cold is the approach warning; no
loud artificial warning stingers and no new cue that broadcasts his position; hiding ends
hunts; the four-minute post-hunt cooldown; three health, no healing; lighter not flashlight;
no strings; no Helium speech; mic/mimicry privacy rules; Developer mode.

| ID | Feature | Answers finding |
|---|---|---|
| A1 | Touch controls for phones and tablets; phone-sized HUD; automatic Low quality on phones | 9 |
| A2 | Brightness setting | 8 |
| A3 | Lighter flame redrawn (no square bloom) | 8 |
| B1 | **Hold your breath.** While hidden, hold Jump to hold your breath. If he searches within a few metres and you are breathing, he hears it and comes to look. Lungs are limited; running out makes you gasp. | 2 |
| B2 | **Difficulty**: Visitor / Ranger / Helium Moon | 11 |
| B4 | **Balloons.** He leaves a balloon where he stood watching you and where a hunt was given up. Walking into one in the dark pops it (loud). A pebble pops one from range. | 1, 6 |
| B5 | The refuge is alive: distant train, farm dog, highway, a car alarm at the lot, a branch coming down | 7 |
| B6 | Co-op ping | 10 |
| C1 | **Night report**: per-player stats, a rank, an epilogue line | 5 |
| C2 | **Field journal** in the main menu: records per difficulty, feats, every note ever found | 5 |
| C3 | Notes expanded from 6 to 14; four scattered per night | 6 |
| C4 | Dispatcher radio lines (subtitles) at story beats | 6 |
| D1 | Compass strip with landmark pips (setting, on by default) | 4 |
| D2 | First-time hints at the moment they matter; a tip on the death screen | 3 |
| D5 | Menu: update tag and What's New | — |

Considered and not built: a forced final hunt during extraction (conflicts with the owner's
four-minute cooldown, which explicitly includes extraction); proximity heartbeat or music
(conflicts with the quiet-cue rule); healing items (conflicts with the fixed grab count).

## Reservations (Claude, this pass)

`shared/config.js` (new blocks only), `shared/sim/sim.js`, `shared/sim/objectives.js`,
`shared/sim/heliumVoice.js` (search hearing + balloon hooks only), new `shared/sim/balloons.js`,
`shared/sim/ambient.js`, `shared/sim/stats.js`, `client/game/*`, `client/ui/*`,
`client/core/*`, `client/audio/synth.js` + `audio.js` (new sounds only), `index.html`,
`client/entities/views.js` (new view classes only), new tests, hosted build.
