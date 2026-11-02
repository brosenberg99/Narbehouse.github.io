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
| M0 design doc + rules engine | design reviewed by Bryan and Ari (2026-11-01); rules engine built 2026-11-02, 35 Node tests pass (see [M0 notes](#m0-notes)) |
| M1 greybox scan flow (grill, board, counter) | not started |
| M2 every station, greybox | not started |
| M3 art | not started |
| M4 voices and sound | not started |
| M5 progression + Free Cook | not started |
| M6 ship (unlisted, direct link only) | not started |

Ari approved the design on 2026-11-01, with changes now written in: two cooking modes
(see [Cooking modes](#cooking-modes)), two ways to pour, Mitch talking while the scan is
parked, typed names for regulars, and editors left for later. The decisions are listed
under [Decided](#decided).

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
| Grill | New patty or bacon → Cook → Flip → cook the other side → Send to Board |
| Board | Bottom bun → patty → cheese → lettuce, tomato, pickles, onion → ketchup, mustard, mayo → top bun. The order of the stack counts |
| Fryer | Fries or onion rings → Fry → Shake the basket → Salt → Send to Tray |
| Griddle | Pour batter → Cook → Flip → Stack → Butter, syrup. Also grilled cheese: bread, cheese, bread, cook, flip |
| Shake Bar | Flavour → Scoops (1 / 2 / 3) → Milk → Blend → Pour → Whipped cream, cherry, sprinkles |
| Drinks | Cup (Small / Medium / Large) → Ice → Flavour → Fill |
| Counter | Check the tray (spoken list of what is on it) → Serve |

How Cook works depends on the Cooking setting ([Cooking modes](#cooking-modes)). Sauces,
syrup, batter, milk, ice and drink fills are pours, set by the Pouring setting
([Pouring](#pouring)). Every station is playable in the first release.

### Cooking stages

Cooking moves through named stages:

| Food | Stages |
|---|---|
| Patty, each side | Raw → Blue Rare → Rare → Medium → Well Done → Extra Crispy |
| Bacon | Raw → Chewy → Crispy → Extra Crispy |
| Fries, onion rings | Raw → Golden → Crispy → Extra Crispy |
| Pancake, grilled cheese, each side | Raw → Golden → Brown → Extra Crispy |

By default, food stops at Extra Crispy and never burns. The **Burning** setting can add a
last stage, Burnt, as a challenge. Burnt food can still be served, still earns at least 1
star, and gets its own reactions.

A patty has two sides, and each side is cooked and scored on its own. It is described
both ways: "Patty 1, top rare, bottom medium."

### My Diner (between shifts)

Coins only go down when the player buys something, and nothing is ever required to
keep playing.

- **Menu:** new recipes and ingredients. Any menu item can be renamed for fun with the
  switch keyboard ("the Fried Dingus Sandwich"); the ticket and customers use the new
  name.
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

## Customers

Two kinds of customer share every shift: **regulars**, who give the diner its
personality, and **walk-ins**, who give it variety. Both follow the same rules:

- **Order size always follows the Orders setting,** whoever is ordering. A customer's
  personality changes *what* they order, never how many presses it takes.
- **The ticket always shows the whole order,** in pictures and words.
- **No customer brings a new mechanic,** changes their mind, leaves or hurries the player.
- **Snark aims at the food, never at the player.** "This bun is a crime" is fine; anything
  about the player's speed or skill is not (ACCESSIBILITY §1).
- Hidden favourites can only add to a score, never take away.

Voices are made in Voice Studio in M4. The voice descriptions below are starting points,
chosen so that no two regulars sound alike.

### The regulars

| Customer | Who they are | Voice | Usually orders | Quirk |
|---|---|---|---|---|
| Marge | Retired school-bus driver, cardigan, reading glasses on a chain | Warm, unhurried | "The usual, hon": cheeseburger, medium, iced tea | Says "the usual" and expects the player to know. The ticket shows it anyway |
| Dale | Wiry mechanic in grease-spotted overalls | Gravelly drawl | Onion rings, extra crispy, with anything | The onion-ring guy. The one customer who scores extra crispy higher |
| Priya | Night-shift nurse in scrubs, coffee-deprived | Dry, quick | Pancakes at any hour | Orders breakfast at dinner time and refuses to discuss it |
| Coach Bev | Whistle, tracksuit, clipboard | Booming | Double bacon cheeseburger | Counts the pickles out loud on serve |
| Professor Oakes | Tweed jacket, bow tie, pocket protector | Nasal, nerdy, slightly too fast | Grilled cheese, lemonade | Hates onions, with a new over-researched reason each visit |
| Gus | Long-haul trucker, huge beard, trucker cap | Low, friendly rumble | Two of one thing, a different thing each visit: "Two chocolate shakes. One for now, one for the road." | Big tips. Never in a hurry |
| Reginald | Self-declared food critic, scarf in all weather | Theatrical, sweeping | Whatever is newest on the menu | Reviews every order like a five-course meal: "A bold choice of pickle placement." |
| Tasha | Teenage skateboarder, deeply unimpressed | Flat, deadpan | Milkshakes | Pretends not to care, cheers quietly on a 3-star shake |
| Kai | Ten years old, notebook under one arm, Reginald's biggest fan | Bright, very serious | A small burger and a small drink (a short order: a breather in the shift) | Copies Reginald's reviews but gets to the point: "Ten out of ten. Needs more ketchup." |
| Vernon | Runs a burger-review blog with eleven followers; arms permanently folded | Deep, slow, droning, with heavy sighs | Very exact orders, within the Orders setting: "Cheeseburger. Medium. Mustard: a line, not a dab. I will know." | Picky and borderline rude, about the food only. A 1-star order: "I've had warmer welcomes from a vending machine." A 3-star one, after a long pause: "…Acceptable. Don't let it go to your head." He tips best of all on 3 stars and pretends he didn't |

More regulars can be added as data. Any regular can be replaced with a voice-free
captioned customer with no other changes.

### Walk-ins

Walk-ins are one-off customers built from parts, so every shift brings faces and lines
the player has not met:

- **Look:** body, outfit, hair, hat or accessory, and colours, from the same toon
  character kit as the regulars.
- **Name:** from a long list, spoken on arrival and shown on the ticket.
- **Voice:** one of a pool of walk-in voices (about eight to start), each recorded with
  the full set of order parts, so any order can be spoken. Text to speech covers anything
  missing.
- **One or two quirks:** a favourite (can only add to the score), a dislike ("no
  pickles"), a way of ordering (polite, chatty, food puns, very formal) and a way of
  reacting (cheerful, deadpan, overjoyed).
- **The order** comes from the same generator as everyone else's, from unlocked recipes.

**The mix changes as the game goes on.** Early shifts are mostly regulars, so the player
learns a few familiar faces. As the menu grows, more walk-ins appear. Every shift has at
least one regular. Starting mix for a 5-customer shift: 3 regulars and 2 walk-ins at
first, moving to 2 regulars and 3 walk-ins once six recipes are unlocked (tuned in M5).

**Other variety, none of which adds presses:**

- **Daily special:** one unlocked recipe is the special each shift, ordered more often
  and with a small tip bonus.
- **Regulars try new things:** once a new recipe is unlocked, a regular will sometimes
  order it instead of their usual, with a line about it ("Marge is feeling adventurous
  today").
- **Visitors' book:** My Diner keeps a page for every customer the player has served,
  with their best order. A walk-in served three times becomes a regular and keeps coming
  back.

### Naming a new regular

When a walk-in has been served three times, a **New Regular** card appears after that
shift's results (never in the middle of a shift). Mitch, the assistant manager, says:
"Looks like the onion-ring lady is a regular now. Want to give her a nickname?"

The card is an ordinary CHOICE card, opening on -1:

- **Four suggested names,** built from who they are: their favourite, a quirk, or a
  rhyme or alliteration with their first name ("Onion Ring Olive", "Double Shake Dana",
  "Mustard Mike"), plus one plain name.
- **More Names:** four new suggestions.
- **Spell a Name:** the switch keyboard, as Pet Pals uses for pet names: pick a row,
  then a letter, with Delete, Done and Cancel, up to 12 letters.
- **Keep "Olive":** keeps the name they came in with.
- **Later:** no name now. Any regular can be renamed from the Visitors' book at any time,
  with the same card.

Suggestions come from word lists in the pack, so they cost no extra code. Every
first name and nickname part is recorded, so Mitch and the customer can say a suggested
name in their own voices. A spelled name is spoken with text to speech. The keyboard is
copied from Pet Pals (`NARBEPETPALS/js/game.js`, `buildNames` and `pressKey`) into this
game's card engine; it is the same keyboard used to rename menu items.

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

## Mitch, the assistant manager

Mitch narrates the diner and gives hints, in the same voice as everything else: funny,
but there to help. He wears a short-sleeved shirt and tie, a headset he does not need, and
a name badge where "ASST." is a strip of tape over "MANAGER". He leans in the kitchen
doorway, and his lines show as captions beside a small portrait in a corner, never over a
scan target.

**What he does**

| When | Example |
|---|---|
| A shift starts | "Doors are open. Try not to set anything on fire." |
| Food is one stage from what the ticket asked for (Time It Yourself) | "Patty 1's nearly medium. Marge's favourite stage, I'm told." |
| Food is one stage from Extra Crispy, or from Burnt (Time It Yourself) | "That bacon is heading for crispy. Dale would be proud. Marge, less so." |
| Food reaches Extra Crispy | "Extra crispy. I'll tell Dale." |
| Food sent on that doesn't match the ticket (Pick the Doneness) | "Vernon asked for medium. That's well done. Bold move." |
| Something is missing at the counter | "Hold up, Gus wanted two shakes. I count one." |
| The first time each station is used | One short tip, once per save: "Flip it when the bottom looks right. Patties have two sides. Shocking, I know." |
| A customer reacts | Sometimes a one-liner after the customer, never instead of them |

His hints say what is happening and what the ticket wanted. They never make the choice
for the player, and they never stop or block anything.

**Rules for when he talks** (these protect the scan, ACCESSIBILITY §4):

- **Scan speech always wins.** Mitch never cuts off a scan label and never holds the
  scanner's speech ticket, so he has no effect on Wait for Speech.
- **He speaks into silence, and parked is his time.** Parking exists so the scan is not
  constant speech and the game has room to breathe, so Mitch talks while the scan is
  parked, after the "parked" announcement ends. In two-switch play he speaks between
  presses. When the scan resumes, the scan label takes over.
- **If no silence comes** within a few seconds, a heads-up turns into a caption and a
  short sound cue instead. A line that is no longer true when the silence comes (the
  patty was flipped) is dropped.
- **With Auto Scan on and Parking off,** the scan never goes quiet, so Mitch can barely be
  heard. A notice at the start of the first shift of each session says so, spoken as it
  opens: "Mitch talks while the scan is parked. To hear him, turn on parking in Hub
  Settings." Its items are OK and Don't Show Again. The game reads the Hub's parking
  setting but never changes it.
- **Priority:** heads-ups about food, then hints, then jokes. At most one joke per
  customer, and no line repeats in a shift.
- **He is silent** while Pause, Settings or any card is open, and during a Hold to Pour.
- **He never comments on how long anything took,** and never talks about the player's
  speed or skill.
- **Heads-ups never rely on Mitch alone.** The food's label changes, a badge appears on
  it and the sizzle sound changes as well. A player with Mitch off loses no information
  that the scan doesn't already give.

With Time It Yourself, Mitch's warnings are the main audio cue that food is getting
close, and parking gives a natural one-switch rhythm: park while the patty cooks, hear
"nearly medium", press to resume and flip (see [Cooking modes](#cooking-modes)).

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
| station | The station scene and its items | CHOICE; with Time It Yourself, a CHOICE scan over a slowly changing world (see [Cooking modes](#cooking-modes)) |
| mech | One Hold to Pour, while held | MECHANIC |
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
   opens a row: Flip · Cook Until… (Pick the Doneness) or Cook (Time It Yourself) ·
   Send to Board · Take · Bin It
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
Hold to Pour, where the hold *is* the control. A pour ends on release, and Pause is
reachable again right after. Pause freezes everything, in every mode: it is the real
"taking a break" button.

### Pouring

Sauces, syrup, batter, milk, ice and drink fills are pours. Every action in the game works
with single presses; holding is only ever an extra (ACCESSIBILITY §9).

- **Auto-Fill** (default): one select pours exactly what the ticket asks for. The
  amount can never be wrong, so it is never scored. In Free Cook, with no ticket, it pours
  a normal amount.
- **Hold to Pour:** selecting a pour starts the mech context. Holding Enter pours, and a
  large gauge shows a target line at the ticket's amount. Near the line the pour slows to
  a trickle, so there is time to let go (like the Shot Helper in Benny's Basketball
  Shooter). Letting go stops the pour and the amount is read out. A hold past the top
  stops at the top: nothing overflows. Space does nothing during a pour.

Cup size, scoop count and flavour are not pours. They are what the customer ordered, so
they stay ordinary choices in both modes.

### How many presses

The press count per order is measured by the M0 planner bot and judged in the M1
playtest. The design estimated about 17 choices for a cheeseburger; the bot measures
**29 with Pick the Doneness and Auto-Fill: 14 on the grill, 12 on the board and 3 to
serve**, counting every Go To and every Back stop. A "choice" is one select, so 29 is
also the one-switch press count. With two switches, the 85 highlight moves between them
are presses too.

| Recipe (as written) | Choices, Pick the Doneness | Choices, Time It Yourself | Wait at Very Slow |
|---|---|---|---|
| Fountain drink, lemonade | 13 | 13 | — |
| Fries, onion rings | 15 | 13 | 40 s |
| Milkshake | 17 | 17 | — |
| Grilled cheese | 17 | 12 | 80 s |
| Root beer float | 19 | 19 | — |
| Hamburger | 28 | 29 | 4 min |
| Cheeseburger | 29 | 30 | 4 min |
| Bacon cheeseburger | 37 | 38 | 4 min |
| Pancake stack | 43 | 34 | 2 min 40 s |
| Double cheeseburger | 44 | 46 | 4 min |
| Breakfast plate | 46 | 44 | 1 min 20 s |
| The Diner Tower | 73 | 74 | 5 min 20 s |

Where the presses go on a cheeseburger: Cook Until… is a row, so each side costs three
choices (patty, Cook Until…, Medium), and Go To costs two (Go To…, the station). Each
recipe's `budget` in the pack is its measured count rounded up to the next 5, as a guard
rail against menu changes that add presses; it is not a target. If the playtest finds it
too many, the first things to try are:

- **Next-Step Star** marks the next needed step with a star and adds "next" to its label
  (no reordering, so the scan stays predictable).
- **Orders: Simple** keeps orders to one burger with up to two toppings.
- **Flatter object rows:** put the Cook to… stages straight into the patty's row (one
  choice less per side), or open a station on the thing most likely needed next.
- **Time It Yourself at Very Slow** is about two minutes a side for a medium patty (three
  40 s stages to reach Medium). The M2 tuning should look at that first.

## Cooking modes

Approved by Ari (2026-11-01). The setting **Cooking: Pick the Doneness / Time It
Yourself** defaults to **Pick the Doneness**. Both work entirely with single presses.

- **Pick the Doneness:** the player reads the ticket and chooses Cook Until… with the
  stage it calls for. The food goes straight to that stage. Nothing in the world moves
  while the player is not pressing, and every screen is a pure CHOICE.
- **Time It Yourself:** the challenge. Pressing Cook once starts the food moving through
  its stages at the chosen Cooking Speed (blue rare through well done for a patty;
  golden through crispy for fried food). The player presses Flip to turn it and Send to
  take it off. There is no Cook Until… in this mode: choosing when to stop *is* the
  challenge.

With Time It Yourself, food changes while the player is not pressing, so by the §4 test
the world is a mechanic. Ari approved keeping the station a **CHOICE scan over a slowly
changing world**, under these rules:

- **The clock never touches the scan.** It never moves the highlight, never adds or
  removes items and never switches contexts. Only labels change ("Patty 1, top rare" →
  "top medium"), and a redraw keeps the same id highlighted.
- **The timing is very forgiving.** Cooking Speed defaults to Very Slow (starting values:
  Very Slow ≈ 40 s per stage, Slow ≈ 25 s, Normal ≈ 12 s; tuned in M2). The stage the
  ticket asks for lasts twice as long as the others, so there is a wide window to take
  the food off.
- **Warnings come early and in several forms.** Mitch says when food is one stage from
  what the ticket wants, or from Extra Crispy, under his speech rules. The food's label,
  a badge on it and the sizzle sound change as well, so nothing depends on speech alone.
- **The clock keeps running while the scan is parked or braked.** Parking is part of the
  rhythm: park while the food cooks, hear Mitch, resume and flip. Two-switch play (Auto
  Scan off) runs the same way.
- **It freezes** whenever Pause, Settings or any card is open, the window is hidden or
  loses focus, or a Hold to Pour is running.
- **There is no deadline.** Customers never leave and waiting is never scored. With
  Burning off (the default), food stops at Extra Crispy, so the worst a forgotten patty can
  cost is one star on that check.
- **Burning** is a separate challenge setting, available only with Time It Yourself. With
  it on, food left past Extra Crispy becomes Burnt. Burnt food is still served, still earns
  at least 1 star, and gets its own lines.
- **Holding is never required.** A hold could later be added as an extra (as with the
  charge kick in the football games), but every action has a single-press route.

## Settings

In the canonical order (ACCESSIBILITY §7), reachable from the main menu and from Pause.
Labels say what changes, not who it is for.

| # | Setting | Values (default first) |
|---|---|---|
| 1 | Text to Speech | On / Off |
| 2 | Voice | cycles available voices |
| 3 | Cooking | Pick the Doneness / Time It Yourself |
| 4 | Cooking Speed | Very Slow / Slow / Normal (disabled with Pick the Doneness) |
| 5 | Burning | Stops at Extra Crispy / Food Can Burn (disabled with Pick the Doneness) |
| 6 | Pouring | Auto-Fill / Hold to Pour |
| 7 | Customers at Once | 1 / 2 / 3 |
| 8 | Shift Length | 5 / 3 / 8 customers |
| 9 | Orders | Usual / Simple / Fancy |
| 10 | Assistant Manager | Hints and Jokes / Hints Only / Off |
| 11 | Next-Step Star | Off / On |
| 12 | Character Voices | Voices and Captions / Captions Only / Off |
| 13 | Colour Profile | Standard / High Contrast |
| 14 | Motion | Full / Reduced |
| 15 | Text Size | Normal / Large / Extra Large |
| 16 | Graphics Quality | Use Hub Setting / High / Standard / Low |
| 17 | Auto Scan | Off — Two Switches / On — One Switch |
| 18 | Scan Speed | 1 s to 5 s; default 2 s |
| 19 | Sound Effects | On / Off |
| 20 | Music | On / Off |
| 21 | Reset Progress | two-step confirm |
| 22 | Back | |

- **Customers at Once** above 1 turns Ticket into a Tickets row, one item per customer.
  The player sets it themselves. A day that builds from quiet hours to a rush hour is
  planned for later ([Later](#later)).
- **Assistant Manager:** Hints Only keeps Mitch's heads-ups and hints and drops his jokes.
  Hints also adds what the order still needs to the Ticket item's speech.
- **Character Voices** controls the recorded voices of customers and Mitch. Scan speech
  always follows Text to Speech.

## Scoring

Each item is checked against its ticket. Every check scores between 0.4 and 1, so a
mistake lowers a score but never zeroes it.

| Check | Full marks | One step off | Further off |
|---|---|---|---|
| Right items on the tray | 1 | — | 0.4 per missing item |
| Doneness (per side, per food) | 1 | 0.7 | 0.4 |
| Toppings present or held | 1 | 0.7 per mistake | floor 0.4 |
| Stack order | 1 | 0.8 | 0.5 |
| Poured amounts (Hold to Pour only; Auto-Fill is always right) | 1 | 0.7 | 0.4 |
| Scoop count | 1 | 0.7 | 0.4 |
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
- The setting is item 16, with the stable id `graphics-quality`, cycling Use Hub
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
  content/voice-lines.json customer lines (M4)
  tests/*.test.cjs         node --test bennyshub/apps/games/BENSBURGERBAR/tests/*.test.cjs
  tests/packs/test-pizza/  test-only proof pack (under tests/, so it is never published)
  tools/                   asset and voice build scripts
```

Generated reference images and working art go to `D:\Projects\Assets\BurgerBar\`, outside
the repo.

## Milestones (riskiest first; the player tries it early)

| M | What gets built | Done when |
|---|---|---|
| M0 | This document; rules modules; the whole diner pack as data; planner bot; test pizzeria pack | Node tests pass: Auto-Fill and Hold to Pour change food through the same rule, food stops at Extra Crispy unless Burning is on, every action has a single-press route, the pack checks out, the planner can finish every recipe, the pizza pack needs no rules changes, press counts per recipe are within budget, a shift saves and restores exactly |
| M1 | Box-art kitchen; grill, board and counter; one text-to-speech customer; Ticket, Go To, Pause, Settings, Exit | Menu tests (stable ids, -1, `enterGroup` only, Back restores the row); a headless Chrome run that makes a burger with real key events, two-switch and one-switch. **The player tries it:** how many presses per burger and per shift, any signs of fatigue, and is it fun? |
| M2 | Fryer, griddle, shake bar, drinks; Time It Yourself with its forgiving window, freeze rules and Burning; Hold to Pour with the slow-down near the line; orders, scoring, shifts, saves; Mitch's hints and warnings with text to speech, including while parked, and the parking notice | Scoring, order, shift, save and clock-freeze tests (runs while parked, freezes on cards and blur); Mitch never speaks over a scan label or during a card; 500 bot shifts per settings combination all finish with every order at 1 star or more. Second playtest |
| M3 | Cel-shaded diner, chunky food with doneness marks, toon customers, world-pinned badges, camera moves, High Contrast, Motion Reduced, Graphics Quality | Draw-call budget; doneness readable in High Contrast without colour; the new-game checklist in `GRAPHICS-QUALITY.md` (Hub inheritance, override, reset, live change, all four modes readable); frame times measured on a typical player tablet, aiming for a steady 30 FPS or better |
| M4 | Customer voice lines (orders built from parts) for the ten regulars, Mitch and the walk-in voice pool (including every first name and nickname part), sound effects, music | Voice and audio checks; Wait for Speech waits on recorded lines; a real-play sound check in Firefox as well as Chrome |
| M5 | My Diner shop, unlocks, decor in the world, upgrades, jukebox, silly reactions, Free Cook, walk-ins, daily special, visitors' book, New Regular naming card with Spell a Name, renaming menu items | Coins never go negative; every unlock is reachable; silly-rule tests; 1,000 generated walk-ins all give valid orders within the Orders setting's press budget |
| M6 | How to Play (`BennyTutorial`), `README-ACCESSIBLE.md`, thumbnail, development history entry | The ACCESSIBILITY §10 checklist and `docs/testing/SWITCH-ACCESS-TESTING.md`; the cold offline test in `OFFLINE-LIBRARY.md` (download the library without opening the game, disconnect, then play a shift); `npm test`, `npm run build`, `npm run audit:release` and `npm run check:pages` pass; the player goes hub → game → shift → pause → settings → hub alone with their own switch setup. The Electron app is not changed |

**The first release is unlisted:** reachable by direct link only, with no `games.json`
entry, as Chasing Rainbows was. Ari reviews it before it is listed in the hub.

## M0 notes

Built 2026-11-02. The rules modules are in `js/core/` and the diner is all data in
`packs/diner/pack.js`; none of it touches the DOM, timers or `Math.random`, and a test
checks that no rules module names any ingredient, station or recipe.

- **One rule per verb:** Auto-Fill and Hold to Pour both end in the same pour rule (a test
  pours both ways and gets the identical burger). Pick the Doneness and Time It Yourself
  both move food through one stage process. Food stops at Extra Crispy unless Burning is
  on.
- **Single presses:** a test checks, at every step of every recipe in every mode, that
  each legal action is one select in the menu tree and that every menu leaf is legal.
  Hold to Pour leaves are marked, and the same pour is a plain select under Auto-Fill.
- **The planner bot** finishes every recipe for 3 stars in all four mode combinations,
  plays 240 bot shifts across every Orders, Customers at Once, cooking and pouring setting
  (every order 1 star or more), and drives the Next-Step Star.
- **Saves:** a shift saved halfway and restored plays out identically to the original.
  Newer saves are never overwritten, and a pack change drops only the shift in progress.
- **The test pizzeria** (prep table, oven, a pizza baked whole, peppers chopped first)
  runs on the same rules. Building it showed two things the rules could not yet do:
  cook a built item whole, and prepare a part before it goes on. Both were added as
  general rules, with no pizzeria code.
- **Two small departures, for review:** the Shake Bar blends in the cup and has no
  separate Pour into a glass, which would add a press for no choice. With two customers
  wanting different amounts, Auto-Fill lists each amount, and Hold to Pour aims its line
  at the item the burger matches so far.

## Later

Planned, with room left in the prototype, but not in the first release. The first
release focuses on the core features and a good prototype.

- **A day at the diner** (Ari's idea): a progression mode through the hours of the day,
  from quiet hours with one customer to a rush hour with more. Tuned from the playtests'
  press and fatigue numbers, and still with no deadlines. Until then, the player sets
  Customers at Once.
- **Caregiver mode:** a menu editor (custom recipes made from the game's existing
  ingredients) and a favourite-customer editor (looks, names, orders). Reached behind the
  standard spoken warning before any mouse-only screen (ACCESSIBILITY §7). The pack format
  already holds recipes and customers as data, so the editors write the same data. How it
  looks is open.
- **More ways to type names:** a regular keyboard, and two-switch predictive text, in
  addition to the Pet Pals-style keyboard in the first release.

## Open questions

None at the moment.

## Decided

**Ari's review (2026-11-01)**

1. **Cooking:** two modes picked in Settings, named for what they do: Pick the Doneness
   (default) and Time It Yourself. Timed cooking is very forgiving; nothing burns by
   default, and a separate Burning setting adds burning as a challenge. Everything works
   with single presses; a hold is only ever an extra.
2. **Customers at Once:** approved, as part of the challenge. The player sets it; the
   day progression comes later (Bryan: focus on the core features first).
3. **Pause:** approved. Pouring offers Auto-Fill (default) and a forgiving Hold to Pour
   that slows near the line. Bryan dropped the earlier Pick an Amount option, since it
   only added ways to get an order wrong.
4. **Editors:** room left in the prototype; caregiver editors come later. Players can type
   names for regulars and rename menu items with the switch keyboard in the first
   release.
5. **Mitch:** approved, with one change. He talks while the scan is parked (parking is
   the game's breathing room), and a notice suggests parking when Auto Scan runs without
   it. Timed cooking stays available with Auto Scan, and parked time counts as cooking
   time.

**Bryan**

- **Title:** Ben's Burger Bar. The folder `BENSBURGERBAR` and the id `bensburgerbar` are
  final (Bryan, 2026-11-01).
- **Shift Length** stays at 5 customers by default until the playtests. The M1 and M2
  playtests count presses per order and per shift and watch for fatigue. Shift Length,
  Orders and the size of each order are tuned from that (Bryan, 2026-11-01).
- **Cast changes** (Bryan, 2026-11-01): Gus orders two of one thing, different each visit;
  Oakes sounds nasal and nerdy; Dale is the onion-ring guy; add a younger regular (Kai);
  add a snarky, picky regular (Vernon); add randomly built walk-ins for variety from shift
  to shift. Kai and Vernon approved as drafted.
- **Naming:** a walk-in served three times becomes a regular, and the player can pick a
  nickname from suggestions or spell one (Bryan and Ari, 2026-11-01).
- **Assistant manager:** a narrator character (Mitch) gives light narration, warnings
  before food reaches a stage, and hints, in the game's funny-but-helpful tone. Mitch
  approved as drafted; Assistant Manager defaults to Hints and Jokes (Bryan, 2026-11-01).
