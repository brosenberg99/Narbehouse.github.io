'use strict';
/* Ben's Burger Bar - the verbs and the kitchen: one rule per verb, whatever the setting.
   node --test bennyshub/apps/games/BENSBURGERBAR/tests/ */
const test = require('node:test'), assert = require('node:assert/strict');
const { I, K, V, DINER, kitchenWith, normalSpec } = require('./helpers.cjs');

const go = (s, to) => K.apply(s, { verb: 'go', station: s.at, opt: { to } });
const find = (s, pred) => K.actions(s).find(pred);
const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (k === 'uid' ? undefined : v)));

function burgerOnBoard(rules) {
  const s = kitchenWith(DINER, [normalSpec(DINER, 'cheeseburger')], rules);
  go(s, 'board');
  K.apply(s, find(s, a => a.bin === 'bunBottom'));
  return s;
}

test('Auto-Fill and Hold to Pour put sauce on through the same rule', () => {
  const auto = burgerOnBoard({ pouring: 'auto' });
  const pour = find(auto, a => a.bin === 'ketchup');
  assert.equal(pour.opt.level, 'line');
  K.apply(auto, pour);

  const hold = burgerOnBoard({ pouring: 'hold' });
  const start = find(hold, a => a.bin === 'ketchup');
  assert.equal(start.opt.mech, true, 'Hold to Pour lists a mech pour');
  const m = K.pourStart(hold, start);
  assert.equal(m.target, 0.66, 'the target line is the ticket amount');
  while (m.amount < m.target) K.pourHold(m, 0.01);
  m.amount = m.target;
  const ev = K.apply(hold, K.pourRelease(m));
  assert.equal(ev[0].type, 'poured');

  const plate = s => s.stations.board.slots.b1;
  assert.deepEqual(strip(plate(hold)), strip(plate(auto)), 'identical burger either way');
  assert.equal(V.VERBS.squeeze, V.VERBS.pour, 'squeezing is the pour rule');
});

test('Hold to Pour slows near the line and never overflows', () => {
  const s = burgerOnBoard({ pouring: 'hold' });
  const m = K.pourStart(s, find(s, a => a.bin === 'ketchup'));
  let t = 0;
  while (m.amount < m.target - V.POUR.slowBand) { K.pourHold(m, 0.01); t += 0.01; }
  const fast = V.POUR.rate * 0.1, before = m.amount;
  K.pourHold(m, 0.1);
  assert.ok(m.amount - before < fast / 2, 'trickles inside the band');
  K.pourHold(m, 60);
  assert.equal(m.amount, 1, 'a long hold stops at the top');
  const ev = K.apply(s, K.pourRelease(m));
  assert.equal(ev[0].amount, 1);
});

test('Pick the Doneness goes straight to the stage and offers no Burnt', () => {
  const s = kitchenWith(DINER, [normalSpec(DINER, 'cheeseburger')], { cooking: 'pick', burning: true });
  assert.equal(s.rules.burning, false, 'Burning needs Time It Yourself');
  go(s, 'grill');
  K.apply(s, find(s, a => a.bin === 'patty'));
  const cooks = K.actions(s).filter(a => a.verb === 'cook').map(a => a.opt.until);
  assert.deepEqual(cooks, ['blueRare', 'rare', 'medium', 'well', 'extraCrispy']);
  const patty = s.stations.grill.slots.g1;
  K.apply(s, find(s, a => a.verb === 'cook' && a.opt.until === 'medium'));
  assert.equal(patty.faces[0].s, 3);
  assert.equal(patty.faces[1].s, 0);
  assert.deepEqual(K.tick(s, 1000), [], 'nothing moves on its own');
  assert.equal(patty.faces[0].s, 3);
});

test('Timed food stops at Extra Crispy unless Burning is on', () => {
  for (const burning of [false, true]) {
    const s = kitchenWith(DINER, [normalSpec(DINER, 'fries')], { cooking: 'timed', burning, speed: 'normal' });
    go(s, 'fryer');
    K.apply(s, find(s, a => a.bin === 'fries'));
    K.apply(s, find(s, a => a.verb === 'cook'));
    const fries = s.stations.fryer.slots.f1;
    const events = [];
    for (let i = 0; i < 600; i++) events.push(...K.tick(s, 1));
    const list = I.stages(DINER, 'fried', s.rules);
    assert.equal(list[fries.faces[0].s], burning ? 'burnt' : 'extraCrispy');
    assert.ok(events.some(e => e.type === 'near'), 'a heads-up comes before the cap');
  }
});

test('The wanted stage lasts twice as long; Pause and Pick the Doneness freeze the clock', () => {
  const s = kitchenWith(DINER, [normalSpec(DINER, 'fries')], { cooking: 'timed', speed: 'normal' });
  go(s, 'fryer');
  K.apply(s, find(s, a => a.bin === 'fries'));
  K.apply(s, find(s, a => a.verb === 'cook'));
  const f = s.stations.fryer.slots.f1.faces[0];
  K.tick(s, 12);
  assert.equal(f.s, 1, 'golden after one 12 s stage');
  K.tick(s, 23);
  assert.equal(f.s, 1, 'golden (wanted) is still showing after 23 more seconds');
  s.paused = true;
  assert.deepEqual(K.tick(s, 999), []);
  assert.deepEqual(K.apply(s, find(s, a => a.verb === 'send')).map(e => e.type), ['refused'], 'no actions while paused');
  s.paused = false;
  K.tick(s, 1);
  assert.equal(f.s, 2);
  K.setRules(s, { cooking: 'pick' });
  K.tick(s, 999);
  assert.equal(f.s, 2, 'switching to Pick the Doneness stops the clock');
});

test('Flipping a grilled cheese turns the whole stack over', () => {
  const s = kitchenWith(DINER, [normalSpec(DINER, 'grilledCheese')], {});
  go(s, 'griddle');
  K.apply(s, find(s, a => a.bin === 'bread'));
  K.apply(s, find(s, a => a.bin === 'cheese'));
  K.apply(s, find(s, a => a.bin === 'bread'));
  const sw = s.stations.griddle.slots.d1;
  assert.equal(sw.ing, 'sandwich', 'a new grilled cheese starts on a hot spot');
  K.apply(s, find(s, a => a.verb === 'cook' && a.opt.until === 'golden'));
  const bottom = sw.parts[0];
  assert.equal(bottom.faces[0].s, 1);
  K.apply(s, find(s, a => a.verb === 'flip'));
  assert.equal(sw.parts[2], bottom, 'the bottom slice is now on top');
  assert.equal(bottom.faces[1].s, 1, 'its toasted side faces up');
  assert.equal(I.heatFace(sw).face.s, 0, 'the other slice is on the heat');
});

test('Actions are only legal where the player stands, and only if listed', () => {
  const s = kitchenWith(DINER, [normalSpec(DINER, 'fries')], {});
  assert.equal(K.apply(s, { verb: 'take', station: 'fryer', bin: 'fries', opt: {} })[0].reason, 'elsewhere');
  go(s, 'fryer');
  assert.equal(K.apply(s, { verb: 'cook', station: 'fryer', target: 'o99', opt: { until: 'golden' } })[0].reason, 'illegal');
  assert.equal(K.apply(s, { verb: 'take', station: 'fryer', bin: 'fries', opt: {} })[0].type, 'made');
});

test('Locked bins and upgrade slots stay hidden until bought', () => {
  const s = K.create(DINER, 1, { unlocked: ['hamburger', 'cheeseburger', 'fries', 'fountain'] });
  go(s, 'shakebar');
  assert.ok(!K.actions(s).some(a => a.bin === 'banana'));
  go(s, 'grill');
  K.apply(s, find(s, a => a.bin === 'patty'));
  assert.ok(!K.actions(s).some(a => a.bin === 'patty'), 'one grill spot until the upgrade');
});
