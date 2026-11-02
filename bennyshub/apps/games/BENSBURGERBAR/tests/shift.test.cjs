'use strict';
/* Ben's Burger Bar - shifts, saves and progress. */
const test = require('node:test'), assert = require('node:assert/strict');
const { SH, G, F, K, DINER, PIZZA, botShift, continueShift, everything } = require('./helpers.cjs');

const clone = o => JSON.parse(JSON.stringify(o));

test('Bot shifts finish under every settings combination (10 seeds each), every order at 1 star or more', () => {
  const combos = [];
  for (const cooking of ['pick', 'timed']) for (const pouring of ['auto', 'hold'])
    for (const orders of ['simple', 'usual', 'fancy']) for (const customersAtOnce of [1, 3])
      combos.push({ cooking, pouring, orders, customersAtOnce, shiftLength: 5, burning: cooking === 'timed', speed: 'normal' });
  for (const [i, settings] of combos.entries()) {
    for (let seed = 0; seed < 10; seed++) {
      const progress = seed % 2 ? everything(DINER) : G.create(DINER);
      const { s, out } = botShift(DINER, { seed: 1000 * i + seed + 1, settings, progress });
      const where = JSON.stringify(settings);
      assert.equal(out.noRoute, null, where);
      assert.ok(s.done, where + ' did not finish');
      assert.equal(s.served.length, 5);
      s.served.forEach(r => assert.ok(r.stars >= 1 && r.tip >= 1, where));
      assert.ok(s.served.some(r => !r.customer.walkIn), 'at least one regular');
    }
  }
});

test('A shift saves and restores exactly', () => {
  const settings = { cooking: 'timed', pouring: 'hold', orders: 'fancy', customersAtOnce: 2, shiftLength: 8, speed: 'slow' };
  const { s } = botShift(DINER, { seed: 42, settings, progress: everything(DINER) }, 3);
  assert.ok(!s.done && s.served.length >= 3);
  const saved = JSON.stringify(F.wrap('shift', DINER, s));
  continueShift(s);

  const back = F.read('shift', saved, DINER);
  assert.ok(back.ok);
  const restored = back.data;
  continueShift(restored);
  assert.deepEqual(restored, s, 'the restored shift plays out identically');
  assert.ok(s.done);
});

test('Pause freezes the shift', () => {
  const { s } = botShift(DINER, { seed: 9, settings: { cooking: 'timed', speed: 'normal' }, progress: everything(DINER) }, 0);
  K.apply(s.kitchen, { verb: 'go', station: s.kitchen.at, opt: { to: 'grill' } });
  K.apply(s.kitchen, { verb: 'take', station: 'grill', bin: 'patty', opt: {} });
  K.apply(s.kitchen, { verb: 'cook', station: 'grill', target: s.kitchen.stations.grill.slots.g1.uid, opt: { start: true } });
  const before = clone(s);
  SH.pause(s, true);
  assert.deepEqual(SH.tick(s, 500), []);
  SH.pause(s, false);
  before.kitchen.paused = false;
  assert.deepEqual(s, before);
  assert.ok(SH.tick(s, 30).length > 0);
});

test('Saves: newer saves are kept, a pack change drops only the shift', () => {
  const g = G.create(DINER);
  g.coins = 77;
  const rec = F.wrap('progress', DINER, g);
  const newer = Object.assign({}, rec, { v: rec.v + 1 });
  assert.deepEqual(F.read('progress', newer, DINER), { ok: false, reason: 'newer', keep: true });
  assert.equal(F.canWrite('progress', JSON.stringify(newer)), false, 'never overwrite a newer save');
  assert.equal(F.canWrite('progress', JSON.stringify(rec)), true);

  const changed = Object.assign({}, DINER, { version: DINER.version + 1 });
  const p = F.read('progress', rec, changed);
  assert.ok(p.ok && p.data.coins === 77, 'coins kept');
  const shiftRec = F.wrap('shift', DINER, SH.create(DINER, { seed: 1 }));
  assert.deepEqual(F.read('shift', shiftRec, changed), { ok: false, reason: 'packVersion', keep: false });
  assert.equal(F.read('shift', '{not json', DINER).reason, 'corrupt');
  assert.equal(F.key('shift', DINER), 'bb-shift:diner');
  assert.equal(F.read('settings', F.wrap('settings', DINER, { cooking: 'timed' }), DINER).data.pouring, 'auto', 'missing settings take defaults');
});

test('Progress: coins never go negative and every unlock is reachable', () => {
  for (const pack of [DINER, PIZZA]) {
    const g = G.create(pack);
    assert.ok(!G.buy(pack, g, 'decor:neonSign:rocket').ok || pack !== DINER);
    let guard = 0;
    for (;;) {
      const left = G.shop(pack, g).filter(x => !x.owned);
      if (!left.length) break;
      const ready = left.filter(x => x.ready).sort((a, b) => a.cost - b.cost)[0];
      assert.ok(ready, pack.id + ': nothing buyable but ' + left.map(x => x.id).join());
      if (g.coins < ready.cost) {
        assert.equal(G.buy(pack, g, ready.id).reason, 'coins');
        g.coins += ready.cost;
      }
      assert.ok(G.buy(pack, g, ready.id).ok, ready.id);
      assert.ok(g.coins >= 0);
      if (++guard > 500) throw new Error('loop');
    }
    assert.deepEqual(new Set(g.unlocked), new Set(K.allIds(pack)));
  }
});

test('A walk-in served three times becomes a regular', () => {
  const g = everything(DINER);
  const walk = { id: 'walk:olive:0', name: 'Olive', walkIn: true, likes: [] };
  const shift = { coins: 5, served: [{ customer: { id: walk.id, name: 'Olive', walkIn: true }, walkIn: walk, recipes: ['fries'], stars: 3 }] };
  assert.deepEqual(G.addShift(DINER, g, shift).promoted, []);
  G.addShift(DINER, g, shift);
  const third = G.addShift(DINER, g, shift).promoted;
  assert.equal(third.length, 1);
  assert.equal(third[0].name, 'Olive');
  assert.equal(g.coins, 15);
  const s = SH.create(DINER, { seed: 3, progress: g, settings: { shiftLength: 8 } });
  assert.ok(s.extraRegulars.some(c => c.id === walk.id), 'she can come back as a regular');
});
