/** Ben's Burger Bar - orders and walk-ins.
 *
 *  One generator for every customer, regular or walk-in. A customer's personality picks
 *  WHAT they order; the Orders setting alone decides HOW MUCH (DESIGN.md "Customers").
 *
 *  An order item ("spec") is a recipe template made concrete:
 *    { recipe, ing, size?, mixed?, done?, parts: [{ ing, done?, amount?, count?, faces? }],
 *      holds: [ing], adds: [ing], with? }   with: the only extras, when the setting trims them
 *  The planner builds from it, scoring checks against it and words.js reads it out.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rng.js'));
  else (root.BB = root.BB || {}).orders = factory(root.BB.rng);
})(typeof window === 'undefined' ? globalThis : window, function (R) {
  'use strict';

  const clone = o => JSON.parse(JSON.stringify(o));

  /** The values a pick may take now (some wait for an unlock). */
  function pickValues(pack, name, unlocked, fancy) {
    const P = pack.picks[name];
    const gate = (pack.pickUnlocks || {})[name] || {};
    const list = (fancy && P.fancy) || P.values;
    return list.filter(v => !gate[v] || unlocked.includes(gate[v]));
  }

  /** A recipe template -> one concrete item. s carries the rng.
   *  ctx = { style, set: { pick: value }, dislikes: [ing], unlocked, maxOptional, exact, change? }
   *  change 0 gives the recipe exactly as written (the planner's press counts use it). */
  function resolve(pack, recipeId, s, ctx) {
    const style = pack.orderStyles[ctx.style || 'usual'];
    const change = ctx.change !== undefined ? ctx.change : ctx.exact ? Math.max(style.change, 0.5) : style.change;
    const set = ctx.set || {}, dislikes = ctx.dislikes || [], unlocked = ctx.unlocked || [];
    const chosen = {};
    const pick = (v) => {
      if (!v || typeof v !== 'object' || !v.pick) return { value: v, picked: false };
      const name = v.pick;
      if (!(name in chosen)) {
        if (set[name] !== undefined) chosen[name] = set[name];
        else {
          const values = pickValues(pack, name, unlocked, style.fancy);
          const normal = values.includes(pack.picks[name].normal) ? pack.picks[name].normal : values[0];
          chosen[name] = R.chance(s, change) ? R.pick(s, values) : normal;
        }
      }
      return { value: chosen[name], picked: true, normal: pack.picks[name].normal };
    };
    const T = pack.recipes[recipeId].item;
    const spec = { recipe: recipeId, ing: pick(T.ing).value, parts: [], holds: [], adds: [] };
    if (T.size) spec.size = pick(T.size).value;
    if (T.mixed) spec.mixed = T.mixed;
    if (T.done) spec.done = pick(T.done).value;
    const optional = [];
    for (const tp of T.parts) {
      const ingPick = pick(tp.ing);
      const p = { ing: ingPick.value, parts: [] };
      if (ingPick.picked) p.flavour = true;
      if (tp.done) p.done = pick(tp.done).value;
      if (tp.faces) p.faces = tp.faces;
      if (tp.chopped) p.chopped = tp.chopped;
      if (tp.count !== undefined) p.count = pick(tp.count).value;
      if (tp.amount) {
        const a = pick(tp.amount);
        p.amount = a.value;
        if ((a.picked && a.value !== a.normal) || ctx.exact) p.sayAmount = true;
      }
      if (tp.opt === 'in') {
        if (dislikes.includes(p.ing) || R.chance(s, change * 0.5)) { spec.holds.push(p.ing); continue; }
        optional.push(p);
      } else if (tp.opt === 'out') {
        if (dislikes.includes(p.ing) || !R.chance(s, change * 0.4)) continue;
        spec.adds.push(p.ing);
        optional.push(p);
      }
      spec.parts.push(p);
    }
    const max = ctx.maxOptional !== undefined ? ctx.maxOptional : style.maxOptional;
    if (max !== undefined && optional.length > max) {
      const cut = R.shuffle(s, optional.slice()).slice(max);
      cut.forEach(p => { spec.parts.splice(spec.parts.indexOf(p), 1); });
      spec.holds = spec.holds.filter(h => !cut.some(p => p.ing === h));
      spec.adds = spec.adds.filter(h => !cut.some(p => p.ing === h));
      spec.with = optional.filter(p => !cut.includes(p)).map(p => p.ing);
    }
    return spec;
  }

  /** The items a customer orders.
   *  ctx = { customer, style, unlocked, special, newest } */
  function order(pack, s, ctx) {
    const C = ctx.customer, style = pack.orderStyles[ctx.style || 'usual'];
    const recipes = Object.keys(pack.recipes).filter(r => ctx.unlocked.includes(r));
    let [lo, hi] = style.items;
    if (C.short) hi = Math.min(hi, 2);
    lo = Math.min(lo, hi);
    const n = lo + R.int(s, hi - lo + 1);
    const rctx = {
      style: ctx.style, set: Object.assign({}, C.set, C.wants), dislikes: C.dislikes, unlocked: ctx.unlocked,
      exact: C.exact, maxOptional: C.short ? Math.min(2, style.maxOptional === undefined ? 2 : style.maxOptional) : undefined,
    };
    const make = (r, set, change) => resolve(pack, r, s, Object.assign({}, rctx, { set: Object.assign({}, rctx.set, set), change }));

    // "The usual, hon": the same every time, as written.
    if (C.usual && C.usual.every(u => recipes.includes(u.recipe))) {
      return C.usual.slice(0, hi).map(u => make(u.recipe, u.set, 0));
    }
    const likes = new Map((C.likes || []).filter(([r]) => recipes.includes(r)));
    const weight = r => (likes.get(r) || 0.5) + (r === ctx.special ? 2 : 0);
    if (C.twin && n >= 2) {
      const one = make(R.weighted(s, recipes.map(r => [r, weight(r)])));
      return [one, clone(one)];
    }
    const chosen = [];
    (C.always || []).forEach(r => { if (recipes.includes(r) && chosen.length < n) chosen.push(r); });
    if (C.newest && ctx.newest && recipes.includes(ctx.newest) && !chosen.includes(ctx.newest) && chosen.length < n) chosen.push(ctx.newest);
    while (chosen.length < n) {
      const left = recipes.filter(r => !chosen.includes(r));
      if (!left.length) break;
      chosen.push(R.weighted(s, left.map(r => [r, weight(r)])));
    }
    return chosen.map(r => make(r));
  }

  /** A one-off customer built from parts: look, name, voice and one or two quirks. */
  function walkIn(pack, s, n) {
    const W = pack.walkIns, look = {};
    Object.keys(W.looks).forEach(k => { look[k] = R.pick(s, W.looks[k]); });
    const name = R.pick(s, W.names);
    const C = { id: 'walk:' + name.toLowerCase() + ':' + n, name, walkIn: true, look, voice: R.pick(s, W.voices),
      ordering: R.pick(s, W.ordering), reacting: R.pick(s, W.reacting), likes: [] };
    const quirk = R.int(s, 3);
    if (quirk !== 1) C.favourite = R.pick(s, W.favourites);
    if (quirk !== 0) C.dislikes = [R.pick(s, W.dislikes)];
    if (C.favourite && C.favourite.kind === 'recipe') C.likes = [[C.favourite.recipe, 3]];
    return C;
  }

  return { resolve, order, walkIn, pickValues };
});
