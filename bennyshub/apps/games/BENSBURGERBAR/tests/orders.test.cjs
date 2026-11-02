'use strict';
/* Ben's Burger Bar - orders: personality picks what, the Orders setting picks how much. */
const test = require('node:test'), assert = require('node:assert/strict');
const { O, K, DINER, W } = require('./helpers.cjs');

const ALL = K.allIds(DINER);
const STARTERS = Object.keys(DINER.recipes).filter(r => !DINER.recipes[r].unlock);
const optionalCount = spec => {
  const T = DINER.recipes[spec.recipe].item;
  const opt = new Set(T.parts.filter(p => p.opt).map(p => p.ing));
  return spec.parts.filter(p => opt.has(p.ing)).length;
};

test('Order size follows the Orders setting for every customer, regular or walk-in', () => {
  const s = { rng: 99 };
  for (const style of Object.keys(DINER.orderStyles)) {
    const [lo, hi] = DINER.orderStyles[style].items;
    const people = DINER.regulars.concat(Array.from({ length: 200 }, (_, i) => O.walkIn(DINER, s, i)));
    for (const customer of people) {
      for (let k = 0; k < 5; k++) {
        const items = O.order(DINER, s, { customer, style, unlocked: ALL, special: 'fries', newest: 'tower' });
        assert.ok(items.length >= Math.min(lo, items.length) && items.length <= hi, customer.name + ' ' + style + ' ' + items.length);
        if (style === 'simple') items.forEach(it => assert.ok(optionalCount(it) <= 2, customer.name + ' ' + W.item(DINER, it)));
        items.forEach(it => assert.ok(ALL.includes(it.recipe)));
      }
    }
  }
});

test('Only unlocked recipes and flavours are ordered', () => {
  const s = { rng: 7 };
  const unlocked = STARTERS.concat(['milkshake']);
  for (let i = 0; i < 300; i++) {
    const items = O.order(DINER, s, { customer: O.walkIn(DINER, s, i), style: 'fancy', unlocked });
    for (const it of items) {
      assert.ok(unlocked.includes(it.recipe), it.recipe);
      it.parts.forEach(p => assert.ok(!['banana', 'cookiesCream', 'mintChip'].includes(p.ing), 'locked flavour ' + p.ing));
    }
  }
});

test('Regular quirks: Marge has the usual, Oakes never gets onions, Gus orders two alike, Kai stays small', () => {
  const s = { rng: 3 };
  const C = id => DINER.regulars.find(c => c.id === id);
  const marge = O.order(DINER, s, { customer: C('marge'), style: 'usual', unlocked: ALL });
  assert.deepEqual(marge.map(i => i.recipe), ['cheeseburger', 'lemonade']);
  assert.equal(W.ticket(DINER, { items: marge }), 'Cheeseburger, medium and Medium iced tea.');
  assert.deepEqual(O.order(DINER, s, { customer: C('marge'), style: 'fancy', unlocked: ALL }), marge, 'the same every visit');
  for (let i = 0; i < 100; i++) {
    for (const it of O.order(DINER, s, { customer: C('oakes'), style: 'fancy', unlocked: ALL })) {
      assert.ok(!it.parts.some(p => p.ing === 'onion'), 'onion for Oakes');
    }
    const gus = O.order(DINER, s, { customer: C('gus'), style: 'fancy', unlocked: ALL });
    if (gus.length === 2) assert.deepEqual(gus[0], gus[1]);
    const kai = O.order(DINER, s, { customer: C('kai'), style: 'fancy', unlocked: ALL });
    assert.ok(kai.length <= 2);
    kai.filter(it => it.size).forEach(it => assert.equal(it.size, 'small'));
  }
  const dale = O.order(DINER, s, { customer: C('dale'), style: 'usual', unlocked: ALL });
  assert.equal(dale[0].recipe, 'onionRings');
  assert.equal(dale[0].done, 'extraCrispy');
});

test('Both patties of a double are asked for the same way', () => {
  const s = { rng: 5 };
  for (let i = 0; i < 100; i++) {
    const spec = O.resolve(DINER, 'doubleCheeseburger', s, { style: 'fancy', unlocked: ALL });
    const d = spec.parts.filter(p => p.ing === 'patty').map(p => p.done);
    assert.equal(d[0], d[1]);
  }
});
