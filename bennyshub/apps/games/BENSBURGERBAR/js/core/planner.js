/** Ben's Burger Bar - the planner bot.
 *
 *  next(state) looks at the kitchen and the first ticket and says the one next step
 *  toward serving it: an action, { wait: true } while timed food cooks, or null. It
 *  picks up where the kitchen is (a half-built burger, a patty on the grill), so the
 *  same call drives the bot shifts and the Next-Step Star.
 *
 *  run() plays it through the real menus: every step must be a leaf of
 *  menus.station(), or the run fails with no single-press route. It counts what a
 *  player would press:
 *    choices  selects, including leaving a row by its Back stop (one-switch presses)
 *    steps    moves of the highlight between them (two-switch "next" presses)
 *  using the scan rules in DESIGN.md: rows return to where they were after a choice,
 *  a gone row clears to the blank -1, and a new station opens fresh.
 *
 *  It builds by the recipe's own data: where a container is made, where each part's bin
 *  is, what must cook and to what stage. No ingredient ids appear here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./items.js'), require('./kitchen.js'), require('./menus.js'), require('./scoring.js'));
  else (root.BB = root.BB || {}).planner = factory(root.BB.items, root.BB.kitchen, root.BB.menus, root.BB.scoring);
})(typeof window === 'undefined' ? globalThis : window, function (I, K, M, S) {
  'use strict';

  /* ── where things are made ──────────────────────────────────────────────── */
  const binsFor = (pack, fn) => {
    const out = [];
    for (const sid of pack.stationOrder) for (const b of pack.stations[sid].bins) if (fn(b, sid)) out.push({ sid, bin: b });
    return out;
  };
  const makesIng = (pack, b, ingId) => b.ing === ingId || I.ing(pack, b.ing).creates === ingId;
  /** Where an item is put together: the station that can start it and has the most of its parts. */
  function homeOf(pack, spec) {
    const starts = pack.stationOrder.filter(sid => {
      const st = pack.stations[sid];
      return st.bins.some(b => makesIng(pack, b, spec.ing) || (b.into && b.into[0] === spec.ing)) || (st.makes || []).includes(spec.ing);
    });
    const cover = sid => spec.parts.filter(p => pack.stations[sid].bins.some(b => makesIng(pack, b, p.ing))).length;
    return starts.sort((a, b) => cover(b) - cover(a))[0];
  }
  /** The bin a part comes from, preferring one that puts it straight into this kind of thing. */
  function sourceOf(pack, ingId, intoIng) {
    const all = binsFor(pack, b => makesIng(pack, b, ingId));
    return all.find(x => x.bin.into && x.bin.into.includes(intoIng)) || all.find(x => !x.bin.into) || all[0];
  }
  /** Parts cooked on their own before they go on (a patty), not with the whole item
   *  (the bread of a grilled cheese, the base of a pizza). */
  const cooksSeparately = (pack, spec, p) => !!p.done && I.has(pack, p.ing, 'cookable') && !I.has(pack, spec.ing, 'onHeat');

  /* ── reading the kitchen ────────────────────────────────────────────────── */
  /** Everything sitting loose in a slot or in the hand (not inside something else). */
  const top = (state) => {
    const out = [];
    for (const sid of Object.keys(state.stations)) for (const slot of Object.keys(state.stations[sid].slots)) {
      const o = state.stations[sid].slots[slot];
      if (o) out.push({ obj: o, station: sid, slot });
    }
    if (state.hand) out.push({ obj: state.hand, held: true });
    return out;
  };
  const trayOf = (pack, state) => {
    for (const sid of pack.stationOrder) for (const sl of pack.stations[sid].slots) if (sl.fixed) return { sid, tray: state.stations[sid].slots[sl.id] };
    return null;
  };
  const stageIdx = (pack, ingId, id) => I.stages(pack, I.cookSet(pack, ingId), { cooking: 'timed', burning: true }).indexOf(id);
  const faceDone = (pack, o, want) => o.faces.every(f => f.s === stageIdx(pack, o.ing, want));
  const faceUnder = (pack, o, want) => o.faces.every(f => f.s <= stageIdx(pack, o.ing, want));

  /** The order an item's parts go in: mixins, then the shake or blend, then the rest. */
  function planOf(pack, spec) {
    if (!spec.mixed) return spec.parts.slice();
    const mixins = spec.parts.filter(p => I.has(pack, p.ing, 'mixin'));
    return mixins.concat([{ mix: true }], spec.parts.filter(p => !mixins.includes(p)));
  }
  /** Does this part already on the item match the plan? */
  function partOk(pack, p, q) {
    if (!q || q.ing !== p.ing) return false;
    if (p.count !== undefined && q.count !== p.count) return false;
    if (p.done && q.faces && !I.has(pack, q.ing, 'cookable')) return false;
    return true;
  }
  /** How far along a thing is for this item (-1: not this item at all). */
  function progressOf(pack, spec, o) {
    if (o.ing !== spec.ing || (spec.size && o.size !== spec.size)) return -1;
    const plan = planOf(pack, spec).filter(p => !p.mix);
    for (let i = 0; i < o.parts.length; i++) if (!partOk(pack, plan[i], o.parts[i])) return -1;
    return o.parts.length + 1;
  }
  const complete = (pack, spec, o, rules) => o.ing === spec.ing && S.itemChecks(pack, spec, o, rules).every(c => c.v === 1);

  /* ── the next step ──────────────────────────────────────────────────────── */
  function next(state) {
    const pack = I.packOf(state);
    const t = state.tickets[0];
    if (!t) return state.hand ? putDown(pack, state) : null;
    const claimed = new Set();
    const tr = trayOf(pack, state);
    // Anything of the right kind on the tray counts as served-to-be (a flawed burger
    // is still a burger): the bot never makes a second one, the star says Serve.
    const onTray = t.items.map(spec => {
      const free = tr.tray.parts.filter(q => !claimed.has(q.uid) && q.ing === spec.ing);
      const o = free.find(q => complete(pack, spec, q, state.rules)) || free[0];
      if (o) claimed.add(o.uid);
      return !!o;
    });
    if (onTray.every(Boolean)) return goOr(state, tr.sid, { verb: 'serve', station: tr.sid, opt: { ticket: t.id } });
    for (let i = 0; i < t.items.length; i++) {
      if (onTray[i]) continue;
      const a = advance(pack, state, t.items[i], claimed);
      if (a) return a;
    }
    return null;
  }
  const goOr = (state, sid, a) => (state.at === sid ? a : { verb: 'go', station: state.at, opt: { to: sid } });
  function putDown(pack, state) {
    const a = K.actions(state).find(x => x.verb === 'place' && x.target === 'hand' && x.opt.slot);
    return a || null;
  }
  function where(state, uid) {
    const at = I.find(state, uid);
    return at.held ? 'hand' : at.station;
  }
  /** Get a thing to a station: Send if this station can, otherwise carry it. */
  function bring(pack, state, uid, sid, into) {
    const w = where(state, uid);
    if (w === 'hand') {
      if (state.at !== sid) return goOr(state, sid, null);
      const fixed = trayOf(pack, state);
      if (into) return { verb: 'place', station: sid, target: 'hand', opt: { into } };
      if (fixed.sid === sid) return { verb: 'place', station: sid, target: 'hand', opt: { into: fixed.tray.uid } };
      return K.actions(state).find(x => x.verb === 'place' && x.target === 'hand' && x.opt.slot) || null;
    }
    if (pack.stations[w].sendTo.includes(sid)) return goOr(state, w, { verb: 'send', station: w, target: uid, opt: { to: sid } });
    if (state.hand) return putDown(pack, state);
    return goOr(state, w, { verb: 'take', station: w, target: uid, opt: { hand: true } });
  }
  /** Cook a thing (or a grilled cheese) to a stage on both its counted faces. */
  function cookStep(pack, state, o, want, sid) {
    const hf = I.heatFace(o);
    const target = stageIdx(pack, hf.obj.ing, want);
    const upPart = o.faces ? o : o.parts[o.parts.length - 1];
    const up = upPart.faces && upPart.faces.length === 2 ? upPart.faces[1] : null;
    if (hf.face.s < target) {
      if (state.rules.cooking === 'timed') return o.cooking ? { wait: true } : goOr(state, sid, { verb: 'cook', station: sid, target: o.uid, opt: { start: true } });
      return goOr(state, sid, { verb: 'cook', station: sid, target: o.uid, opt: { until: want } });
    }
    if (up && up.s < target) return goOr(state, sid, { verb: 'flip', station: sid, target: o.uid, opt: {} });
    return null;
  }
  /** The pour or other bin action that adds a part (amount from the ticket in Auto-Fill). */
  function binAction(pack, state, src, p, opt) {
    const verb = src.bin.verb, a = { verb, station: src.sid, bin: src.bin.id, opt: Object.assign({}, opt) };
    if (verb === 'pour' || verb === 'squeeze') {
      if (state.rules.pouring === 'hold') a.opt.mech = true;
      else {
        const lv = p.amount || pack.amountSets[I.ing(pack, p.ing).amounts].normal;
        Object.assign(a.opt, { level: lv, amount: I.levelValue(pack, I.ing(pack, p.ing).amounts, lv) });
      }
    }
    if (verb === 'portion') a.opt.count = p.count;
    return a;
  }

  function advance(pack, state, spec, claimed) {
    const home = homeOf(pack, spec);
    // The thing being built: the furthest-along match, or none yet.
    let best = null, bestP = -1;
    for (const x of top(state)) {
      if (claimed.has(x.obj.uid)) continue;
      const pr = progressOf(pack, spec, x.obj);
      if (pr > bestP) { best = x.obj; bestP = pr; }
    }
    if (best) claimed.add(best.uid);
    const at = best ? where(state, best.uid) : home;
    if (at === 'hand') {
      // Carry it where its next part is, or to the counter when it is done.
      const pending = pendingPart(pack, state, spec, best);
      const dest = pending && !pending.mix ? sourceOf(pack, pending.ing, spec.ing).sid : pending && pending.mix ? state.at : trayOf(pack, state).sid;
      return bring(pack, state, best.uid, dest);
    }

    // Food that cooks on its own station comes first, so it is on the heat (or ready
    // and sent over) before the build needs it. Timed food cooking: carry on meanwhile.
    const plan = planOf(pack, spec);
    const have = best ? best.parts.length : 0;
    const found = new Map();
    let waiting = false, first = null, k = 0;
    for (const p of plan) {
      if (p.mix) continue;
      if (k++ < have || !cooksSeparately(pack, spec, p)) continue;
      const r = findCooked(pack, state, p, claimed);
      found.set(p, r);
      if (first) continue;
      if (r.kind === 'cooking') {
        const c = cookStep(pack, state, r.x.obj, p.done, r.x.station);
        if (c && c.wait) waiting = true; else if (c) first = c;
      } else if (r.kind === 'ready' && r.x.station && r.x.station !== home && heated(pack, r.x) && freeSlots(pack, state, home) > (best ? 0 : 1)) {
        first = bring(pack, state, r.x.obj.uid, home);
      } else if (r.kind === 'none') {
        const src = sourceOf(pack, p.ing, spec.ing);
        if (!state.hand && hasHotSlot(pack, state, src.sid)) first = goOr(state, src.sid, binAction(pack, state, src, p, {}));
      }
    }
    if (first) return first;

    if (!best) {
      // Start it: a cup or basket from its bin, or let the first part make the container.
      const src = binsFor(pack, b => b.ing === spec.ing)[0];
      if (src) return goOr(state, src.sid, { verb: src.bin.verb, station: src.sid, bin: src.bin.id, opt: spec.size ? { size: spec.size } : {} });
      if (!I.has(pack, spec.ing, 'container')) return waiting ? { wait: true } : null;
    }
    if (best && spec.done && best.faces) {
      const c = cookStep(pack, state, best, spec.done, at);
      if (c) return c;
    }
    let j = 0;
    for (const p of plan) {
      if (p.mix) {
        const list = pack.stageSets[I.ing(pack, best.ing).mix].stages;
        if (list[best.mixed.s] !== spec.mixed) return goOr(state, at, { verb: 'mix', station: at, target: best.uid, opt: {} });
        continue;
      }
      if (best && best.parts[j]) { j++; continue; }
      return addPart(pack, state, spec, best, at, p, found.get(p));
    }
    if (I.has(pack, spec.ing, 'onHeat')) {
      const want = spec.parts.find(p => p.done);
      if (want) { const c = cookStep(pack, state, best, want.done, at); if (c) return c; }
    }
    if (spec.done && !best.faces) {
      // Cooked whole once it is built (a pizza): to a hot slot, then cook.
      const hf = I.heatFace(best);
      if (hf && hf.face.s < stageIdx(pack, hf.obj.ing, spec.done)) {
        const w = I.find(state, best.uid);
        const hot = w.station && heated(pack, w) && pack.stations[w.station].verbs.includes('cook');
        if (!hot) return bring(pack, state, best.uid, hotStation(pack, state, w.station));
        const c = cookStep(pack, state, best, spec.done, w.station);
        if (c) return c;
      }
    }
    return bring(pack, state, best.uid, trayOf(pack, state).sid);
  }
  function pendingPart(pack, state, spec, o) {
    let j = 0;
    for (const p of planOf(pack, spec)) {
      if (p.mix) { const list = pack.stageSets[I.ing(pack, o.ing).mix].stages; if (list[o.mixed.s] !== spec.mixed) return p; continue; }
      if (o.parts[j]) { j++; continue; }
      return p;
    }
    return null;
  }
  const heated = (pack, x) => !!(pack.stations[x.station].slots.find(sl => sl.id === x.slot) || {}).heat;
  /** A station that cooks, with a free hot slot; one this station can Send to first. */
  function hotStation(pack, state, from) {
    const ok = pack.stationOrder.filter(sid => pack.stations[sid].verbs.includes('cook') && hasHotSlot(pack, state, sid));
    return ok.find(sid => from && pack.stations[from].sendTo.includes(sid)) || ok[0];
  }
  const freeSlots = (pack, state, sid) => pack.stations[sid].slots.filter(sl =>
    !sl.fixed && (!sl.upgrade || state.unlocked.includes(sl.upgrade)) && !state.stations[sid].slots[sl.id]).length;
  const hasHotSlot = (pack, state, sid) => pack.stations[sid].slots.some(sl =>
    sl.heat && (!sl.upgrade || state.unlocked.includes(sl.upgrade)) && !state.stations[sid].slots[sl.id]);
  /** A separately cooked part (a patty for this burger): ready, still cooking, or none yet. */
  function findCooked(pack, state, p, claimed) {
    const amountOk = o => !p.amount || state.rules.pouring === 'hold' || I.levelIndex(pack, I.ing(pack, o.ing).amounts, o.amount) === pack.amountSets[I.ing(pack, o.ing).amounts].levels.findIndex(L => L.id === p.amount);
    const mine = top(state).filter(x => !claimed.has(x.obj.uid) && x.obj.ing === p.ing && x.obj.faces && amountOk(x.obj));
    const ready = mine.find(x => faceDone(pack, x.obj, p.done));
    const cooking = !ready && mine.find(x => x.station && heated(pack, x) && faceUnder(pack, x.obj, p.done));
    const x = ready || cooking;
    if (!x) return { kind: 'none' };
    claimed.add(x.obj.uid);
    return { kind: ready ? 'ready' : 'cooking', x };
  }

  function addPart(pack, state, spec, box, at, p, cooked) {
    const into = box ? { into: box.uid } : { make: spec.ing };
    if (cooked) {
      if (cooked.kind === 'ready') {
        const w = where(state, cooked.x.obj.uid);
        if (w === 'hand') return state.at === at ? { verb: 'place', station: at, target: 'hand', opt: into } : goOr(state, at, null);
        if (w === at) return goOr(state, at, { verb: 'place', station: at, target: cooked.x.obj.uid, opt: into });
        return bring(pack, state, cooked.x.obj.uid, at);
      }
      if (cooked.kind === 'cooking') return cookStep(pack, state, cooked.x.obj, p.done, cooked.x.station);
      if (state.hand) return putDown(pack, state);
      const src = sourceOf(pack, p.ing, spec.ing);
      return hasHotSlot(pack, state, src.sid) ? goOr(state, src.sid, binAction(pack, state, src, p, {})) : null;
    }
    if (p.chopped) return prepared(pack, state, spec, box, at, p);
    const src = sourceOf(pack, p.ing, spec.ing);
    if (box && at !== src.sid) return bring(pack, state, box.uid, src.sid);
    if (!box && state.at !== src.sid) return goOr(state, src.sid, null);
    return goOr(state, src.sid, binAction(pack, state, src, p, into));
  }

  /** A part prepared on its own first (peppers chopped, then put on). */
  function prepared(pack, state, spec, box, at, p) {
    const into = box ? { into: box.uid } : { make: spec.ing };
    const list = x => pack.stageSets[I.ing(pack, x.obj.ing).chop].stages;
    const mine = top(state).filter(x => x.obj.ing === p.ing && x.obj.chopped && x.station);
    const ready = mine.find(x => list(x)[x.obj.chopped.s] === p.chopped);
    if (ready) return ready.station === at ? goOr(state, at, { verb: 'place', station: at, target: ready.obj.uid, opt: into }) : bring(pack, state, ready.obj.uid, at);
    if (mine[0]) return goOr(state, mine[0].station, { verb: 'chop', station: mine[0].station, target: mine[0].obj.uid, opt: {} });
    const src = sourceOf(pack, p.ing, spec.ing);
    return goOr(state, src.sid, { verb: src.bin.verb, station: src.sid, bin: src.bin.id, opt: {} });
  }

  /* ── playing it through the menus ───────────────────────────────────────── */
  /** Press counting along the scan rules. */
  function scanCost(scan, tree, L) {
    const rows = L.ids.slice(0, -1);
    let common = 0;
    while (common < scan.rows.length && common < rows.length && scan.rows[common] === rows[common]) common++;
    let choices = 0, steps = 0;
    const listAt = depth => {
      let list = tree.items;
      for (let d = 0; d < depth; d++) list = (list.find(it => it.id === rows[d]) || { children: [] }).children;
      return list;
    };
    // Leave rows by their Back stop.
    let hi = scan.hi;
    for (let d = scan.rows.length; d > common; d--) {
      const len = (scan.lens[d - 1] || 1);
      steps += Math.max(0, len - 1 - hi);
      choices += 1;
      hi = scan.parentHi[d - 1] || 0;
    }
    for (let d = common; d < L.index.length; d++) {
      const list = d < rows.length || d === L.index.length - 1 ? listAt(d) : [];
      const len = list.length + 1;
      const pos = d === 0 ? L.index[d] + 1 : L.index[d];
      const cur = d === common ? hi : (d === 0 ? 0 : len - 1);
      steps += ((pos - cur) % len + len) % len;
      choices += 1;
      hi = pos;
    }
    return { choices, steps };
  }
  function afterChoice(scan, tree, L, newTree, wentAway) {
    if (wentAway) return { rows: [], lens: [], parentHi: [], hi: 0 };
    const rows = L.ids.slice(0, -1);
    let list = newTree.items;
    const lens = [], parentHi = [];
    for (let d = 0; d < rows.length; d++) {
      const i = list.findIndex(it => it.id === rows[d]);
      if (i < 0 || !list[i].children) return { rows: [], lens: [], parentHi: [], hi: 0 };
      parentHi.push(d === 0 ? i + 1 : i);
      list = list[i].children;
      lens.push(list.length + 1);
    }
    const leafId = L.ids[L.ids.length - 1];
    const k = list.findIndex(it => it.id === leafId);
    const hi = k >= 0 ? (rows.length ? k : k + 1) : (rows.length ? list.length : 0);
    return { rows, lens, parentHi, hi };
  }

  /** Run the bot. driver = { state(): kitchen, apply(a): events, tick(dt): events }.
   *  opts = { settings, maxSteps, maxWait, hold: 'exact'|'early' } */
  function run(driver, opts) {
    opts = opts || {};
    const settings = opts.settings || {};
    const out = { choices: 0, steps: 0, waited: 0, held: 0, actions: 0, events: [], noRoute: null, stuck: false };
    let scan = { rows: [], lens: [], parentHi: [], hi: 0 };
    const limit = opts.maxSteps || 5000;
    for (let n = 0; n < limit; n++) {
      const state = driver.state();
      if (opts.until && opts.until(state, out)) break;
      const a = next(state);
      if (!a) { out.stuck = state.tickets.length > 0; break; }
      if (a.wait) { out.waited += 1; out.events.push(...driver.tick(1)); if (out.waited > (opts.maxWait || 20000)) { out.stuck = true; break; } continue; }
      const tree = M.station(state, state.at, settings);
      const L = M.find(tree, a);
      if (!L) { out.noRoute = { action: a, key: K.key(a) }; break; }
      const c = scanCost(scan, tree, L);
      out.choices += c.choices; out.steps += c.steps; out.actions += 1;
      let act = L.item.action;
      if (L.item.kind === 'mech') {
        const m = K.pourStart(state, act);
        const dt = 0.05;
        while (m.amount < m.target - 0.01 && m.amount < 1) { K.pourHold(m, dt); out.held += dt; }
        act = K.pourRelease(m);
      } else if (K.key(act) !== K.key(a) && a.opt && a.opt.level) act = a;
      const before = state.at;
      const ev = driver.apply(act);
      if (ev.some(e => e.type === 'refused')) { out.noRoute = { action: act, key: K.key(act), refused: ev }; break; }
      out.events.push(...ev);
      const s2 = driver.state();
      const gone = s2.at !== before || ev.some(e => e.type === 'served');
      scan = afterChoice(scan, tree, L, M.station(s2, s2.at, settings), gone);
    }
    return out;
  }

  /** A kitchen-only driver, for one ticket at a time. */
  function kitchenDriver(state) {
    return { state: () => state, apply: a => K.apply(state, a), tick: dt => K.tick(state, dt) };
  }

  return { next, run, kitchenDriver, homeOf, sourceOf };
});
