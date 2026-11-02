/** Ben's Burger Bar - the shift, between the rules and the screens.
 *
 *  BB.shift (js/core/shift.js) is the whole shift as plain JSON; this file feeds it the
 *  player's choices and turns what happens into speech, captions and cards. M1 plays
 *  the grill, the board and the counter: orders are hamburgers and cheeseburgers, one
 *  customer at a time, cooked with Pick the Doneness and sauced with Auto-Fill
 *  (DESIGN.md "Milestones"). Customers speak with text to speech; their recorded voices
 *  are M4. The shift in progress is saved from M2.
 */
(function () {
  'use strict';
  const pack = BBPacks.diner, W = BB.words, I = BB.items;
  const M1_RECIPES = ['hamburger', 'cheeseburger'];

  let s = null;                         // the shift
  let seedNext = null;                  // the browser check sets a seed

  const UI = () => BB.ui;
  const kitchen = () => s.kitchen;
  const ticket = () => (s && s.kitchen.tickets[0]) || null;

  function settings() {
    const S = BB.save;
    return Object.assign({}, BB.savefmt.DEFAULT_SETTINGS, S.all(),
      { cooking: 'pick', pouring: 'auto', customersAtOnce: 1 });
  }

  function startShift() {
    const progress = BB.progress.create(pack);
    progress.unlocked = M1_RECIPES.slice();
    progress.order = M1_RECIPES.slice();
    const seed = seedNext || ((Date.now() % 100000) + 1);
    seedNext = null;
    s = BB.shift.create(pack, { seed, settings: settings(), progress });
    BB.world.sync(s.kitchen, ticket() && ticket().customer);
    BB.world.goTo(s.kitchen.at, true);
    arrival();
  }
  /** A customer at the counter says their order. */
  function arrival() {
    const t = ticket();
    if (!t) return;
    const line = greeting(t) + ' ' + W.ticket(pack, t);
    UI().caption('<b>' + escape(t.customer.name) + ':</b> ' + escape(line), 9000);
    UI().openStation(null, t.customer.name + ' says: ' + line);
  }
  const GREETINGS = ['Evening!', 'Hi there.', 'Hello!', 'Afternoon.', 'Hey.'];
  function greeting(t) {
    const c = t.customer;
    if (c.usual && t.items.length && t.items.every((it, i) => c.usual[i] && c.usual[i].recipe === it.recipe)) return 'The usual, hon.';
    return GREETINGS[(t.id + c.name.length) % GREETINGS.length];
  }
  const escape = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  /** The station's scan tree, with only the M1 stations under Go To. */
  function tree() {
    const k = s.kitchen;
    const st = BB.save.get('star');
    const t = BB.menus.station(k, k.at, { star: st }, { next: st ? BB.planner.next(k) : null });
    const go = t.items.find(it => it.id === 'go');
    if (go) go.children = go.children.filter(c => BB.world.has(c.action.opt.to));
    return t;
  }

  /** Do one thing. -> { refused?, served?, text } */
  function act(action) {
    const events = BB.shift.apply(s, action);
    if (events.some(e => e.type === 'refused')) return { refused: true };
    const scored = events.find(e => e.type === 'scored');
    BB.world.sync(s.kitchen, scored ? null : ticket() && ticket().customer);
    // The next customer's ticket waits until the stars card is closed.
    UI().paintTicket(!scored);
    if (scored) { served(scored, events.some(e => e.type === 'done')); return { served: true }; }
    return { text: outcome(events) };
  }

  /** What just happened, in words: the thing as it is now. */
  function outcome(events) {
    const k = s.kitchen;
    const head = uid => { const f = I.find(k, uid); return f ? W.thing(pack, f.obj).split(',')[0] : ''; };
    const now = uid => { const f = I.find(k, uid); return f ? W.thing(pack, f.obj) : ''; };
    const out = [];
    for (const e of events) {
      if (e.type === 'made' || e.type === 'stage' || e.type === 'flipped') out.push(now(e.uid));
      else if (e.type === 'added' || e.type === 'poured') out.push(W.name(pack, e.ing) + ' on ' + head(e.into).toLowerCase());
      else if (e.type === 'held') out.push('Holding ' + now(e.uid));
      else if (e.type === 'placed') { const f = I.find(k, e.uid); out.push(head(e.uid) + (f && f.parent ? ' on ' + W.thing(pack, f.parent).split(',')[0].toLowerCase() : ' put down')); }
      else if (e.type === 'sent') out.push(W.name(pack, I.find(k, e.uid) ? I.find(k, e.uid).obj.ing : '') + ' sent to the ' + W.name(pack, e.to));
      else if (e.type === 'binned') out.push(W.name(pack, e.ing) + ' binned');
    }
    return out.filter(Boolean).join('. ');
  }

  const REACTIONS = { 3: 'Now that is a burger.', 2: 'Not bad. Not bad at all.', 1: 'Well… it is food.' };
  function served(e, last) {
    if (window.SafeAudio && BB.save.get('sfx')) try { SafeAudio.play(e.stars === 3 ? 'win' : 'score', 0.5); } catch (x) { /* optional */ }
    const silly = e.score.silly && e.score.silly[0];
    UI().openCard('served', { name: e.customer.name, stars: e.stars, tip: e.tip, line: silly ? silly.line : REACTIONS[e.stars], last });
  }
  function nextCustomer() {
    BB.world.sync(s.kitchen, ticket() && ticket().customer);
    arrival();
  }
  function showResults() {
    const r = BB.shift.results(s);
    s = null;
    BB.world.sync(emptyKitchen(), null);
    UI().openCard('results', r);
  }
  function quit() {
    s = null;
    BB.world.sync(emptyKitchen(), null);
    BB.world.goTo('counter', true);
    UI().openCard('title');
  }
  const emptyKitchen = () => BB.kitchen.create(pack, 1);
  function resume() { UI().openStation(null, stationName()); }

  function ticketText() {
    const t = ticket();
    if (!t) return { say: 'No ticket yet', caption: 'No ticket yet' };
    const words = W.ticket(pack, t);
    return { say: 'Ticket. ' + t.customer.name + ': ' + words, caption: '<b>' + escape(t.customer.name) + ':</b> ' + escape(words) };
  }
  const stationName = () => (s ? W.name(pack, s.kitchen.at) : '');

  BB.game = {
    startShift, tree, act, nextCustomer, showResults, quit, resume, ticketText, stationName,
    kitchen, ticket, inShift: () => !!s && !s.done,
    progress: () => ({ at: s ? s.arrived : 0, of: s ? s.length : 0 }),
    /** For the browser check: the next shift starts from this seed. */
    seed(n) { seedNext = n; },
    shift: () => s,
  };
})();
