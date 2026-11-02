/** Ben's Burger Bar - things in the kitchen.
 *
 *  Every patty, bun, cup and plate is a plain object, so the whole kitchen is JSON:
 *    { uid, ing, n,            ingredient id and its display number ("Patty 2")
 *      faces?: [down, up],     two-sided cookables; one face for one-sided ones
 *      cooking?,               Time It Yourself: moving through its stages on the heat
 *      mixed?, chopped?,       other stage processes (shaken, blended, sliced)
 *      size?, count?, amount?, what a portion or pour gave it
 *      parts: [obj] }          what is on or in it, bottom first
 *  A face or process is a stage record { s: stage index, t: seconds into that stage }.
 *
 *  What an ingredient can do comes only from its traits in the pack (cookable,
 *  twoSided, container, ordered, pourable, squeezable, topping, mixin...), never from
 *  its id, so a new pack needs no code here.
 *
 *  Packs are registered by id; a state names its pack, so a saved state finds it again.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.BB = root.BB || {}).items = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  const packs = {};
  function register(pack) { packs[pack.id] = pack; return pack; }
  function packOf(state) {
    const p = packs[state.pack];
    if (!p) throw new Error('Pack not loaded: ' + state.pack);
    return p;
  }

  const ing = (pack, id) => pack.ingredients[id];
  const has = (pack, id, trait) => !!(pack.ingredients[id] && pack.ingredients[id].traits.includes(trait));

  /* ── stage sets ─────────────────────────────────────────────────────────── */
  /** The stages an ingredient's process can reach. Burnt is added only when the
   *  rules allow it (Time It Yourself with Food Can Burn). */
  function stages(pack, setId, rules) {
    const set = pack.stageSets[setId];
    const list = set.stages.slice();
    if (set.burnt && rules && rules.cooking === 'timed' && rules.burning) list.push(set.burnt);
    return list;
  }
  const cookSet = (pack, id) => ing(pack, id).stages;
  /** The last stage a set stops at by itself: Extra Crispy, or Burnt with burning on. */
  const capIndex = (pack, setId, rules) => stages(pack, setId, rules).length - 1;

  /* ── one stage process for cooking, mixing and chopping ─────────────────── */
  /** Jump straight to a stage (Pick the Doneness, Blend, Chop). Never goes back. */
  function advanceTo(rec, index) {
    if (index > rec.s) { rec.s = index; rec.t = 0; }
    return rec.s;
  }
  /** Move along by dt seconds (Time It Yourself). duration(index) gives each stage's
   *  length; the record stops at cap. Returns the stage indexes entered, in order. */
  function progress(rec, dt, duration, cap) {
    const entered = [];
    rec.t += dt;
    while (rec.s < cap && rec.t >= duration(rec.s)) {
      rec.t -= duration(rec.s);
      rec.s += 1;
      entered.push(rec.s);
    }
    if (rec.s >= cap) rec.t = 0;
    return entered;
  }
  const record = () => ({ s: 0, t: 0 });

  /* ── making and finding things ─────────────────────────────────────────── */
  function make(state, pack, id, extra) {
    const I = ing(pack, id);
    if (!I) throw new Error('Unknown ingredient: ' + id);
    state.nums[id] = (state.nums[id] || 0) + 1;
    const o = { uid: 'o' + (state.uid += 1), ing: id, n: state.nums[id], parts: [] };
    if (I.traits.includes('cookable')) {
      o.faces = I.traits.includes('twoSided') ? [record(), record()] : [record()];
      o.cooking = false;
    }
    if (I.mix) o.mixed = record();
    if (I.chop) o.chopped = record();
    return Object.assign(o, extra || {});
  }

  /** Every object, depth first, with where it sits: { obj, parent, station, slot, held }. */
  function each(state, fn) {
    const visit = (o, where, parent) => {
      if (fn(o, Object.assign({ parent }, where)) === false) return false;
      for (const p of o.parts) if (visit(p, where, o) === false) return false;
      return true;
    };
    for (const sid of Object.keys(state.stations)) {
      const slots = state.stations[sid].slots;
      for (const slot of Object.keys(slots)) {
        if (slots[slot] && visit(slots[slot], { station: sid, slot }, null) === false) return;
      }
    }
    if (state.hand) visit(state.hand, { held: true }, null);
  }
  function find(state, uid) {
    let found = null;
    each(state, (o, where) => { if (o.uid === uid) { found = Object.assign({ obj: o }, where); return false; } return true; });
    return found;
  }
  /** Take an object out of wherever it is. Returns it. */
  function detach(state, uid) {
    const at = find(state, uid);
    if (!at) return null;
    if (at.parent) at.parent.parts.splice(at.parent.parts.indexOf(at.obj), 1);
    else if (at.held) state.hand = null;
    else state.stations[at.station].slots[at.slot] = null;
    at.obj.cooking = at.obj.cooking === undefined ? undefined : false;
    return at.obj;
  }

  /* ── heat and flipping ──────────────────────────────────────────────────── */
  /** The face touching the heat: the object's own down face, or, for a container
   *  such as a grilled cheese, the down face of the part at the bottom. */
  function heatFace(o) {
    if (o.faces) return { obj: o, face: o.faces[0] };
    const base = o.parts[0];
    return base && base.faces ? { obj: base, face: base.faces[0] } : null;
  }
  /** Turn over: swap faces; a stack also turns upside down, every part with it. */
  function flip(o) {
    if (o.faces && o.faces.length === 2) o.faces.reverse();
    if (o.parts.length) { o.parts.reverse(); o.parts.forEach(flip); }
  }
  const flippable = (pack, o) => (o.faces && o.faces.length === 2) || (o.parts.length > 0 && !!heatFace(o) && has(pack, o.ing, 'container'));

  /* ── amounts ─────────────────────────────────────────────────────────────── */
  /** The named level nearest an amount ("a line"), as an index into the set. */
  function levelIndex(pack, setId, amount) {
    const levels = pack.amountSets[setId].levels;
    let best = 0;
    levels.forEach((L, i) => { if (Math.abs(L.v - amount) < Math.abs(levels[best].v - amount)) best = i; });
    return best;
  }
  const levelValue = (pack, setId, id) => pack.amountSets[setId].levels.find(L => L.id === id).v;

  return {
    register, packOf, ing, has, stages, cookSet, capIndex,
    advanceTo, progress, record, make, each, find, detach,
    heatFace, flip, flippable, levelIndex, levelValue,
  };
});
