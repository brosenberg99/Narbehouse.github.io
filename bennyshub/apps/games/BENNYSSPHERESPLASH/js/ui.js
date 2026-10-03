/** Benny's Sphere Splash - every screen, and all switch input.
 *
 * NARBE Racer's card engine (NARBEKART/js/ui.js): every menu is SCREENS[name](opts)
 * returning { title, sub, items, speech, startIndex, listenFirst, layout, size, stats },
 * rendered into one card and fitted so it never needs a scrollbar.
 *
 * Three input contexts:
 *   card   a menu card is up. Space released = next, Enter released = choose, hold
 *          Space = scan backwards at the player's scan speed, Auto Scan from
 *          NarbeScanManager. The hub's contract, exactly.
 *   world  a decision is on the scene: the SAME scanning, over the choice plates
 *          beside the carrier, the teammates themselves (pass targets) and the
 *          on-screen Pause button. Holding Enter opens Pause from here too.
 *   live   the match is playing. A short press of either switch opens the Huddle.
 *          Holding Enter opens Pause directly, with Racer's "keep holding" ring and
 *          rising ticks.
 * Everything fires on RELEASE. A press of any length short of the full pause hold
 * is an ordinary press - a player may hold a switch for seconds without meaning to.
 *
 * Every card and decision opens with nothing highlighted, Back included
 * (ACCESSIBILITY.md "Menus open with nothing highlighted"): the first Space finds the
 * first item, hold Space the last, and Enter waits for a choice. Only an in-place
 * change (a setting's value, arming Reset) keeps the highlight. Each list has a blank
 * step before it wraps, so Auto Scan leaves a beat between laps.
 * The focus marker (Fish Mystery's brackets) is the same on cards and in the world.
 */
SS.ui = (function () {
  'use strict';

  const U = SS.util, $ = U.$;

  /* ── Tuning. Never quoted to the player (ACCESSIBILITY.md §4). ──────────── */
  const SCAN_BACK_HOLD = 3000;
  const SCAN_BACK_REPEAT = 2000;   // if the scan manager is missing
  const PAUSE_HOLD_SHOW = 2000;    // the ring appears, so the gesture is discoverable
  const PAUSE_HOLD_MS = 5000;      // Pause opens
  const GHOST_MS = 380;            // a new card ignores taps this soon (touch -> click echo)
  const ACTIVATE_DEBOUNCE = 140;
  const RESET_ARM_MS = 6000;

  /* ── state ───────────────────────────────────────────────────────────── */
  let ctx = 'none';                // none | card | world | live
  let screen = null, screenOpts = {}, meta = {}, items = [], index = -1;
  let world = null;                // the open decision: { spec, index }
  let autoTimer = null, openedAt = 0, lastActivate = 0, resetArmed = 0;
  let settingsReturn = null, cardReturn = null;
  const down = { Space: false, Enter: false }, downAt = { Space: 0, Enter: 0 };
  const pressIndex = { Space: -1, Enter: -1 };
  const ignore = { Space: false, Enter: false };
  let backHold = null, backRepeat = null, didBack = false;
  let pauseWatch = null, pauseTicks = 0;

  const G = () => SS.game;
  const isAuto = () => { const s = U.sm(); return !!(s && s.getSettings().autoScan); };
  const interval = () => { const s = U.sm(); return s ? s.getScanInterval() : SCAN_BACK_REPEAT; };
  const setting = k => SS.save.settings.get(k);

  /* ══ the card ═══════════════════════════════════════════════════════════ */
  function buildDom() {
    const ov = $('overlay');
    ov.innerHTML = '<div id="card" class="card" role="dialog" aria-live="polite">' +
      '<div class="band" aria-hidden="true"></div><div id="cardArt" class="art"></div>' +
      '<h1 id="cardTitle"></h1><p id="cardSub"></p><div id="cardStats"></div>' +
      '<div id="menu" class="menu"></div><p id="hint"></p></div>';
    U.addTap($('pauseBtn'), () => {
      if (ctx === 'live' || ctx === 'world') openPause();
      else if (ctx === 'card' && screen === 'huddle') setScreen('pause');
    });
    // Mouse and touch in live play: a tap on the water opens the Huddle, like a press.
    U.addTap($('canvasWrap'), () => { if (ctx === 'live' && performance.now() - openedAt > GHOST_MS) G().openHuddle(); });
    window.addEventListener('resize', refitSoon);
  }

  const selectable = it => !!it && it.enabled !== false && !it.header;

  function renderCard() {
    const menu = $('menu');
    menu.innerHTML = '';
    menu.className = 'menu ' + (meta.layout || 'list');
    if (meta.layout === 'cols2') menu.style.gridTemplateRows = 'repeat(' + Math.ceil(items.length / 2) + ', auto)';
    else menu.style.gridTemplateRows = '';
    items.forEach((it, i) => {
      const el = document.createElement('div');
      el.className = 'item' + (it.wide ? ' wide' : '') + (it.header ? ' header' : '') + (it.enabled === false && !it.header ? ' locked' : '') +
        (it.primary ? ' primary' : '') + (it.cls ? ' ' + it.cls : '');
      let html = '';
      if (it.icon) html += '<span class="ic">' + it.icon + '</span>';
      html += '<span class="lb"><span class="nm">' + it.label + '</span>' + (it.note ? '<small>' + it.note + '</small>' : '') + '</span>';
      if (it.value !== undefined && it.value !== '') html += '<span class="val">' + U.esc(it.value) + '</span>';
      el.innerHTML = html;
      if (!it.header) {
        U.addTap(el, () => {
          if (performance.now() - openedAt < GHOST_MS) return;     // the tail of the tap that opened this card
          if (it.enabled === false) { SS.audio.menu('blocked'); return; }
          index = i; showFocus(); activate(i);
        });
        el.addEventListener('mouseenter', () => { if (!selectable(it) || index === i) return; index = i; showFocus(); restartAuto(); });
      }
      it.el = el;
      menu.appendChild(el);
    });
  }

  /** No card may ever need a scrollbar: try the tight layout, then scale (never below 0.6). */
  function fitCard() {
    const card = $('card'), ov = $('overlay');
    card.classList.remove('tight'); card.style.transform = ''; card.style.marginBottom = '';
    const cs = getComputedStyle(ov);
    const room = ov.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0) - 8;
    let h = card.getBoundingClientRect().height;
    if (h <= room) return;
    card.classList.add('tight');
    h = card.getBoundingClientRect().height;
    if (h <= room) return;
    const k = Math.max(0.6, room / h);
    card.style.transform = 'scale(' + k.toFixed(3) + ')';
    card.style.marginBottom = Math.round(-h * (1 - k)) + 'px';
  }
  let refitTimer = null;
  function refitSoon() { clearTimeout(refitTimer); refitTimer = setTimeout(() => { if (ctx === 'card') fitCard(); }, 140); }

  /** A card or a decision appears. A switch still held belongs to whatever opened it. */
  function swallowHeld() {
    ['Space', 'Enter'].forEach(k => { if (down[k]) ignore[k] = true; });
    clearKeys();
    openedAt = performance.now();
  }

  function setScreen(name, opts) {
    const builder = SCREENS[name];
    if (!builder) return;
    opts = opts || {};
    const wasCard = ctx === 'card';
    screen = name; screenOpts = opts;
    meta = builder(opts) || {};
    items = meta.items || [];
    index = meta.startIndex !== undefined ? meta.startIndex : (meta.listenFirst === false ? 0 : -1);
    if (opts.index !== undefined) index = opts.index;
    if (index >= items.length) index = items.length - 1;
    if (index >= 0 && !selectable(items[index])) index = nextSelectable(index, 1, false);

    leaveWorld();
    ctx = 'card';
    const ov = $('overlay'), card = $('card');
    ov.classList.add('on');
    ov.classList.toggle('scrim', !!meta.scrim);
    card.className = 'card size-' + (meta.size || 'normal') + (meta.cardClass ? ' ' + meta.cardClass : '');
    if (opts.announce !== false) { void card.offsetWidth; card.classList.add('enter'); }
    $('cardArt').innerHTML = meta.art || '';
    $('cardTitle').innerHTML = meta.title || '';
    $('cardSub').innerHTML = meta.sub || '';
    $('hint').innerHTML = meta.hint || defaultHint();
    renderCard();
    if (!wasCard || opts.announce !== false) swallowHeld();
    showChrome();
    showFocus();
    fitCard();
    SS.broadcast.hush();
    if (meta.announce !== false && opts.announce !== false) U.speak(meta.speech || U.stripTags((meta.title || '') + '. ' + (meta.sub || '')));
    restartAuto();
  }
  function refresh() { setScreen(screen, Object.assign({}, screenOpts, { index, announce: false })); }

  function closeCard() {
    $('overlay').classList.remove('on');
    screen = null; items = []; index = -1;
    SS.worldui.setFocus(null);
    stopAuto();
  }

  function showChrome() {
    const inMatch = G() && G().inMatch();
    $('pauseBtn').classList.toggle('on', inMatch && (ctx === 'live' || ctx === 'world'));
    if (SS.hud) SS.hud.visible(inMatch && ctx !== 'card');
  }

  /* ══ the world (a decision on the scene) ════════════════════════════════ */
  /** spec = { title, sub, items: [{ label, sub, odds, speech, action, focus?, el? }], anchor, speech } */
  function openWorld(spec) {
    closeCard();
    leaveWorld();
    world = { spec, index: -1 };
    ctx = 'world';
    items = spec.items;
    buildCluster(spec);
    if (spec.onOpen) spec.onOpen();
    index = world.index;
    swallowHeld();
    showChrome();
    showFocus();
    if (spec.speech) U.speak(spec.speech);
    SS.broadcast.hush();
    restartAuto();
  }
  function buildCluster(spec) {
    const el = document.createElement('div');
    el.className = 'cluster';
    el.innerHTML = '<div class="head"><b></b><span></span></div><div class="row"></div>';
    el.querySelector('.head b').textContent = spec.title || '';
    el.querySelector('.head span').textContent = spec.sub || '';
    const row = el.querySelector('.row');
    spec.items.forEach((it, i) => {
      // A teammate, or the Pause button: not a plate. A plate item keeps its old element when
      // the same choice comes back from Pause, so that alone must not skip it (Bryan found the
      // plates gone after Pause > Continue: every item was skipped as if it were the button).
      if (it.focus || (it.el && !it.plate)) return;
      const p = document.createElement('div');
      p.className = 'plate' + (it.cls ? ' ' + it.cls : '');
      p.innerHTML = '<b></b><span class="sub"></span><span class="odds"><i></i><em></em></span>';
      p.querySelector('b').textContent = it.label;
      p.querySelector('.sub').textContent = it.sub || '';
      if (it.odds) {
        p.querySelector('.odds i').style.setProperty('--p', it.odds.p.toFixed(2));
        p.querySelector('.odds em').textContent = it.odds.word;
        p.dataset.odds = it.odds.word.toLowerCase().replace(/\s+/g, '-');
      } else p.querySelector('.odds').remove();
      U.addTap(p, () => { if (performance.now() - openedAt < GHOST_MS) return; index = i; showFocus(); activate(i); });
      p.addEventListener('mouseenter', () => { if (index === i) return; index = i; showFocus(); restartAuto(); });
      it.el = p; it.plate = true;
      row.appendChild(p);
    });
    SS.worldui.setCluster(spec.anchor, el);
    world.cluster = el;
  }
  /** Change what the cluster's heading says (the focused teammate's details). */
  function worldHead(title, sub) {
    if (!world || !world.cluster) return;
    world.cluster.querySelector('.head b').textContent = title;
    world.cluster.querySelector('.head span').textContent = sub || '';
  }
  function leaveWorld() {
    if (!world) return;
    SS.worldui.setCluster(null, null);
    SS.worldui.setFocus(null);
    if (world.spec.onLeave) world.spec.onLeave();
    world = null;
  }
  function closeWorld() { leaveWorld(); items = []; index = -1; stopAuto(); }

  /* ══ focus and scanning (cards and world alike) ═════════════════════════ */
  function showFocus() {
    items.forEach((it, i) => { if (it.el && it.el !== $('pauseBtn')) it.el.classList.toggle('focused', i === index); });
    $('pauseBtn').classList.toggle('focused', !!items[index] && items[index].el === $('pauseBtn'));
    const it = items[index];
    if (ctx === 'card') {
      $('cardStats').innerHTML = it && it.stats !== undefined ? it.stats : (meta.stats || '');
      SS.worldui.setFocus(it && it.el ? { el: it.el } : null);
    } else if (ctx === 'world') {
      if (world) world.index = index;
      SS.worldui.setFocus(!it ? null : it.focus ? { pts: it.focus } : { el: it.el });
    }
    if (ctx === 'world' && world && world.spec.onFocus) world.spec.onFocus(it || null);
    if (it && it.onFocus) it.onFocus();
  }
  function speakItem() {
    const it = items[index];
    if (it) U.speak(it.speech !== undefined ? it.speech : U.stripTags(it.label) + (it.value !== undefined && it.value !== '' ? ', ' + it.value : ''));
  }
  /** The next selectable index from i in direction d. With `blank`, running off either
   *  end returns -1 (nothing highlighted) - the beat between laps - and the step after
   *  that starts the next lap. */
  function nextSelectable(i, d, blank) {
    const n = items.length;
    for (let k = 0; k < n + 2; k++) {
      i += d;
      if (i < 0 || i >= n) {
        if (blank) return -1;
        i = d > 0 ? -1 : n;                 // wrap: the next step lands on the first or last item
        continue;
      }
      if (selectable(items[i])) return i;
    }
    return -1;
  }
  function step(d) {
    if (!items.length || (ctx !== 'card' && ctx !== 'world')) return;
    const lap = items.filter(selectable).length > 1;
    index = index < 0 ? nextSelectable(d > 0 ? -1 : items.length, d, false) : nextSelectable(index, d, lap);
    showFocus();
    if (index >= 0) { speakItem(); SS.audio.menu('move'); }
    if (!didBack) restartAuto();
  }
  function activate(at) {
    const t = performance.now();
    if (t - lastActivate < ACTIVATE_DEBOUNCE) return;
    lastActivate = t;
    const i = at != null && at >= 0 && at < items.length ? at : index;
    if (i < 0) { U.speak(isAuto() ? 'Wait for the highlight, then press Enter' : 'Press Space first to pick an item'); return; }
    const it = items[i];
    if (!selectable(it)) { SS.audio.menu('blocked'); return; }
    SS.audio.menu('select');
    if (typeof it.action === 'function') it.action();
  }

  function restartAuto() {
    stopAuto();
    if ((ctx !== 'card' && ctx !== 'world') || !isAuto()) return;
    if (down.Space || down.Enter) return;                  // the highlight waits while a switch is held
    autoTimer = setInterval(() => step(1), interval());
  }
  function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }

  function defaultHint() {
    const touch = (() => { try { return matchMedia('(hover: none) and (pointer: coarse)').matches; } catch (e) { return false; } })();
    const keys = isAuto() ? '<kbd>Enter</kbd> picks the highlighted item'
      : 'Tap <kbd>Space</kbd> = next · hold <kbd>Space</kbd> = back · <kbd>Enter</kbd> = choose';
    return (touch ? 'Tap an item to pick it · ' : '') + keys;
  }

  /* ══ switch input ═══════════════════════════════════════════════════════ */
  const isSwitch = c => c === 'Space' || c === 'Enter' || c === 'NumpadEnter';
  const norm = c => (c === 'NumpadEnter' ? 'Enter' : c);

  function clearBack() { clearTimeout(backHold); backHold = null; clearInterval(backRepeat); backRepeat = null; didBack = false; }
  function clearPauseWatch() { clearInterval(pauseWatch); pauseWatch = null; pauseTicks = 0; if (SS.hud) SS.hud.ring(0); }
  function clearKeys() {
    down.Space = down.Enter = false; pressIndex.Space = pressIndex.Enter = -1;
    clearBack(); clearPauseWatch();
  }

  function onKeyDown(e) {
    if (!isSwitch(e.code)) return;
    e.preventDefault();
    if (e.repeat) return;
    const k = norm(e.code);
    if (ignore[k]) ignore[k] = false;                     // a fresh press: that key was let go, even if we missed it
    if (down[k]) return;
    down[k] = true; downAt[k] = performance.now();
    if (ctx === 'card' || ctx === 'world') {
      pressIndex[k] = index;
      stopAuto();
      if (k === 'Space' && !backHold && !backRepeat) {
        didBack = false;
        backHold = setTimeout(() => {
          backHold = null; didBack = true; step(-1);
          backRepeat = setInterval(() => step(-1), interval());
        }, SCAN_BACK_HOLD);
      }
    }
    if (k === 'Enter' && (ctx === 'live' || ctx === 'world')) watchPauseHold();
  }

  function watchPauseHold() {
    clearPauseWatch();
    pauseWatch = setInterval(() => {
      if (!down.Enter) { clearPauseWatch(); return; }
      const held = performance.now() - downAt.Enter;
      if (held >= PAUSE_HOLD_MS) { clearPauseWatch(); openPause(); return; }
      if (held < PAUSE_HOLD_SHOW) return;
      SS.hud.ring((held - PAUSE_HOLD_SHOW) / (PAUSE_HOLD_MS - PAUSE_HOLD_SHOW));
      const secs = Math.floor(held / 1000);
      if (secs > pauseTicks) { pauseTicks = secs; SS.audio.tick(secs - 1); }
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
    if (ctx === 'live') { G().openHuddle(); return; }
    if (ctx !== 'card' && ctx !== 'world') return;
    if (k === 'Space') {
      const wasBack = didBack;
      clearBack();
      if (wasBack) { pressIndex.Space = -1; restartAuto(); return; }
      step(1);
    } else {
      const at = pressIndex.Enter; pressIndex.Enter = -1;
      activate(at);
    }
    restartAuto();
  }

  function onBlur() { clearKeys(); ignore.Space = ignore.Enter = false; if (ctx === 'card' || ctx === 'world') restartAuto(); }

  /* ══ match lifecycle hooks (called by SS.game) ═════════════════════════ */
  function goLive() {
    closeCard(); closeWorld();
    ctx = 'live';
    swallowHeld();
    showChrome();
  }
  /** Pause: from live play, a decision, or the Huddle. Continue returns to where it came from. */
  function openPause() {
    if (!G().inMatch()) return;
    cardReturn = world ? { world: world.spec } : { live: true };
    G().setFrozen(true);
    setScreen('pause');
  }
  function resumeFromCard() {
    const r = cardReturn; cardReturn = null;
    if (r && r.world) { openWorld(r.world); return; }      // asks again, nothing highlighted
    G().resume();
  }

  function goToHub() {
    stopAuto(); SS.audio.stopAll(); SS.broadcast.hush();
    if (G()) G().saveNow();
    U.speak('Exiting to hub');
    setTimeout(leave, 700);
  }
  function leave() {
    if (window.parent && window.parent !== window) window.parent.postMessage({ action: 'focusBackButton' }, '*');
    else window.location.href = '../../../index.html';
  }
  function openSettings() { resetArmed = 0; settingsReturn = { screen, opts: screenOpts }; setScreen('settings'); }
  function backFromSettings() { resetArmed = 0; const r = settingsReturn || { screen: 'title' }; setScreen(r.screen, Object.assign({}, r.opts, { index: undefined })); }

  /* ══ screen helpers ═════════════════════════════════════════════════════ */
  const back = fn => ({ icon: '↩', label: 'Back', speech: 'Back', wide: true, action: fn, cls: 'back' });
  const art = e => '<div class="emblem"><span>' + e + '</span></div>';
  const TEAM_WORD = t => { const avg = t.players.slice(0, 6).reduce((a, p) => a + p.level, 0) / 6; return avg >= 10 ? 'Champions' : avg >= 8 ? 'Strong' : avg >= 6 ? 'Solid' : 'Underdogs'; };
  const STOPS = { ours: 'Our ball only', both: 'Attack and defense', key: 'Key moments', coach: 'Coach (watch)' };
  const STOPS_SAY = { ours: 'Our ball only. You choose whenever we have the ball.', both: 'Attack and defense. You also choose how we defend.',
    key: 'Key moments. You choose only the big chances.', coach: 'Coach. Watch, and set tactics from the huddle.' };
  const SPEEDS = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };
  const DIFFS = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
  // Stadium and time of day: Random, or one of world.js's.
  const arenaChoices = o => Object.assign({ random: 'Random' }, ...Object.keys(o).map(k => ({ [k]: o[k].name })));
  const DIFFS_SAY = { easy: 'Easy. Your team is much stronger.', normal: 'Normal. Your team gets a little help.', hard: 'Hard. A real challenge.' };
  const COMMENTARY = { full: 'Full broadcast', calls: 'Big calls only', captions: 'Captions only', off: 'Off' };
  const cycle = (list, v) => list[(list.indexOf(v) + 1) % list.length];

  function logo() {
    return '<div class="logo" aria-label="Benny\'s Sphere Splash"><span class="top">Benny\'s</span>' +
      '<span class="main">Sphere Splash</span><span class="drops"></span></div>';
  }
  function statsBoard(info) {
    if (!info) return '';
    const rows = [['Goals', 'goals'], ['Shots', 'shots'], ['On target', 'onTarget'], ['Passes completed', 'completed'],
      ['Tackles won', 'tackles'], ['Saves', 'saves']];
    let h = '<table class="board"><tr><th></th><th class="t0">' + U.esc(info.teams[0].short) + '</th><th class="t1">' + U.esc(info.teams[1].short) + '</th></tr>';
    rows.forEach(([lb, k]) => { h += '<tr><td>' + lb + '</td><td>' + info.stats[0][k] + '</td><td>' + info.stats[1][k] + '</td></tr>'; });
    return h + '</table>';
  }
  function scoreLine(info) {
    return '<span class="bigScore"><span>' + U.esc(info.teams[0].short) + '</span><b>' + info.score[0] + '</b><em>–</em><b>' + info.score[1] +
      '</b><span>' + U.esc(info.teams[1].short) + '</span></span>';
  }

  /* ══ SCREENS ════════════════════════════════════════════════════════════ */
  const SCREENS = {
    title: () => {
      const save = G().savedMatch();
      const list = [];
      if (save) list.push({ icon: '▶️', label: 'Continue', primary: true, note: U.esc(save.summary),
        speech: 'Continue. ' + save.summary, action: () => G().continueSaved() });
      list.push(
        { icon: '⚡', label: 'Quick Game', note: 'One match, short halves', speech: 'Quick Game. One match, short halves.', action: () => setScreen('quick') },
        { icon: '📅', label: 'Simple Season', note: 'Coming soon', enabled: false },
        { icon: '🏆', label: 'Full Season', note: 'Coming soon', enabled: false },
        { icon: '❓', label: 'How to Play', speech: 'How to Play', action: () => setScreen('howto', { page: 0 }) },
        { icon: '⚙️', label: 'Settings', speech: 'Settings', action: openSettings },
        { icon: '🏠', label: 'Exit Game', speech: 'Exit Game', action: goToHub });
      return { art: logo(), cardClass: 'title', title: '', items: list,
        speech: "Benny's Sphere Splash. " + (save ? 'Continue, ' : '') + 'Quick Game, How to Play, Settings, or Exit Game.' };
    },

    quick: () => ({
      art: art('⚡'), title: 'Quick Game',
      sub: 'One match with short halves. The game plays itself and <b>stops whenever you have a choice to make</b>.',
      items: [
        { icon: '🎲', label: 'Start', note: 'Random teams', primary: true, speech: 'Start, with random teams.', action: () => G().startQuick(null) },
        { icon: '👕', label: 'Pick the Teams', speech: 'Pick the teams', action: () => setScreen('pickTeam', { side: 0 }) },
        back(() => setScreen('title')),
      ],
      speech: 'Quick Game. Start with random teams, or pick the teams.',
    }),

    pickTeam: o => {
      const side = o.side || 0, teams = SS.DATA.TEAMS;
      const list = teams.filter(t => side === 0 || t.id !== o.ours).map(t => ({
        icon: '<i class="kit" style="background:' + U.hex(t.kit) + ';border-color:' + U.hex(t.accent) + '"></i>',
        label: U.esc(t.name), note: TEAM_WORD(t) + ' · ' + U.esc(t.blurb),
        speech: t.name + '. ' + TEAM_WORD(t) + '. ' + t.blurb,
        action: () => side === 0 ? setScreen('pickTeam', { side: 1, ours: t.id }) : G().startQuick([o.ours, t.id]),
      }));
      list.push(back(() => side === 0 ? setScreen('quick') : setScreen('pickTeam', { side: 0 })));
      return { art: art(side === 0 ? '👕' : '🆚'), title: side === 0 ? 'Your Team' : 'Your Opponent',
        sub: side === 0 ? 'Pick the team you will play for.' : 'Pick who you will play against.',
        items: list, layout: 'grid2', size: 'wide', speech: side === 0 ? 'Pick your team.' : 'Pick your opponent.' };
    },

    kickoff: o => {
      const info = G().matchInfo(), back2 = !!(o && o.resume);
      const vs = U.esc(info.teams[0].name) + ' <small>vs</small> ' + U.esc(info.teams[1].name);
      return { art: art(back2 ? '👋' : '🌊'), title: back2 ? 'Welcome Back' : vs,
        sub: back2 ? scoreLine(info) : 'You play for the <b>' + U.esc(info.teams[0].name) + '</b>, attacking to the right. ' + U.esc(STOPS[setting('stops')]) + '. ' + DIFFS[setting('difficulty')] + ' difficulty.',
        items: [
          { icon: back2 ? '▶️' : '🏁', label: back2 ? 'Resume Play' : 'Kick Off', primary: true, speech: back2 ? 'Resume play' : 'Kick off', action: () => G().kickoff() },
          { icon: '⚙️', label: 'Settings', speech: 'Settings', action: openSettings },
          { icon: '🏠', label: 'Main Menu', speech: 'Main Menu', action: () => G().quitToMenu() },
        ],
        speech: back2 ? 'Welcome back. ' + info.scoreSpeech + ' Resume play, Settings, or Main Menu.'
          : info.teams[0].name + ' versus ' + info.teams[1].name + '. You play for the ' + info.teams[0].name + '. Kick off, Settings, or Main Menu.' };
    },

    huddle: () => {
      const g = G(), ours = g.weHaveBall(), coach = setting('stops') === 'coach';
      const list = [
        { icon: '▶️', label: 'Continue', primary: true, speech: 'Continue', action: () => g.resume() },
        { icon: '📣', label: 'Call it Now', note: ours ? 'Pass or shoot right away' : 'We need the ball', enabled: ours,
          speech: 'Call it now. Pass or shoot right away.', action: () => g.callNow() },
        { icon: '🧭', label: 'Formation', note: U.esc(g.formationName()), speech: 'Formation, ' + g.formationName(), action: () => setScreen('formation', { from: 'huddle' }) },
      ];
      if (coach) list.push({ icon: '⏭️', label: 'Skip to Full Time', speech: 'Skip to full time', action: () => g.skipToEnd() });
      list.push({ icon: '⚙️', label: 'Settings', speech: 'Settings', action: openSettings },
        { icon: '⏸️', label: 'Pause Menu', speech: 'Pause menu', action: () => setScreen('pause') });
      return { art: art('🤝'), title: 'Huddle', sub: 'Play is stopped.', items: list, layout: 'grid2',
        speech: 'Huddle. Play is stopped.' };
    },

    formation: o => {
      const g = G(), cur = g.formationId(), wins = g.totalWins();
      const list = Object.keys(SS.DATA.FORMATIONS).map(id => {
        const f = SS.DATA.FORMATIONS[id], open = g.formationsOpen() || wins >= f.wins;
        return { label: U.esc(f.name), note: open ? U.esc(f.blurb) : 'Win ' + f.wins + ' matches to unlock', value: id === cur ? 'Now' : '',
          enabled: open, speech: f.name + (id === cur ? ', current' : '') + '. ' + f.blurb,
          action: () => { g.setFormation(id); U.speak('Formation: ' + f.name); setScreen(o.from || 'huddle'); } };
      });
      list.push(back(() => setScreen(o.from || 'huddle')));
      const rec = g.formationRecord(), theirs = g.theirFormationName();
      return { art: art('🧭'), title: 'Formation',
        sub: 'Now: <b>' + U.esc(rec) + '</b><br>' + U.esc(g.matchInfo().teams[1].short) + ' play <b>' + U.esc(theirs) + '</b>.',
        items: list, layout: 'grid2', size: 'wide',
        speech: 'Formation. ' + rec.replace(' · ', '. ') + '. They play ' + theirs + '.' };
    },

    pause: () => ({
      art: art('⏸️'), title: 'Paused',
      items: [
        { icon: '▶️', label: 'Continue', speech: 'Continue', action: resumeFromCard },
        { icon: '🔄', label: 'Restart Match', speech: 'Restart match', action: () => setScreen('confirmRestart') },
        { icon: '⚙️', label: 'Settings', speech: 'Settings', action: openSettings },
        { icon: '🏠', label: 'Main Menu', note: 'The match is saved', speech: 'Main menu. The match is saved.', action: () => G().quitToMenu() },
        { icon: '🚪', label: 'Exit Game', speech: 'Exit Game', action: () => setScreen('confirmExit', { from: 'pause' }) },
        { icon: '🆘', label: 'Help', speech: 'Help', action: () => U.speak('I need help') },
      ],
      layout: 'grid2', speech: 'Paused. Continue, Restart Match, Settings, Main Menu, Exit Game, or Help.',
    }),

    confirmRestart: () => ({
      art: art('🔄'), title: 'Restart the Match?', sub: 'The score goes back to <b>0 – 0</b>.',
      items: [
        { icon: '↩', label: 'Keep Playing', primary: true, speech: 'Keep playing', action: () => setScreen('pause') },
        { icon: '🔄', label: 'Restart', speech: 'Restart', action: () => G().restartMatch() },
      ],
      speech: 'Restart the match? The score goes back to nil nil. Keep playing, or Restart.',
    }),

    confirmExit: o => ({
      art: art('🚪'), title: 'Leave Sphere Splash?', sub: 'Go back to the hub. The match is saved, so you can continue it later.',
      items: [
        { icon: '↩', label: 'Stay', primary: true, speech: 'Stay', action: () => setScreen(o.from || 'pause') },
        { icon: '🏠', label: 'Exit Game', speech: 'Exit Game', action: goToHub },
      ],
      speech: 'Leave Sphere Splash and go back to the hub? The match is saved. Stay, or Exit Game.',
    }),

    halftime: () => {
      const info = G().matchInfo();
      return { art: art('⏱️'), title: 'Halftime', sub: scoreLine(info), stats: statsBoard(info), cardClass: 'results', size: 'wide', scrim: true,
        items: [
          { icon: '▶️', label: 'Second Half', primary: true, speech: 'Start the second half', action: () => G().startSecondHalf() },
          { icon: '🧭', label: 'Formation', note: U.esc(G().formationName()), speech: 'Formation, ' + G().formationName(), action: () => setScreen('formation', { from: 'halftime' }) },
          { icon: '⚙️', label: 'Settings', speech: 'Settings', action: openSettings },
          { icon: '🏠', label: 'Main Menu', note: 'The match is saved', speech: 'Main menu. The match is saved.', action: () => G().quitToMenu() },
        ],
        layout: 'row', speech: 'Halftime. ' + info.scoreSpeech };
    },

    results: () => {
      const info = G().matchInfo(), w = info.winner;
      const title = w === 0 ? 'You Win!' : w === 1 ? 'Full Time' : 'A Draw';
      return { art: art(w === 0 ? '🏆' : w === 1 ? '🏁' : '🤝'), title, sub: scoreLine(info), stats: statsBoard(info), cardClass: 'results', size: 'wide', scrim: true,
        items: [
          { icon: '🔄', label: 'Play Again', primary: true, note: 'Same teams', speech: 'Play again, same teams', action: () => G().startQuick([info.teams[0].id, info.teams[1].id]) },
          { icon: '🎲', label: 'New Teams', speech: 'New random teams', action: () => G().startQuick(null) },
          { icon: '🏠', label: 'Main Menu', speech: 'Main Menu', action: () => G().quitToMenu() },
          { icon: '🚪', label: 'Exit Game', speech: 'Exit Game', action: goToHub },
        ],
        layout: 'row', speech: (w === 0 ? 'You win! ' : w === 1 ? 'Full time. ' : 'A draw. ') + info.scoreSpeech };
    },

    howto: o => {
      const page = o.page || 0;
      const pages = [
        { e: '🌊', t: 'The Match', s: '<p>Two teams of six swim in a giant sphere of water. Get the ball into the other team\'s goal.</p>' +
          '<p>The game <b>plays itself</b>. It <b>stops</b> whenever there is a choice to make, and waits for you as long as you like.</p>' +
          '<p>You play for the team attacking to the <b>right</b>.</p>' },
        { e: '🤔', t: 'Your Choices', s: '<p>When a defender gets in the way, choose: <b>Pass</b> to a teammate, <b>Shoot</b> at the goal, or <b>Dribble</b> through.</p>' +
          '<p>Every choice shows its chances in words: <b>Good chance</b>, <b>Fair</b> or <b>Risky</b>.</p>' +
          '<p>To pass, choose Pass, then pick the teammate. <b>Tech</b> moves are special shots, passes and dribbles that cost energy.</p>' +
          '<p>When they have the ball, choose how to defend: <b>Tackle</b> to win it, or <b>Block</b> to stand in the way of passes and shots.</p>' },
        { e: '🎮', t: 'Controls', s: '<p>Tap <b>Space</b> to move, <b>hold Space</b> to go backwards, and press <b>Enter</b> to choose.</p>' +
          '<p>While the ball is moving, press either switch for the <b>Huddle</b>: change formation, or call a pass or shot right now.</p>' +
          '<p>After a goal you see it again in slow motion. Press either switch to skip the <b>replay</b>.</p>' +
          '<p>To pause, <b>hold Enter</b>, or press the <b>Pause</b> button.</p>' },
      ];
      const pg = pages[page];
      const list = [page < pages.length - 1
        ? { icon: '▶', label: 'Next: ' + pages[page + 1].t, speech: 'Next page. ' + pages[page + 1].t, action: () => setScreen('howto', { page: page + 1 }) }
        : { icon: '⏮', label: 'Back to the start', speech: 'Back to the first page', action: () => setScreen('howto', { page: 0 }) }];
      list.push(back(() => setScreen('title')));
      return { art: art(pg.e), title: '<span class="kicker">How to Play · ' + (page + 1) + ' of ' + pages.length + '</span>' + pg.t,
        sub: pg.s, cardClass: 'howto', items: list,
        speech: 'How to play, page ' + (page + 1) + ' of ' + pages.length + '. ' + pg.t + '. ' + U.stripTags(pg.s.replace(/<\/p>/g, ' ')) };
    },

    settings: () => {
      const v = U.vm(), s = U.sm();
      const tts = v ? v.getSettings().ttsEnabled : true;
      const voiceName = v && v.getVoiceDisplayName ? v.getVoiceDisplayName(v.getCurrentVoice()) : 'Default';
      const auto = s ? s.getSettings().autoScan : false, speed = s ? s.getScanInterval() : 2000;
      const replays = setting('replays') !== false, shotCam = setting('shotCam'), diff = setting('difficulty'), stops = setting('stops'), play = setting('speed'), com = setting('commentary'), ui = setting('uiSize'), sfx = setting('sfx') !== false, music = setting('music') !== false, crowd = setting('crowd') !== false;
      const set = (k, val, say) => { SS.save.settings.set(k, val); refresh(); U.speak(say); };
      const STADIA = arenaChoices(SS.world.STADIUMS), TIMES = arenaChoices(SS.world.TIMES), stad = setting('stadium'), tod = setting('timeOfDay');
      const stadSay = k => 'Stadium, ' + STADIA[k] + (k === 'random' ? '. A different stadium every match.' : '.');
      const todSay = k => 'Time of day, ' + TIMES[k] + (k === 'random' ? '. A different time every match.' : '.');
      const list = [
        { icon: '🗣️', label: 'Text to Speech', value: tts ? 'On' : 'Off', speech: 'Text to Speech, ' + (tts ? 'On' : 'Off'),
          action: () => { if (v) { v.toggleTTS(); refresh(); if (v.getSettings().ttsEnabled) U.speak('Text to speech on'); } } },
        { icon: '🎙️', label: 'Voice', value: voiceName, speech: 'Voice, ' + voiceName, action: () => { if (v) { v.cycleVoice(); refresh(); U.speak('Voice changed'); } } },
        { icon: '🎚️', label: 'Difficulty', value: DIFFS[diff], speech: 'Difficulty. ' + DIFFS_SAY[diff],
          action: () => { const n = cycle(Object.keys(DIFFS), diff); set('difficulty', n, 'Difficulty. ' + DIFFS_SAY[n]); } },
        { icon: '🛑', label: 'Decision Stops', value: STOPS[stops], speech: 'Decision stops. ' + STOPS_SAY[stops],
          action: () => { const n = cycle(Object.keys(STOPS), stops); set('stops', n, 'Decision stops. ' + STOPS_SAY[n]); } },
        { icon: '🎥', label: 'Shot Camera', value: shotCam === 'steady' ? 'Steady' : 'Cinematic',
          speech: shotCam === 'steady' ? 'Shot camera, steady. The camera stays put for shots.' : 'Shot camera, cinematic. The camera follows every shot in close.',
          action: () => { const n = shotCam === 'steady' ? 'cinematic' : 'steady'; set('shotCam', n, n === 'steady' ? 'Shot camera, steady. The camera stays put for shots.' : 'Shot camera, cinematic. The camera follows every shot in close.'); } },
        { icon: '⏪', label: 'Goal Replays', value: replays ? 'On' : 'Off',
          speech: replays ? 'Goal replays, on. Every goal plays again in slow motion. Press to skip one.' : 'Goal replays, off.',
          action: () => set('replays', !replays, replays ? 'Goal replays, off.' : 'Goal replays, on. Every goal plays again in slow motion. Press to skip one.') },
        { icon: '🏟️', label: 'Stadium', value: STADIA[stad] || 'Random', speech: stadSay(STADIA[stad] ? stad : 'random'),
          action: () => { const n = cycle(Object.keys(STADIA), stad); set('stadium', n, stadSay(n)); } },
        { icon: '🌅', label: 'Time of Day', value: TIMES[tod] || 'Random', speech: todSay(TIMES[tod] ? tod : 'random'),
          action: () => { const n = cycle(Object.keys(TIMES), tod); set('timeOfDay', n, todSay(n)); } },
        { icon: '⏩', label: 'Play Speed', value: SPEEDS[play], speech: 'Play speed, ' + SPEEDS[play],
          action: () => { const n = cycle(Object.keys(SPEEDS), play); set('speed', n, 'Play speed, ' + SPEEDS[n]); } },
        { icon: '📢', label: 'Commentary', value: COMMENTARY[com], speech: 'Commentary, ' + COMMENTARY[com],
          action: () => { const n = cycle(Object.keys(COMMENTARY), com); set('commentary', n, 'Commentary, ' + COMMENTARY[n]); } },
        { icon: '🔍', label: 'Text Size', value: Math.round(ui * 100) + '%', speech: 'Text size, ' + Math.round(ui * 100) + ' percent',
          action: () => { const n = cycle([1, 1.25, 1.5, 1.75, 2], ui); set('uiSize', n, 'Text size, ' + Math.round(n * 100) + ' percent'); } },
        { icon: '🔁', label: 'Auto Scan', value: auto ? 'On — One Switch' : 'Off — Two Switches',
          speech: auto ? 'Auto Scan on. One switch: Enter chooses.' : 'Auto Scan off. Two switches: Space moves, Enter chooses.',
          action: () => { if (!s) return; s.toggleAutoScan(); refresh(); U.speak(s.getSettings().autoScan ? 'Auto scan on. One switch. Enter chooses.' : 'Auto scan off. Two switches. Space moves, Enter chooses.'); } },
        { icon: '⏲️', label: 'Scan Speed', value: (speed / 1000) + 's', speech: 'Scan speed, ' + (speed / 1000) + ' seconds',
          action: () => { if (s) { s.cycleScanSpeed(); refresh(); U.speak('Scan speed ' + (s.getScanInterval() / 1000) + ' seconds'); } } },
        { icon: '🔊', label: 'Sound Effects', value: sfx ? 'On' : 'Off', speech: 'Sound effects, ' + (sfx ? 'On' : 'Off'),
          action: () => set('sfx', !sfx, 'Sound effects ' + (sfx ? 'off' : 'on')) },
        { icon: '🎵', label: 'Music', value: music ? 'On' : 'Off', speech: 'Music, ' + (music ? 'On' : 'Off'),
          action: () => set('music', !music, 'Music ' + (music ? 'off' : 'on')) },
        { icon: '👥', label: 'Crowd', value: crowd ? 'On' : 'Off', speech: 'Crowd, ' + (crowd ? 'On' : 'Off'),
          action: () => set('crowd', !crowd, 'Crowd ' + (crowd ? 'off' : 'on')) },
        { icon: '🗑️', label: 'Reset Progress', value: resetArmed ? 'Sure?' : '', cls: resetArmed ? 'armed' : '',
          speech: resetArmed ? 'Select again to erase the saved match and these settings' : 'Reset progress',
          action: () => {
            if (resetArmed && Date.now() - resetArmed < RESET_ARM_MS) { resetArmed = 0; G().resetProgress(); refresh(); U.speak('Progress reset'); }
            else { resetArmed = Date.now(); refresh(); U.speak('Select again to erase the saved match and these settings'); }
          } },
        back(backFromSettings),
      ];
      return { art: '', title: 'Settings', items: list, layout: 'cols2', size: 'wide', speech: 'Settings' };
    },
  };

  /* ══ boot ═══════════════════════════════════════════════════════════════ */
  function init() {
    buildDom();
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    const s = U.sm();
    if (s && s.subscribe) s.subscribe(() => { if (ctx === 'card') { $('hint').innerHTML = meta.hint || defaultHint(); } restartAuto(); });
    SS.save.settings.onChange(k => { if (k === 'uiSize' || k === '*') applySize(); });
    applySize();
    document.addEventListener('visibilitychange', () => { if (document.hidden && (ctx === 'live' || ctx === 'world')) openPause(); });
  }
  function applySize() { document.documentElement.style.setProperty('--ui', setting('uiSize') || 1); refitSoon(); }

  return {
    init, setScreen, openWorld, closeWorld, worldHead, goLive, openPause, resumeFromCard, goToHub,
    context: () => ctx,
    get screen() { return screen; },
    /** For the browser checks, which cannot see focus state from the DOM. */
    __dbg: () => ({ ctx, screen, index, rows: items.map(it => String(it.speech || U.stripTags(it.label || ''))),
      down: Object.assign({}, down), ignore: Object.assign({}, ignore), auto: !!autoTimer }),
  };
})();
