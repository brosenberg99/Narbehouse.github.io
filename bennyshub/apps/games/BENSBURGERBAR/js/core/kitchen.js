/** Ben's Burger Bar - the kitchen.
 *
 *  K.create(pack, seed, opts) -> state, plain JSON.
 *  K.actions(state)           -> every legal action at the station the player is at.
 *  K.apply(state, action)     -> events. The only way the kitchen changes.
 *  K.tick(state, dt)          -> events. Time It Yourself cooking; nothing else moves on
 *                                its own, and with Pick the Doneness nothing moves at all.
 *
 *  An action is only legal at the station the player stands at, and only if it is one
 *  K.actions lists, so the menus, the planner bot and the tests can never do anything
 *  the player could not. A Hold to Pour release matches its listed action by everything
 *  except the amount.
 *
 *  rules = { cooking: pick|timed, speed: verySlow|slow|normal, burning, pouring: auto|hold }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./items.js'), require('./verbs.js'));
  else (root.BB = root.BB || {}).kitchen = factory(root.BB.items, root.BB.verbs);
})(typeof window === 'undefined' ? globalThis : window, function (I, V) {
  'use strict';

  const VERSION = 1;
  const DEFAULT_RULES = { cooking: 'pick', speed: 'verySlow', burning: false, pouring: 'auto' };

  function create(pack, seed, opts) {
    opts = opts || {};
    I.register(pack);
    const state = {
      v: VERSION, pack: pack.id, packVersion: pack.version, rng: (seed >>> 0) || 1,
      uid: 0, nums: {}, at: pack.start, hand: null, stations: {}, tickets: [], paused: false,
      rules: Object.assign({}, DEFAULT_RULES, opts.rules || {}),
      unlocked: (opts.unlocked || allIds(pack)).slice(),
    };
    if (state.rules.cooking !== 'timed') state.rules.burning = false;
    for (const sid of Object.keys(pack.stations)) {
      state.stations[sid] = { slots: {} };
      for (const sl of pack.stations[sid].slots) {
        state.stations[sid].slots[sl.id] = sl.fixed ? I.make(state, pack, sl.fixed) : null;
      }
    }
    return state;
  }
  /** Everything that can be unlocked: Free Cook and the tests start with all of it. */
  const allIds = pack => [...Object.keys(pack.recipes), ...Object.keys(pack.extras || {}), ...Object.keys(pack.upgrades || {})];

  function setRules(state, rules) {
    Object.assign(state.rules, rules);
    if (state.rules.cooking !== 'timed') state.rules.burning = false;
    if (state.rules.cooking !== 'timed') I.each(state, o => { if (o.cooking) o.cooking = false; });
  }

  const cxOf = state => ({ pack: I.packOf(state), state, rules: state.rules });

  function actions(state, sid) {
    const cx = cxOf(state), pack = cx.pack;
    sid = sid || state.at;
    const st = pack.stations[sid], out = [];
    const add = (verb, base, list) => list.forEach(o => out.push(Object.assign({ verb, station: sid }, base, { opt: o.opt })));
    for (const at of V.topLevel(cx, sid)) {
      for (const verb of st.verbs) {
        const v = V.VERBS[verb];
        if (v.forObject) add(verb, { target: at.obj.uid }, v.forObject(cx, sid, at));
      }
    }
    for (const bin of st.bins) {
      if (!V.owned(cx, bin.unlock)) continue;
      add(bin.verb, { bin: bin.id }, V.VERBS[bin.verb].forBin(cx, sid, bin));
    }
    if (state.hand) add('place', { target: 'hand' }, V.VERBS.place.forHand(cx, sid));
    for (const verb of st.verbs) {
      const v = V.VERBS[verb];
      if (v.forStation) add(verb, {}, v.forStation(cx, sid));
    }
    for (const to of pack.stationOrder) if (to !== sid) out.push({ verb: 'go', station: sid, opt: { to } });
    return out;
  }

  /** A stable key for an action. amount/level/mech are left out with `loose`, so a
   *  Hold to Pour release matches the pour it started from. */
  function key(a, loose) {
    const opt = Object.keys(a.opt || {}).sort()
      .filter(k => !(loose && (k === 'amount' || k === 'level' || k === 'mech')))
      .map(k => k + '=' + a.opt[k]).join(',');
    return [a.verb, a.station, a.target || '', a.bin || '', opt].join('|');
  }

  function apply(state, a) {
    if (state.paused) return [{ type: 'refused', reason: 'paused' }];
    if (a.station !== state.at) return [{ type: 'refused', reason: 'elsewhere' }];
    const k = key(a, true);
    if (!actions(state).some(b => key(b, true) === k)) return [{ type: 'refused', reason: 'illegal', key: key(a) }];
    if (a.verb === 'go') { state.at = a.opt.to; return [{ type: 'went', to: a.opt.to }]; }
    return V.VERBS[a.verb].apply(cxOf(state), a);
  }

  function tick(state, dt) {
    if (state.paused || state.rules.cooking !== 'timed' || !(dt > 0)) return [];
    return V.VERBS.cook.tick(cxOf(state), dt);
  }

  /** Hold to Pour, as the mech context drives it: start, hold(dt) while held, release. */
  const pourStart = (state, a) => V.VERBS[a.verb].mechanic.start(cxOf(state), a);
  const pourHold = (m, dt) => V.VERBS.pour.mechanic.hold(m, dt);
  const pourRelease = m => V.VERBS.pour.mechanic.release(m);

  return { VERSION, DEFAULT_RULES, create, setRules, actions, key, apply, tick, allIds, pourStart, pourHold, pourRelease };
});
