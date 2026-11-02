/** Ben's Burger Bar - checks a pack before anything uses it.
 *
 *  validate(pack) -> list of problems (empty when the pack checks out). Every id a pack
 *  refers to must exist, every trait and verb must be one the rules know, and every
 *  recipe part must come from somewhere a player can reach. The Node tests run it on
 *  the diner and on the test pizzeria; a bad pack is caught here, not in play.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./verbs.js'));
  else (root.BB = root.BB || {}).schema = factory(root.BB.verbs);
})(typeof window === 'undefined' ? globalThis : window, function (V) {
  'use strict';

  const TRAITS = ['cookable', 'twoSided', 'topping', 'squeezable', 'pourable', 'container', 'ordered', 'onHeat', 'scoop', 'mixin', 'choppable'];
  const SILLY = ['firstLast', 'allStage', 'with', 'without', 'empty', 'count', 'anyStage'];
  const FAVOURITES = ['stage', 'extra', 'recipe'];

  function validate(pack) {
    const errs = [];
    const bad = (where, msg) => errs.push(where + ': ' + msg);
    const ings = pack.ingredients || {}, stations = pack.stations || {}, recipes = pack.recipes || {};
    const ingOk = (where, id) => { if (!ings[id]) bad(where, 'unknown ingredient ' + id); return !!ings[id]; };
    const buyable = new Set([...Object.keys(recipes), ...Object.keys(pack.extras || {}), ...Object.keys(pack.upgrades || {})]);

    if (!pack.id || typeof pack.version !== 'number') bad('pack', 'needs an id and a numeric version');
    for (const [id, set] of Object.entries(pack.stageSets || {})) {
      if (!Array.isArray(set.stages) || set.stages.length < 2) bad('stageSets.' + id, 'needs at least two stages');
      [...(set.stages || []), set.burnt].filter(Boolean).forEach(st => { if (!(pack.stageNames || {})[st]) bad('stageSets.' + id, 'no name for stage ' + st); });
    }
    for (const [id, set] of Object.entries(pack.amountSets || {})) {
      if (!set.levels || !set.levels.length) bad('amountSets.' + id, 'no levels');
      else if (!set.levels.some(L => L.id === set.normal)) bad('amountSets.' + id, 'normal is not a level');
    }

    for (const [id, I] of Object.entries(ings)) {
      const w = 'ingredients.' + id;
      if (!I.name) bad(w, 'no name');
      (I.traits || []).forEach(t => { if (!TRAITS.includes(t)) bad(w, 'unknown trait ' + t); });
      const has = t => (I.traits || []).includes(t);
      if (has('cookable') && !(pack.stageSets || {})[I.stages]) bad(w, 'cookable without a stage set');
      if ((has('pourable') || has('squeezable')) && !(pack.amountSets || {})[I.amounts]) bad(w, 'pours without an amount set');
      if (I.creates) ingOk(w, I.creates);
      if (I.mix && !(pack.stageSets || {})[I.mix]) bad(w, 'unknown mix set ' + I.mix);
      if (I.chop && !(pack.stageSets || {})[I.chop]) bad(w, 'unknown chop set ' + I.chop);
      if (I.sizes && !(pack.sizeSets || {})[I.sizes]) bad(w, 'unknown size set ' + I.sizes);
    }

    const order = pack.stationOrder || [];
    if (order.length !== Object.keys(stations).length || !order.every(s => stations[s])) bad('stationOrder', 'must list every station once');
    if (!stations[pack.start]) bad('start', 'unknown station ' + pack.start);
    let fixed = 0;
    for (const [sid, st] of Object.entries(stations)) {
      const w = 'stations.' + sid;
      const ids = new Set();
      (st.slots || []).forEach(sl => {
        if (ids.has(sl.id)) bad(w, 'slot id twice: ' + sl.id);
        ids.add(sl.id);
        if (sl.upgrade && !buyable.has(sl.upgrade)) bad(w, 'slot needs unknown upgrade ' + sl.upgrade);
        if (sl.fixed) { fixed += 1; ingOk(w, sl.fixed); }
      });
      (st.verbs || []).forEach(v => { if (!V.VERBS[v]) bad(w, 'unknown verb ' + v); });
      (st.sendTo || []).forEach(to => { if (!stations[to]) bad(w, 'sends to unknown station ' + to); });
      (st.makes || []).forEach(m => ingOk(w, m));
      for (const b of st.bins || []) {
        const wb = w + '.bins.' + b.id;
        if (!ingOk(wb, b.ing)) continue;
        if (!V.VERBS[b.verb] || !V.VERBS[b.verb].forBin) bad(wb, 'verb ' + b.verb + ' cannot use a bin');
        (b.into || []).forEach(i => ingOk(wb, i));
        if (b.unlock && !buyable.has(b.unlock)) bad(wb, 'unknown unlock ' + b.unlock);
        const I = ings[b.ing];
        if (b.verb === 'portion' && !I.sizes && !I.counts) bad(wb, 'portion needs sizes or counts');
        if (b.verb === 'portion' && I.counts && !(b.into || []).length) bad(wb, 'scoops need something to go into');
        if ((b.verb === 'pour' || b.verb === 'squeeze') && !I.amounts) bad(wb, 'pour needs an amount set');
        if ((b.verb === 'pour' || b.verb === 'squeeze') && !I.creates && !(b.into || []).length) bad(wb, 'pour needs into, or an ingredient it creates');
      }
    }
    if (fixed !== 1) bad('stations', 'needs exactly one fixed tray slot (the counter)');

    // Where each ingredient can come from.
    const source = new Set();
    for (const st of Object.values(stations)) for (const b of st.bins || []) { source.add(b.ing); if (ings[b.ing] && ings[b.ing].creates) source.add(ings[b.ing].creates); }
    for (const st of Object.values(stations)) (st.makes || []).forEach(m => source.add(m));
    for (const st of Object.values(stations)) for (const b of st.bins || []) if (b.into && b.into[0] && ings[b.into[0]] && (ings[b.into[0]].traits || []).includes('container')) source.add(b.into[0]);

    const picks = pack.picks || {};
    const checkValue = (w, v, test) => {
      if (v && typeof v === 'object' && v.pick) {
        const P = picks[v.pick];
        if (!P) return bad(w, 'unknown pick ' + v.pick);
        (P.values.concat(P.fancy || [])).forEach(x => test(x, w + ' pick ' + v.pick));
        if (!P.values.includes(P.normal)) bad(w, 'pick ' + v.pick + ' normal is not a value');
      } else test(v, w);
    };
    if (!Object.values(recipes).some(R => !R.unlock)) bad('recipes', 'no starter recipe');
    for (const [rid, R] of Object.entries(recipes)) {
      const w = 'recipes.' + rid;
      if (!(R.price > 0)) bad(w, 'needs a price');
      if (!(R.budget > 0)) bad(w, 'needs a press budget');
      const T = R.item;
      if (!T) { bad(w, 'no item'); continue; }
      checkValue(w + '.ing', T.ing, (x, ww) => { if (ingOk(ww, x) && !source.has(x)) bad(ww, x + ' cannot be made anywhere'); });
      const tIng = ings[T.ing];
      if (T.size) checkValue(w + '.size', T.size, (x, ww) => { if (!tIng || !tIng.sizes || !pack.sizeSets[tIng.sizes].some(z => z.id === x)) bad(ww, 'unknown size ' + x); });
      if (T.mixed && tIng && (!tIng.mix || !pack.stageSets[tIng.mix].stages.includes(T.mixed))) bad(w, 'cannot be ' + T.mixed);
      // A thing cooked whole is cooked by its base (the dough of a pizza).
      const cooks = tIng && tIng.stages ? tIng : ings[((T.parts || [])[0] || {}).ing];
      if (T.done) checkValue(w + '.done', T.done, (x, ww) => { if (!cooks || !cooks.stages || !pack.stageSets[cooks.stages].stages.includes(x)) bad(ww, 'unknown stage ' + x); });
      (T.parts || []).forEach((p, i) => {
        const wp = w + '.parts[' + i + ']';
        checkValue(wp, p.ing, (x, ww) => {
          if (!ingOk(ww, x)) return;
          if (!source.has(x)) bad(ww, x + ' has no bin');
          const I = ings[x];
          if (p.done) checkValue(wp + '.done', p.done, (d, wd) => { if (!I.stages || !pack.stageSets[I.stages].stages.includes(d)) bad(wd, x + ' has no stage ' + d); });
          if (p.amount) checkValue(wp + '.amount', p.amount, (a, wa) => { if (!I.amounts || !pack.amountSets[I.amounts].levels.some(L => L.id === a)) bad(wa, x + ' has no amount ' + a); });
          if (p.chopped && (!I.chop || !pack.stageSets[I.chop].stages.includes(p.chopped))) bad(wp, x + ' cannot be ' + p.chopped);
          if (p.count !== undefined) checkValue(wp + '.count', p.count, (c, wc) => { if (!(I.counts || []).includes(c)) bad(wc, x + ' cannot have ' + c); });
        });
        if (p.opt && p.opt !== 'in' && p.opt !== 'out') bad(wp, 'opt is in or out');
      });
    }
    for (const [id, X] of Object.entries(pack.extras || {})) {
      if (!picks[X.pick] || !picks[X.pick].values.includes(X.value)) bad('extras.' + id, 'unknown pick value');
      if (X.needs && !buyable.has(X.needs)) bad('extras.' + id, 'needs unknown ' + X.needs);
    }
    for (const [id, U] of Object.entries(pack.upgrades || {})) if (U.needs && !buyable.has(U.needs)) bad('upgrades.' + id, 'needs unknown ' + U.needs);
    for (const [part, gate] of Object.entries(pack.pickUnlocks || {})) {
      Object.values(gate).forEach(u => { if (!buyable.has(u)) bad('pickUnlocks.' + part, 'unknown unlock ' + u); });
    }
    for (const [sid, D] of Object.entries(pack.decor || {})) if (!D.options.some(o => !o.cost)) bad('decor.' + sid, 'needs a free option');

    const favourite = (w, F) => {
      if (!F) return;
      if (!FAVOURITES.includes(F.kind)) bad(w, 'unknown favourite ' + F.kind);
      if (F.kind === 'extra') ingOk(w, F.ing);
      if (F.kind === 'recipe' && !recipes[F.recipe]) bad(w, 'unknown recipe ' + F.recipe);
      if (!(F.bonus > 0)) bad(w, 'a favourite only adds: bonus must be above 0');
    };
    const ids = new Set();
    for (const C of pack.regulars || []) {
      const w = 'regulars.' + C.id;
      if (ids.has(C.id)) bad(w, 'id twice');
      ids.add(C.id);
      (C.likes || []).forEach(([r]) => { if (!recipes[r]) bad(w, 'likes unknown recipe ' + r); });
      (C.always || []).forEach(r => { if (!recipes[r]) bad(w, 'always orders unknown recipe ' + r); });
      (C.usual || []).forEach(u => { if (!recipes[u.recipe]) bad(w, 'usual is an unknown recipe ' + u.recipe); });
      (C.dislikes || []).forEach(d => ingOk(w, d));
      Object.keys(Object.assign({}, C.set, C.wants)).forEach(k => { if (!picks[k]) bad(w, 'sets unknown pick ' + k); });
      favourite(w, C.favourite);
    }
    const WI = pack.walkIns;
    if (WI) {
      ['names', 'voices', 'ordering', 'reacting'].forEach(k => { if (!(WI[k] || []).length) bad('walkIns.' + k, 'empty'); });
      (WI.dislikes || []).forEach(d => ingOk('walkIns.dislikes', d));
      (WI.favourites || []).forEach((F, i) => favourite('walkIns.favourites[' + i + ']', F));
    }
    for (const r of pack.silly || []) if (!SILLY.includes(r.kind) || !r.line) bad('silly.' + r.id, 'unknown kind or no line');
    return errs;
  }

  return { validate, TRAITS };
});
