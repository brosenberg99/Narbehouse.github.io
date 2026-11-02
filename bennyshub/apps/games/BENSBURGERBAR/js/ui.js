/** Ben's Burger Bar - every screen, and all switch input.
 *
 *  Input contexts (ACCESSIBILITY.md §4, "If Ben stops pressing, does anything keep
 *  happening?" - in M1, never; Time It Yourself arrives in M2):
 *    card     CHOICE. A menu card is up: main menu, settings, pause, a confirmation, an
 *             order's stars, the shift's results.
 *    station  CHOICE. The station's scan tree (js/core/menus.js) as big plates on the
 *             right, with the bracket frame on the 3D thing the lit plate is about.
 *  Both run on the hub's shared choice scanner (NarbeChoiceScanAdapter): the blank -1,
 *  Auto Scan, parking, the Space brake and Wait for Speech come from it and from the
 *  player's Hub Settings. Every row is entered with enterGroup({wrap:true, backStop:true}),
 *  so it loops through a spoken Back stop and has no Back plate of its own.
 *  This file owns the keys, hold-Space-to-scan-backwards, the 5-second Enter hold that
 *  also opens Pause from a station, and what each choice does. Choices act on RELEASE.
 *
 *  After a choice the scan goes back into the row it came from, on the same item or on
 *  the row's Back stop if the item is gone (BB.menus.resume, the rule the planner counts
 *  presses by). Moving to another station opens it fresh on the blank.
 */
(function () {
  'use strict';
  const pack = BBPacks.diner, W = BB.words, M = BB.menus;
  const $ = id => document.getElementById(id);
  const vm = () => window.NarbeVoiceManager || null;
  const sm = () => window.NarbeScanManager || null;
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const G = () => BB.game;

  /* ── Tuning. Never quoted to the player. ────────────────────────────────── */
  const SCAN_BACK_HOLD = 3000;
  const SCAN_BACK_REPEAT = 2000;
  const PAUSE_HOLD_SHOW = 2000;
  const PAUSE_HOLD_MS = 5000;
  const GHOST_MS = 380;
  const BACK_ID = 'narbe:row-back';       // the adapter's Back stop

  /* ── state ──────────────────────────────────────────────────────────────── */
  let ctx = 'none';                       // none | card | station
  let choice = null, lastLit = null, openedAt = 0, gen = 0;
  let card = null, cardName = '', cardOpts = {};
  let settingsReturn = null;
  const down = { Space: false, Enter: false }, downAt = { Space: 0, Enter: 0 };
  const ignore = { Space: false, Enter: false };
  let backHold = null, backRepeat = null, didBack = false, braking = false, pauseWatch = null;
  let levels = [];                        // station: the open levels, root first { key, rows, node, dom, echo }
  let captionTimer = null;

  const isAuto = () => !!(sm() && sm().getSettings().autoScan);
  const interval = () => (sm() ? sm().getScanInterval() : SCAN_BACK_REPEAT);
  const sfx = (name, vol) => { try { if (BB.save.get('sfx') && window.SafeAudio) SafeAudio.play(name, vol); } catch (e) { /* sound is optional */ } };
  const speak = text => (vm() ? vm().speak(text) : null);

  /* ══ the hub's choice scanner ═══════════════════════════════════════════ */
  function initChoice() {
    if (!window.NarbeChoiceScanAdapter || !sm()) return;
    choice = NarbeChoiceScanAdapter.create({
      holdThreshold: SCAN_BACK_HOLD, stateHost: document.body, speak,
      onContext(current) {
        if (!current || current.kind !== 'station') return;
        // The scanner left a row (its Back stop): drop the rows above it and show this one.
        while (levels.length && levels[levels.length - 1].key !== current.key) levels.pop().remove();
        showLevel();
      },
      onHighlight(item, state, context) {
        if (!context || state.suspended) return;
        document.querySelectorAll('.plate.lit, .item.lit, .tag.lit').forEach(el => el.classList.remove('lit'));
        if (item && item.element) item.element.classList.add('lit');
        if (context.kind === 'station') {
          const top = levels[levels.length - 1];
          const echo = item && item.ref ? echoOf(item.ref, top) : (state.backStop ? null : null);
          BB.world.setEcho(echo || (item ? top && top.echo : null), !!(item && state.braked));
        } else BB.world.setEcho(null);
        const id = item ? item.id : null;
        if (id !== null && id !== lastLit) sfx('hover', 0.25);
        lastLit = id;
      },
      onSelect(item, state, context) {
        sfx('select', 0.4);
        if (context.kind === 'card') { if (item.ref && item.ref.action) item.ref.action(); return; }
        stationChoice(item.ref, context);
      },
    });
  }
  /** A card or station opens: its title speech is the scanner's own, so Auto Scan's first
   *  step waits for it under Wait for Speech; with parking on, "park" is said for the blank. */
  function announceOpen(text) {
    if (!choice || !choice.active) { if (text) speak(text); return; }
    const st = choice.getState(), it = st.index >= 0 ? choice.context.items[st.index] : null;
    const parking = !it && isAuto() && sm().isParkingEnabled();
    const tail = it ? it.label() : parking ? 'Park.' : '';
    const say = [text, tail].filter(Boolean).join('. ');
    if (say) choice.announce(say, { parkingLabel: parking });
  }

  /* ══ cards ══════════════════════════════════════════════════════════════ */
  function openCard(name, opts) {
    opts = opts || {};
    leaveStation();
    ctx = 'card'; cardName = name; cardOpts = opts;
    card = SCREENS[name](opts);
    renderCard();
    openedAt = performance.now();
    swallowHeld();
    if (choice) choice.sync(cardContext(), { fresh: true, restoreId: opts.restoreId || null });
    announceOpen(card.speech === undefined ? card.title : card.speech);
  }
  /** Redraw the open card in place (a setting changed): the highlight stays put. */
  function refreshCard() {
    if (ctx !== 'card') return;
    card = SCREENS[cardName](cardOpts);
    renderCard();
    if (choice) choice.sync(cardContext());
  }
  function cardContext() {
    return { key: 'card:' + cardName, kind: 'card', statusHost: $('cardStatus'),
      items: card.items.map(it => ({ id: it.id, label: () => it.say || it.label, element: it.el, ref: it })) };
  }
  function renderCard() {
    const ov = $('overlay');
    ov.classList.add('on');
    ov.innerHTML = '<div class="card" role="dialog"><div id="cardStatus"></div>' + (card.top || '') +
      (card.title ? '<h1>' + esc(card.title) + '</h1>' : '') + (card.sub ? '<p class="sub">' + card.sub + '</p>' : '') +
      (card.html || '') + '<div class="menu' + (card.cols2 ? ' cols2' : '') + '"></div><p class="hint">' + hint() + '</p></div>';
    const menu = ov.querySelector('.menu');
    card.items.forEach(it => {
      const el = document.createElement('div');
      el.className = 'item' + (it.cls ? ' ' + it.cls : '');
      el.innerHTML = (it.icon ? '<span class="ic">' + it.icon + '</span>' : '') + '<span class="lb">' + esc(it.label) + '</span>' +
        (it.value !== undefined ? '<span class="val">' + esc(it.value) + '</span>' : '');
      el.addEventListener('click', () => pointAndPick(it.id));
      it.el = el;
      menu.appendChild(el);
    });
  }
  function closeCard() { $('overlay').classList.remove('on'); $('overlay').innerHTML = ''; card = null; }
  function hint() {
    const s = sm(), brake = isAuto() && s && s.getSettings().spaceBrake;
    return isAuto() ? '<kbd>Enter</kbd> picks the highlighted choice' + (brake ? ' · <kbd>Space</kbd> pauses the scan' : '')
      : 'Tap <kbd>Space</kbd> = next · hold <kbd>Space</kbd> = back · <kbd>Enter</kbd> = choose';
  }

  /* ══ the station ════════════════════════════════════════════════════════ */
  // The scan's targets are the things in the kitchen. At a station's root, every bin and
  // every thing gets a label pinned on it in the 3D scene, and the scan moves between
  // them. Only what has no place in the kitchen (Ticket, Go To, Pause, what is held)
  // sits in the rail, bottom right. A row (what can be done to a thing, a bin's amounts)
  // is a cluster of plates hung beside its thing, or above the rail for Go To.
  const ICONS = { pause: '⏸️', ticket: '🧾', tickets: '🧾', go: '🚶' };
  function plate(node) {
    const el = document.createElement('div');
    el.className = 'plate' + (node.kind === 'pause' ? ' pause' : '') + (node.star ? ' star' : '');
    const ic = ICONS[node.id] || ICONS[node.kind] || (node.action && node.action.verb === 'serve' ? '🛎️' : '');
    el.innerHTML = (ic ? '<span class="ic">' + ic + '</span>' : '') + '<span class="lb">' + esc(node.label) + '</span>' +
      (node.kind === 'row' ? '<span class="go">›</span>' : '');
    el.addEventListener('click', () => pointAndPick(node.id));
    return el;
  }
  /** A label on a thing in the kitchen: its name in big type, its state under it. A bin's
   *  own label (always on show, js/world.js) becomes the target, so nothing is doubled. */
  function tag(node, at) {
    const el = (at && at.startsWith('bin:') && BB.world.binLabel(at)) || document.createElement('div');
    const serve = node.action && node.action.verb === 'serve' || node.id === 'verb:serve';
    el.className = 'tag pick' + (el.dataset.name ? ' binlabel' : '') + (serve ? ' serve' : '') + (node.star ? ' star' : '');
    const [head, ...rest] = String(node.label).split(', ');
    const more = rest.join(', ');
    el.innerHTML = (serve ? '<span class="ic">🛎️</span> ' : '') + '<b>' + esc(head) + '</b>' +
      (more && more.length <= 40 ? '<small>' + esc(more) + '</small>' : '') + (node.kind === 'row' ? '<span class="go">›</span>' : '');
    el.onclick = () => pointAndPick(node.id);
    return el;
  }
  /** The tray at this station, for Serve. */
  function trayKey() {
    const k = G().kitchen(), sl = pack.stations[k.at].slots.find(x => x.fixed);
    const o = sl && k.stations[k.at].slots[sl.id];
    return o ? 'obj:' + o.uid : null;
  }
  /** Where a root choice lives in the kitchen, or null for the rail. */
  function anchorOf(node) {
    if (node.id.startsWith('obj:')) return node.id;
    if (node.id.startsWith('bin:')) return BB.world.binKey(node.id.slice(4), G().kitchen().at);
    if ((node.action && node.action.verb === 'serve') || node.id === 'verb:serve') return trayKey();
    return null;
  }
  function makeRoot(nodes) {
    const els = [];
    const items = nodes.map(n => {
      const at = anchorOf(n);
      const el = at ? tag(n, at) : plate(n);
      if (at && el.dataset.name) { /* a bin's label: already in place */ }
      // Food is labelled on its front edge, clear of the bins behind it; Serve stands over the tray.
      else if (at) { $('worldLayer').appendChild(el); BB.world.pin(el, at, el.classList.contains('serve') ? 'label' : 'front'); els.push(el); }
      else { $('rail').appendChild(el); els.push(el); }
      return { id: n.id, label: () => n.say, element: el, ref: n };
    });
    return { key: 'st:' + gen + ':', kind: 'station', rows: [], node: null, echo: null, items, statusHost: $('choiceStatus'),
      remove() { els.forEach(el => { BB.world.unpin(el); el.remove(); }); BB.world.resetBinLabels(); } };
  }
  /** A row: a cluster of plates beside its thing, headed by what it is. */
  function makeRow(nodes, rows, node, echo) {
    const dom = document.createElement('div');
    dom.className = 'cluster' + (echo ? '' : ' docked');
    const head = document.createElement('div');
    head.className = 'crumb';
    head.innerHTML = '<span class="bk">‹</span>' + esc(node.label);
    head.addEventListener('click', onCrumb);
    dom.appendChild(head);
    const list = document.createElement('div');
    list.className = 'choices' + (nodes.length > 6 ? ' cols2' : '');
    if (nodes.length > 6) list.style.gridTemplateRows = 'repeat(' + Math.ceil(nodes.length / 2) + ', auto)';
    dom.appendChild(list);
    const items = nodes.map(n => ({ id: n.id, label: () => n.say, element: plate(n), ref: n }));
    items.forEach(it => list.appendChild(it.element));
    document.body.appendChild(dom);
    if (echo) BB.world.pin(dom, echo, 'beside');
    return { key: 'st:' + gen + ':' + rows.join('>'), kind: 'station', rows, node, dom, echo, items, statusHost: $('choiceStatus'),
      remove() { BB.world.unpin(dom); dom.remove(); } };
  }
  function showLevel() {
    levels.forEach((l, i) => { if (l.dom) l.dom.style.display = i === levels.length - 1 ? '' : 'none'; });
    document.body.classList.toggle('inrow', levels.length > 1);
  }
  /** What 3D thing a choice is about: the thing itself, a bin, the tray for Serve. */
  function echoOf(node, lvl) {
    if (node.id.startsWith('obj:')) return node.id;
    // The customer is only in view from the counter.
    if (node.ticket !== undefined || node.kind === 'ticket') return G().kitchen().at === 'counter' ? 'customer' : null;
    const a = node.action;
    if (a && a.target && a.target !== 'hand') return 'obj:' + a.target;
    if (a && a.bin) return BB.world.binKey(a.bin, a.station);
    if ((a && a.verb === 'serve') || node.id === 'verb:serve') return trayKey();
    if (node.id.startsWith('bin:')) return BB.world.binKey(node.id.slice(4), G().kitchen().at);
    return lvl ? lvl.echo : null;
  }

  function leaveStation() {
    levels.forEach(l => l.remove());
    levels = [];
    $('rail').classList.remove('on');
    document.body.classList.remove('inrow');
    BB.world.setEcho(null);
  }
  /** Draw the station's tree and put the scan at `to` ({ rows, land }), or on the blank. */
  function openStation(to, outcome) {
    if (ctx === 'card') closeCard();
    leaveStation();
    ctx = 'station';
    gen += 1;
    $('rail').classList.add('on');
    paintTicket();
    const tree = G().tree();
    let list = tree.items;
    const root = makeRoot(list);
    levels = [root];
    to = to || { rows: [], land: null };
    const first = to.rows.length ? to.rows[0] : to.land;
    openedAt = performance.now();
    swallowHeld();
    if (choice) choice.sync(root, { fresh: true, restoreId: first && first !== 'back' ? first : null });
    let echo = null;
    for (let d = 0; d < to.rows.length && choice; d++) {
      const node = list.find(n => n.id === to.rows[d]);
      echo = echoOf(node, levels[levels.length - 1]) || echo;
      const lvl = makeRow(node.children, to.rows.slice(0, d + 1), node, echo);
      levels.push(lvl);
      showLevel();
      const next = d + 1 < to.rows.length ? to.rows[d + 1] : (to.land === 'back' ? BACK_ID : to.land);
      if (!choice.enterGroup(lvl, { wrap: true, backStop: true, restoreId: next })) { levels.pop().remove(); break; }
      list = node.children;
    }
    showLevel();
    if (outcome !== undefined) announceOpen(outcome);
  }
  /** Enter a row: the scan lands on its first item. */
  function enterRow(node) {
    const top = levels[levels.length - 1];
    const lvl = makeRow(node.children, top.rows.concat(node.id), node, echoOf(node, top));
    levels.push(lvl);
    showLevel();
    if (!choice || !choice.enterGroup(lvl, { wrap: true, backStop: true })) { levels.pop().remove(); showLevel(); }
  }

  function stationChoice(node, context) {
    if (!node) return;
    if (node.kind === 'row') { enterRow(node); return; }
    if (node.kind === 'pause') { openPause(); return; }
    if (node.kind === 'ticket') {
      // Speaks the order again; the highlight stays on Ticket.
      const t = G().ticketText();
      caption(t.caption);
      if (choice) choice.announce(t.say);
      return;
    }
    if (!node.action) return;
    const ids = context.rows.concat(node.id);
    const r = G().act(node.action);
    if (r.refused) { sfx('bust', 0.3); return; }
    if (r.served) return;                                   // the game opens the order's card
    if (node.action.verb === 'go') {
      BB.world.goTo(node.action.opt.to);
      openStation(null, G().stationName());
      return;
    }
    if (r.text) caption(esc(r.text));
    openStation(M.resume(G().tree(), ids), r.text || '');
  }

  /** The ticket: whose order this is, what it says, and what the player is holding. */
  function paintTicket(show) {
    const t = G().ticket(), el = $('ticket');
    if (!t || show === false) { el.classList.remove('on'); return; }
    el.classList.add('on');
    const k = G().kitchen();
    el.innerHTML = '<div class="who">Working on: <b>' + esc(t.customer.name) + '</b></div><ol>' +
      t.items.map(s => '<li>' + esc(W.item(pack, s)) + '</li>').join('') + '</ol>' +
      (k.hand ? '<div class="held">Holding: ' + esc(W.thing(pack, k.hand)) + '</div>' : '') +
      '<div class="meta">Customer ' + G().progress().at + ' of ' + G().progress().of + '</div>';
  }

  /* ── captions ──────────────────────────────────────────────────────────── */
  function caption(html, ms) {
    const el = $('caption');
    el.innerHTML = html;
    el.classList.add('on');
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => el.classList.remove('on'), ms || Math.max(4000, html.length * 70));
  }

  /* ══ mouse and touch ════════════════════════════════════════════════════ */
  function pointAndPick(id) {
    if (!choice || !choice.active || performance.now() - openedAt < GHOST_MS) return;
    const cur = choice.context;
    if (!cur || !cur.items.some(it => it.id === id)) return;
    if (choice.getState().id !== id) {
      // align() would reopen a row as a fresh top-level menu; inside a row, step round to it.
      if (choice.getState().depth > 0) {
        for (let k = 0; k < cur.items.length + 2 && choice.getState().id !== id; k++) choice.step(1);
        if (choice.getState().id !== id) return;
      } else choice.align(id);
    }
    choice.select();
  }
  function onCrumb() {
    if (ctx === 'station' && levels.length > 1 && choice) choice.back({ restore: true });
  }

  /* ══ switch input ═══════════════════════════════════════════════════════ */
  const isSwitch = c => c === 'Space' || c === 'Enter' || c === 'NumpadEnter';
  const norm = c => (c === 'NumpadEnter' ? 'Enter' : c);
  function clearBack() { clearTimeout(backHold); backHold = null; clearInterval(backRepeat); backRepeat = null; didBack = false; }
  function clearPauseWatch() { clearInterval(pauseWatch); pauseWatch = null; ring(0); }
  function clearKeys() {
    down.Space = down.Enter = false; braking = false;
    clearBack(); clearPauseWatch();
    if (choice) choice.setInputHeld(false);
  }
  /** A key already down when a new screen opens belongs to the old one: its release is ignored. */
  function swallowHeld() {
    if (down.Space) ignore.Space = true;
    if (down.Enter) ignore.Enter = true;
    clearKeys();
  }
  function ring(p) {
    const r = $('holdRing');
    r.classList.toggle('on', p > 0);
    r.querySelector('i').style.setProperty('--p', Math.max(0, Math.min(1, p)).toFixed(3));
  }
  function onKeyDown(e) {
    if (!isSwitch(e.code)) return;
    e.preventDefault();
    if (e.repeat) return;
    const k = norm(e.code);
    if (ignore[k]) ignore[k] = false;
    if (down[k]) return;
    down[k] = true; downAt[k] = performance.now();
    if ((ctx === 'card' || ctx === 'station') && choice && choice.active) {
      // Auto Scan + Space Brake: Space freezes the scan on PRESS so the label is not cut off.
      if (k === 'Space') braking = choice.brakePress();
      if (k !== 'Space' || !braking) choice.setInputHeld(true);
      if (k === 'Space' && !braking && !backHold && !backRepeat) {
        didBack = false;
        backHold = setTimeout(() => {
          backHold = null; didBack = true; choice.step(-1);
          backRepeat = setInterval(() => choice.step(-1), interval());
        }, SCAN_BACK_HOLD);
      }
    }
    if (k === 'Enter' && ctx === 'station') watchPauseHold();
  }
  /** Holding Enter for 5 seconds also opens Pause from a station (a ring shows from 2 s). */
  function watchPauseHold() {
    clearPauseWatch();
    pauseWatch = setInterval(() => {
      if (!down.Enter) { clearPauseWatch(); return; }
      const held = performance.now() - downAt.Enter;
      if (held >= PAUSE_HOLD_MS) { clearPauseWatch(); openPause(); return; }
      if (held >= PAUSE_HOLD_SHOW) ring((held - PAUSE_HOLD_SHOW) / (PAUSE_HOLD_MS - PAUSE_HOLD_SHOW));
    }, 50);
  }
  function onKeyUp(e) {
    if (!isSwitch(e.code)) return;
    e.preventDefault();
    const k = norm(e.code);
    if (ignore[k]) { ignore[k] = false; down[k] = false; return; }
    if (!down[k]) return;
    down[k] = false;
    if (k === 'Enter') clearPauseWatch();
    if (ctx !== 'card' && ctx !== 'station') return;
    if (!choice || !choice.active) return;
    if (k === 'Space') {
      const wasBack = didBack, wasBrake = braking;
      clearBack(); braking = false;
      if (wasBrake) choice.brakeRelease();
      else if (!wasBack) choice.step(1);
    } else choice.select();
    choice.setInputHeld(down.Space || down.Enter);
  }
  /** Focus lost, or the hub's input guard dropped a press: no key may stay half-held. */
  function onBlur() { clearKeys(); ignore.Space = ignore.Enter = false; if (choice) choice.cancelInput(); }

  /* ══ the routes in and out ══════════════════════════════════════════════ */
  function openPause() {
    if (!G().inShift()) return;
    openCard('pause');
  }
  function openSettings(from) { settingsReturn = from; openCard('settings'); }
  function backFromSettings() {
    const r = settingsReturn || { card: 'title' };
    if (r.card) openCard(r.card, { restoreId: 'settings' });
  }
  function exitGame() {
    if (choice) choice.sync(null);
    speak('Exiting to hub');
    setTimeout(() => {
      if (window.parent && window.parent !== window) window.parent.postMessage({ action: 'focusBackButton' }, '*');
      else window.location.href = '../../../index.html';
    }, 700);
  }
  /** A one-way door: the safe choice comes first, and the consequence is spoken on open. */
  function confirm(id, title, warn, yes, fn) {
    openCard('confirm', { id, title, warn, yes, fn, from: cardName, fromOpts: cardOpts });
  }

  /* ══ SCREENS ════════════════════════════════════════════════════════════ */
  const onOff = v => (v ? 'On' : 'Off');
  const cycle = (list, v) => list[(list.indexOf(v) + 1) % list.length];
  const SHIFT_LENGTHS = [5, 3, 8];
  const ORDERS = { usual: 'Usual', simple: 'Simple', fancy: 'Fancy' };
  const ORDERS_SAY = { usual: 'Usual. One or two burgers, as customers like them.', simple: 'Simple. One burger with up to two toppings.',
    fancy: 'Fancy. More changes to every order.' };
  const TEXT = { normal: 'Normal', large: 'Large', xlarge: 'Extra Large' };
  const stars = n => '<div class="stars">' + [1, 2, 3].map(i => '<span' + (i > n ? ' class="off"' : '') + '>★</span>').join('') + '</div>';

  /** A setting item: its label, value and what it means, said on every change. */
  function setting(id, label, value, say, change) {
    return { id, label, value, say: label + ', ' + (say || value), action() {
      change();
      refreshCard();
      const it = card.items.find(x => x.id === id);
      if (choice && it) choice.announce(it.say);
    } };
  }

  const SCREENS = {
    title: () => ({
      top: '<div class="logo"><span class="top">BEN\'S</span><span class="main">Burger Bar</span></div>',
      title: '', sub: 'Make every order by hand.', speech: "Ben's Burger Bar",
      items: [
        { id: 'start', label: 'Start Shift', icon: '🍔', action: () => G().startShift() },
        { id: 'settings', label: 'Settings', icon: '⚙️', action: () => openSettings({ card: 'title' }) },
        { id: 'exit', label: 'Exit Game', icon: '🚪', action: () => confirm('exit', 'Exit the game?', 'You will go back to the hub.', 'Exit Game', exitGame) },
      ],
    }),

    settings: () => {
      const v = vm(), s = sm(), S = BB.save;
      const tts = v ? v.getSettings().ttsEnabled : false;
      const voice = v && v.getCurrentVoice() ? v.getVoiceDisplayName(v.getCurrentVoice()) : 'Default';
      const auto = isAuto();
      const later = G().inShift() ? ' From the next shift.' : '';
      return {
        title: 'Settings', sub: '', cols2: true,
        items: [
          setting('tts', 'Text to Speech', onOff(tts), null, () => v && v.toggleTTS()),
          setting('voice', 'Voice', voice, null, () => v && v.cycleVoice()),
          setting('shiftLength', 'Shift Length', S.get('shiftLength') + ' customers', S.get('shiftLength') + ' customers.' + later,
            () => S.set('shiftLength', cycle(SHIFT_LENGTHS, +S.get('shiftLength')))),
          setting('orders', 'Orders', ORDERS[S.get('orders')], ORDERS_SAY[S.get('orders')] + later, () => S.set('orders', cycle(Object.keys(ORDERS), S.get('orders')))),
          setting('star', 'Next-Step Star', onOff(S.get('star')), S.get('star') ? 'On. A star marks the next step.' : 'Off',
            () => { S.set('star', !S.get('star')); }),
          setting('motion', 'Motion', S.get('motion') === 'reduced' ? 'Reduced' : 'Full',
            S.get('motion') === 'reduced' ? 'Reduced. The camera cuts between stations.' : 'Full', () => S.set('motion', S.get('motion') === 'reduced' ? 'full' : 'reduced')),
          setting('textSize', 'Text Size', TEXT[S.get('textSize')], null, () => S.set('textSize', cycle(Object.keys(TEXT), S.get('textSize')))),
          setting('autoScan', 'Auto Scan', auto ? 'On — One Switch' : 'Off — Two Switches',
            auto ? 'On. One switch. Enter picks the highlighted choice.' : 'Off. Two switches. Space moves, Enter picks.', () => s && s.toggleAutoScan()),
          setting('scanSpeed', 'Scan Speed', s ? s.getScanInterval() / 1000 + ' s' : '2 s', s ? s.getScanInterval() / 1000 + ' seconds' : null, () => s && s.cycleScanSpeed()),
          setting('sfx', 'Sound Effects', onOff(S.get('sfx')), null, () => S.set('sfx', !S.get('sfx'))),
          { id: 'back', label: 'Back', icon: '↩', action: backFromSettings },
        ],
      };
    },

    pause: () => ({
      title: 'Paused', speech: 'Paused',
      items: [
        { id: 'continue', label: 'Continue', icon: '▶️', action: () => G().resume() },
        { id: 'restart', label: 'Restart Shift', icon: '🔁', action: () => confirm('restart', 'Restart the shift?', "This shift's orders and tips start again.", 'Restart Shift', () => G().startShift()) },
        { id: 'settings', label: 'Settings', icon: '⚙️', action: () => openSettings({ card: 'pause' }) },
        { id: 'menu', label: 'Main Menu', icon: '🏠', action: () => confirm('menu', 'Go to the main menu?', 'This shift ends, and its tips are lost.', 'Main Menu', () => G().quit()) },
        { id: 'exit', label: 'Exit Game', icon: '🚪', action: () => confirm('exit', 'Exit the game?', 'This shift ends, and you go back to the hub.', 'Exit Game', exitGame) },
      ],
    }),

    confirm: o => ({
      title: o.title, sub: esc(o.warn), speech: o.title + ' ' + o.warn,
      items: [
        { id: 'cancel', label: 'Cancel', icon: '↩', action: () => openCard(o.from, Object.assign({}, o.fromOpts, { restoreId: o.id })) },
        { id: 'yes', label: o.yes, icon: '✔️', action: o.fn },
      ],
    }),

    /** After a serve: the customer's reaction, the stars and the tip. */
    served: o => ({
      title: o.name, sub: '“' + esc(o.line) + '”', html: stars(o.stars) + '<p class="sub">Tip: ' + o.tip + ' coins</p>',
      speech: o.name + ': ' + o.line + ' ' + o.stars + (o.stars === 1 ? ' star.' : ' stars.') + ' Tip, ' + o.tip + ' coins.',
      items: [o.last
        ? { id: 'results', label: 'Results', icon: '🏁', action: () => G().showResults() }
        : { id: 'next', label: 'Next Customer', icon: '🛎️', action: () => G().nextCustomer() }],
    }),

    results: o => ({
      title: 'Shift done', sub: o.orders + ' orders · ' + o.coins + ' coins in tips',
      html: '<p class="sub">' + o.stars.map(n => '★'.repeat(n)).join(' · ') + '</p>',
      speech: 'Shift done. ' + o.orders + ' orders, ' + o.coins + ' coins in tips.',
      items: [
        { id: 'again', label: 'Another Shift', icon: '🍔', action: () => G().startShift() },
        { id: 'menu', label: 'Main Menu', icon: '🏠', action: () => G().quit() },
        { id: 'exit', label: 'Exit Game', icon: '🚪', action: () => confirm('exit', 'Exit the game?', 'You will go back to the hub.', 'Exit Game', exitGame) },
      ],
    }),
  };

  function applyLook() {
    document.body.dataset.motion = BB.save.get('motion');
    document.body.dataset.text = BB.save.get('textSize');
  }

  function init() {
    initChoice();
    applyLook();
    BB.save.onChange(applyLook);
    if (sm()) sm().subscribe(() => { if (ctx === 'card') refreshCard(); });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('narbe-input-cancelled', onBlur);
    if (window.SafeAudio) ['select', 'hover', 'score', 'win', 'bust'].forEach(n => SafeAudio.preload(n));
  }

  /** For the browser check: where the scan is and what it would say. */
  function __dbg() {
    const st = choice ? choice.getState() : null;
    const cur = choice && choice.context;
    return { ctx, card: cardName, index: st ? st.index : -1, id: st ? st.id : null, depth: st ? st.depth : 0,
      backStop: !!(st && st.backStop), parked: !!(st && st.parked), items: cur ? cur.items.map(it => it.id) : [],
      rows: levels.length ? levels[levels.length - 1].rows : [] };
  }

  BB.ui = { init, openCard, openStation, caption, paintTicket, openPause, __dbg, get context() { return ctx; } };
})();
