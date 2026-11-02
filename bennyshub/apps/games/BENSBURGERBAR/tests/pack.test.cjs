'use strict';
/* Ben's Burger Bar - the packs check out, and the rules know no pack by name. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { SC, DINER, PIZZA, W, normalSpec } = require('./helpers.cjs');

test('The diner pack and the test pizzeria pass the pack check', () => {
  assert.deepEqual(SC.validate(DINER), []);
  assert.deepEqual(SC.validate(PIZZA), []);
});

test('The pack check catches broken packs', () => {
  const broken = JSON.parse(JSON.stringify(DINER));
  broken.ingredients.patty.traits.push('glowing');
  broken.recipes.cheeseburger.item.parts.push({ ing: 'unicorn' });
  broken.stations.grill.sendTo.push('moon');
  broken.regulars[0].likes.push(['caviar', 1]);
  broken.recipes.fries.item.done = { pick: 'nope' };
  broken.regulars[1].favourite.bonus = -0.2;
  const errs = SC.validate(broken).join('\n');
  for (const want of ['unknown trait glowing', 'unknown ingredient unicorn', 'unknown station moon', 'unknown recipe caviar', 'unknown pick nope', 'only adds']) {
    assert.ok(errs.includes(want), 'expected: ' + want + '\n' + errs);
  }
});

test('No rules module names an ingredient, station or recipe from any pack', () => {
  const ids = new Set();
  for (const p of [DINER, PIZZA]) [...Object.keys(p.ingredients), ...Object.keys(p.stations), ...Object.keys(p.recipes)].forEach(i => ids.add(i));
  const dir = path.join(__dirname, '..', 'js', 'core');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const id of ids) assert.ok(!new RegExp('[\'"`]' + id + '[\'"`]').test(src), f + ' names "' + id + '"');
  }
});

test('Rules modules use no DOM, timers or Math.random', () => {
  const dir = path.join(__dirname, '..', 'js', 'core');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const bad of ['document.', 'Math.random', 'setTimeout', 'setInterval', 'Date.now', 'THREE', 'localStorage']) {
      assert.ok(!src.includes(bad), f + ' uses ' + bad);
    }
  }
});

test('Every recipe reads out as a ticket', () => {
  for (const pack of [DINER, PIZZA]) {
    for (const r of Object.keys(pack.recipes)) {
      const line = W.ticket(pack, { items: [normalSpec(pack, r)] });
      assert.match(line, /^[A-Z].+\.$/, r + ': ' + line);
      assert.ok(!/undefined|NaN|\[object/.test(line), r + ': ' + line);
    }
  }
  assert.equal(W.ticket(DINER, { items: [normalSpec(DINER, 'cheeseburger'), normalSpec(DINER, 'fries')] }), 'Cheeseburger, medium and Fries, golden.');
});
