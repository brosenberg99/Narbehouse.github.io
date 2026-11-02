'use strict';
/* Ben's Burger Bar - scoring: never below 1 star, favourites only add, silly food is noticed. */
const test = require('node:test'), assert = require('node:assert/strict');
const { S, DINER, playRecipe, MODES, normalSpec, kitchenWith, K, I } = require('./helpers.cjs');

const ticket = (items, customer) => ({ items, customer: customer || { id: 't', name: 'T' } });
/** A perfect served item, made by the bot. */
const made = recipe => {
  const r = playRecipe(DINER, recipe, MODES[0]);
  return r.served.items[0];
};
const clone = o => JSON.parse(JSON.stringify(o));

test('A perfect order is 3 stars and q 1; the tip follows the formula', () => {
  const spec = normalSpec(DINER, 'cheeseburger');
  const sc = S.score(DINER, ticket([spec]), [made('cheeseburger')], {});
  assert.equal(sc.q, 1);
  assert.equal(sc.stars, 3);
  assert.equal(sc.tip, Math.round(7 * (0.6 + 0.2 * 3)));
});

test('Nothing on the tray still earns 1 star and at least 1 coin', () => {
  const sc = S.score(DINER, ticket([normalSpec(DINER, 'cheeseburger'), normalSpec(DINER, 'fries')]), [], {});
  assert.equal(sc.q, 0.4);
  assert.equal(sc.stars, 1);
  assert.ok(sc.tip >= 1);
});

test('One stage off is 0.7 per side; every check stays within 0.4 and 1', () => {
  const spec = normalSpec(DINER, 'cheeseburger');
  const b = clone(made('cheeseburger'));
  const patty = b.parts.find(p => p.ing === 'patty');
  patty.faces[0].s += 1;
  const sc = S.score(DINER, ticket([spec]), [b], {});
  const done = sc.checks.filter(c => c.id === 'done').map(c => c.v).sort();
  assert.deepEqual(done, [0.7, 1]);
  patty.faces[1].s = 0;
  b.parts.reverse();
  b.parts.splice(1, 0, { uid: 'x', ing: 'cherry', n: 1, parts: [] });
  const bad = S.score(DINER, ticket([spec]), [b], {});
  bad.checks.forEach(c => assert.ok(c.v >= 0.4 && c.v <= 1, JSON.stringify(c)));
  assert.ok(bad.stars >= 1);
  const ids = bad.silly.map(x => x.id);
  assert.ok(ids.includes('upsideDown') && ids.includes('cherryBurger'), ids.join());
});

test('Favourites only add: Dale scores extra-crispy rings higher, never lower', () => {
  const dale = DINER.regulars.find(c => c.id === 'dale');
  const spec = normalSpec(DINER, 'onionRings');
  const rings = made('onionRings');
  const plain = S.score(DINER, ticket([spec]), [rings], {});
  const forDale = S.score(DINER, ticket([spec], dale), [rings], {});
  assert.equal(forDale.q, plain.q, 'no favourite stage, no change');
  const crispy = clone(rings);
  crispy.faces[0].s = 3;
  const a = S.score(DINER, ticket([spec]), [crispy], {});
  const b = S.score(DINER, ticket([spec], dale), [crispy], {});
  assert.ok(b.q > a.q);
  assert.ok(b.silly.some(x => x.id === 'allCrispy' && /how you cook/.test(x.line)), 'Dale has his own line');
});

test('Poured amounts are scored only with Hold to Pour', () => {
  const spec = normalSpec(DINER, 'cheeseburger');
  const b = clone(made('cheeseburger'));
  b.parts.find(p => p.ing === 'ketchup').amount = 1;
  assert.equal(S.score(DINER, ticket([spec]), [b], { pouring: 'auto' }).q, 1);
  const held = S.score(DINER, ticket([spec]), [b], { pouring: 'hold' });
  assert.deepEqual(held.checks.filter(c => c.id === 'pour').map(c => c.v), [0.7]);
});

test('A drink is checked on size, ice and flavour; an empty cup is silly, not a fail', () => {
  const spec = normalSpec(DINER, 'fountain');
  const cup = clone(made('fountain'));
  cup.size = 'large';
  assert.deepEqual(S.score(DINER, ticket([spec]), [cup], {}).checks.filter(c => c.id === 'drink').map(c => c.v), [0.6]);
  cup.parts = [];
  const empty = S.score(DINER, ticket([spec]), [cup], {});
  assert.ok(empty.stars >= 1);
  assert.ok(empty.silly.some(x => x.id === 'emptyCup'));
});

test('Burnt food is still served, scores at least 1 star, and gets its line', () => {
  const r = playRecipe(DINER, 'fries', { cooking: 'timed', burning: true, speed: 'normal' });
  const fries = clone(r.served.items[0]);
  fries.faces[0].s = I.stages(DINER, 'fried', { cooking: 'timed', burning: true }).indexOf('burnt');
  const sc = S.score(DINER, ticket([normalSpec(DINER, 'fries')]), [fries], r.state.rules);
  assert.ok(sc.stars >= 1);
  assert.ok(sc.silly.some(x => x.id === 'burnt'));
});
