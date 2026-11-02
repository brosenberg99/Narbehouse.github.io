/** Ben's Burger Bar - the diner, as data.
 *
 *  Everything the diner is lives here: stage sets, ingredients (what they can do comes
 *  from their traits), stations, recipes, customers, silly-food rules and the shop. The
 *  rules in js/core/ read this and nothing else, so a pizzeria or a food truck is a new
 *  pack with no code changes (tests/packs/test-pizza proves it).
 *
 *  Recipe items are templates. A part's value can be a pick, { pick: 'doneness' }, which
 *  the order generator resolves from `picks`, once per item, so both patties of a double
 *  come out the same. `opt: 'in'` parts can be held ("hold the onions"); `opt: 'out'`
 *  parts are left off unless asked for. `faces: 'out'` checks only the outside faces
 *  (a grilled cheese is scored on its outside, not on the bread touching the cheese).
 *
 *  Prices and costs are starting values, tuned in M5 (DESIGN.md "Recipes").
 */
(function (root, data) {
  if (typeof module === 'object' && module.exports) module.exports = data;
  else (root.BBPacks = root.BBPacks || {}).diner = data;
})(typeof window === 'undefined' ? globalThis : window, {
  id: 'diner',
  version: 1,
  name: "Ben's Burger Bar",

  /* ── stages ─────────────────────────────────────────────────────────────── */
  stageSets: {
    patty:   { stages: ['raw', 'blueRare', 'rare', 'medium', 'well', 'extraCrispy'], burnt: 'burnt' },
    bacon:   { stages: ['raw', 'chewy', 'crispy', 'extraCrispy'], burnt: 'burnt' },
    fried:   { stages: ['raw', 'golden', 'crispy', 'extraCrispy'], burnt: 'burnt' },
    griddle: { stages: ['raw', 'golden', 'brown', 'extraCrispy'], burnt: 'burnt' },
    shake:   { stages: ['unshaken', 'shaken'] },
    blend:   { stages: ['unblended', 'blended'] },
  },
  stageNames: {
    raw: 'Raw', blueRare: 'Blue Rare', rare: 'Rare', medium: 'Medium', well: 'Well Done',
    extraCrispy: 'Extra Crispy', burnt: 'Burnt', chewy: 'Chewy', crispy: 'Crispy',
    golden: 'Golden', brown: 'Brown', unshaken: 'Not Shaken', shaken: 'Shaken',
    unblended: 'Not Blended', blended: 'Blended',
  },
  /** Seconds per stage with Time It Yourself (DESIGN.md "Cooking modes"; tuned in M2).
   *  The stage a ticket asks for lasts `wantedScale` times as long. */
  cookSpeeds: { verySlow: 40, slow: 25, normal: 12 },
  wantedScale: 2,

  /* ── amounts, for pours ─────────────────────────────────────────────────── */
  amountSets: {
    sauce:  { normal: 'line', levels: [{ id: 'dab', v: 0.33, name: 'a dab' }, { id: 'line', v: 0.66, name: 'a line' }, { id: 'lots', v: 1, name: 'lots' }] },
    ice:    { normal: 'some', levels: [{ id: 'some', v: 0.5, name: 'some ice' }, { id: 'lots', v: 1, name: 'lots of ice' }] },
    fill:   { normal: 'full', levels: [{ id: 'half', v: 0.5, name: 'half full' }, { id: 'full', v: 0.85, name: 'full' }, { id: 'top', v: 1, name: 'to the top' }] },
    batter: { normal: 'normal', levels: [{ id: 'small', v: 0.4, name: 'small' }, { id: 'normal', v: 0.7, name: 'normal' }, { id: 'big', v: 1, name: 'big' }] },
    syrup:  { normal: 'pour', levels: [{ id: 'drizzle', v: 0.4, name: 'a drizzle' }, { id: 'pour', v: 0.7, name: 'a pour' }, { id: 'flood', v: 1, name: 'a flood' }] },
    milk:   { normal: 'normal', levels: [{ id: 'splash', v: 0.4, name: 'a splash' }, { id: 'normal', v: 0.7, name: 'normal' }, { id: 'lots', v: 1, name: 'lots' }] },
  },
  sizeSets: {
    cup: [{ id: 'small', name: 'Small' }, { id: 'medium', name: 'Medium' }, { id: 'large', name: 'Large' }],
  },

  /* ── ingredients ────────────────────────────────────────────────────────── */
  // container: holds parts; ordered: the order of its parts is scored; onHeat: a new
  // one is made on a hot slot (a grilled cheese builds on the griddle).
  ingredients: {
    patty:        { name: 'Patty', traits: ['cookable', 'twoSided', 'topping'], stages: 'patty' },
    bacon:        { name: 'Bacon', traits: ['cookable', 'topping'], stages: 'bacon' },
    // One bun, named and shaped by where it sits: the lowest is the bottom bun, the
    // highest the top bun, any between them a middle bun (a triple decker).
    bun:          { name: 'Bun', traits: ['topping'], layers: { bottom: 'Bottom Bun', middle: 'Middle Bun', top: 'Top Bun' } },
    cheese:       { name: 'Cheese', traits: ['topping'] },
    lettuce:      { name: 'Lettuce', traits: ['topping'] },
    tomato:       { name: 'Tomato', traits: ['topping'] },
    pickles:      { name: 'Pickles', traits: ['topping'] },
    onion:        { name: 'Onion', plural: 'Onions', traits: ['topping'] },
    ketchup:      { name: 'Ketchup', traits: ['squeezable'], amounts: 'sauce' },
    mustard:      { name: 'Mustard', traits: ['squeezable'], amounts: 'sauce' },
    mayo:         { name: 'Mayo', traits: ['squeezable'], amounts: 'sauce' },
    plate:        { name: 'Plate', traits: ['container', 'ordered'] },

    fries:        { name: 'Fries', traits: ['cookable'], stages: 'fried', mix: 'shake' },
    rings:        { name: 'Onion Rings', traits: ['cookable'], stages: 'fried', mix: 'shake' },
    salt:         { name: 'Salt', traits: ['topping'] },

    batter:       { name: 'Batter', traits: ['pourable'], amounts: 'batter', creates: 'pancake' },
    pancake:      { name: 'Pancake', traits: ['cookable', 'twoSided', 'topping'], stages: 'griddle', amounts: 'batter' },
    bread:        { name: 'Bread', traits: ['cookable', 'twoSided', 'topping'], stages: 'griddle' },
    sandwich:     { name: 'Grilled Cheese', traits: ['container', 'ordered', 'onHeat'] },
    butter:       { name: 'Butter', traits: ['topping'] },
    syrup:        { name: 'Syrup', traits: ['pourable'], amounts: 'syrup' },

    shakeCup:     { name: 'Shake Cup', traits: ['container'], mix: 'blend' },
    chocolate:    { name: 'Chocolate Ice Cream', short: 'Chocolate', traits: ['scoop', 'mixin'], counts: [1, 2, 3] },
    vanilla:      { name: 'Vanilla Ice Cream', short: 'Vanilla', traits: ['scoop', 'mixin'], counts: [1, 2, 3] },
    strawberry:   { name: 'Strawberry Ice Cream', short: 'Strawberry', traits: ['scoop', 'mixin'], counts: [1, 2, 3] },
    banana:       { name: 'Banana Ice Cream', short: 'Banana', traits: ['scoop', 'mixin'], counts: [1, 2, 3] },
    cookiesCream: { name: 'Cookies and Cream Ice Cream', short: 'Cookies and Cream', traits: ['scoop', 'mixin'], counts: [1, 2, 3] },
    mintChip:     { name: 'Mint Chip Ice Cream', short: 'Mint Chip', traits: ['scoop', 'mixin'], counts: [1, 2, 3] },
    milk:         { name: 'Milk', traits: ['pourable', 'mixin'], amounts: 'milk' },
    whippedCream: { name: 'Whipped Cream', traits: ['topping'] },
    cherry:       { name: 'Cherry', traits: ['topping'] },
    sprinkles:    { name: 'Sprinkles', traits: ['topping'] },

    cup:          { name: 'Cup', traits: ['container'], sizes: 'cup' },
    ice:          { name: 'Ice', traits: ['pourable'], amounts: 'ice' },
    cola:         { name: 'Cola', traits: ['pourable'], amounts: 'fill' },
    lemonLime:    { name: 'Lemon-Lime', traits: ['pourable'], amounts: 'fill' },
    orangeSoda:   { name: 'Orange Soda', traits: ['pourable'], amounts: 'fill' },
    lemonade:     { name: 'Lemonade', traits: ['pourable'], amounts: 'fill' },
    icedTea:      { name: 'Iced Tea', traits: ['pourable'], amounts: 'fill' },
    rootBeer:     { name: 'Root Beer', traits: ['pourable'], amounts: 'fill' },

    tray:         { name: 'Tray', traits: ['container'] },
  },

  /* ── stations ───────────────────────────────────────────────────────────── */
  // slots: heat = cooks what is on it; upgrade = only there once bought.
  // bins: verb is how the bin is used; into = which things it goes on or in (the first,
  // if a container, is made when there is none yet).
  // verbs: what may be done to things here. sendTo: where Send can take things.
  // makes: containers that Stack/Add can start fresh here.
  stations: {
    grill: {
      name: 'Grill',
      slots: [{ id: 'g1', heat: true }, { id: 'g2', heat: true, upgrade: 'grill2' }, { id: 'g3', heat: true, upgrade: 'grill3' }],
      bins: [{ id: 'patty', ing: 'patty', verb: 'take' }, { id: 'bacon', ing: 'bacon', verb: 'take' }],
      verbs: ['cook', 'flip', 'send', 'take', 'place', 'discard'],
      sendTo: ['board', 'griddle'],
    },
    board: {
      name: 'Board',
      slots: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }, { id: 'b4' }],
      bins: [
        { id: 'bun', ing: 'bun', verb: 'top', into: ['plate'] },
        { id: 'cheese', ing: 'cheese', verb: 'top', into: ['plate'] },
        { id: 'lettuce', ing: 'lettuce', verb: 'top', into: ['plate'] },
        { id: 'tomato', ing: 'tomato', verb: 'top', into: ['plate'] },
        { id: 'pickles', ing: 'pickles', verb: 'top', into: ['plate'] },
        { id: 'onion', ing: 'onion', verb: 'top', into: ['plate'] },
        { id: 'ketchup', ing: 'ketchup', verb: 'squeeze', into: ['plate'] },
        { id: 'mustard', ing: 'mustard', verb: 'squeeze', into: ['plate'] },
        { id: 'mayo', ing: 'mayo', verb: 'squeeze', into: ['plate'] },
      ],
      verbs: ['place', 'send', 'take', 'discard'],
      sendTo: ['counter'],
      makes: ['plate'],
      labels: { place: 'Add to Burger' },
    },
    fryer: {
      name: 'Fryer',
      slots: [{ id: 'f1', heat: true }, { id: 'f2', heat: true, upgrade: 'fryer2' }],
      bins: [{ id: 'fries', ing: 'fries', verb: 'take' }, { id: 'rings', ing: 'rings', verb: 'take' },
        { id: 'salt', ing: 'salt', verb: 'top', into: ['fries', 'rings'] }],
      verbs: ['cook', 'mix', 'send', 'take', 'place', 'discard'],
      sendTo: ['counter'],
      labels: { cook: 'Fry', mix: 'Shake the Basket' },
    },
    griddle: {
      name: 'Griddle',
      slots: [{ id: 'd1', heat: true }, { id: 'd2', heat: true, upgrade: 'griddle2' }, { id: 'p1' }, { id: 'p2' }],
      bins: [
        { id: 'batter', ing: 'batter', verb: 'pour' },
        { id: 'bread', ing: 'bread', verb: 'top', into: ['sandwich'] },
        { id: 'cheese', ing: 'cheese', verb: 'top', into: ['sandwich'] },
        { id: 'butter', ing: 'butter', verb: 'top', into: ['plate'] },
        { id: 'syrup', ing: 'syrup', verb: 'pour', into: ['plate'] },
      ],
      verbs: ['cook', 'flip', 'place', 'send', 'take', 'discard'],
      sendTo: ['counter'],
      makes: ['plate'],
      labels: { place: 'Stack' },
    },
    shakebar: {
      name: 'Shake Bar',
      slots: [{ id: 's1' }, { id: 's2' }],
      bins: [
        { id: 'shakeCup', ing: 'shakeCup', verb: 'take' },
        { id: 'chocolate', ing: 'chocolate', verb: 'portion', into: ['shakeCup', 'cup'] },
        { id: 'vanilla', ing: 'vanilla', verb: 'portion', into: ['shakeCup', 'cup'] },
        { id: 'strawberry', ing: 'strawberry', verb: 'portion', into: ['shakeCup', 'cup'] },
        { id: 'banana', ing: 'banana', verb: 'portion', into: ['shakeCup', 'cup'], unlock: 'banana' },
        { id: 'cookiesCream', ing: 'cookiesCream', verb: 'portion', into: ['shakeCup', 'cup'], unlock: 'cookiesCream' },
        { id: 'mintChip', ing: 'mintChip', verb: 'portion', into: ['shakeCup', 'cup'], unlock: 'mintChip' },
        { id: 'milk', ing: 'milk', verb: 'pour', into: ['shakeCup'] },
        { id: 'whippedCream', ing: 'whippedCream', verb: 'top', into: ['shakeCup', 'cup'] },
        { id: 'cherry', ing: 'cherry', verb: 'top', into: ['shakeCup', 'cup'] },
        { id: 'sprinkles', ing: 'sprinkles', verb: 'top', into: ['shakeCup', 'cup'] },
      ],
      verbs: ['mix', 'send', 'take', 'place', 'discard'],
      sendTo: ['counter'],
      labels: { mix: 'Blend' },
    },
    drinks: {
      name: 'Drinks',
      slots: [{ id: 'k1' }, { id: 'k2' }],
      bins: [
        { id: 'cup', ing: 'cup', verb: 'portion' },
        { id: 'ice', ing: 'ice', verb: 'pour', into: ['cup'] },
        { id: 'cola', ing: 'cola', verb: 'pour', into: ['cup'] },
        { id: 'lemonLime', ing: 'lemonLime', verb: 'pour', into: ['cup'] },
        { id: 'orangeSoda', ing: 'orangeSoda', verb: 'pour', into: ['cup'] },
        { id: 'lemonade', ing: 'lemonade', verb: 'pour', into: ['cup'], unlock: 'lemonade' },
        { id: 'icedTea', ing: 'icedTea', verb: 'pour', into: ['cup'], unlock: 'lemonade' },
        { id: 'rootBeer', ing: 'rootBeer', verb: 'pour', into: ['cup'], unlock: 'float' },
      ],
      verbs: ['send', 'take', 'place', 'discard'],
      sendTo: ['counter', 'shakebar'],
    },
    counter: {
      name: 'Counter',
      slots: [{ id: 'tray', fixed: 'tray' }],
      bins: [],
      verbs: ['serve', 'take', 'discard'],
      sendTo: [],
      counter: true,
    },
  },
  stationOrder: ['grill', 'board', 'fryer', 'griddle', 'shakebar', 'drinks', 'counter'],
  start: 'counter',

  /* ── recipes ────────────────────────────────────────────────────────────── */
  picks: {
    doneness:     { values: ['rare', 'medium', 'well'], normal: 'medium', fancy: ['blueRare', 'rare', 'medium', 'well'] },
    bacon:        { values: ['chewy', 'crispy'], normal: 'crispy' },
    fry:          { values: ['golden', 'crispy'], normal: 'golden' },
    toast:        { values: ['golden', 'brown'], normal: 'golden' },
    sauce:        { values: ['dab', 'line', 'lots'], normal: 'line' },
    ice:          { values: ['some', 'lots'], normal: 'some' },
    syrup:        { values: ['drizzle', 'pour', 'flood'], normal: 'pour' },
    cupSize:      { values: ['small', 'medium', 'large'], normal: 'medium' },
    scoops:       { values: [1, 2, 3], normal: 2 },
    soda:         { values: ['cola', 'lemonLime', 'orangeSoda'], normal: 'cola' },
    tea:          { values: ['lemonade', 'icedTea'], normal: 'lemonade' },
    shakeFlavour: { values: ['chocolate', 'vanilla', 'strawberry', 'banana', 'cookiesCream', 'mintChip'], normal: 'chocolate' },
  },
  // budget: the most choices the planner bot may take to make one, alone, in either
  // cooking mode with Auto-Fill. A guard rail against menu changes that add presses; the
  // M1 playtest judges the real numbers (DESIGN.md "How many presses").
  recipes: {
    hamburger: {
      name: 'Hamburger', price: 6, unlock: 0, kind: 'burger', budget: 30,
      item: { ing: 'plate', parts: [
        { ing: 'bun' }, { ing: 'patty', done: { pick: 'doneness' } },
        { ing: 'lettuce', opt: 'in' }, { ing: 'tomato', opt: 'in' }, { ing: 'pickles', opt: 'in' }, { ing: 'onion', opt: 'out' },
        { ing: 'ketchup', opt: 'in', amount: { pick: 'sauce' } }, { ing: 'mustard', opt: 'out', amount: { pick: 'sauce' } },
        { ing: 'mayo', opt: 'out', amount: { pick: 'sauce' } }, { ing: 'bun' }] },
    },
    cheeseburger: {
      name: 'Cheeseburger', price: 7, unlock: 0, kind: 'burger', budget: 30,
      item: { ing: 'plate', parts: [
        { ing: 'bun' }, { ing: 'patty', done: { pick: 'doneness' } }, { ing: 'cheese' },
        { ing: 'lettuce', opt: 'in' }, { ing: 'tomato', opt: 'in' }, { ing: 'pickles', opt: 'in' }, { ing: 'onion', opt: 'out' },
        { ing: 'ketchup', opt: 'in', amount: { pick: 'sauce' } }, { ing: 'mustard', opt: 'out', amount: { pick: 'sauce' } },
        { ing: 'mayo', opt: 'out', amount: { pick: 'sauce' } }, { ing: 'bun' }] },
    },
    fries: {
      name: 'Fries', price: 3, unlock: 0, kind: 'side', budget: 15,
      item: { ing: 'fries', done: { pick: 'fry' }, mixed: 'shaken', parts: [{ ing: 'salt', opt: 'in' }] },
    },
    fountain: {
      name: 'Fountain Drink', price: 2, unlock: 0, kind: 'drink', budget: 15,
      item: { ing: 'cup', nameFrom: 'flavour', size: { pick: 'cupSize' }, parts: [
        { ing: 'ice', opt: 'in', amount: { pick: 'ice' } }, { ing: { pick: 'soda' }, amount: 'full' }] },
    },
    baconCheeseburger: {
      name: 'Bacon Cheeseburger', price: 9, unlock: 40, kind: 'burger', budget: 40,
      item: { ing: 'plate', parts: [
        { ing: 'bun' }, { ing: 'patty', done: { pick: 'doneness' } }, { ing: 'cheese' }, { ing: 'bacon', done: { pick: 'bacon' } },
        { ing: 'lettuce', opt: 'in' }, { ing: 'tomato', opt: 'in' }, { ing: 'pickles', opt: 'out' }, { ing: 'onion', opt: 'out' },
        { ing: 'ketchup', opt: 'in', amount: { pick: 'sauce' } }, { ing: 'mustard', opt: 'out', amount: { pick: 'sauce' } },
        { ing: 'mayo', opt: 'out', amount: { pick: 'sauce' } }, { ing: 'bun' }] },
    },
    doubleCheeseburger: {
      name: 'Double Cheeseburger', price: 10, unlock: 60, kind: 'burger', budget: 50,
      item: { ing: 'plate', parts: [
        { ing: 'bun' }, { ing: 'patty', done: { pick: 'doneness' } }, { ing: 'cheese' },
        { ing: 'patty', done: { pick: 'doneness' } }, { ing: 'cheese' },
        { ing: 'lettuce', opt: 'in' }, { ing: 'tomato', opt: 'out' }, { ing: 'pickles', opt: 'in' }, { ing: 'onion', opt: 'in' },
        { ing: 'ketchup', opt: 'in', amount: { pick: 'sauce' } }, { ing: 'mustard', opt: 'in', amount: { pick: 'sauce' } },
        { ing: 'mayo', opt: 'out', amount: { pick: 'sauce' } }, { ing: 'bun' }] },
    },
    onionRings: {
      name: 'Onion Rings', price: 4, unlock: 40, kind: 'side', budget: 15,
      item: { ing: 'rings', done: { pick: 'fry' }, mixed: 'shaken', parts: [{ ing: 'salt', opt: 'in' }] },
    },
    lemonade: {
      name: 'Lemonade or Iced Tea', price: 3, unlock: 30, kind: 'drink', budget: 15,
      item: { ing: 'cup', nameFrom: 'flavour', size: { pick: 'cupSize' }, parts: [
        { ing: 'ice', opt: 'in', amount: { pick: 'ice' } }, { ing: { pick: 'tea' }, amount: 'full' }] },
    },
    milkshake: {
      name: 'Milkshake', suffix: 'Shake', price: 5, unlock: 60, kind: 'drink', budget: 20,
      item: { ing: 'shakeCup', nameFrom: 'flavour', mixed: 'blended', parts: [
        { ing: { pick: 'shakeFlavour' }, count: { pick: 'scoops' } }, { ing: 'milk', amount: 'normal' },
        { ing: 'whippedCream', opt: 'in' }, { ing: 'cherry', opt: 'in' }, { ing: 'sprinkles', opt: 'out' }] },
    },
    grilledCheese: {
      name: 'Grilled Cheese', price: 5, unlock: 50, kind: 'main', budget: 20,
      item: { ing: 'sandwich', parts: [
        { ing: 'bread', done: { pick: 'toast' }, faces: 'out' }, { ing: 'cheese' },
        { ing: 'bread', done: { pick: 'toast' }, faces: 'out' }] },
    },
    pancakes: {
      name: 'Pancake Stack', price: 6, unlock: 80, kind: 'main', budget: 45,
      item: { ing: 'plate', parts: [
        { ing: 'pancake', done: { pick: 'toast' }, amount: 'normal' }, { ing: 'pancake', done: { pick: 'toast' }, amount: 'normal' },
        { ing: 'pancake', done: { pick: 'toast' }, amount: 'normal' },
        { ing: 'butter', opt: 'in' }, { ing: 'syrup', opt: 'in', amount: { pick: 'syrup' } }] },
    },
    breakfast: {
      name: 'Breakfast Plate', price: 9, unlock: 100, kind: 'main', budget: 50,
      item: { ing: 'plate', parts: [
        { ing: 'pancake', done: { pick: 'toast' }, amount: 'normal' }, { ing: 'pancake', done: { pick: 'toast' }, amount: 'normal' },
        { ing: 'butter', opt: 'in' }, { ing: 'syrup', opt: 'in', amount: { pick: 'syrup' } },
        { ing: 'bacon', done: { pick: 'bacon' } }] },
    },
    float: {
      name: 'Root Beer Float', price: 5, unlock: 80, kind: 'drink', budget: 20,
      item: { ing: 'cup', size: { pick: 'cupSize' }, parts: [{ ing: 'rootBeer', amount: 'full' }, { ing: 'vanilla', count: 1 }] },
    },
    tower: {
      name: 'The Diner Tower', price: 14, unlock: 150, kind: 'burger', budget: 75,
      item: { ing: 'plate', parts: [
        { ing: 'bun' },
        { ing: 'patty', done: { pick: 'doneness' } }, { ing: 'cheese' },
        { ing: 'patty', done: { pick: 'doneness' } }, { ing: 'cheese' },
        { ing: 'patty', done: { pick: 'doneness' } }, { ing: 'cheese' },
        { ing: 'bacon', done: { pick: 'bacon' } },
        { ing: 'lettuce', opt: 'in' }, { ing: 'tomato', opt: 'in' }, { ing: 'pickles', opt: 'in' }, { ing: 'onion', opt: 'in' },
        { ing: 'ketchup', opt: 'in', amount: { pick: 'sauce' } }, { ing: 'mustard', opt: 'in', amount: { pick: 'sauce' } },
        { ing: 'mayo', opt: 'in', amount: { pick: 'sauce' } }, { ing: 'bun' }] },
    },
  },
  /** Things that are bought but are not recipes of their own. */
  extras: {
    banana:       { name: 'Banana Shakes', cost: 50, pick: 'shakeFlavour', value: 'banana', needs: 'milkshake' },
    cookiesCream: { name: 'Cookies and Cream Shakes', cost: 50, pick: 'shakeFlavour', value: 'cookiesCream', needs: 'milkshake' },
    mintChip:     { name: 'Mint Chip Shakes', cost: 50, pick: 'shakeFlavour', value: 'mintChip', needs: 'milkshake' },
  },
  /** Pick values that wait for an unlock (anything not listed is always available). */
  pickUnlocks: { shakeFlavour: { banana: 'banana', cookiesCream: 'cookiesCream', mintChip: 'mintChip' } },
  /** Orders setting: how many items, and how far from the normal recipe it strays.
   *  maxOptional caps the optional toppings on a burger (Simple: two). */
  orderStyles: {
    simple: { items: [1, 1], change: 0, maxOptional: 2 },
    usual:  { items: [1, 2], change: 0.25 },
    fancy:  { items: [1, 3], change: 0.5, fancy: true },
  },

  /* ── customers ──────────────────────────────────────────────────────────── */
  // likes: recipes and weights. usual: Marge's fixed order. wants: values they always
  // pick. dislikes: always held. favourite: can only add to an order's score.
  // twin: orders two of one thing. short: a small order. newest: the newest recipe.
  regulars: [
    { id: 'marge', name: 'Marge', voice: 'Warm, unhurried', who: 'Retired school-bus driver, cardigan, reading glasses on a chain',
      likes: [['cheeseburger', 3], ['lemonade', 2]], usual: [{ recipe: 'cheeseburger', set: { doneness: 'medium' } }, { recipe: 'lemonade', set: { tea: 'icedTea' } }] },
    { id: 'dale', name: 'Dale', voice: 'Gravelly drawl', who: 'Wiry mechanic in grease-spotted overalls',
      likes: [['onionRings', 4], ['cheeseburger', 1], ['hamburger', 1], ['fountain', 1]], always: ['onionRings'],
      wants: { fry: 'extraCrispy' }, favourite: { kind: 'stage', stage: 'extraCrispy', bonus: 0.15 } },
    { id: 'priya', name: 'Priya', voice: 'Dry, quick', who: 'Night-shift nurse in scrubs, coffee-deprived',
      likes: [['pancakes', 4], ['breakfast', 3], ['fountain', 1]] },
    { id: 'bev', name: 'Coach Bev', voice: 'Booming', who: 'Whistle, tracksuit, clipboard',
      likes: [['doubleCheeseburger', 3], ['baconCheeseburger', 2], ['tower', 1], ['cheeseburger', 1]],
      favourite: { kind: 'extra', ing: 'pickles', bonus: 0.1 } },
    { id: 'oakes', name: 'Professor Oakes', voice: 'Nasal, nerdy, slightly too fast', who: 'Tweed jacket, bow tie, pocket protector',
      likes: [['grilledCheese', 4], ['lemonade', 3], ['hamburger', 1]], dislikes: ['onion'], set: { tea: 'lemonade' } },
    { id: 'gus', name: 'Gus', voice: 'Low, friendly rumble', who: 'Long-haul trucker, huge beard, trucker cap',
      likes: [['milkshake', 2], ['cheeseburger', 2], ['fries', 1], ['baconCheeseburger', 2]], twin: true, tipScale: 1.25 },
    { id: 'reginald', name: 'Reginald', voice: 'Theatrical, sweeping', who: 'Self-declared food critic, scarf in all weather',
      likes: [['cheeseburger', 1], ['grilledCheese', 1]], newest: true },
    { id: 'tasha', name: 'Tasha', voice: 'Flat, deadpan', who: 'Teenage skateboarder, deeply unimpressed',
      likes: [['milkshake', 5], ['fries', 2], ['fountain', 1]] },
    { id: 'kai', name: 'Kai', voice: 'Bright, very serious', who: 'Ten years old, notebook under one arm',
      likes: [['hamburger', 2], ['cheeseburger', 2], ['fountain', 2]], short: true, set: { cupSize: 'small' } },
    { id: 'vernon', name: 'Vernon', voice: 'Deep, slow, droning, with heavy sighs', who: 'Runs a burger-review blog with eleven followers',
      likes: [['cheeseburger', 3], ['hamburger', 2], ['doubleCheeseburger', 1]], exact: true, threeStarScale: 1.5 },
  ],
  walkIns: {
    names: ['Olive', 'Dana', 'Mike', 'Rosa', 'Theo', 'June', 'Hank', 'Lena', 'Omar', 'Bea', 'Felix', 'Iris', 'Sam', 'Nora',
      'Pete', 'Maya', 'Lou', 'Ada', 'Ray', 'Wendy', 'Cal', 'Tess', 'Ike', 'Ruth', 'Gil', 'Pam', 'Ned', 'Zoe', 'Abe', 'Fay'],
    looks: {
      body: ['round', 'tall', 'short', 'broad'], outfit: ['hoodie', 'suit', 'apron', 'jacket', 'tee', 'raincoat'],
      hair: ['curly', 'bald', 'bun', 'mohawk', 'long', 'buzz'], hat: ['none', 'cap', 'beanie', 'cowboy', 'chef', 'none'],
      colour: ['red', 'teal', 'mustard', 'plum', 'navy', 'orange'],
    },
    voices: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'],
    favourites: [
      { kind: 'stage', stage: 'extraCrispy', bonus: 0.1, word: 'Crispy' },
      { kind: 'extra', ing: 'pickles', bonus: 0.1, word: 'Pickle' },
      { kind: 'extra', ing: 'cheese', bonus: 0.1, word: 'Cheesy' },
      { kind: 'recipe', recipe: 'onionRings', bonus: 0.1, word: 'Onion Ring' },
      { kind: 'recipe', recipe: 'milkshake', bonus: 0.1, word: 'Shake' },
    ],
    dislikes: ['pickles', 'onion', 'tomato', 'mustard', 'mayo'],
    ordering: ['polite', 'chatty', 'puns', 'formal'],
    reacting: ['cheerful', 'deadpan', 'overjoyed'],
  },
  /** How many regulars per shift, by recipes unlocked (DESIGN.md "Walk-ins"; tuned in M5). */
  customerMix: [{ recipes: 0, regulars: 0.6 }, { recipes: 6, regulars: 0.4 }],
  servesToRegular: 3,

  /* ── silly food ─────────────────────────────────────────────────────────── */
  silly: [
    { id: 'allCrispy', kind: 'allStage', stage: 'extraCrispy', line: '…crunchy.', lines: { dale: 'Now that is how you cook a burger.' } },
    { id: 'cherryBurger', kind: 'with', ing: 'cherry', and: 'patty', line: 'Is that a cherry? On a burger?' },
    { id: 'noBun', kind: 'without', container: 'plate', and: 'patty', ings: ['bun'], line: "So it's a… patty salad." },
    { id: 'pancakeBuns', kind: 'with', ing: 'pancake', and: 'patty', line: 'Breakfast and lunch at the same time. Efficient.' },
    { id: 'emptyCup', kind: 'empty', containers: ['cup', 'shakeCup'], line: 'Ah. A cup of air. Very refreshing.' },
    { id: 'tower', kind: 'count', ing: 'patty', min: 12, line: "I'm going to need a bigger mouth." },
    { id: 'burnt', kind: 'anyStage', stage: 'burnt', line: 'Smoky. Very… smoky.' },
  ],

  /* ── the shop ───────────────────────────────────────────────────────────── */
  // Upgrades add room or flair, never speed.
  upgrades: {
    grill2:   { name: 'Second Grill Spot', cost: 60 },
    grill3:   { name: 'Third Grill Spot', cost: 120, needs: 'grill2' },
    fryer2:   { name: 'Bigger Fryer Basket', cost: 80 },
    griddle2: { name: 'Second Griddle Spot', cost: 80, needs: 'pancakes' },
    blender:  { name: 'Fancy Blender', cost: 100, needs: 'milkshake', flair: true },
  },
  decor: {
    neonSign:   { name: 'Neon Sign', options: [{ id: 'classic', cost: 0 }, { id: 'burger', cost: 40 }, { id: 'rocket', cost: 60 }] },
    wallPaint:  { name: 'Wall Paint', options: [{ id: 'cream', cost: 0 }, { id: 'mint', cost: 20 }, { id: 'cherry', cost: 20 }, { id: 'sky', cost: 20 }] },
    floor:      { name: 'Floor', options: [{ id: 'checker', cost: 0 }, { id: 'wood', cost: 30 }, { id: 'terrazzo', cost: 40 }] },
    booths:     { name: 'Booths', options: [{ id: 'red', cost: 0 }, { id: 'teal', cost: 35 }, { id: 'gold', cost: 50 }] },
    stools:     { name: 'Counter Stools', options: [{ id: 'chrome', cost: 0 }, { id: 'rainbow', cost: 30 }] },
    jukebox:    { name: 'Jukebox Songs', options: [{ id: 'diner', cost: 0 }, { id: 'surf', cost: 25 }, { id: 'swing', cost: 25 }, { id: 'disco', cost: 40 }] },
  },
  dailySpecialBonus: 0.2,
});
