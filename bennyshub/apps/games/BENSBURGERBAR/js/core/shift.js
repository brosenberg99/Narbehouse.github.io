/** Ben's Burger Bar - a shift.
 *
 *  Customers arrive one ticket at a time (up to Customers at Once), each order is made
 *  in the kitchen and served at the counter, and after Shift Length customers the shift
 *  is done. The next customer only arrives after a serve: nobody waits, leaves or hurries.
 *
 *  The whole shift is plain JSON, kitchen included, with its own seeded rng, so a saved
 *  shift continues exactly (DESIGN.md "Saves").
 *
 *  Shift.create(pack, { seed, settings, progress }) -> state
 *  Shift.apply(state, action) -> events   (kitchen events, plus arrived / scored / done)
 *  Shift.tick(state, dt) -> events        (Time It Yourself; nothing moves while paused)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./rng.js'), require('./items.js'), require('./kitchen.js'), require('./orders.js'),
      require('./scoring.js'), require('./progress.js'), require('./savefmt.js'));
  } else {
    const B = root.BB = root.BB || {};
    B.shift = factory(B.rng, B.items, B.kitchen, B.orders, B.scoring, B.progress, B.savefmt);
  }
})(typeof window === 'undefined' ? globalThis : window, function (R, I, K, O, S, G, F) {
  'use strict';

  const VERSION = 1;

  function create(pack, opts) {
    opts = opts || {};
    I.register(pack);
    const settings = Object.assign({}, F.DEFAULT_SETTINGS, opts.settings || {});
    const progress = opts.progress || G.create(pack);
    const unlocked = G.ids(pack, progress);
    const s = {
      v: VERSION, pack: pack.id, packVersion: pack.version, rng: R.seed(opts.seed || 1),
      kitchen: K.create(pack, opts.seed || 1, { rules: F.rulesFrom(settings), unlocked }),
      length: +settings.shiftLength, atOnce: +settings.customersAtOnce, orders: settings.orders,
      arrived: 0, served: [], coins: 0, nextTicket: 1, seen: [], regulars: 0, done: false,
      special: null, newest: progress.order[progress.order.length - 1] || null,
      extraRegulars: (progress.regulars || []).slice(),
    };
    const recipes = Object.keys(pack.recipes).filter(r => unlocked.includes(r));
    s.special = R.pick(s, recipes);
    s.recipesUnlocked = recipes.length;
    arrive(pack, s);
    return s;
  }

  /** The share of regulars by how many recipes are unlocked. */
  function regularShare(pack, n) {
    let share = 0.5;
    for (const step of pack.customerMix || []) if (n >= step.recipes) share = step.regulars;
    return share;
  }
  function nextCustomer(pack, s) {
    const pool = pack.regulars.concat(s.extraRegulars).filter(c => !s.seen.includes(c.id));
    const last = s.arrived === s.length - 1;
    const wantRegular = pool.length && ((last && !s.regulars) || R.chance(s, regularShare(pack, s.recipesUnlocked)));
    if (wantRegular) { s.regulars += 1; const c = R.pick(s, pool); s.seen.push(c.id); return c; }
    return O.walkIn(pack, s, s.arrived);
  }
  function arrive(pack, s) {
    const events = [];
    const unlocked = s.kitchen.unlocked;
    while (s.kitchen.tickets.length < s.atOnce && s.arrived < s.length) {
      const customer = nextCustomer(pack, s);
      const items = O.order(pack, s, { customer, style: s.orders, unlocked, special: s.special, newest: s.newest });
      const ticket = { id: s.nextTicket++, customer, items, special: s.special };
      s.kitchen.tickets.push(ticket);
      s.arrived += 1;
      events.push({ type: 'arrived', ticket });
    }
    return events;
  }

  function apply(s, action) {
    const pack = I.packOf(s.kitchen);
    const events = K.apply(s.kitchen, action);
    const out = events.slice();
    for (const e of events) {
      if (e.type !== 'served') continue;
      const sc = S.score(pack, e.ticket, e.items, s.kitchen.rules);
      const rec = { ticket: e.ticket.id, customer: { id: e.ticket.customer.id, name: e.ticket.customer.name, walkIn: !!e.ticket.customer.walkIn },
        recipes: e.ticket.items.map(i => i.recipe), stars: sc.stars, q: sc.q, tip: sc.tip, silly: sc.silly.map(x => x.id) };
      if (e.ticket.customer.walkIn) rec.walkIn = e.ticket.customer;
      s.served.push(rec);
      s.coins += sc.tip;
      out.push(Object.assign({ type: 'scored' }, rec, { score: sc }));
      out.push(...arrive(pack, s));
      if (s.served.length >= s.length) { s.done = true; out.push({ type: 'done', results: results(s) }); }
    }
    return out;
  }
  const tick = (s, dt) => K.tick(s.kitchen, dt);
  function pause(s, on) { s.kitchen.paused = !!on; }

  function results(s) {
    const best = s.served.slice().sort((a, b) => b.q - a.q).slice(0, 3);
    return { coins: s.coins, orders: s.served.length, stars: s.served.map(r => r.stars), best };
  }

  return { VERSION, create, apply, tick, pause, results };
});
