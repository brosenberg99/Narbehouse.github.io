# Ben's Burger Bar — design notes (for review before any code)

An original cooking simulation in a 3D cartoon diner. Talking customers order at the
counter, and the player makes every item by hand: grill the patty, flip it, stack the
burger, fry, pour and serve. Tips buy new recipes, upgrades and decorations. The
inspiration is the hands-on, slightly silly feel of job and shop simulators. This game
copies no names, art, characters or mechanics from any of them.

The hub rulebook, `bennyshub/ACCESSIBILITY.md`, outranks this file. Where the two
disagree, this file is wrong.

## Status

| Milestone | State |
|---|---|
| M0 design doc + rules engine | **this document — waiting on review by Bryan and Ari** |
| M1 greybox scan flow (grill, board, counter) | not started; starts after review |
| M2 every station, greybox | not started |
| M3 art | not started |
| M4 voices and sound | not started |
| M5 progression + Free Cook | not started |
| M6 ship (unlisted, direct link only) | not started |

**Needs Ari's sign-off before M1:** the optional "Cooks on Its Own" setting (see
[Cooking on its own](#cooking-on-its-own-opt-in)). It is the one place this game runs a
world clock under a CHOICE scan. Every other question is in
[Open questions](#open-questions).

## What the player sees

**Main menu:** Start Shift · Free Cook · My Diner · How to Play · Settings · Exit Game.

### A shift

1. A customer walks up to the counter and says their order out loud. A large picture
   ticket appears, with a word under every picture. Example: "Evening! Bacon
   cheeseburger, well done, hold the onions, and a large lemonade."
2. The player goes from station to station and makes each item.
3. **Serve.** The customer reacts with a voiced line and an animation. The order earns
   1 to 3 stars and a tip. There is no zero and no fail: it is always food, and odd
   food gets a funny line instead of a penalty.
4. After a set number of customers (Shift Length), a results card shows the tips and the
   best orders. The player can then go to My Diner or start another shift.

A shift can be left at any time from Pause. It is saved as it goes, and Start Shift
offers **Continue Shift** when one is in progress.

### The stations

| Station | What the player does |
|---|---|
| Grill | New patty or bacon → Cook until… (Rare / Medium / Well Done / Extra Crispy) → Flip → cook the other side → Send to Board |
| Board | Bottom bun → patty → cheese → lettuce, tomato, pickles, onion → ketchup, mustard, mayo (Dab / Line / Lots) → top bun. The order of the stack counts |
| Fryer | Fries or onion rings → Fry until… (Golden / Crispy / Extra Crispy) → Shake the basket → Salt → Send to Tray |
| Griddle | Pour batter (Small / Medium / Large) → Cook → Flip → Stack → Butter, syrup. Also grilled cheese: bread, cheese, bread, cook, flip |
| Shake Bar | Flavour → Scoops (1 / 2 / 3) → Milk (Splash / Some / Lots) → Blend → Pour → Whipped cream, cherry, sprinkles |
| Drinks | Cup (Small / Medium / Large) → Ice (None / Some / Lots) → Flavour → Fill to (Half / Full / To the Top) |
| Counter | Check the tray (spoken list of what is on it) → Serve |

Every station is playable in the first release.

### Food never burns

Cooking moves through named stages and stops at the last one, which is never a failure:

| Food | Stages (the last is the cap) |
|---|---|
| Patty, each side | Raw → Rare → Medium → Well Done → Extra Crispy |
| Bacon | Raw → Chewy → Crispy → Extra Crispy |
| Fries, onion rings | Raw → Golden → Crispy → Extra Crispy |
| Pancake, grilled cheese, each side | Raw → Golden → Brown → Extra Crispy |

A patty has two sides, and each side is cooked and scored on its own. It is described
both ways: "Patty 1, top rare, bottom medium."

### My Diner (between shifts)

Coins only go down when the player buys something, and nothing is ever required to
keep playing.

- **Menu:** new recipes and ingredients.
- **Upgrades:** a second and third grill spot, a bigger fryer basket, a fancy blender, a
  second griddle spot. Upgrades add room or flair, **never speed**: nothing in this game
  rewards being quick.
- **Decorate:** neon sign, wall paint, floor, booths, counter stools, jukebox songs. Every
  change shows in the 3D diner.

### Free Cook

Every ingredient and every station, with no tickets and no tips. The player can build a
twelve-patty tower or a pancake cheeseburger. **Feed Someone** picks a customer to taste
it, and they react ("…is that a cherry on a burger?"). Free Cook never changes coins or
progress.

### Writing tone

The customers are funny and a bit absurd, written for adults (ACCESSIBILITY §1). No
baby talk, no "great job!" after every press, no talking down. The joke is usually on the
customer, never on the player.

## Recipes

Starting prices are in coins and will be tuned in M5. "Starter" means unlocked from the
first shift.

| Recipe | Stations | Unlock | Price |
|---|---|---|---|
| Hamburger | Grill, Board | Starter | 6 |
| Cheeseburger | Grill, Board | Starter | 7 |
| Fries | Fryer | Starter | 3 |
| Fountain drink (cola, lemon-lime, orange) | Drinks | Starter | 2 |
| Bacon Cheeseburger | Grill, Board | 40 | 9 |
| Double Cheeseburger | Grill, Board | 60 | 10 |
| Onion Rings | Fryer | 40 | 4 |
| Lemonade and iced tea | Drinks | 30 | 3 |
| Milkshake (chocolate, vanilla, strawberry) | Shake Bar | 60 | 5 |
| Grilled Cheese | Griddle | 50 | 5 |
| Pancake Stack | Griddle | 80 | 6 |
| Breakfast Plate (pancakes + bacon) | Griddle, Grill | 100 | 9 |
| Root Beer Float | Drinks, Shake Bar | 80 | 5 |
| More shake flavours (banana, cookies and cream, mint chip) | Shake Bar | 50 each | 5 |
| The Diner Tower (triple, bacon, everything) | Grill, Board | 150 | 14 |

Every recipe is plain data in the pack, so new ones need no code. An order is one to
three items, chosen from unlocked recipes to match the **Orders** setting.

## The regulars

Each regular has a look, a voice, favourites and one quirk. Hidden favourites can only
add to a score, never take away. Voices are made in Voice Studio in M4; the descriptions
below are starting points.

| Customer | Who they are | Usually orders | Quirk |
|---|---|---|---|
| Marge | Retired school-bus driver, cardigan, reading glasses on a chain. Warm, unhurried voice | "The usual, hon": cheeseburger, medium, iced tea | Says "the usual" and expects the player to know. The ticket shows it anyway |
| Dale | Wiry mechanic in grease-spotted overalls. Gravelly drawl | Anything, extra crispy | Delighted by anything at the cap. The one customer who scores extra crispy higher |
| Priya | Night-shift nurse in scrubs, coffee-deprived. Dry, quick voice | Pancakes at any hour | Orders breakfast at dinner time and refuses to discuss it |
| Coach Bev | Whistle, tracksuit, clipboard. Booming voice | Double bacon cheeseburger | Counts the pickles out loud on serve |
| Professor Oakes | Tweed jacket, bow tie. Precise, plummy voice | Grilled cheese, lemonade | Hates onions, with a one-line reason that changes each visit |
| Gus | Long-haul trucker, huge beard, trucker cap. Low, friendly rumble | Two of everything | Biggest orders, biggest tips. Never in a hurry |
| Reginald | Self-declared food critic, scarf in all weather. Theatrical voice | Whatever is newest on the menu | Reviews every order like a five-course meal: "A bold choice of pickle placement." |
| Tasha | Teenage skateboarder, deeply unimpressed. Flat voice | Milkshakes | Pretends not to care, cheers quietly on a 3-star shake |

More regulars can be added as data. Any regular can be replaced with a voice-free
captioned customer with no other changes.

### Silly-food reactions

Odd food never scores below 1 star, and gets its own line. Some examples:

| What happened | Reaction |
|---|---|
| Burger stacked upside down | "An upside-down burger. Bold. I respect it." |
| Every side extra crispy | Dale: "Now *that* is how you cook a burger." Everyone else: "…crunchy." |
| Cherry on a burger | "Is that a cherry? On a burger?" |
| No bun | "So it's a… patty salad." |
| Pancakes as burger buns | "Breakfast and lunch at the same time. Efficient." |
| An empty cup | "Ah. A cup of air. Very refreshing." |
| Twelve patties (Free Cook) | "I'm going to need a bigger mouth." |

## How the 3D works

- Each station has a fixed, close-up camera with big, chunky food. Moving between
  stations glides the camera; with Motion Reduced it cuts.
- The scan highlight is a thick bracket frame around the real 3D object, at least 64 px
  on screen, with its choices on large plates beside it (the Sphere Splash
  `worldui` pattern).
- Doneness, sauces and flavours always show a **word plus a shape or mark**: grill lines
  and char flecks for doneness, pip counts for amounts, a printed label on each sauce
  bottle and shake cup. Colour is never the only signal.
- High Contrast theme is supported, and Graphics Quality follows the Hub (see
  [Graphics quality](#graphics-quality)).

## Controls and scanning

### Contexts (ACCESSIBILITY §4)

| Context | What is on screen | Classification |
|---|---|---|
| card | Main menu, Settings, Pause, My Diner, results, confirmations | CHOICE |
| station | The station scene and its items | CHOICE (see the clock question below) |
| mech | One Hold and Let Go pour or squeeze, while held | MECHANIC |
| playout | A short animation of an outcome already applied (a flip, a pour, a serve) | Not scanned; under one second, then the scan resumes on the same row |

All the rules of §4 apply: the root opens on the blank -1, every row is entered with
`enterGroup(children, {wrap:true, backStop:true})` and has no visible Back buttons,
choices act on release, and Parking, Loops, Space Brake and Wait for Speech live only in
Hub Settings.

### A station's scan

Each station's root is a list of what is there right now, then the standard items.
The grill, for example:

1. -1 (blank)
2. Each object on the grill, read with its state: "Patty 1, top medium, bottom rare". It
   opens a row: Flip · Cook Until… · Send to Board · Take · Bin It
3. New Patty · New Bacon
4. Put Down (only while holding something)
5. Ticket: speaks the order again. The highlight stays on Ticket
6. Go To…: a row of stations, each with a short status ("Fryer, fries golden")
7. Pause (always last)

Rules the menu builder keeps:

- **Stable ids:** `obj:<uid>`, `bin:<id>`, `verb:<verb>:<option>`, `go:<station>`,
  `ticket`, `pause`. Redraws keep the highlight on the same id, never the same index.
- **Labels are live,** so what is spoken is always the current state.
- **After a choice, the scan returns to the row it came from.** Cooking a patty and then
  flipping it is two choices in a row, with no scanning back up. If the object is gone
  (sent, binned), the scan clears to -1.
- **Moving to another station opens it fresh on -1.** Whatever the player is holding
  goes with them.

### Pause

Pause is the last item on every station root and on every card that is not itself
Pause. Pause holds the standard items (ACCESSIBILITY §7): Continue · Restart Shift ·
Settings · Main Menu · Exit Game. A hold-Enter shortcut also opens Pause, except during a
Hold and Let Go pour, where the hold *is* the control. A pour ends on release, and Pause
is reachable again right after.

### Picking an amount or holding (Pouring and Squeezing setting)

- **Pick an Amount** (default): sauce, batter, milk and drink fills are a row of named
  amounts (Dab / Line / Lots; Half / Full / To the Top).
- **Hold and Let Go:** selecting a pour starts the mech context. Holding Enter pours; a
  large gauge shows the same named marks. Letting go stops the pour and the amount is
  read out. A hold past the top mark stops at the top: nothing overflows. Space does
  nothing during a pour.

Both forms end in the same rule that changes the food, so they always give the same
result for the same amount. Tests check this.

### How many presses

The press count per order is measured by the M0 planner bot and judged in the M1
playtest. A rough estimate for a cheeseburger with Cooking: Waits for You and Pick an
Amount: about **8 choices on the grill, 7 on the board and 3 to serve**, plus the
scanning between them. If that is too many, the first things to try are:

- **Order Helper: Guide** marks the next needed step with a star and says "next" (no
  reordering, so the scan stays predictable).
- **Orders: Simple** keeps orders to one burger with up to two toppings.

## Cooking on its own (opt-in)

**This section needs Ari's sign-off.**

The setting **Cooking: Waits for You / Cooks on Its Own** defaults to **Waits for You.**

- **Waits for You:** food cooks only when the player chooses Cook Until…, and goes
  straight to the chosen stage. Nothing in the world moves while the player is not
  pressing. Every screen is a pure CHOICE.
- **Cooks on Its Own:** food on the grill, fryer and griddle keeps cooking at the chosen
  Cooking Speed, the way a real kitchen does. Cook Until… still exists and stops the food
  at a chosen stage.

With Cooks on Its Own, food changes while the player is not pressing. By the §4 test
("If Ben stops pressing, does anything in the game keep happening?") the station screen
is then a MECHANIC. The proposal is to keep it a **CHOICE scan over a slowly changing
world**, under these rules:

- **The clock never touches the scan.** It never moves the highlight, never adds or
  removes items and never switches contexts. Only labels change ("Patty 1, top rare" →
  "top medium"), and a redraw keeps the same id highlighted.
- **It only speaks into silence,** and only about a stage that matters to an open
  ticket: "Patty 1 is medium on the bottom." It never cuts off a scan label or takes the
  speech ticket away from the scanner.
- **It freezes** whenever the scan is parked, the Space Brake is holding, any card
  (Pause, Settings, results) is open, the window is hidden or loses focus, or a Hold and
  Let Go pour is running.
- **There is no deadline.** Customers never leave. Food left too long stops at the cap,
  and the worst a forgotten patty can cost is one star on that check.
- **Waiting is never scored,** in either setting.
- **Cooking Speed defaults to Very Slow** (starting values: Very Slow ≈ 40 s per stage,
  Slow ≈ 25 s, Normal ≈ 12 s; tuned in M2). The speed setting is shown but disabled while
  Cooking is set to Waits for You.

If Ari decides this should not ship, the game still works fully without it. Cooks on Its
Own would be removed and Waits for You would be the only mode.

## Settings

In the canonical order (ACCESSIBILITY §7), reachable from the main menu and from Pause.
Labels say what changes, not who it is for.

| # | Setting | Values (default first) |
|---|---|---|
| 1 | Text to Speech | On / Off |
| 2 | Voice | cycles available voices |
| 3 | Cooking | Waits for You / Cooks on Its Own |
| 4 | Cooking Speed | Very Slow / Slow / Normal (disabled while Cooking waits) |
| 5 | Pouring and Squeezing | Pick an Amount / Hold and Let Go |
| 6 | Customers at Once | 1 / 2 / 3 |
| 7 | Shift Length | 5 / 3 / 8 customers |
| 8 | Orders | Usual / Simple / Fancy |
| 9 | Order Helper | Off / Hints / Guide |
| 10 | Customer Voices | Voices and Captions / Captions Only / Off |
| 11 | Colour Profile | Standard / High Contrast |
| 12 | Motion | Full / Reduced |
| 13 | Text Size | Normal / Large / Extra Large |
| 14 | Graphics Quality | Use Hub Setting / High / Standard / Low |
| 15 | Auto Scan | Off — Two Switches / On — One Switch |
| 16 | Scan Speed | 1 s to 5 s; default 2 s |
| 17 | Sound Effects | On / Off |
| 18 | Music | On / Off |
| 19 | Reset Progress | two-step confirm |
| 20 | Back | |

- **Customers at Once** above 1 turns Ticket into a Tickets row, one item per customer.
- **Order Helper: Hints** adds what the order still needs to the Ticket item's speech.
  **Guide** also marks the next step with a star.
- **Customer Voices** controls recorded voices only. Scan speech always follows Text to
  Speech.

## Scoring

Each item is checked against its ticket. Every check scores between 0.4 and 1, so a
mistake lowers a score but never zeroes it.

| Check | Full marks | One step off | Further off |
|---|---|---|---|
| Right items on the tray | 1 | — | 0.4 per missing item |
| Doneness (per side, per food) | 1 | 0.7 | 0.4 |
| Toppings present or held | 1 | 0.7 per mistake | floor 0.4 |
| Stack order | 1 | 0.8 | 0.5 |
| Sauce, fill and scoop amounts | 1 | 0.7 | 0.4 |
| Drink size, ice and flavour | 1 | 0.6 | 0.4 |

The order's quality *q* is the average of its checks. Stars: 3 if *q* ≥ 0.9, 2 if
*q* ≥ 0.6, otherwise 1. Tip = price × (0.6 + 0.2 × stars), at least 1 coin. A customer's
hidden favourite (Dale's extra crispy, Coach Bev's extra pickles) can add to *q*, never
lower it. Time is never part of the score.

## Saves

Saved to `localStorage` as things happen, with the same pattern as Sphere Splash
(`js/save.js`).

| Key | Holds |
|---|---|
| `bb-settings` | the settings above |
| `bb-progress:diner` | coins, unlocks, upgrades, decor, best orders |
| `bb-shift:diner` | the shift in progress, so it can be continued |

Each holds `{v, pack, packVersion, …}`. Older saves are upgraded step by step. A save
from a newer version is never overwritten. If the pack has changed since the save, only
the shift in progress is dropped; coins and unlocks are kept.

## How it is built

### Three layers (Chasing Rainbows' structure, Sphere Splash's 3D)

1. **Rules, in `js/core/`.** No DOM, no THREE, no timers, seeded random numbers. The
   modules also load under Node, so every rule is tested without a browser. Modules:
   `rng`, `schema`, `items`, `verbs`, `kitchen`, `planner`, `orders`, `scoring`, `shift`,
   `progress`, `menus`, `words`, `savefmt`.
   - `K.create(pack, seed)`, `K.apply(state, action) → events`,
     `K.tick(state, dt) → events`, `M.station(state, id, settings) → scan tree`.
2. **The diner, as data, in `packs/diner/pack.js`.** Stage sets, ingredients (what they do
   comes from their *traits*), stations, recipes, customers, silly rules, decor and
   unlocks.
3. **Presentation, in `js/`.** Rendering, camera, world-pinned highlight, cards, audio and
   voice. The renderer, toon materials, outlines and Graphics Quality code are copied from
   NARBE Racer (`NARBEKART`); characters, `worldui`, the card engine, themes, audio and
   voice lines from Sphere Splash. There is no shared 3D library to import from.

### One framework for every station

- **Verbs** are written once: `take`, `place`, `portion`, `cook`, `flip`, `chop`, `pour`,
  `squeeze`, `mix`, `top`, `send`, `serve`, `discard`. A verb decides what it applies to
  by traits ("cookable", "two-sided", "pourable"), never by ingredient name.
- **A station is configuration:** its camera, its slots (grill, oil, griddle, blender),
  its bins, which verbs it allows, where it sends food, and which slots an upgrade adds.
- **A new restaurant is a new pack.** A pizzeria, food truck or bakery needs new data,
  art and voice lines, and no rules or scan code. A small test-only pizzeria pack proves
  this from M0.

### Graphics quality

Follows `docs/development/GRAPHICS-QUALITY.md`, which is authoritative.

- Load `shared/platform.js`, then `shared/graphics-quality.js`, before any renderer code.
  Open the game with the stable id `bensburgerbar` and wait for `ready` before creating
  the renderer.
- The setting is item 14, with the stable id `graphics-quality`, cycling Use Hub
  Setting / High / Standard / Low. High is the Hub default and never lowers itself.
- **High:** full detail, pixel ratio capped at 2, no automatic lowering.
- **Standard:** the same as High. This game has no older adaptive behaviour to preserve.
- **Low:** shadows off, antialiasing off at launch, renderer capped at 1280 × 720,
  simpler diner background props. Food, doneness marks, customer outlines, the scan frame
  and all text stay the same. Low never changes rules, timing, input or random results.

### Offline

Follows `docs/development/OFFLINE-LIBRARY.md`. The game must play fully offline once the
Hub library is downloaded.

- Every dependency is local and pinned: Three.js in `js/vendor/` with its licence (as
  Sphere Splash and NARBE Racer do), fonts, models, textures, sound and recorded voices.
  No CDN links.
- The Hub's offline library picks up every public file under `bennyshub/` automatically,
  so the unlisted release is downloaded too. Do not edit the service worker's shell list.
- Regenerate `bennyshub/offline-manifest.json` (`node scripts/offline-manifest.cjs`) and
  commit it with every source change. This document is Markdown, so it is not published
  and does not change the manifest.
- Text to speech uses the device's own voices, so offline speech depends on what is
  installed. Recorded customer voices are bundled files and always work offline.

### Files

```
BENSBURGERBAR/
  DESIGN.md                this file
  index.html
  js/core/*.js             rules (Node-testable)
  js/*.js                  presentation
  js/vendor/               pinned Three.js and its licence
  packs/diner/pack.js      the diner's data
  packs/test-pizza/        test-only proof pack
  content/voice-lines.json customer lines (M4)
  tests/*.test.cjs
  tools/                   asset and voice build scripts
```

Generated reference images and working art go to `D:\Projects\Assets\BurgerBar\`, outside
the repo.

## Milestones (riskiest first; the player tries it early)

| M | What gets built | Done when |
|---|---|---|
| M0 | This document; rules modules; the whole diner pack as data; planner bot; test pizzeria pack | Node tests pass: pick and hold give the same result, food stops at the cap, the pack checks out, the planner can finish every recipe, the pizza pack needs no rules changes, press counts per recipe are within budget, a shift saves and restores exactly |
| M1 | Box-art kitchen; grill, board and counter; one text-to-speech customer; Ticket, Go To, Pause, Settings, Exit | Menu tests (stable ids, -1, `enterGroup` only, Back restores the row); a headless Chrome run that makes a burger with real key events, two-switch and one-switch. **The player tries it:** how many presses per burger, and is it fun? |
| M2 | Fryer, griddle, shake bar, drinks; Cooks on Its Own and its freeze rules (if approved); Hold and Let Go; orders, scoring, shifts, saves | Scoring, order, shift, save and clock-freeze tests; 500 bot shifts per settings combination all finish with every order at 1 star or more. Second playtest |
| M3 | Cel-shaded diner, chunky food with doneness marks, toon customers, world-pinned badges, camera moves, High Contrast, Motion Reduced, Graphics Quality | Draw-call budget; doneness readable in High Contrast without colour; the new-game checklist in `GRAPHICS-QUALITY.md` (Hub inheritance, override, reset, live change, all four modes readable); frame times measured on a typical player tablet, aiming for a steady 30 FPS or better |
| M4 | Customer voice lines (orders built from parts), sound effects, music | Voice and audio checks; Wait for Speech waits on recorded lines; a real-play sound check in Firefox as well as Chrome |
| M5 | My Diner shop, unlocks, decor in the world, upgrades, jukebox, silly reactions, Free Cook | Coins never go negative; every unlock is reachable; silly-rule tests |
| M6 | How to Play (`BennyTutorial`), `README-ACCESSIBLE.md`, thumbnail, development history entry | The ACCESSIBILITY §10 checklist and `docs/testing/SWITCH-ACCESS-TESTING.md`; the cold offline test in `OFFLINE-LIBRARY.md` (download the library without opening the game, disconnect, then play a shift); `npm test`, `npm run build`, `npm run audit:release` and `npm run check:pages` pass; the player goes hub → game → shift → pause → settings → hub alone with their own switch setup. The Electron app is not changed |

**The first release is unlisted:** reachable by direct link only, with no `games.json`
entry, as Chasing Rainbows was. Ari reviews it before it is listed in the hub.

## Open questions

**For Ari**

1. Can the station screen stay a CHOICE scan while Cooks on Its Own is on, under the
   rules in [Cooking on its own](#cooking-on-its-own-opt-in)? Or should that setting be
   dropped?
2. Customers at Once above 1 turns Ticket into a row. Is that acceptable, or should the
   game stay at one customer at a time?
3. Pause is a scan item on every station, with hold-Enter as a shortcut except during a
   pour. Does that match the §12 direction?
4. §1 asks whether a new game can have an editor. The pack format would allow a
   caregiver **Menu Editor** later (custom recipes, customers named after family).
   Should that be planned now, behind the standard mouse warning?

**For Bryan**

5. The title: "Ben's Burger Bar", or "Benny's Burger Bar" to match the other Benny's
   games? The folder name and the id `bensburgerbar` follow the choice. The id needs to be
   settled before M3, because graphics settings and the Hub's play history are stored
   under it.
6. Is the cast of regulars right? Are any to add, change or drop?
7. Are the default Shift Length (5 customers) and Orders (Usual) right for a first session?
