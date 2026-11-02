/** Ben's Burger Bar - what things are called.
 *
 *  Every label the scan speaks and every ticket line, built from the pack's names, so
 *  speech always says the current state ("Patty 1, top rare, bottom medium"). Customer
 *  voice lines (M4) are recorded from these same parts; text to speech reads these.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./items.js'));
  else (root.BB = root.BB || {}).words = factory(root.BB.items);
})(typeof window === 'undefined' ? globalThis : window, function (I) {
  'use strict';

  const stage = (pack, id) => pack.stageNames[id] || id;
  const name = (pack, id) => (pack.ingredients[id] ? pack.ingredients[id].name : (pack.stations[id] || {}).name || id);
  // Names inside a sentence: "top blue rare", "bottom bun".
  const lower = s => s.toLowerCase();
  const level = (pack, ingId, lv) => {
    const set = pack.amountSets[I.ing(pack, ingId).amounts];
    return (set.levels.find(L => L.id === lv) || {}).name || lv;
  };
  const sizeName = (pack, ingId, sz) => (pack.sizeSets[I.ing(pack, ingId).sizes].find(x => x.id === sz) || {}).name || sz;
  function list(words) {
    if (words.length < 2) return words.join('');
    return words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
  }

  /* ── things in the kitchen ──────────────────────────────────────────────── */
  function faces(pack, o) {
    const set = I.cookSet(pack, o.ing);
    const all = I.stages(pack, set, { cooking: 'timed', burning: true });
    const sName = f => lower(stage(pack, all[f.s]));
    if (o.faces.length === 1) return sName(o.faces[0]);
    if (o.faces[0].s === o.faces[1].s) return sName(o.faces[0]) + ' both sides';
    return 'top ' + sName(o.faces[1]) + ', bottom ' + sName(o.faces[0]);
  }
  /** One thing, with its state: "Patty 1, top rare, bottom medium". */
  function thing(pack, o) {
    const I0 = I.ing(pack, o.ing), bits = [];
    let head = I0.name + ' ' + o.n;
    if (o.size) head = sizeName(pack, o.ing, o.size) + ' ' + lower(head);
    if (o.faces) bits.push(faces(pack, o) + (o.cooking ? ', cooking' : ''));
    if (o.mixed && o.mixed.s > 0) bits.push(lower(stage(pack, pack.stageSets[I0.mix].stages[o.mixed.s])));
    if (o.chopped && o.chopped.s > 0) bits.push(lower(stage(pack, pack.stageSets[I0.chop].stages[o.chopped.s])));
    if (o.parts.length) bits.push(o.parts.map(p => part(pack, p)).join(', '));
    else if (I.has(pack, o.ing, 'container')) bits.push('empty');
    return [head].concat(bits).join(', ');
  }
  function part(pack, p) {
    const I0 = I.ing(pack, p.ing);
    let s = lower(I0.short || I0.name);
    if (p.count) s = p.count + ' ' + s + (p.count === 1 ? ' scoop' : ' scoops');
    if (p.faces) s += ' ' + faces(pack, p);
    return s;
  }

  /* ── what an action is called ───────────────────────────────────────────── */
  /** short: leave out "on plate 1" when there is nothing else it could go on. */
  function action(pack, state, a, short) {
    const st = pack.stations[a.station], labels = st.labels || {};
    const bin = a.bin && st.bins.find(b => b.id === a.bin);
    const into = a.opt && a.opt.into && I.find(state, a.opt.into);
    const onto = into && !short ? ' on ' + thing(pack, into.obj).split(',')[0].toLowerCase() : '';
    switch (a.verb) {
      case 'go': return name(pack, a.opt.to);
      case 'take': return bin ? 'New ' + name(pack, bin.ing) : 'Take';
      case 'place':
        if (a.opt.slot) return 'Put Down';
        if (a.opt.make) return (labels.place || 'Put') + ' on a New ' + name(pack, a.opt.make);
        if (into && !into.parent && pack.stations[into.station].slots.some(sl => sl.id === into.slot && sl.fixed)) return 'Put on ' + name(pack, into.obj.ing);
        return (labels.place || 'Put') + (labels.place ? '' : onto);
      case 'portion':
        if (a.opt.size) return sizeName(pack, bin.ing, a.opt.size);
        return a.opt.count + (a.opt.count === 1 ? ' Scoop' : ' Scoops');
      case 'top': return name(pack, bin.ing) + onto;
      case 'pour': case 'squeeze': {
        const ingId = I.ing(pack, bin.ing).creates ? bin.ing : bin.ing;
        const how = a.opt.mech ? 'Hold to Pour' : (a.opt.level ? level(pack, ingId, a.opt.level) : '');
        return name(pack, bin.ing) + (how ? ', ' + how : '') + onto;
      }
      case 'cook':
        if (a.opt.start) return labels.cook || 'Cook';
        return (labels.cook || 'Cook') + ' to ' + stage(pack, a.opt.until);
      case 'flip': return 'Flip';
      case 'mix': return labels.mix || 'Mix';
      case 'chop': return labels.chop || 'Chop';
      case 'send': return 'Send to ' + name(pack, a.opt.to);
      case 'serve': {
        const t = state.tickets.find(x => x.id === a.opt.ticket);
        return 'Serve ' + (t ? t.customer.name : 'Order');
      }
      case 'discard': return 'Bin It';
      default: return a.verb;
    }
  }
  /** The label for a row holding several of one verb's actions. */
  function verbRow(pack, sid, verb) {
    const labels = pack.stations[sid].labels || {};
    return ({ cook: (labels.cook || 'Cook') + ' Until…', send: 'Send to…', place: (labels.place || 'Put') + '…',
      serve: 'Serve…', take: 'Take' })[verb] || name(pack, verb);
  }

  /* ── orders ─────────────────────────────────────────────────────────────── */
  /** One item as the ticket says it: "Bacon Cheeseburger, well done, hold the onions". */
  function item(pack, spec) {
    const R = pack.recipes[spec.recipe];
    const flavour = spec.parts.find(p => p.flavour);
    let head = R.item.nameFrom === 'flavour' && flavour ? (I.ing(pack, flavour.ing).short || name(pack, flavour.ing)) + (R.suffix ? ' ' + R.suffix : '') : R.name;
    if (spec.size) head = sizeName(pack, spec.ing, spec.size) + ' ' + head.toLowerCase();
    const bits = [];
    const dones = [];
    const look = s => { if (s.done && !dones.includes(s.done)) dones.push(s.done); s.parts.forEach(look); };
    look(spec);
    dones.forEach(d => bits.push(lower(stage(pack, d))));
    spec.parts.forEach(p => { if (p.count && p.count !== 1) bits.push(p.count + ' scoops'); });
    // An added sauce with its amount is said once: "add a line of mustard".
    const said = [];
    spec.parts.forEach(p => {
      if (!p.amount || !p.sayAmount) return;
      const add = !spec.with && (spec.adds || []).includes(p.ing);
      bits.push((add ? 'add ' : '') + level(pack, p.ing, p.amount) + ' of ' + lower(name(pack, p.ing)));
      if (add) said.push(p.ing);
    });
    if (spec.with) bits.push(spec.with.length ? 'with just ' + list(spec.with.map(h => lower(name(pack, h)))) : 'plain');
    else {
      (spec.holds || []).forEach(h => bits.push('hold the ' + lower(I.ing(pack, h).plural || name(pack, h))));
      (spec.adds || []).filter(h => !said.includes(h)).forEach(h => bits.push('add ' + lower(name(pack, h))));
    }
    return [head].concat(bits).join(', ');
  }
  function ticket(pack, t) {
    const items = t.items.map(s => item(pack, s));
    return list(items) + '.';
  }

  /** Go To row status: "Fryer, fries golden". */
  function status(pack, state, sid) {
    const things = [];
    for (const sl of pack.stations[sid].slots) {
      const o = state.stations[sid].slots[sl.id];
      if (!o) continue;
      if (sl.fixed) { if (o.parts.length) things.push(o.parts.length + ' on the tray'); continue; }
      things.push(thing(pack, o).split(', ').slice(0, 2).join(' ').replace(/ \d+ /, ' ').toLowerCase());
    }
    return name(pack, sid) + (things.length ? ', ' + things.join('; ') : '');
  }

  return { stage, name, level, list, thing, part, action, verbRow, item, ticket, status };
});
