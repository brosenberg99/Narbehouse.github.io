'use strict';
/* Ben's Burger Bar - shared test helpers. Node only. */
const path = require('node:path');
const core = name => require(path.join(__dirname, '..', 'js', 'core', name + '.js'));

const I = core('items'), K = core('kitchen'), M = core('menus'), O = core('orders'), S = core('scoring');
const PL = core('planner'), SH = core('shift'), G = core('progress'), F = core('savefmt'), SC = core('schema');
const W = core('words'), V = core('verbs'), R = core('rng');
const DINER = require(path.join(__dirname, '..', 'packs', 'diner', 'pack.js'));
const PIZZA = require(path.join(__dirname, 'packs', 'test-pizza', 'pack.js'));

/** The rule combinations every recipe is played under. */
const MODES = [
  { cooking: 'pick', pouring: 'auto' },
  { cooking: 'pick', pouring: 'hold' },
  { cooking: 'timed', pouring: 'auto', speed: 'verySlow' },
  { cooking: 'timed', pouring: 'hold', speed: 'normal', burning: true },
];

/** A recipe exactly as written, as a one-item ticket. */
function normalSpec(pack, recipe) {
  return O.resolve(pack, recipe, { rng: 3 }, { style: 'usual', change: 0, unlocked: K.allIds(pack) });
}
function kitchenWith(pack, items, rules, seed) {
  const s = K.create(pack, seed || 5, { rules });
  s.tickets = [{ id: 1, customer: { id: 'test', name: 'Test' }, items }];
  return s;
}

/** Every action the kitchen allows is one select in the menu tree, and every leaf is
 *  an action the kitchen allows. Returns a list of problems. */
function routeProblems(state, settings) {
  const tree = M.station(state, state.at, settings || {});
  const leaves = M.leaves(tree);
  const problems = [];
  const leafKeys = new Map(leaves.filter(L => L.item.action).map(L => [K.key(L.item.action), L]));
  for (const a of K.actions(state)) {
    const L = leafKeys.get(K.key(a));
    if (!L) problems.push('no leaf for ' + K.key(a));
    else if (L.item.kind === 'mech' && state.rules.pouring !== 'hold') problems.push('hold needed for ' + K.key(a));
  }
  const legal = new Set(K.actions(state).map(a => K.key(a)));
  for (const L of leaves) if (L.item.action && !legal.has(K.key(L.item.action))) problems.push('illegal leaf ' + L.ids.join('>'));
  const ids = [];
  const walk = list => list.forEach(it => { ids.push(it.id); if (it.children) walk(it.children); });
  tree.items.forEach(it => { if (it.children) { const seen = new Set(); it.children.forEach(c => { if (seen.has(c.id)) problems.push('id twice in ' + it.id + ': ' + c.id); seen.add(c.id); }); } });
  const root = tree.items.map(it => it.id);
  if (new Set(root).size !== root.length) problems.push('root ids repeat');
  if (root[root.length - 1] !== 'pause') problems.push('pause is not last');
  return problems;
}

/** A driver that checks the single-press route at every state before acting. */
function checkedDriver(state, settings, problems) {
  return {
    state: () => state,
    apply: a => { problems.push(...routeProblems(state, settings)); return K.apply(state, a); },
    tick: dt => K.tick(state, dt),
  };
}

function playRecipe(pack, recipe, rules, opts) {
  const s = kitchenWith(pack, [normalSpec(pack, recipe)], rules);
  const problems = [];
  const out = PL.run(checkedDriver(s, {}, problems), opts || {});
  const served = out.events.find(e => e.type === 'served');
  const score = served ? S.score(pack, served.ticket, served.items, s.rules) : null;
  return { out, served, score, problems, state: s };
}

function botShift(pack, opts, untilServed) {
  const s = SH.create(pack, opts);
  const out = PL.run({ state: () => s.kitchen, apply: a => SH.apply(s, a), tick: dt => SH.tick(s, dt) },
    { until: () => s.done || (untilServed !== undefined && s.served.length >= untilServed), maxSteps: 40000 });
  return { s, out };
}
function continueShift(s) {
  return PL.run({ state: () => s.kitchen, apply: a => SH.apply(s, a), tick: dt => SH.tick(s, dt) },
    { until: () => s.done, maxSteps: 40000 });
}
const everything = pack => {
  const g = G.create(pack);
  g.unlocked = K.allIds(pack);
  g.order = Object.keys(pack.recipes);
  return g;
};

module.exports = { I, K, M, O, S, PL, SH, G, F, SC, W, V, R, DINER, PIZZA, MODES, normalSpec, kitchenWith,
  routeProblems, checkedDriver, playRecipe, botShift, continueShift, everything };
