/** Ben's Burger Bar - a test-only pizzeria.
 *
 *  Proof that a new restaurant is a new pack (DESIGN.md "One framework for every
 *  station"): different stations, a pizza built cold and baked whole, peppers chopped
 *  before they go on, and no code in js/core/ that knows about any of it. It lives
 *  under tests/, so it is never published or downloaded with the game.
 */
(function (root, data) {
  if (typeof module === 'object' && module.exports) module.exports = data;
  else (root.BBPacks = root.BBPacks || {}).testPizza = data;
})(typeof window === 'undefined' ? globalThis : window, {
  id: 'test-pizza',
  version: 1,
  name: 'Test Pizzeria',

  stageSets: {
    bake:  { stages: ['raw', 'golden', 'crispy', 'charred'], burnt: 'burnt' },
    slice: { stages: ['whole', 'sliced'] },
  },
  stageNames: { raw: 'Raw', golden: 'Golden', crispy: 'Crispy', charred: 'Charred', burnt: 'Burnt', whole: 'Whole', sliced: 'Sliced' },
  cookSpeeds: { verySlow: 30, slow: 20, normal: 10 },
  wantedScale: 2,
  amountSets: {
    sauce: { normal: 'normal', levels: [{ id: 'light', v: 0.4, name: 'light' }, { id: 'normal', v: 0.7, name: 'normal' }, { id: 'heavy', v: 1, name: 'heavy' }] },
  },
  sizeSets: {},

  ingredients: {
    dough:      { name: 'Dough', traits: ['cookable', 'topping'], stages: 'bake' },
    pizza:      { name: 'Pizza', traits: ['container', 'ordered'] },
    sauce:      { name: 'Tomato Sauce', traits: ['pourable'], amounts: 'sauce' },
    mozzarella: { name: 'Mozzarella', traits: ['topping'] },
    pepperoni:  { name: 'Pepperoni', traits: ['topping'] },
    pepper:     { name: 'Pepper', plural: 'Peppers', traits: ['topping', 'choppable'], chop: 'slice' },
    basil:      { name: 'Basil', traits: ['topping'] },
    tray:       { name: 'Tray', traits: ['container'] },
  },

  stations: {
    prep: {
      name: 'Prep Table',
      slots: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      bins: [
        { id: 'dough', ing: 'dough', verb: 'top', into: ['pizza'] },
        { id: 'sauce', ing: 'sauce', verb: 'pour', into: ['pizza'] },
        { id: 'mozzarella', ing: 'mozzarella', verb: 'top', into: ['pizza'] },
        { id: 'pepperoni', ing: 'pepperoni', verb: 'top', into: ['pizza'] },
        { id: 'pepper', ing: 'pepper', verb: 'take' },
        { id: 'basil', ing: 'basil', verb: 'top', into: ['pizza'] },
      ],
      verbs: ['chop', 'place', 'send', 'take', 'discard'],
      sendTo: ['oven'],
      labels: { place: 'Put on Pizza' },
    },
    oven: {
      name: 'Oven',
      slots: [{ id: 'o1', heat: true }, { id: 'o2', heat: true }],
      bins: [],
      verbs: ['cook', 'send', 'take', 'discard'],
      sendTo: ['counter'],
      labels: { cook: 'Bake' },
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
  stationOrder: ['prep', 'oven', 'counter'],
  start: 'counter',

  picks: {
    bake:  { values: ['golden', 'crispy'], normal: 'golden' },
    sauce: { values: ['light', 'normal', 'heavy'], normal: 'normal' },
  },
  recipes: {
    margherita: {
      name: 'Margherita', price: 8, unlock: 0, kind: 'main', budget: 20,
      item: { ing: 'pizza', done: { pick: 'bake' }, parts: [
        { ing: 'dough' }, { ing: 'sauce', amount: { pick: 'sauce' } }, { ing: 'mozzarella' }, { ing: 'basil', opt: 'in' }] },
    },
    pepperoni: {
      name: 'Pepperoni Pizza', price: 9, unlock: 0, kind: 'main', budget: 20,
      item: { ing: 'pizza', done: { pick: 'bake' }, parts: [
        { ing: 'dough' }, { ing: 'sauce', amount: { pick: 'sauce' } }, { ing: 'mozzarella' }, { ing: 'pepperoni' }] },
    },
    veggie: {
      name: 'Pepper Pizza', price: 9, unlock: 20, kind: 'main', budget: 25,
      item: { ing: 'pizza', done: { pick: 'bake' }, parts: [
        { ing: 'dough' }, { ing: 'sauce', amount: { pick: 'sauce' } }, { ing: 'mozzarella' }, { ing: 'pepper', chopped: 'sliced' }] },
    },
  },
  orderStyles: {
    simple: { items: [1, 1], change: 0, maxOptional: 2 },
    usual:  { items: [1, 2], change: 0.25 },
    fancy:  { items: [1, 3], change: 0.5, fancy: true },
  },

  regulars: [
    { id: 'nonna', name: 'Nonna', voice: 'Warm', likes: [['margherita', 3]] },
    { id: 'rocco', name: 'Rocco', voice: 'Loud', likes: [['pepperoni', 3]], favourite: { kind: 'stage', stage: 'crispy', bonus: 0.1 } },
  ],
  walkIns: {
    names: ['Ava', 'Ben', 'Cleo'], looks: { body: ['tall'] }, voices: ['p1'],
    favourites: [{ kind: 'extra', ing: 'basil', bonus: 0.1 }], dislikes: ['basil'],
    ordering: ['polite'], reacting: ['cheerful'],
  },
  customerMix: [{ recipes: 0, regulars: 0.5 }],
  servesToRegular: 3,
  silly: [{ id: 'bare', kind: 'without', container: 'pizza', and: 'dough', ings: ['sauce', 'mozzarella'], line: 'A pizza with nothing on it. Minimalist.' }],
  upgrades: {},
  decor: {},
});
