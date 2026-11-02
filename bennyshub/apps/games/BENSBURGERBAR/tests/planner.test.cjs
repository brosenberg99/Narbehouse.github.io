'use strict';
/* Ben's Burger Bar - the planner bot makes every recipe through the real menus, in
   every cooking and pouring mode, within each recipe's press budget. */
const test = require('node:test'), assert = require('node:assert/strict');
const { K, M, DINER, PIZZA, MODES, playRecipe, kitchenWith, normalSpec } = require('./helpers.cjs');

const label = r => r.cooking + '/' + r.pouring + (r.burning ? '/burning' : '');

for (const pack of [DINER, PIZZA]) {
  test(pack.name + ': the planner makes every recipe for 3 stars in every mode', () => {
    for (const rules of MODES) {
      for (const recipe of Object.keys(pack.recipes)) {
        const r = playRecipe(pack, recipe, rules);
        const where = recipe + ' ' + label(rules);
        assert.equal(r.out.noRoute, null, where + ': no single-press route for ' + JSON.stringify(r.out.noRoute));
        assert.ok(!r.out.stuck, where + ': stuck');
        assert.ok(r.served, where + ': never served');
        assert.equal(r.score.stars, 3, where + ': ' + JSON.stringify(r.score.checks.filter(c => c.v < 1)));
        assert.deepEqual(r.problems, [], where);
      }
    }
  });
}

test('Every action has a single-press route; holding is never the only way', () => {
  for (const rules of MODES) {
    for (const recipe of Object.keys(DINER.recipes)) {
      const r = playRecipe(DINER, recipe, rules);
      assert.deepEqual(r.problems, [], recipe + ' ' + label(rules));
    }
  }
  // With Hold to Pour, the same pour is a plain select under Auto-Fill.
  const s = kitchenWith(DINER, [normalSpec(DINER, 'cheeseburger')], { pouring: 'hold' });
  K.apply(s, { verb: 'go', station: s.at, opt: { to: 'board' } });
  const held = M.leaves(M.station(s)).filter(L => L.item.kind === 'mech');
  assert.ok(held.length > 0);
  K.setRules(s, { pouring: 'auto' });
  const plain = M.leaves(M.station(s));
  for (const L of held) {
    assert.ok(plain.some(P => P.item.kind === 'act' && K.key(P.item.action, true) === K.key(L.item.action, true)), L.ids.join('>'));
  }
});

test('Press counts per recipe are within budget (either cooking mode, Auto-Fill)', () => {
  const rows = [];
  for (const pack of [DINER, PIZZA]) {
    for (const [recipe, R] of Object.entries(pack.recipes)) {
      for (const rules of [MODES[0], MODES[2]]) {
        const r = playRecipe(pack, recipe, rules);
        rows.push(recipe.padEnd(20) + rules.cooking.padEnd(6) + String(r.out.choices).padStart(4) + ' choices' + String(r.out.steps).padStart(5) + ' moves  (budget ' + R.budget + ')');
        assert.ok(r.out.choices <= R.budget, recipe + ' ' + rules.cooking + ': ' + r.out.choices + ' choices, budget ' + R.budget);
      }
    }
  }
  if (process.env.BB_REPORT) console.log(rows.join('\n'));
});

test('Next-Step Star marks one leaf and the rows leading to it, without reordering', () => {
  const s = kitchenWith(DINER, [normalSpec(DINER, 'cheeseburger')], {});
  K.apply(s, { verb: 'go', station: s.at, opt: { to: 'grill' } });
  K.apply(s, { verb: 'take', station: 'grill', bin: 'patty', opt: {} });
  const plain = M.station(s, 'grill', {});
  const next = require('./helpers.cjs').PL.next(s);
  const starred = M.station(s, 'grill', { star: true }, { next });
  assert.deepEqual(starred.items.map(i => i.id), plain.items.map(i => i.id));
  const marked = M.leaves(starred).filter(L => L.item.star);
  assert.equal(marked.length, 1);
  assert.equal(K.key(marked[0].item.action), K.key(next));
  assert.ok(marked[0].item.say.endsWith(', next'));
  const row = starred.items.find(i => i.id === marked[0].ids[0]);
  assert.ok(row.star);
});
