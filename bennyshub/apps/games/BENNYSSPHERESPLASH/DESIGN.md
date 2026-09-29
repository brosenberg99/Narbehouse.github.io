# Benny's Sphere Splash — design notes (working title)

An original homage to blitzball (Final Fantasy X / X-2): underwater team sport in a
floating sphere of water, full team management, nobody steers a swimmer. The match
plays itself and **freezes at every decision the rules create**; the player picks
from choices pinned to the scene. No Square Enix names, teams, players or moves.

The hub rulebook, `bennyshub/ACCESSIBILITY.md`, outranks this file.

## Status

| Milestone | State |
|---|---|
| M0 tech spike (3D stack, swimmers, on-screen choices, carry-swim) | done — `js/spike.js`, replaced in M2 |
| M1 match rules engine | done — `js/data.js`, `modes.js`, `ai.js`, `sim.js`; `tools/check-sim.cjs` green |
| M2 Quick Game, playable grey-box | next |

## How a match works (`js/sim.js`)

- **6 a side** (LF, RF, MF, LD, RD, GL), two halves of game clock (5 min, or 2 min in
  Quick Game), golden-goal overtime in cup matches. **The clock only runs during live
  play** — never while a decision is on screen, so nothing is ever on a deadline.
- **Stats** (FFX): HP, SP, EN, AT, PA, BL, SH, CA. Carrying drains HP; passes, shots and
  techniques spend it; below a quarter of max HP, PA and SH halve and techniques are off.
- **Encounter**: an opponent who gets close *and is in the carrier's path* starts one.
  - The **defense** picks a stance first: **Tackle** (full-strength tackles, but a tackler
    cannot block) or **Block** (stand in the lanes: wider, stronger blocks; tackles at half).
  - The **carrier** then picks Pass / Shoot / Dribble (with techniques) **blind to the
    stance**; its odds are computed against how those defenders usually play
    (`ai.stanceMix`). That is the guessing game.
- **Pass / shot**: strength = rolled PA/SH, minus distance decay, minus each blocker in the
  lane (a blocker who beats what is left stops it — intercepts if clearly stronger —
  otherwise takes half their BL off it). A surviving shot meets the keeper's CA: goal, catch
  or parry. Every pass in a row makes the defense read the next one better.
- **Dribble**: each tackler's AT comes off the carrier's EN; at zero the ball is lost.
  Speed over the tacklers helps (half the SP gap is added to EN).
- **Shot chances** at 14 m (with "keep swimming") and 5 m (point blank) as well as in
  encounters.
- **Outcomes are rolled once, the moment an option is chosen, then acted out.**
  Odds shown to the player are Monte Carlo on a *separate* random stream, so looking at
  odds never changes the match. The AI chooses from the same odds (`ai.valueOf`).
- Deterministic and JSON-serialisable: same seed, same match; `snapshot()` at any
  decision and `restore()` resumes exactly.

## Decision stops (the player's control over pacing)

| Setting | Stops for the player | Per full match (measured) |
|---|---|---|
| Our ball only | every encounter, shot chance and keeper throw when we have the ball | ~50 |
| Attack and defense | the above, plus our defensive stance | more |
| Key moments | shot chances, and encounters where Shoot is at least a Fair chance | ~34 |
| Coach | none; the AI plays our decisions by the same rules | 0 |

Quick Game's short halves cut these by about 60%.

## Modes (`js/modes.js`)

Quick Game / Simple Season / Full Season are **presets of individual toggles**; every
system reads its toggle through `SS.modes.rules(season)`, never the mode name.

## Balance (measured by `node tools/check-sim.cjs`, 600 matches)

~7 goals, ~19 shots, ~47 encounters, ~32 possession changes per match; 78% of passes
complete. The two strong clubs (Harbor Stars, Mistwood Monarchs) win ~90%; the rest win
16-36%; the Bayside Beamers (the player's underdogs) win about a quarter. Picking good odds
clearly beats picking bad ones.

Tuning history worth keeping (each was a real failure the checks caught):
- Encounters re-fired the moment a cooldown ended because chasers out-swam the carrier →
  new carriers get a grace period, and only a defender **in the path** can engage.
- Blocking defenders stopped every pass regardless of direction → block stance widens and
  strengthens *lane* blocks; it does not block passes away from you.
- A single technique decided matches (Spin Shot / Super Save; see `tools/ablate.cjs`) →
  technique bonuses are 60% of FFX's, and the shot-vs-keeper roll is deliberately wide.
- Carriers circled the goal because they steered away from the keeper → they no longer
  do, and bend less the nearer the goal gets.

## Assets

Swimmers: Quaternius Universal Base Characters + Universal Animation Library (CC0),
bundled by `tools/build/prep-models.mjs` into `js/model-data.js` (base64 GLB, textures
stripped, toon colours painted by bone). Custom motion is layered on the clips in
`js/rig.js` (world-space two-bone IK; the carry-swim is the first user). Three.js r155
(the hub's copy) plus GLTFLoader/SkeletonUtils from three@0.155.0, bundled by
`tools/build/bundle-addons.mjs`.
