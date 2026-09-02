# Benny's Ballista

A siege game for one or two switches. You fire a giant crossbow at real 3D
castles and bring the crowns down — by a direct hit, by dropping a wall on
one, or by knocking out whatever was holding it up and letting it fall.

The game is real-time 3D and real physics, both in [`js/`](js/):
[three.js r155](https://threejs.org/) for rendering and
[Ammo.js](https://github.com/kripken/ammo.js/) (a port of Bullet Physics)
for the castles. Unlike the box2d-wasm build the 2D version of this game
used to vendor, Ammo.js here is the asm.js build, not WebAssembly-over-`fetch`
— so **this game runs fine opened directly as a `file://` page**, no server
needed, and does not carry `"needsServer": true` in `games.json`.

## Why this game exists

An artillery game normally has a sweeping aimer and a filling power bar, and
both are reaction tests: let go at the wrong instant and the shot is wasted,
which locks out the person this hub is built for.

This game keeps the sweep and the bar and takes the reaction out of them,
along the lines [`AGENTS.md`](../../../../AGENTS.md) lays out under
"Hold-to-charge and hold-to-sweep" — but it goes one step further than a
typical version of this genre: **power sets where the shot lands, never how
hard it hits.** Muzzle speed is fixed per ammunition and never touched by a
meter; the range meter only ever picks a distance, and the elevation needed
to reach it is solved automatically. There is no such thing as an
undercharged dud — an early release costs accuracy, never effect. Three
things make the meters themselves safe to fumble:

- **The aim meter turns round.** Hold Space and the yaw sweeps left and right
  at 4.5°/s. At each edge of the window it reverses and comes back, and keeps
  doing that for as long as you hold. Overshooting the angle you wanted costs
  you the wait for it to come past again, and nothing else.
- **The range meter stops at full.** It fills at 5%/s and pins itself at
  100%. Holding on too long is never worse than letting go at the perfect
  moment, because there is no perfect moment to miss. Let go early and the
  next hold picks up where the last one stopped.
- **Letting go never fires.** A release only ever *stops* a meter. Firing is
  a separate press of Return, so a switch slipping out of a hand costs
  nothing.

While a meter is moving a dotted trail of gold dots and a ground-ring
reticle show the exact arc the bolt will take and where it lands — in the
main 3D view *and* on a top-down minimap — and the game says out loud what
it is about to hit, but only once you stop moving, never while a meter is
sweeping: *"12 degrees. This shot hits the stone block. Press return to lock
it in."* Nothing is hidden, nothing is rushed, and you can sit between
presses for an hour.

Once you fire, a cinematic camera takes over completely — chasing the bolt,
cutting to a scored seat on impact, orbiting the wreckage until it settles —
and every input is blocked until it's done, so the cinematic actually gets
watched rather than raced past. **Steady Camera** (in Settings, and on
automatically under the OS's reduced-motion setting) holds one fixed pose
through all of it instead, for anyone the cuts and shake would bother.

## How to play

| Input | What it does |
|---|---|
| **Space**, held | Sweeps the aim, then charges the range. Let go to stop. |
| **Return**, short press | Stops a moving meter; otherwise locks the aim or fires the shot |
| **Return**, held 3 seconds | Back up one step, or open the menu |
| **Space**, short press | *In a scan list (ammunition, or a menu):* move to the next choice |
| **Space**, held 3 seconds | *In a scan list:* scan backwards until you let go |
| Mouse / touch | Optional. Hold a meter to move it, then press Lock or Fire. Never a drag. |

A shot goes: ammunition (once you have more than one unlocked), then **aim**,
then **range**, then Return to fire. Destroy every crown to clear the level.

Each meter takes two Return presses, never one that does both jobs: the first
stops the meter, the second commits it. That is what makes the whole thing
work on a single switch — with **Auto Scan** on, both meters run by
themselves and Return alone plays the game.

Backing out with a Return-hold, from the very first step of a shot, opens the
**menu** — Resume, Restart Level, How to Play, Settings, Exit Game — the same
one the header's Help/Settings/Exit buttons open (they just jump straight to
the screen they name; nothing there is mouse-only). Backing out from a menu
sub-screen goes back one screen at a time, same gesture. The one place it
can't be opened yet is mid-cinematic, while a shot is in flight or a castle
is still settling.

In the ammunition list the highlight passes through a blank "deadzone" step
before it wraps, same as every other list in the hub, and the list only ever
contains legal choices, so a selection can never fail.

### Select-Target aim mode

An alternative to sweeping and charging, switched on from **Settings** →
**Aim Mode**. Instead of two meters, it's one scan list of every destructible
piece in the castle (steel girders excluded — they never break) sorted
left-to-right, same reading order the sweep meter already uses. Scan to a
piece, and Return works the same two-press rhythm every meter uses — first
press **locks** it (speaks the real predicted outcome, spends nothing),
second press **fires**. A Return-hold while locked clears the lock and
resumes scanning at the same spot rather than backing out a whole stage, so
changing your mind never costs a scan position.

Locking a piece doesn't guarantee a hit on that exact piece — the trace
already speaks the real predicted outcome (something else may be in the way,
the same ambiguity sweep mode has), and the minimap marks the two separately:
an open diamond at what's highlighted, the usual crosshair at where the shot
will actually land. Switching modes mid-shot (from the Settings menu) starts
the current shot over in the new mode, the same reset a retry goes through.

## What is in a castle

| Letter | Piece | Behaviour |
|---|---|---|
| `W` | Wood beam | Breaks easily. Fire Bolts burn straight through it. |
| `S` | Stone block | Needs a hard hit. Boulders are best against it. |
| `I` | Glass pane | Shatters at a touch, but holds almost nothing up. |
| `T` | Powder keg | Fragile (low hp), no bonus. Drawn as a barrel, not a box. Explodes on death (`js/data.js`'s `KEG_BLAST`, fed through the same `applySplash()` the Powder Bomb ammo uses) — real area damage and outward knock, and a keg can chain into a neighbouring keg the same way. |
| `K` | Crown | The target. Destroy them all to win. Drawn as a faceted gem (or the baked tyrant model, once approved), not a box. |
| `Q` | Guard (spear) | A real, placed target, not the decorative pair standing beside the ballista. Worth real points — see "Scoring" below. Drawn as the baked `guard-spear` model. |
| `H` | Guard (halberd) | Same as `Q`, a different pose (`guard-halberd`) so a level can mix the two. |
| `X` | Steel girder | Never breaks and never moves. Go around it. |
| `B` | Timber board | Thin (15% of a cell) and mergeable, sitting flush on its own row's floor instead of filling the cell — for bridges, ceilings and floors. See "Boards" below. |
| `w` / `s` / `i` | Small rubble | Half-size, lighter, never welds to a neighbour — loose debris. |

**Some pieces have their own silhouette, and that is deliberate.** Two things
the player has to tell apart must differ in *shape*, not only colour — a
marking or a shade alone does not survive low vision. The keg is a barrel and
the crown is a gem for exactly that reason; as boxes they were distinguished
from wood and stone by hue alone. It matters most in the High Contrast
profile, where materials are unlit and the crown's emissive glow — its main
"look at me" cue in the other three profiles — does nothing at all.

Only materials that are **never mergeable** can have a shape, because a
mergeable run can be any number of cells wide and a shaped mesh cannot stretch
across it without distorting. `js/art.js`'s `blockGeometry()` is where shapes
are chosen; the physics body stays a box either way.

**A crown does not need a clear shot.** It's an ordinary physics body with hp
like everything else, so it dies the same three ways anything else does: a
direct hit, a hard landing, or a hard knock from a collapsing neighbour.
Levels are free to bury a crown behind a wall that has to come down first —
that's true by construction now, not proved by an audit sampling shots. A
level is also free to need a *sequence* of shots (break the obstruction, then
hit the now-exposed crown) — there is no boot-time check that requires a
single-shot solution, or any particular solution at all. See "Adding a level"
below.

## Scoring

- **A crown is worth a flat 500** regardless of how it dies (direct hit,
  collateral collapse, or a fall) — it always did; killing the last one still
  ends the level.
- **A guard (`Q`/`H`) is worth a flat 350** the same way, but doesn't end the
  level. An ordinary block (wood, stone, glass, a keg, rubble) is 100.
- **Killing a guard or the crown on an early bolt pays an efficiency bonus**
  on top of its flat value — `max(0, CFG.KEY_BUDGET - boltsUsed) *
  CFG.KEY_BONUS_PER_BOLT` (`js/data.js`), scored the instant it dies. A guard
  killed on bolt 1 pays more than the same guard killed on bolt 5.
- **A single shot that kills more than one guard/crown pays a combo bonus**
  (`CFG.COMBO_BONUS_PER_KILL` per extra key kill beyond the first) — a splash
  or seam hit that drops two guards together, or a guard alongside the crown,
  pays out for both individually AND the combo. This is tracked per-shot
  (`shotKeyKills`, reset in `fire()`) and paid out incrementally inside
  `destroyBlockRec()` as each kill happens, not deferred to when the shot's
  cinematic finishes — a shot that ends the level (killing the crown itself)
  has to already reflect it, since `finishLevel()` reads the level's score
  the instant `checkWin()` sees the last crown die.
- All of the above stacks with (and is separate from) the existing "bolts
  remaining at the win" bonus, which only ever looks at the final total.

## Physics

Every piece of every castle is a real Ammo.js (Bullet) rigid body from the
moment the level loads — not a special case for "loose" pieces. That means
there is no hand-written "is this block held up?" check anywhere in the game.
A well-built castle stands because Bullet's own contact solver is
distributing weight through it via friction and normal force, exactly the
way a real stack of blocks does. Knock the right piece out and the same
solver is what makes everything that depended on it topple, slide down its
neighbours' faces, and crash into whatever is next to it — a chain reaction,
not one block quietly vanishing.

A bolt striking a piece doesn't just deal damage, either — it hands the
piece some of its own velocity, so a hit that doesn't destroy something
still knocks it loose to go tumbling. Impact damage (from a hard landing, or
one piece crashing into another) works by watching for a drop in a piece's
own speed since it last came to rest — the physics engine doesn't need to be
told when that happens, the game just notices it (`stepPhysicsWithImpacts()`
in `js/game.js`). That comparison is against the *peak* speed reached since
the last landing, evaluated once the piece actually settles, not a plain
frame-to-frame delta — Bullet's own contact resolution spreads a hard stop's
deceleration across several frames, so comparing only consecutive frames (or
resetting the moment any single frame crosses the threshold) catches just a
fragment of a real multi-unit fall and badly under-credits it.

A hard landing also hurts whatever the landing piece is now resting directly
on top of (`applyCrush()`), separately from the landing piece's own damage —
a support knocked out from under a heavy span genuinely crushes what the span
comes down on. And destroying a piece wakes whatever was resting on it
(`wakeBlocksAbove()`, backed by `js/physics.js`'s `wake()`): removing a body
from the physics world carries no collision event on its own, so without this
a sleeping piece would float in place forever with nothing left underneath
it, support or no support.

Gravity (`CFG.GRAVITY`) is set well above real-world for a 1-unit block on
purpose — that's what makes a collapse read as chunky and toy-like rather
than floaty. It's also the single number every ballistics/reachability
result depends on, so changing it means re-running the boot audits.

Debris flies harder and further than it used to (`CFG.KNOCK_SCALE` up,
`CFG.LINEAR_DAMPING`/`CFG.ANGULAR_DAMPING` down) — a direct/splash hit throws
more of its own velocity into whatever it touches, and once thrown, a piece
keeps tumbling instead of settling fast. Playtesting a guard standing right
next to a merged wall run showed just how far this reaches: one flanking
shot's knockback-then-fall can be enough on its own to bring the whole run
down, not just the piece directly hit — a real, first-pass tuning number
worth another look once it's actually played, not just watched.

**A shot doesn't just hit one thing at its impact point, either.**
`findHitBlock()` still stops a trace's *flight* at the first block it
overlaps, but every hit — direct or otherwise — also calls
`applySeamHit()` (`js/game.js`): a small, fixed radius (`CFG.SEAM_RADIUS`)
around the impact point, independent of any ammo's own splash, checked
against each block's actual (rotated) surface rather than its centre — a
wide merged wall's centre can sit cells away from the edge actually touching
whatever got hit, which would make a naive centre-to-centre check miss the
seam entirely. So a bolt landing where two parts meet, or a guard standing
flush against a wall, can take out both with one shot.

**A bolt keeps existing for up to `CFG.LINGER_MS` after its first hit**,
instead of vanishing on contact — it deflects off the surface it struck
(`CFG.LINGER_RESTITUTION`) and keeps flying under gravity, the same
deterministic step-and-trace style the rest of a shot already uses, not a
second real Ammo.js body. Each frame it checks for a NEW block it hasn't
already hit; a new hit deals damage scaled down per additional hit this same
bolt has already scored (`CFG.LINGER_DMG_DECAY`, compounding), so one bolt
can carom through a cluster of debris without bulldozing an entire
structure. The SETTLE camera phase waits out a still-lingering bolt the same
way it waits for bodies to sleep, so the cinematic never cuts away mid-carom.

Two piece sizes come out of the level parser (`js/levels.js`):

- **Merged runs.** A run of the same mergeable letter side by side in one row
  (`WWWWW`, `SSSSSSS`, …) welds into one wide rigid body, not N separate
  cells — so a wall topples and lands as a single slab. The *same* run
  repeated on the next layer back (see "Depth" below) welds through depth
  too, so a wall drawn identically on several layers is one thick slab, not
  a stack of thin plates standing shoulder to shoulder.
- **Small rubble** (`w`/`s`/`i`) is half the size of a normal block, much
  lighter, and never welds to anything. A light hit sends it flying rather
  than just damaging it in place, which is what makes it fun as loose
  debris on top of a solid structure. It's still much lighter than a full
  block, so a light hit still knocks it (and whatever's resting on it) around
  more readily — but anything drawn directly above one now rests flush on its
  real (half-height) surface rather than floating with a gap, same as a board.

### Depth

A castle is a *stack* of ASCII pictures, front layer first (nearest the
ballista), not a single flat one — see the big comment above `LEVELS` in
`js/levels.js` for the full authoring rules. Because layers sit in their own
z-slice with no vertical overlap between them, each layer has to stand on
its own; knocking down a front wall doesn't structurally support anything
behind it, only newly reveals or reaches it. Two tricks this makes possible,
both already used by the shipped levels:

- **Cladding.** Put `S` in front of a `W` (same row, same column, earlier
  layer) and the wood is armoured — reachable only by getting through the
  stone first, or a lob that clears the front layer entirely.
- **A hidden crown.** A solid front layer can hide a back layer's crown from
  a flat shot completely — see "What is in a castle" above for why that's a
  legitimate level design now rather than a broken one.

### Boards

`B` (timber board) is the one material that doesn't fill its whole cell — it
sits flush on its own row's floor, claiming only the bottom 15% of the row's
vertical budget (`PLANK_FRAC` in `js/levels.js`), so a run of it can bridge a
gap with nothing but open air underneath. It's still mergeable and still just
a plain box (`js/art.js`'s `blockGeometry()` fallthrough — a board only needs
a different *proportion*, not a different *shape*, so it never sets `shape`
the way the keg/crown do), so row-merge, depth-merge and cladding all work on
it exactly like any other material.

This opens up patterns the other materials can't: a bridge spanning a gap on
two end supports with an open shaft in between (see "The Bridge"), or a roof
over a crown that a lob thuds into while a flat shot sails underneath at the
crown's own height (see "The Vaulted Hall" family).

**Drawing something directly above a board (or a small-rubble chunk) now
rests flush on its real surface**, no gap — `js/levels.js`'s `rowBottoms()`
computes each row's floor from the ACTUAL height of whatever's really below
it (a full `CELL` normally, but only `PLANK_FRAC*CELL` for a row that's
entirely board, or half a cell for one that's entirely small rubble), instead
of the old blind `(rows - row - 1) * CELL` that assumed every row was a full
cell tall. There is no longer a "never draw above a board" rule to remember —
it used to leave an ~0.85-unit gap for anything drawn there (a crown would
fail `auditLevels()`'s drift check outright), now it doesn't.

## Ammunition

You start with the Stone Bolt. Clearing levels 3, 6, 9 and 10 unlocks the
rest, in that order. Each one is better at something rather than simply
stronger, and each carries its own trajectory — flat ("direct") ammo takes
the low root of the ballistics solution, lobbed ammo the high one, so both
land on the same spot by different paths:

- **Stone Bolt** — flat and true, no bonus, unlimited.
- **Boulder** — lobs, 1.6× damage against stone, unlimited.
- **Fire Bolt** — flat, 3× damage against wood, unlimited.
- **Splitter** — lobs, lower per-hit damage, unlimited. Its in-game subtitle
  says "splits in 3", inherited from the 2D version's design — nothing in
  `js/game.js` actually spawns extra bolts yet, so that text currently
  over-promises. Worth either implementing the split or rewording the
  subtitle; flagging rather than picking one silently.
- **Powder Bomb** — lobs, moderate direct hit *plus* falloff-scaled splash
  damage to everything else nearby (see `applySplash()` in `js/game.js`) —
  **only one per level**, reset on a retry. The one ammo worth saving for
  the shot that actually needs it.

A level may also narrow this list further with its own `ammo` field (see
"Adding a level" below) — a castle can restrict itself to, say, only Stone
Bolt and Boulder, for a puzzle built specifically around what those two can
and can't do. That narrowing can never override the unlock schedule above; it
only ever removes options a level doesn't want, never grants ones the player
hasn't earned yet.

## The minimap and Settings

A top-down minimap (top-right) shows the sweep cone, every surviving crown as
its own ring marker, and a bold crosshair at exactly where the current aim
and range will land — big while you're actually composing a shot, shrinking
out of the way the instant it's locked in. **Settings** (in the menu) lets
you pick its size (Large / Medium / Off), and also holds Aim Mode, Colour
Profile, Steady Camera, Endless Bolts and Sound — see their own sections
above/below for what each does.

## Colour profiles

Four profiles — **Ben's**, **Dark**, **Light** and **High Contrast** — chosen
from Settings and remembered. They repaint the whole game, the 3D world
included, not just the UI chrome: every colour comes from a CSS custom
property in `index.html`, `js/game.js` reads them once per change into
`PALETTE_VARS`, and hands them to `js/art.js` and `js/world.js`.

**High Contrast is a different profile, not a darker skin.** It swaps the
paper-craft look for unlit, solid-fill geometry, inverts the outline ink to
white so every block still has a hard border on black, and drops distance fog
entirely — fog fades geometry toward the sky colour, which on a near-black sky
would mean a far castle losing exactly the contrast the profile exists to add.

Two things to know if you touch this:

- **A colour missing from `PALETTE_VARS` silently comes out grey.** Add it to
  all four CSS blocks *and* the array.
- **Repainting is not automatic.** A mesh keeps whatever material it was built
  with, so `onThemeChanged()` has to hand every live block and every ballista
  part a fresh one. Anything new that holds a material needs adding there, or
  it will quietly stay in the previous profile's colours.

## Sound

Every sound in this game is synthesised at runtime in `js/audio.js`. There are
no audio files, which is part of why the game opens straight from a `file://`
page with nothing to fetch and nothing to fail to load.

What you hear is meant to carry information, not just atmosphere:

- **Each material breaks differently** — wood cracks, stone grinds, glass
  shatters and tinkles, a powder keg booms, steel rings. If you cannot resolve
  the blocks visually, the sound still tells you what you just hit.
- **Volume follows force.** A glancing hit and a full-speed one are not the
  same sound, because they are not the same event.
- **Sound is positioned.** Impacts are panned to where they happened on
  screen, and the aim sweep is panned to where the ballista is pointing — so
  left and right are audible, not only visible.
- **The range meter climbs a musical ladder** rather than repeating one blip,
  so how far along the charge is comes through as pitch.
- **A collapse is summed, not stacked.** A falling castle makes dozens of
  contacts at once; only the loudest few get their own sound and the rest
  become one low rumble, which is both what a collapse actually sounds like
  and what stops it turning into static.

**Sound** in Settings turns all of this off. It does **not** affect speech —
those are separate controls on purpose, because someone playing largely by ear
may well want the narration without the crashes. The setting is shared with the
other Race Tracks-derived games under the same `rt-sound` key.

### A deliberate divergence, for whoever checks

`AGENTS.md` tells hub games to use the shared `SafeAudio` rather than the Web
Audio API, because an `AudioContext` can take down the renderer in the Electron
desktop build. This game uses Web Audio anyway, following the precedent Race
Tracks and FishMaster already set, and `js/audio.js` is defensively wrapped
throughout — a `broken` flag means any Web Audio failure degrades to silence
rather than throwing, and every call site treats sound as never load-bearing.

The reason for diverging is specific rather than aesthetic: `SafeAudio` bakes a
fixed waveform at preload time and has no panner, so it cannot express either
"scaled by force" or "positioned on screen" — the two properties that make the
list above work. `SafeAudio` stays loaded, and muting mirrors into it, so the
two systems can never disagree about whether the game is silent.

## No fail states

Running out of bolts is not a loss. You are offered the level again, or the
option to switch on **Endless Bolts**, which is **on by default** — with it
on, the bolt count only affects your star rating, never your ability to
finish. Nothing in this game can be failed by being slow, and nothing is on
a timer.

## Adding a level

Levels are entries in the `LEVELS` array in `js/levels.js` — each one or more
stacked ASCII layers (front layer first), built from the letters in "What is
in a castle" above. The bottom row of every layer sits on the ground.
[`editor.html`](editor.html) is a real mouse-driven level editor now, not just
a previewer: a sticky block palette, snap-to-attach placement, copy/paste,
a saved-assembly library, a live validation panel, an idempotent stability
test, and an ammo-availability readout, all previewed against the game's own
four colour profiles. It exports straight into `levels.js`'s format.

```js
{ name: 'The Reed Tower', par: 1, bolts: 6, dist: 24, layers: [[
  '..K..',
  '.WWW.',
  '.W.W.',
  '.W.W.',
  '.W.W.'
]] },
```

- `dist` — the castle's centre distance downrange. The range meter's window
  is derived from this plus the castle's own footprint (`castleBounds()`/
  `rangeWindow()` in `js/data.js`), so there's no dead travel at either end
  regardless of how far out a castle sits — but `dist` still has to stay
  inside every relevant ammo's `maxRange(speed)`, or `auditAmmoOffers()`
  below will warn about it (loudly, in the console, though it won't block a
  boot). As a rough guide, the 16 shipped levels sit between 24 and 29; a
  level several layers deep that needs a lob to clear its front wall has
  noticeably less real reach than that number suggests, since the lob still
  has to clear the *same* absolute distance ceiling.
- `par` — the bolt count worth three stars.
- `bolts` — the limit when Endless Bolts is switched off.
- `layers` — front to back. A crown or a support can live on any layer; see
  "Depth" above for what that buys.
- `ammo` — **optional.** An array of `js/data.js`'s `AMMO` ids (e.g.
  `['stone', 'fire']`) restricting which ammo this level offers. It
  **narrows the unlocked set, never grants** — an early level can never hand
  out the Powder Bomb just by listing it, and if the intersection with what
  the player has actually unlocked comes out empty, the game falls back to
  the full unlocked set and warns once in the console rather than presenting
  zero ammo. Displayed in `AMMO`'s own canonical order regardless of the
  array's order (the ammo lane is a scan list; a chip's position is
  something a switch-scanning player learns, and it must not move between
  levels). An unknown id is a boot-time error (see below) — a typo here gets
  caught immediately, not discovered by a confused playtester. Omit the
  field entirely for "no restriction", which is every shipped level today.

Two things to check after drawing one:

1. **It must stand up** (`auditLevels()`, a boot-time assertion in
   `js/game.js`, throws on failure) — build it, step a few seconds of
   physics, and confirm no crown drifted, none was destroyed by collateral
   damage, and nothing is still awake. If it collapses the moment the level
   loads, it genuinely wasn't standing on its own: check that every piece
   sits on the ground or on something wide enough underneath it, and mind
   the small-rubble caveat under Physics above (a beam with only rubble for
   legs can sag and fall). `editor.html`'s stability test runs the identical
   check, idempotently, without needing to touch the shipped `LEVELS` array
   first.
2. **Ammo range is sanity-checked, not required** (`auditAmmoOffers()`, pure
   arithmetic against `maxRange()`/`minRange()`, warn-only, never throws) —
   if none of a level's offered ammo can physically reach it at all, or an
   offered flat ammo's own minimum range overshoots the whole castle, that
   prints a `console.error` naming the level; a narrower issue (an ammo that
   can't reach the castle's back face, or can't reach the top of the meter)
   prints a `console.warn` or nothing at all. This deliberately does **not**
   ask whether a crown is reachable or solvable — a crown never needs a
   clear shot (see "What is in a castle" above) and a level is free to need
   a sequence of shots, so there is no audit trying to prove single-shot
   solvability by sampling. `editor.html` surfaces the same report live,
   under the ammo selector, while you're still drawing.

One thing that **does** throw, immediately, and is meant to (`auditLevelData()`,
pure data validation, no physics): an `ammo` field that isn't an array, is
empty, or lists an id that doesn't match anything in `js/data.js`'s `AMMO`.
That class of mistake — a static, save-independent typo with no tuning to get
wrong — is exactly what this codebase's own history says should fail loudly
at boot rather than silently doing the wrong thing at runtime.

All three checks run on every boot, against every level, before the title
resolves — a throwing failure surfaces as a loud error on screen rather than
a silent hang; a warn-only one just prints and lets the boot continue.
`RT.game.__test` exposes `auditLevels`, `auditLevelData`, `auditAmmoOffers`,
`availableAmmo`/`availableAmmoAt` (what a given level actually offers), and
`unlockedAmmo` (progression alone, module-private otherwise — see the
`availableAmmo()` comment in `js/game.js` for why the two are kept
deliberately separate).

## Notes for whoever edits this next

- The whole thing is split across `js/`: `data.js` (tunables, ammo,
  materials, ballistics), `levels.js` (level data + the ASCII parser),
  `physics.js` (the Ammo.js adapter), `art.js` (the paper-craft models),
  `world.js` (sky/ground/lights), `audio.js` (all sound, synthesised),
  `game.js` (camera director, shot pipeline, save/progress, boot audits),
  `ui.js` (input, meters, minimap, the menu). `main.js` is the whole
  bootstrap and frame loop.
- **The four status pills across the top are live now.** `#pLevel`,
  `#pCrowns`, `#pBolts` and `#pScore` existed as markup from the step-2
  rewrite and nothing ever wrote to them, so they permanently read "Level 1 /
  Crowns 0 / Bolts 0 / Score 0" no matter what was happening. `updateStatus()`
  in `js/ui.js` fills them from `tick()`. Worth remembering as a shape of bug:
  a large, prominent indicator that always shows a plausible value is harder
  to notice than a missing one, and worse than either.
- **Anything that destroys or settles blocks in bulk must be silent.**
  `auditLevels()` stands sixteen castles up on every boot; without a guard
  that is a burst of noise before the player has touched anything. It sets
  `game.js`'s `auditing` flag around itself, so calling it from the console
  is as quiet as booting is. If you add another bulk-simulation path, it
  needs the same treatment — the guard belongs on the thing making the
  noise, not on one caller. (A second boot audit, `auditReach()`, used to
  fire real test shots to prove crown reachability by sampling; it was
  removed — see `js/game.js`'s header comment — in favour of
  `auditAmmoOffers()`'s pure arithmetic, which needs no such guard because
  it never touches physics or `save` at all.)
- **Power sets range, never force** — see "Why this game exists" above. If
  you add a new ammunition or mechanic, keep this rule; it's the strongest
  form of the hub's "letting go early must be harmless" principle and it's
  why elevation isn't a second meter.
- Ammo.js's module factory resolves via a hand-rolled `.then()` with no
  `.catch` and a single argument only — `await`-ing the raw factory hangs
  the page outright. `js/physics.js` wraps it in a real `Promise`; don't
  `await` `Ammo()` directly anywhere else.
- A "rebuild this level" function needs the exact same teardown discipline
  as the "destroy this one thing" function it sits next to. `clearBlocks()`
  in `game.js` removes every mesh from the scene and disposes its geometry
  for exactly this reason — skipping that leaked draw calls forever the
  first time levels could actually be swapped.
- Nothing is spoken while a meter moves. Everything the player is told about
  a shot comes from `stopAim()`/`stopCharge()` in `ui.js`, on release, using
  the same `traceShot()` the real shot fires with — "the dots never lie"
  because there's only one function that can lie.
- `Space` means "scan backwards" in a list and "move the meter" in the aim
  and range stages. `meterStage()`/`inScanList()` in `ui.js` are what keep
  those apart; don't let the two paths merge. The same file's `overlayPhase()`
  treats the menu's item list as one more list to scan, for free.
- `RT.game.CAM.phase` is the one source of truth for what's on screen —
  `ATTRACT` / `AIM` / `FLIGHT` / `IMPACT` / `SETTLE` / `RESULTS` /
  `RESULTS_MENU` / `OUTOFBOLTS` / `MENU`. `ui.js`'s `canAct()`/`overlayPhase()`
  gate every input entry point against it; add a phase there before adding
  one in `game.js`, not after.
- Progress, stars, and settings (minimap size, Steady Camera, Endless Bolts)
  live in one object under `RT.util`'s `rt-ballista` save key — see
  `defaultSave()` in `game.js`. `runBootAudits()` snapshots and restores this
  around `auditLevels()` — **this guard is still required with `auditReach()`
  gone, not a leftover from it.** `auditLevels()`'s own settling can
  legitimately kill a level's only crown via collateral/fall damage, tripping
  `checkWin()` → `finishLevel()` → a real save mutation. Do not remove this
  guard on the reasoning that "the thing that used to fire test shots is
  gone" — that reasoning is exactly backwards; see `runBootAudits()`'s own
  comment in `game.js` for the full call chain.

## Third-party code

`js/three.min.js` is vendored unmodified from [three.js](https://threejs.org/)
r155 (MIT licence). `js/ammo.js` is vendored unmodified from
[ammo.js](https://github.com/kripken/ammo.js/) (zlib licence), a port of
[Bullet Physics](https://pybullet.org/) to JavaScript. Don't hand-edit
either; pull a fresh build from upstream if either needs updating.
