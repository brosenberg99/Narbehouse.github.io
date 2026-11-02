'use strict';
/* Ben's Burger Bar - the station menus the M1 screens scan (DESIGN.md "A station's scan").
   The scanner itself (the blank -1, the Back stop, real keys) is checked in headless Chrome
   by tools/check-browser.cjs; these check the trees it is given and where it goes next.
   node --test bennyshub/apps/games/BENSBURGERBAR/tests/ */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { K, M, PL, DINER, kitchenWith, normalSpec } = require('./helpers.cjs');

const go = (s, to) => K.apply(s, { verb: 'go', station: s.at, opt: { to } });
const leafFor = (s, a) => M.find(M.station(s, s.at, {}), a);
const ids = list => list.map(it => it.id);

test('ids are stable across redraws: a thing keeps its id while it stays put', () => {
  const s = kitchenWith(DINER, [normalSpec(DINER, 'cheeseburger')], { cooking: 'pick' });
  go(s, 'grill');
  K.apply(s, K.actions(s).find(a => a.bin === 'patty'));
  const before = M.station(s, 'grill', {});
  const row = before.items.find(it => it.id.startsWith('obj:'));
  K.apply(s, K.actions(s).find(a => a.verb === 'cook' && a.opt.until === 'rare'));
  const after = M.station(s, 'grill', {});
  assert.ok(after.items.some(it => it.id === row.id), 'the patty keeps its row id once cooked');
  assert.ok(after.items.find(it => it.id === row.id).children.some(c => c.id === 'verb:flip'), 'Flip keeps its id');
  assert.notEqual(after.items.find(it => it.id === row.id).label, row.label, 'the label says the new state');
});

test('every root ends with Pause, has no repeats, and rows have no Back items of their own', () => {
  for (const recipe of ['hamburger', 'cheeseburger']) {
    const s = kitchenWith(DINER, [normalSpec(DINER, recipe)], { cooking: 'pick' });
    const driver = PL.kitchenDriver(s), seen = [];
    const check = () => {
      const tree = M.station(s, s.at, {});
      const root = ids(tree.items);
      assert.equal(root[root.length - 1], 'pause', 'Pause is last at ' + s.at);
      assert.equal(new Set(root).size, root.length, 'no repeated ids at ' + s.at);
      const walk = list => list.forEach(it => {
        assert.ok(!/^back$/i.test(it.label), 'no Back plate in ' + it.id);
        if (it.children) { assert.ok(it.children.length > 0, 'no empty row ' + it.id); walk(it.children); }
      });
      walk(tree.items);
      seen.push(s.at);
    };
    PL.run({ state: driver.state, tick: driver.tick, apply: a => { check(); return driver.apply(a); } }, { until: st => !st.tickets.length });
    assert.ok(seen.includes('grill') && seen.includes('board') && seen.includes('counter'));
  }
});

test('after a choice the scan stays in its row: on the same item, or on the Back stop', () => {
  const s = kitchenWith(DINER, [normalSpec(DINER, 'cheeseburger')], { cooking: 'pick' });
  go(s, 'grill');
  K.apply(s, K.actions(s).find(a => a.bin === 'patty'));
  const patty = M.station(s, 'grill', {}).items.find(it => it.id.startsWith('obj:')).id;

  // Cook to Medium: that stage is gone from Cook Until..., so the scan waits on its Back stop.
  const cook = K.actions(s).find(a => a.verb === 'cook' && a.opt.until === 'medium');
  const cookIds = leafFor(s, cook).ids;
  assert.deepEqual(cookIds, [patty, 'verb:cook', 'verb:cook:medium']);
  K.apply(s, cook);
  assert.deepEqual(M.resume(M.station(s, 'grill', {}), cookIds), { rows: [patty, 'verb:cook'], land: 'back' });

  // Flip: still there, so the scan stays on Flip, ready to cook the other side.
  const flip = K.actions(s).find(a => a.verb === 'flip');
  const flipIds = leafFor(s, flip).ids;
  K.apply(s, flip);
  assert.deepEqual(M.resume(M.station(s, 'grill', {}), flipIds), { rows: [patty], land: 'verb:flip' });

  // Send to the Board: the patty's row is gone, so the scan clears to the blank -1.
  const send = K.actions(s).find(a => a.verb === 'send' && a.opt.to === 'board');
  const sendIds = leafFor(s, send).ids;
  K.apply(s, send);
  assert.deepEqual(M.resume(M.station(s, 'grill', {}), sendIds), { rows: [], land: null });

  // A bin at the root stays lit after it is used (a second slice of cheese is one select).
  go(s, 'board');
  const bun = K.actions(s).find(a => a.bin === 'bunBottom');
  const bunIds = leafFor(s, bun).ids;
  K.apply(s, bun);
  assert.deepEqual(M.resume(M.station(s, 'board', {}), bunIds), { rows: [], land: 'bin:bunBottom' });
});

test('the screens enter every row with enterGroup({wrap:true, backStop:true}) and nothing else', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');
  const calls = src.match(/\.enterGroup\([^;]*\)/g) || [];
  assert.ok(calls.length >= 2, 'rows are entered');
  for (const c of calls) assert.match(c, /wrap: true, backStop: true/, c);
  assert.ok(!/\.open\(|createChoiceScan/.test(src), 'only the adapter drives the scanner');
});
