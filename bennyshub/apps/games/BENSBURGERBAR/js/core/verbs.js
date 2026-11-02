/** Ben's Burger Bar - the verbs, written once for every station.
 *
 *  take, place, portion, cook, flip, chop, pour, squeeze, mix, top, send, serve, discard.
 *  A verb decides what it applies to by traits and by the station's configuration, never
 *  by ingredient id. Each verb can list its actions:
 *    forBin(cx, station, bin) / forObject(cx, station, at) / forStation(cx, station)
 *  and has one apply(cx, action) -> events, the only code that changes the kitchen.
 *  Every form of a verb ends in that same apply: Auto-Fill and Hold to Pour both pour
 *  through pour.apply, and Pick the Doneness and Time It Yourself both cook through the
 *  shared stage process in items.js.
 *
 *  An action is plain data: { verb, station, target?, bin?, opt? }.
 *  cx = { pack, state, rules }.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./items.js'));
  else (root.BB = root.BB || {}).verbs = factory(root.BB.items);
})(typeof window === 'undefined' ? globalThis : window, function (I) {
  'use strict';

  /* ── shared helpers ─────────────────────────────────────────────────────── */
  const stationOf = (cx, sid) => cx.pack.stations[sid];
  const owned = (cx, id) => !id || cx.state.unlocked.includes(id);
  const openSlots = (cx, sid) => stationOf(cx, sid).slots.filter(sl => owned(cx, sl.upgrade));
  const allows = (cx, sid, verb) => stationOf(cx, sid).verbs.includes(verb);
  const heatOf = (cx, sid, slotId) => !!(stationOf(cx, sid).slots.find(sl => sl.id === slotId) || {}).heat;

  /** A free slot here, preferring one that is hot (or not) as asked. */
  function freeSlot(cx, sid, wantHeat) {
    const free = openSlots(cx, sid).filter(sl => !sl.fixed && !cx.state.stations[sid].slots[sl.id]);
    return (free.find(sl => !!sl.heat === !!wantHeat) || free[0] || {}).id || null;
  }
  const needsHeat = (cx, ingId) => I.has(cx.pack, ingId, 'cookable') || I.has(cx.pack, ingId, 'onHeat');
  /** Things sitting in this station's slots, plus what is on a fixed slot's container (the tray). */
  function topLevel(cx, sid) {
    const out = [];
    for (const sl of openSlots(cx, sid)) {
      const o = cx.state.stations[sid].slots[sl.id];
      if (!o) continue;
      if (sl.fixed) o.parts.forEach(p => out.push({ obj: p, station: sid, slot: sl.id, parent: o, onFixed: true }));
      else out.push({ obj: o, station: sid, slot: sl.id, parent: null });
    }
    return out;
  }
  const containersHere = (cx, sid, kinds) => topLevel(cx, sid)
    .filter(a => !a.onFixed && I.has(cx.pack, a.obj.ing, 'container') && (!kinds || kinds.includes(a.obj.ing)));
  const fixedContainer = (cx, sid) => {
    const sl = openSlots(cx, sid).find(s => s.fixed);
    return sl ? cx.state.stations[sid].slots[sl.id] : null;
  };

  /** Where a bin's ingredient can go: each matching thing here, or, when there is none
   *  and the first kind is a container, a new one ({ make }). */
  function binTargets(cx, sid, bin) {
    const kinds = bin.into || [];
    const here = topLevel(cx, sid).filter(a => !a.onFixed && kinds.includes(a.obj.ing)).map(a => ({ into: a.obj.uid }));
    if (here.length) return here;
    const first = kinds[0];
    if (first && I.has(cx.pack, first, 'container') && freeSlot(cx, sid, needsHeat(cx, first))) return [{ make: first }];
    return [];
  }
  function intoTarget(cx, sid, opt) {
    if (opt.into) return I.find(cx.state, opt.into).obj;
    const slot = freeSlot(cx, sid, needsHeat(cx, opt.make));
    const c = I.make(cx.state, cx.pack, opt.make);
    cx.state.stations[sid].slots[slot] = c;
    return c;
  }

  /** How well a thing being built matches an ordered item so far (its parts in order). */
  function fit(spec, into) {
    if (!into) return 0;
    let n = 0;
    while (n < into.parts.length && spec.parts[n] && spec.parts[n].ing === into.parts[n].ing) n++;
    return n === into.parts.length ? n + 1 : n - into.parts.length;
  }
  /** The amounts open tickets want of an ingredient, poured into this kind of thing
   *  (level ids, without repeats), the item this one is most likely for first. Hold to
   *  Pour aims its line at the first. Nothing asked for: the set's normal amount. */
  function wantedLevels(cx, ingId, intoIng, into) {
    const set = I.ing(cx.pack, ingId).amounts;
    const found = [];
    const look = (spec) => {
      if (!intoIng || spec.ing === intoIng) spec.parts.forEach(p => { if (p.ing === ingId && p.amount) found.push({ lv: p.amount, fit: fit(spec, into) }); });
      spec.parts.forEach(look);
    };
    for (const t of cx.state.tickets) t.items.forEach(look);
    const out = [];
    found.sort((a, b) => b.fit - a.fit).forEach(f => { if (!out.includes(f.lv)) out.push(f.lv); });
    return out.length ? out : [cx.pack.amountSets[set].normal];
  }
  /** The stages open tickets want for an ingredient (for the longer window). */
  function wantedStages(cx, ingId) {
    const out = [];
    const look = (spec) => { if (spec.ing === ingId && spec.done) out.push(spec.done); spec.parts.forEach(look); };
    for (const t of cx.state.tickets) t.items.forEach(look);
    return out;
  }

  /* ── one stage process for cook, mix and chop ───────────────────────────── */
  /** A verb that moves a stage record on one jump at a time (mix, chop). */
  function processVerb(field, setKey) {
    const set = (cx, o) => I.stages(cx.pack, I.ing(cx.pack, o.ing)[setKey]);
    return {
      forObject(cx, sid, at) {
        const o = at.obj, rec = o[field];
        if (at.onFixed || !rec || rec.s >= set(cx, o).length - 1) return [];
        return [{ opt: {} }];
      },
      apply(cx, a) {
        const o = I.find(cx.state, a.target).obj, list = set(cx, o);
        I.advanceTo(o[field], list.length - 1);
        return [{ type: field, uid: o.uid, stage: list[o[field].s] }];
      },
    };
  }

  /* ── the verbs ──────────────────────────────────────────────────────────── */
  const VERBS = {
    take: {
      forBin(cx, sid, bin) {
        const slot = freeSlot(cx, sid, needsHeat(cx, bin.ing));
        return slot ? [{ opt: {} }] : [];
      },
      forObject(cx, sid, at) { return cx.state.hand ? [] : [{ opt: { hand: true } }]; },
      apply(cx, a) {
        if (a.bin) {
          const bin = stationOf(cx, a.station).bins.find(b => b.id === a.bin);
          const o = I.make(cx.state, cx.pack, bin.ing);
          cx.state.stations[a.station].slots[freeSlot(cx, a.station, needsHeat(cx, bin.ing))] = o;
          return [{ type: 'made', uid: o.uid, ing: o.ing }];
        }
        const o = I.detach(cx.state, a.target);
        cx.state.hand = o;
        return [{ type: 'held', uid: o.uid }];
      },
    },

    place: {
      /** What is held: Put Down in a free slot, or onto something here. */
      forHand(cx, sid) {
        const h = cx.state.hand, out = [];
        const fixed = fixedContainer(cx, sid);
        if (fixed) out.push({ opt: { into: fixed.uid } });
        if (allows(cx, sid, 'place') && !I.has(cx.pack, h.ing, 'container')) containersHere(cx, sid).forEach(c => out.push({ opt: { into: c.obj.uid } }));
        const slot = freeSlot(cx, sid, needsHeat(cx, h.ing));
        if (slot) out.push({ opt: { slot } });
        return out;
      },
      /** Something here onto a container here (Add to Burger, Stack). */
      forObject(cx, sid, at) {
        if (at.onFixed || I.has(cx.pack, at.obj.ing, 'container')) return [];
        const out = containersHere(cx, sid).filter(c => c.obj.uid !== at.obj.uid).map(c => ({ opt: { into: c.obj.uid } }));
        for (const kind of stationOf(cx, sid).makes || []) {
          if (!out.length && freeSlot(cx, sid, false)) out.push({ opt: { make: kind } });
        }
        return out;
      },
      apply(cx, a) {
        const o = a.target === 'hand' ? cx.state.hand : I.detach(cx.state, a.target);
        if (a.target === 'hand') cx.state.hand = null;
        if (a.opt.slot) cx.state.stations[a.station].slots[a.opt.slot] = o;
        else intoTarget(cx, a.station, a.opt).parts.push(o);
        return [{ type: 'placed', uid: o.uid, station: a.station }];
      },
    },

    portion: {
      forBin(cx, sid, bin) {
        const I0 = I.ing(cx.pack, bin.ing);
        if (I0.sizes) {
          const slot = freeSlot(cx, sid, false);
          return slot ? cx.pack.sizeSets[I0.sizes].map(sz => ({ opt: { size: sz.id } })) : [];
        }
        const out = [];
        binTargets(cx, sid, bin).forEach(t => I0.counts.forEach(n => out.push({ opt: Object.assign({ count: n }, t) })));
        return out;
      },
      apply(cx, a) {
        const bin = stationOf(cx, a.station).bins.find(b => b.id === a.bin);
        if (a.opt.size) {
          const o = I.make(cx.state, cx.pack, bin.ing, { size: a.opt.size });
          cx.state.stations[a.station].slots[freeSlot(cx, a.station, false)] = o;
          return [{ type: 'made', uid: o.uid, ing: o.ing }];
        }
        const into = intoTarget(cx, a.station, a.opt);
        const p = I.make(cx.state, cx.pack, bin.ing, { count: a.opt.count });
        into.parts.push(p);
        return [{ type: 'added', uid: p.uid, into: into.uid, ing: p.ing }];
      },
    },

    top: {
      forBin(cx, sid, bin) { return binTargets(cx, sid, bin).map(t => ({ opt: t })); },
      apply(cx, a) {
        const bin = stationOf(cx, a.station).bins.find(b => b.id === a.bin);
        const into = intoTarget(cx, a.station, a.opt);
        const p = I.make(cx.state, cx.pack, bin.ing);
        into.parts.push(p);
        return [{ type: 'added', uid: p.uid, into: into.uid, ing: p.ing }];
      },
    },

    cook: {
      forObject(cx, sid, at) {
        if (at.onFixed || !heatOf(cx, sid, at.slot)) return [];
        const hf = I.heatFace(at.obj);
        if (!hf) return [];
        const set = I.cookSet(cx.pack, hf.obj.ing);
        if (cx.rules.cooking === 'timed') return at.obj.cooking ? [] : [{ opt: { start: true } }];
        const list = I.stages(cx.pack, set), out = [];
        for (let i = hf.face.s + 1; i < list.length; i++) out.push({ opt: { until: list[i] } });
        return out;
      },
      apply(cx, a) {
        const o = I.find(cx.state, a.target).obj;
        if (a.opt.start) { o.cooking = true; return [{ type: 'cooking', uid: o.uid }]; }
        const hf = I.heatFace(o);
        const list = I.stages(cx.pack, I.cookSet(cx.pack, hf.obj.ing), cx.rules);
        I.advanceTo(hf.face, list.indexOf(a.opt.until));
        return [{ type: 'stage', uid: hf.obj.uid, stage: a.opt.until }];
      },
      /** Time It Yourself: everything cooking on a hot slot moves along its stages. */
      tick(cx, dt) {
        const events = [];
        for (const sid of Object.keys(cx.pack.stations)) {
          for (const sl of openSlots(cx, sid)) {
            const o = cx.state.stations[sid].slots[sl.id];
            if (!o || !sl.heat || !o.cooking) continue;
            const hf = I.heatFace(o);
            if (!hf) continue;
            const setId = I.cookSet(cx.pack, hf.obj.ing);
            const list = I.stages(cx.pack, setId, cx.rules);
            const plain = I.stages(cx.pack, setId);
            // A stage asked of the food itself, or of the whole thing it is the base of (a pizza).
            const wanted = wantedStages(cx, hf.obj.ing).concat(o !== hf.obj ? wantedStages(cx, o.ing) : []);
            const base = cx.pack.cookSpeeds[cx.rules.speed] || cx.pack.cookSpeeds.verySlow;
            const duration = i => base * (wanted.includes(list[i]) ? cx.pack.wantedScale : 1);
            for (const s of I.progress(hf.face, dt, duration, list.length - 1)) {
              const stage = list[s];
              events.push({ type: 'stage', uid: hf.obj.uid, stage, timed: true });
              const nextStage = list[s + 1];
              if (nextStage && (wanted.includes(nextStage) || nextStage === plain[plain.length - 1] || s + 1 === list.length - 1)) {
                events.push({ type: 'near', uid: hf.obj.uid, stage, next: nextStage, wanted: wanted.includes(nextStage) });
              }
            }
          }
        }
        return events;
      },
    },

    flip: {
      forObject(cx, sid, at) { return !at.onFixed && I.flippable(cx.pack, at.obj) ? [{ opt: {} }] : []; },
      apply(cx, a) {
        const o = I.find(cx.state, a.target).obj;
        I.flip(o);
        return [{ type: 'flipped', uid: o.uid }];
      },
    },

    mix: processVerb('mixed', 'mix'),
    chop: processVerb('chopped', 'chop'),

    /** Pouring a liquid: sauces are squeezed, everything else poured; one rule for both,
     *  and for both Auto-Fill and Hold to Pour. */
    pour: {
      forBin(cx, sid, bin) {
        const I0 = I.ing(cx.pack, bin.ing);
        const targets = bin.into ? binTargets(cx, sid, bin)
          : (freeSlot(cx, sid, needsHeat(cx, I0.creates)) ? [{}] : []);
        const out = [];
        for (const t of targets) {
          const into = t.into ? I.find(cx.state, t.into).obj : null;
          const intoIng = into ? into.ing : t.make;
          if (cx.rules.pouring === 'hold') { out.push({ opt: Object.assign({ mech: true }, t) }); continue; }
          const levels = wantedLevels(cx, I0.creates || bin.ing, I0.creates ? null : intoIng, into);
          for (const lv of levels) out.push({ opt: Object.assign({ amount: I.levelValue(cx.pack, I0.amounts, lv), level: lv }, t) });
        }
        return out;
      },
      apply(cx, a) {
        const bin = stationOf(cx, a.station).bins.find(b => b.id === a.bin);
        const I0 = I.ing(cx.pack, bin.ing);
        const amount = Math.max(0, Math.min(1, Math.round(a.opt.amount * 100) / 100));
        if (I0.creates) {
          const o = I.make(cx.state, cx.pack, I0.creates, { amount });
          cx.state.stations[a.station].slots[freeSlot(cx, a.station, needsHeat(cx, I0.creates))] = o;
          return [{ type: 'made', uid: o.uid, ing: o.ing, amount }];
        }
        const into = intoTarget(cx, a.station, a.opt);
        const p = I.make(cx.state, cx.pack, bin.ing, { amount });
        into.parts.push(p);
        return [{ type: 'poured', uid: p.uid, into: into.uid, ing: p.ing, amount }];
      },
      /** Hold to Pour: a gauge that fills while held and trickles near the target line,
       *  so there is time to let go. Never overflows. release() gives the action to apply. */
      mechanic: {
        start(cx, a) {
          const bin = stationOf(cx, a.station).bins.find(b => b.id === a.bin);
          const I0 = I.ing(cx.pack, bin.ing);
          const into = a.opt.into ? I.find(cx.state, a.opt.into).obj : null;
          const lv = wantedLevels(cx, I0.creates || bin.ing, I0.creates ? null : (into ? into.ing : a.opt.make), into)[0];
          return { action: a, amount: 0, target: I.levelValue(cx.pack, I0.amounts, lv), level: lv };
        },
        hold(m, dt) {
          const lo = m.target - POUR.slowBand, hi = m.target + POUR.slowBand;
          let left = dt;
          while (left > 0 && m.amount < 1) {
            const inBand = m.amount >= lo && m.amount < hi;
            const rate = inBand ? POUR.trickle : POUR.rate;
            const edge = Math.min(1, m.amount < lo ? lo : inBand ? hi : 1);
            const t = Math.min(left, (edge - m.amount) / rate);
            m.amount = t === left ? m.amount + rate * t : edge;
            left -= t;
          }
          m.amount = Math.min(1, m.amount);
          return m;
        },
        release(m) {
          const opt = Object.assign({}, m.action.opt, { amount: m.amount });
          delete opt.mech;
          return Object.assign({}, m.action, { opt });
        },
      },
    },

    send: {
      forObject(cx, sid, at) {
        if (at.onFixed) return [];
        return stationOf(cx, sid).sendTo
          .filter(to => fixedContainer(cx, to) || freeSlot(cx, to, false))
          .map(to => ({ opt: { to } }));
      },
      apply(cx, a) {
        const o = I.detach(cx.state, a.target);
        const fixed = fixedContainer(cx, a.opt.to);
        if (fixed) fixed.parts.push(o);
        else cx.state.stations[a.opt.to].slots[freeSlot(cx, a.opt.to, false)] = o;
        return [{ type: 'sent', uid: o.uid, to: a.opt.to }];
      },
    },

    serve: {
      forStation(cx, sid) {
        const tray = fixedContainer(cx, sid);
        if (!tray || !tray.parts.length) return [];
        return cx.state.tickets.map(t => ({ opt: { ticket: t.id } }));
      },
      apply(cx, a) {
        const tray = fixedContainer(cx, a.station);
        const items = tray.parts.splice(0, tray.parts.length);
        const i = cx.state.tickets.findIndex(t => t.id === a.opt.ticket);
        const ticket = cx.state.tickets.splice(i, 1)[0];
        return [{ type: 'served', ticket, items }];
      },
    },

    discard: {
      forObject() { return [{ opt: {} }]; },
      apply(cx, a) {
        const o = I.detach(cx.state, a.target);
        return [{ type: 'binned', uid: o.uid, ing: o.ing }];
      },
    },
  };
  // Squeezing is pouring from a bottle: the same options, apply and hold.
  VERBS.squeeze = VERBS.pour;

  /** Hold to Pour gauge, per second of holding (DESIGN.md "Pouring"; tuned in M2). */
  const POUR = { rate: 0.4, trickle: 0.06, slowBand: 0.08 };

  return { VERBS, POUR, freeSlot, topLevel, openSlots, fixedContainer, wantedLevels, wantedStages, owned };
});
