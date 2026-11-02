/** Ben's Burger Bar - coins, unlocks, upgrades, decor and the visitors' book.
 *
 *  Coins only go down when the player buys something, and nothing is ever required to
 *  keep playing (DESIGN.md "My Diner"). Plain JSON, saved as bb-progress:<pack>.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.BB = root.BB || {}).progress = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  const VERSION = 1;

  function create(pack) {
    const starters = Object.keys(pack.recipes).filter(r => !pack.recipes[r].unlock);
    const decor = {}, owned = [];
    for (const part of Object.keys(pack.decor || {})) {
      const free = pack.decor[part].options.find(o => !o.cost) || pack.decor[part].options[0];
      decor[part] = free.id;
      pack.decor[part].options.filter(o => !o.cost).forEach(o => owned.push(part + ':' + o.id));
    }
    return { v: VERSION, coins: 0, unlocked: starters, order: starters.slice(), decor, decorOwned: owned,
      best: {}, visitors: {}, regulars: [], shifts: 0 };
  }
  /** Ids the kitchen treats as unlocked: recipes, extras and upgrades bought. */
  const ids = (pack, g) => g.unlocked.slice();

  /** Everything in the shop. needs: something else that must be bought first. */
  function shop(pack, g) {
    const out = [];
    const entry = (id, kind, name, cost, needs) => {
      const owned = g.unlocked.includes(id);
      const ready = !needs || g.unlocked.includes(needs);
      out.push({ id, kind, name, cost, owned, ready, affordable: ready && !owned && g.coins >= cost });
    };
    for (const [id, R] of Object.entries(pack.recipes)) if (R.unlock) entry(id, 'recipe', R.name, R.unlock);
    for (const [id, X] of Object.entries(pack.extras || {})) entry(id, 'extra', X.name, X.cost, X.needs);
    for (const [id, U] of Object.entries(pack.upgrades || {})) entry(id, 'upgrade', U.name, U.cost, U.needs);
    for (const [part, D] of Object.entries(pack.decor || {})) {
      for (const o of D.options) {
        const id = 'decor:' + part + ':' + o.id, owned = g.decorOwned.includes(part + ':' + o.id);
        out.push({ id, kind: 'decor', name: D.name + ': ' + o.id, cost: o.cost, owned, ready: true, affordable: !owned && g.coins >= o.cost, using: g.decor[part] === o.id });
      }
    }
    return out;
  }

  /** Buy (or, for owned decor, switch to) something. Never takes coins below zero. */
  function buy(pack, g, id) {
    const item = shop(pack, g).find(x => x.id === id);
    if (!item) return { ok: false, reason: 'unknown' };
    if (item.kind === 'decor') {
      const [, part, opt] = id.split(':');
      if (!item.owned) {
        if (g.coins < item.cost) return { ok: false, reason: 'coins' };
        g.coins -= item.cost; g.decorOwned.push(part + ':' + opt);
      }
      g.decor[part] = opt;
      return { ok: true };
    }
    if (item.owned) return { ok: false, reason: 'owned' };
    if (!item.ready) return { ok: false, reason: 'needs' };
    if (g.coins < item.cost) return { ok: false, reason: 'coins' };
    g.coins -= item.cost;
    g.unlocked.push(id);
    if (item.kind === 'recipe') g.order.push(id);
    return { ok: true };
  }

  /** Fold a finished (or left) shift in: coins, best orders, the visitors' book, and
   *  walk-ins who have now been served enough times to become regulars. */
  function addShift(pack, g, shift) {
    g.coins += shift.coins;
    g.shifts += 1;
    const promoted = [];
    for (const r of shift.served) {
      for (const recipe of r.recipes) if (!g.best[recipe] || g.best[recipe] < r.stars) g.best[recipe] = r.stars;
      const v = g.visitors[r.customer.id] = g.visitors[r.customer.id] || { name: r.customer.name, served: 0, best: 0, walkIn: r.customer.walkIn };
      v.served += 1;
      v.best = Math.max(v.best, r.stars);
      if (r.walkIn && v.served >= (pack.servesToRegular || 3) && !g.regulars.some(c => c.id === r.customer.id)) {
        const c = Object.assign({}, r.walkIn, { walkIn: false, nickname: null, promoted: true });
        g.regulars.push(c);
        promoted.push(c);
      }
    }
    return { promoted };
  }

  return { VERSION, create, ids, shop, buy, addShift };
});
