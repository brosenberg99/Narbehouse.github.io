/** Ben's Burger Bar - a station's scan tree.
 *
 *  Pure: kitchen state in, menu tree out. The screen renders it and the hub's choice
 *  scanner scans it; nothing here touches the DOM (DESIGN.md "A station's scan").
 *
 *  Root: each thing here (a row of what can be done to it) · the bins · what is held ·
 *  Serve · Ticket · Go To… · Pause, always last. The scanner opens the root on its blank
 *  -1 and enters every row with enterGroup(children, {wrap:true, backStop:true}).
 *
 *  Ids are stable across redraws: obj:<uid>, bin:<id>, verb:<verb>:<option>,
 *  go:<station>, ticket, pause. A verb with one action is a leaf; with several it is a
 *  row of them (Cook Until… -> Cook to Medium). Only legal actions ever appear, every
 *  one of them is a single select, and a Hold to Pour leaf is marked kind 'mech'.
 *
 *  item = { id, kind: row|act|mech|ticket|pause, label, say, action?, children?, star? }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./items.js'), require('./verbs.js'), require('./kitchen.js'), require('./words.js'));
  else (root.BB = root.BB || {}).menus = factory(root.BB.items, root.BB.verbs, root.BB.kitchen, root.BB.words);
})(typeof window === 'undefined' ? globalThis : window, function (I, V, K, W) {
  'use strict';

  const OBJECT_VERBS = ['flip', 'cook', 'mix', 'chop', 'place', 'send', 'take', 'discard'];

  const optId = opt => Object.keys(opt || {}).sort().filter(k => k !== 'amount')
    .map(k => (opt[k] === true ? k : String(opt[k]))).join('.');
  function leaf(pack, state, a, id, short) {
    const label = W.action(pack, state, a, short);
    const o = optId(a.opt);
    return { id: id || 'verb:' + a.verb + (o ? ':' + o : ''), kind: a.opt && a.opt.mech ? 'mech' : 'act', label, say: label, action: a };
  }
  /** Several actions of one verb: a leaf when there is one, a row when there are more. */
  function verbItem(pack, state, sid, verb, list, soleId) {
    if (list.length === 1) return leaf(pack, state, list[0], soleId, true);
    const label = W.verbRow(pack, sid, verb);
    return { id: 'verb:' + verb, kind: 'row', label, say: label, children: list.map(a => leaf(pack, state, a)) };
  }

  function station(state, sid, settings, opts) {
    const pack = I.packOf(state);
    sid = sid || state.at;
    settings = settings || {};
    opts = opts || {};
    const all = K.actions(state, sid);
    const items = [];
    const cx = { pack, state, rules: state.rules };

    for (const at of V.topLevel(cx, sid)) {
      const mine = all.filter(a => a.target === at.obj.uid);
      const children = [];
      for (const verb of OBJECT_VERBS) {
        const list = mine.filter(a => a.verb === verb);
        if (list.length) children.push(verbItem(pack, state, sid, verb, list));
      }
      const label = W.thing(pack, at.obj);
      items.push({ id: 'obj:' + at.obj.uid, kind: 'row', label, say: label, children });
    }
    for (const bin of pack.stations[sid].bins) {
      const list = all.filter(a => a.bin === bin.id);
      if (!list.length) continue;
      const item = verbItem(pack, state, sid, bin.verb, list, 'bin:' + bin.id);
      if (item.kind === 'row') { item.id = 'bin:' + bin.id; item.label = item.say = W.name(pack, bin.ing); }
      items.push(item);
    }
    const held = all.filter(a => a.target === 'hand');
    if (held.length) {
      const item = verbItem(pack, state, sid, 'place', held, 'hand');
      if (item.kind === 'row') { item.id = 'hand'; item.label = item.say = 'Holding ' + W.thing(pack, state.hand); }
      items.push(item);
    }
    const serve = all.filter(a => a.verb === 'serve');
    if (serve.length) items.push(verbItem(pack, state, sid, 'serve', serve));

    if (state.tickets.length > 1) {
      items.push({ id: 'tickets', kind: 'row', label: 'Tickets', say: 'Tickets',
        children: state.tickets.map(t => ({ id: 'ticket:' + t.id, kind: 'ticket', label: t.customer.name, say: t.customer.name + ': ' + W.ticket(pack, t), ticket: t.id })) });
    } else {
      const t = state.tickets[0];
      items.push({ id: 'ticket', kind: 'ticket', label: 'Ticket', say: t ? 'Ticket: ' + W.ticket(pack, t) : 'No ticket yet', ticket: t && t.id });
    }
    const go = all.filter(a => a.verb === 'go');
    items.push({ id: 'go', kind: 'row', label: 'Go To…', say: 'Go To',
      children: go.map(a => {
        const say = W.status(pack, state, a.opt.to);
        return { id: 'go:' + a.opt.to, kind: 'act', label: W.name(pack, a.opt.to), say, action: a };
      }) });
    items.push({ id: 'pause', kind: 'pause', label: 'Pause', say: 'Pause' });

    const tree = { context: 'station', station: sid, items };
    if (settings.star && opts.next) star(tree, opts.next);
    return tree;
  }

  /** Next-Step Star: mark the next needed step and the rows leading to it. No reordering. */
  function star(tree, next) {
    const k = K.key(next, true);
    const mark = list => {
      for (const it of list) {
        if ((it.action && K.key(it.action, true) === k) || (it.children && mark(it.children))) {
          it.star = true; it.say += ', next';
          return true;
        }
      }
      return false;
    };
    mark(tree.items);
    return tree;
  }

  /** Every leaf with the ids and positions leading to it: { ids, index, item }. */
  function leaves(tree) {
    const out = [];
    const walk = (list, ids, index) => list.forEach((it, i) => {
      if (it.children) walk(it.children, ids.concat(it.id), index.concat(i));
      else out.push({ ids: ids.concat(it.id), index: index.concat(i), item: it });
    });
    walk(tree.items, [], []);
    return out;
  }
  /** The leaf that does this action (a Hold to Pour release matches its pour). */
  function find(tree, a) {
    const all = leaves(tree).filter(L => L.item.action);
    const k = K.key(a), loose = K.key(a, true);
    return all.find(L => K.key(L.item.action) === k) || all.find(L => K.key(L.item.action, true) === loose) || null;
  }

  return { station, star, leaves, find, optId };
});
