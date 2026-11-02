/** Ben's Burger Bar - stars and tips.
 *
 *  Each ordered item is checked against what was served (DESIGN.md "Scoring"). Every
 *  check scores between 0.4 and 1, so a mistake lowers a score but never zeroes it:
 *    items on the tray    1, or 0.4 for each one missing
 *    doneness             per side, per food: 1 / 0.7 one stage off / 0.4
 *    toppings             1, less 0.3 per thing missing, extra or not done (shaken,
 *                         blended), floor 0.4
 *    stack order          1 / 0.8 one swap / 0.5 (ordered containers: plates, sandwiches)
 *    poured amounts       Hold to Pour only, per pour: 1 / 0.7 / 0.4
 *    scoop count          1 / 0.7 / 0.4
 *    drink                size, ice and flavour: 1 / 0.6 one mistake / 0.4
 *  q is the average. Stars: 3 at q >= 0.9, 2 at q >= 0.6, else 1. A customer's hidden
 *  favourite can add to q, never take away. Time is never scored.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./items.js'));
  else (root.BB = root.BB || {}).scoring = factory(root.BB.items);
})(typeof window === 'undefined' ? globalThis : window, function (I) {
  'use strict';

  const steps = (d, one, far) => (d === 0 ? 1 : d === 1 ? one : far);
  const fullStages = (pack, ingId) => I.stages(pack, I.cookSet(pack, ingId), { cooking: 'timed', burning: true });

  /** The faces that count: all of them, or for faces 'out' only the outside ones. */
  function countedFaces(q, index, total, mode) {
    if (mode !== 'out' || q.faces.length < 2) return q.faces;
    if (index === 0 && total > 1) return [q.faces[0]];
    if (index === total - 1 && total > 1) return [q.faces[1]];
    return q.faces;
  }
  const doneChecks = (pack, ingId, faces, want) => {
    const list = fullStages(pack, ingId), w = list.indexOf(want);
    return faces.map(f => ({ id: 'done', v: steps(Math.abs(f.s - w), 0.7, 0.4) }));
  };

  /** Pair each wanted part with the served part of the same ingredient, in order. */
  function pairParts(spec, obj) {
    const used = new Set();
    return spec.parts.map(p => {
      const i = obj.parts.findIndex((q, k) => !used.has(k) && q.ing === p.ing);
      if (i < 0) return null;
      used.add(i);
      return { q: obj.parts[i], index: i };
    });
  }
  function inversions(list) {
    let n = 0;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (list[i] > list[j]) n++;
    return n;
  }

  function itemChecks(pack, spec, obj, rules) {
    const checks = [], pairs = pairParts(spec, obj);
    const isCup = !!I.ing(pack, spec.ing).sizes;
    const drinkPart = id => isCup && I.has(pack, id, 'pourable');

    if (spec.done) {
      const hf = I.heatFace(obj);
      if (hf) checks.push(...doneChecks(pack, hf.obj.ing, obj.faces ? obj.faces : [hf.face], spec.done));
    }
    spec.parts.forEach((p, k) => {
      const m = pairs[k];
      if (p.done && m && m.q.faces) checks.push(...doneChecks(pack, m.q.ing, countedFaces(m.q, m.index, obj.parts.length, p.faces), p.done));
    });

    // Toppings: missing wanted things, kinds nobody asked for, and steps not done.
    const want = {}, have = {};
    spec.parts.forEach(p => { if (!drinkPart(p.ing)) want[p.ing] = (want[p.ing] || 0) + 1; });
    obj.parts.forEach(q => { if (!drinkPart(q.ing)) have[q.ing] = (have[q.ing] || 0) + 1; });
    let mistakes = 0;
    Object.keys(want).forEach(id => { mistakes += Math.max(0, want[id] - (have[id] || 0)); });
    Object.keys(have).forEach(id => { if (!want[id]) mistakes += 1; });
    spec.parts.forEach((p, k) => {
      const m = pairs[k];
      if (p.chopped && m && m.q.chopped && pack.stageSets[I.ing(pack, m.q.ing).chop].stages[m.q.chopped.s] !== p.chopped) mistakes += 1;
    });
    if (spec.mixed && obj.mixed) {
      const list = pack.stageSets[I.ing(pack, obj.ing).mix].stages;
      if (list[obj.mixed.s] !== spec.mixed) mistakes += 1;
    }
    if (Object.keys(want).length || Object.keys(have).length || spec.mixed) checks.push({ id: 'toppings', v: Math.max(0.4, 1 - 0.3 * mistakes) });

    if (I.has(pack, spec.ing, 'ordered') && obj.parts.length > 1) {
      const pos = [], seen = {};
      obj.parts.forEach(q => {
        const k = seen[q.ing] = (seen[q.ing] || 0) + 1;
        let c = 0;
        const at = spec.parts.findIndex(p => p.ing === q.ing && ++c === k);
        if (at >= 0) pos.push(at);
      });
      checks.push({ id: 'order', v: steps(Math.min(inversions(pos), 2), 0.8, 0.5) });
    }

    if (rules && rules.pouring === 'hold') {
      spec.parts.forEach((p, k) => {
        const m = pairs[k];
        if (!p.amount || !m || m.q.amount === undefined) return;
        const set = I.ing(pack, p.ing).amounts;
        const want = pack.amountSets[set].levels.findIndex(L => L.id === p.amount);
        checks.push({ id: 'pour', v: steps(Math.abs(I.levelIndex(pack, set, m.q.amount) - want), 0.7, 0.4) });
      });
    }
    spec.parts.forEach((p, k) => {
      const m = pairs[k];
      if (p.count !== undefined && m) checks.push({ id: 'scoops', v: steps(Math.min(Math.abs((m.q.count || 0) - p.count), 2), 0.7, 0.4) });
    });

    if (isCup) {
      const sizes = pack.sizeSets[I.ing(pack, spec.ing).sizes].map(x => x.id);
      let m = obj.size === spec.size ? 0 : 1;
      const wantP = spec.parts.filter(p => drinkPart(p.ing)).map(p => p.ing);
      const haveP = obj.parts.filter(q => drinkPart(q.ing)).map(q => q.ing);
      m += Math.max(wantP.filter(x => !haveP.includes(x)).length, haveP.filter(x => !wantP.includes(x)).length);
      if (sizes.indexOf(obj.size) < 0 && spec.size) m = Math.max(m, 1);
      checks.push({ id: 'drink', v: steps(Math.min(m, 2), 0.6, 0.4) });
    }
    if (!checks.length) checks.push({ id: 'item', v: 1 });
    return checks;
  }
  const mean = list => list.reduce((k, c) => k + c.v, 0) / list.length;

  /** Best pairing of ordered items with served things (an order has at most three). */
  function assign(pack, specs, served, rules) {
    let best = null;
    const go = (i, used, acc) => {
      if (i === specs.length) {
        const total = acc.reduce((k, a) => k + (a ? mean(a.checks) : 0.4), 0);
        if (!best || total > best.total) best = { total, pairs: acc.slice() };
        return;
      }
      let any = false;
      served.forEach((o, j) => {
        if (used.has(j) || o.ing !== specs[i].ing) return;
        any = true;
        used.add(j); acc.push({ spec: specs[i], obj: o, checks: itemChecks(pack, specs[i], o, rules) });
        go(i + 1, used, acc);
        acc.pop(); used.delete(j);
      });
      acc.push(null); go(i + 1, used, acc); acc.pop();
      return any;
    };
    go(0, new Set(), []);
    return best.pairs;
  }

  /* ── silly food ─────────────────────────────────────────────────────────── */
  function walk(list, fn) { list.forEach(o => { fn(o); walk(o.parts, fn); }); }
  function stagesSeen(pack, served) {
    const out = [];
    walk(served, o => { if (o.faces) { const list = fullStages(pack, o.ing); o.faces.forEach(f => out.push(list[f.s])); } });
    return out;
  }
  const contains = (o, id) => { let f = false; walk([o], q => { if (q.ing === id) f = true; }); return f; };
  function silly(pack, served, customer) {
    const seen = stagesSeen(pack, served), out = [];
    for (const r of pack.silly || []) {
      let hit = false;
      if (r.kind === 'firstLast') hit = served.some(o => o.ing === r.container && o.parts.length > 1 && o.parts[0].ing === r.first && o.parts[o.parts.length - 1].ing === r.last);
      else if (r.kind === 'allStage') hit = seen.length > 0 && seen.every(x => x === r.stage);
      else if (r.kind === 'with') hit = served.some(o => contains(o, r.ing) && contains(o, r.and));
      else if (r.kind === 'without') hit = served.some(o => o.ing === r.container && contains(o, r.and) && !r.ings.some(id => contains(o, id)));
      else if (r.kind === 'empty') hit = served.some(o => r.containers.includes(o.ing) && !o.parts.length);
      else if (r.kind === 'count') { let n = 0; walk(served, q => { if (q.ing === r.ing) n++; }); hit = n >= r.min; }
      else if (r.kind === 'anyStage') hit = seen.includes(r.stage);
      if (hit) out.push({ id: r.id, line: (r.lines && customer && r.lines[customer.id]) || r.line });
    }
    return out;
  }

  /** Favourites only ever add. */
  function favourite(pack, ticket, served, customer) {
    const F = customer && customer.favourite;
    if (!F) return 0;
    if (F.kind === 'stage') return stagesSeen(pack, served).includes(F.stage) ? F.bonus : 0;
    if (F.kind === 'extra') {
      let want = 0, have = 0;
      walk(ticket.items, p => { if (p.ing === F.ing) want++; });
      walk(served, q => { if (q.ing === F.ing) have++; });
      return have > want ? F.bonus : 0;
    }
    if (F.kind === 'recipe') return ticket.items.some(s => s.recipe === F.recipe) && served.length ? F.bonus : 0;
    return 0;
  }

  /** Score a serve. ticket = { items, customer, special? }; served = what was on the tray. */
  function score(pack, ticket, served, rules) {
    const pairs = assign(pack, ticket.items, served, rules);
    const checks = [];
    pairs.forEach((p, i) => {
      if (!p) checks.push({ item: i, id: 'missing', v: 0.4 });
      else p.checks.forEach(c => checks.push(Object.assign({ item: i }, c)));
    });
    const base = mean(checks);
    const q = Math.min(1, base + favourite(pack, ticket, served, ticket.customer));
    const stars = q >= 0.9 ? 3 : q >= 0.6 ? 2 : 1;
    const C = ticket.customer || {};
    const price = ticket.items.reduce((k, s) => k + pack.recipes[s.recipe].price, 0);
    let scale = C.tipScale || 1;
    if (stars === 3 && C.threeStarScale) scale *= C.threeStarScale;
    if (ticket.special && ticket.items.some(s => s.recipe === ticket.special)) scale *= 1 + (pack.dailySpecialBonus || 0);
    const tip = Math.max(1, Math.round(price * (0.6 + 0.2 * stars) * scale));
    return { q, base, stars, tip, checks, silly: silly(pack, served, C), matched: pairs.map(p => (p ? p.obj.uid : null)) };
  }

  return { score, itemChecks, silly, favourite };
});
