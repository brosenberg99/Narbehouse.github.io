/**
 * Benny's Ballista — input, meters, ammo list, minimap, and the results/
 * out-of-bolts/context-menu overlay. The game starts straight into aiming
 * against whichever level the save file resumes at.
 *
 * Input only responds while the camera director (js/game.js) is in its AIM
 * phase, or while it's holding one of the three overlay phases
 * (RESULTS_MENU, OUTOFBOLTS, MENU) — canAct()/overlayPhase() below. Once a
 * shot fires, the director owns FLIGHT through RESULTS on its own timing;
 * the next shot's meters reset the moment it returns to AIM (see the
 * edge-detect in tick()), and the overlay opens/closes on the same kind of
 * edge-detect rather than being driven from whatever fired the shot.
 *
 * A Return-hold with nothing left to back out of opens the context menu
 * (see backOut()) — Resume, Restart Level, How to Play, Settings, Exit —
 * which is AGENTS.md's "Return-hold opens Pause/Context from every screen"
 * rule satisfied everywhere it can currently be satisfied. The header's
 * Help/Settings/Exit buttons are pointer shortcuts into that same menu
 * rather than parallel paths, so nothing a mouse can reach is unreachable
 * by switch. Still outstanding: opening it *mid-cinematic*, which needs a
 * real freeze/resume of the camera director rather than a phase swap.
 *
 * The overlay reuses the ammo list's own scan-list machinery
 * (scanStep()/inScanList()/resetAutoScan()) rather than a parallel
 * implementation — overlayPhase() just makes those functions treat "focus
 * within the overlay's item list" as one more list to scan, so Space-hold-
 * to-scan-backward and Auto Scan both work on it for free. The one trap this
 * created: meterStage() has to explicitly exclude overlayPhase(), or
 * whatever `state.stage` was left over from the shot that triggered the
 * overlay (usually 'range') makes Space silently resume the hidden meter
 * instead of moving overlay focus — caught by testing the actual Space/
 * Return input path, not just calling the action functions directly.
 *
 * Reuses the exact hold-timer discipline the 2D version used (recovered from
 * git history at commit 695472a, `index.html:2196-2244` there) rather than
 * re-deriving it: short presses fire on RELEASE and only when the hold never
 * engaged (that's what lets one physical switch serve as both "next" and
 * "auto scan"), and Auto Scan makes the meters sweep/charge themselves so a
 * one-switch player never needs Space at all — Return alone completes a shot.
 * See AGENTS.md and switch-game-control-vocabulary for the house rules this
 * follows.
 */
RT.ui = (function () {
  'use strict';

  const U = RT.util;
  const D = RT.data;
  const G = RT.game;
  const LV = RT.levels;
  const CFG = D.CFG;

  let els = null;
  let overlayIx = -1;   // focus within the results/out-of-bolts panel; -1 = deadzone

  const state = {
    stage: 'ammo',              // 'ammo' | 'aim' | 'range'
    pick: { ammo: 0 },
    last: { ammo: 0, yawDeg: 0, rangePct: CFG.DEFAULT_RANGE_PCT },
    locked: {},
    scan: -1,                   // ammo list highlight; -1 = deadzone
    yawDeg: 0, yawDir: 1, yawSwept: false, aiming: false, yawTick: 0,
    rangePct: CFG.DEFAULT_RANGE_PCT, charging: false, charged: false, rangeTick: 0,
    previewAt: 0
  };
  let previewTrace = null;

  const timers = { space: null, spaceRepeat: null, ret: null, auto: null };
  const input = { spaceDown: false, retDown: false, retLong: false };

  /** True only while the camera director is holding its fixed AIM frame —
   *  see the file header. Every input entry point checks this. */
  function canAct() { return G.CAM.phase === 'AIM'; }

  function level() { return G.currentLevel(); }
  function yawHalfDeg() { return D.yawLimit(level()) * 180 / Math.PI; }
  function clampYaw(deg) { const h = yawHalfDeg(); return U.clamp(deg, -h, h); }
  function unlockedAmmo() { return G.unlockedAmmo(); }
  function stageOrder() { return unlockedAmmo().length > 1 ? ['ammo', 'aim', 'range'] : ['aim', 'range']; }

  /* UI blips come from js/audio.js now rather than the shared SafeAudio — see
   * that file's header for why this game diverges. The three names the rest of
   * this file already used are kept as-is so every call site didn't have to
   * change; SafeAudio stays loaded and stays in step, because
   * RT.audio.setEnabled() mirrors into SafeAudio.setEnabled().
   *
   * `vol` is no longer a volume. It survives as the soft/normal distinction it
   * was actually being used for: the quiet variants (below 0.4) all mark the
   * deadzone step where nothing is highlighted, and that reads better as a
   * lower, duller blip than as the same blip played more quietly. */
  function sfx(name, vol) {
    if (!RT.audio) return;
    const soft = vol !== undefined && vol < 0.4;
    try {
      if (name === 'hover') RT.audio.menuMove(soft);
      else if (name === 'select') RT.audio.menuSelect();
      else if (name === 'bust') RT.audio.menuBlocked();
    } catch (e) { /* audio is never load-bearing */ }
  }
  function audioFn(fn, a, b) {
    if (!RT.audio) return;
    try { RT.audio[fn](a, b); } catch (e) { /* audio is never load-bearing */ }
  }
  function autoScanOn() { const m = U.sm(); return m ? m.getSettings().autoScan : false; }
  function scanInterval() { const m = U.sm(); return m ? m.getScanInterval() : 2000; }

  /* ── Overlay screens: results, out-of-bolts, and the context menu ────────
   * The one place js/game.js's camera director takes input away from the
   * meters for something other than a cinematic — CAM.phase is
   * 'RESULTS_MENU' after a level is cleared, 'OUTOFBOLTS' after the last
   * bolt with Endless Bolts off, or 'MENU' while the player has the
   * context/pause menu open (Return-hold with nothing to back out of, or a
   * header button — see openMenu() in js/game.js, only reachable from AIM).
   *
   * MENU has its own three sub-screens, tracked here in `menuScreen` rather
   * than as more CAM phases, since the camera does exactly the same thing
   * for all of them and only the panel contents differ.
   *
   * Every screen is one descriptor from screenDef() below — title, sub,
   * note, items, speech — so render/scan/select/announce all read from ONE
   * definition instead of three parallel switch statements that have to be
   * kept in agreement (which is what the earlier results/out-of-bolts pair
   * was already starting to become).
   */
  let menuScreen = 'root';   // 'root' | 'howto' | 'settings' — only meaningful while CAM.phase is 'MENU'
  /** Which screen the *next* menu open should land on. The header buttons
   *  set this instead of setting menuScreen directly, because opening the
   *  menu doesn't render it — tick()'s edge-detect does, one frame later,
   *  via enterOverlay(), which resets to 'root'. Handing the target through
   *  here lets enterOverlay() honour it rather than racing it. */
  let pendingMenuScreen = null;

  function overlayPhase() {
    return G.CAM.phase === 'RESULTS_MENU' || G.CAM.phase === 'OUTOFBOLTS' || G.CAM.phase === 'MENU';
  }

  function gotoMenuScreen(name) {
    menuScreen = name;
    overlayIx = -1;
    renderOverlay();
    resetAutoScan();
    U.speak(screenDef().speech);
  }

  /** Exit to the hub, matching BENNYSRACETRACKS' goToHub() — the hub embeds
   *  games in an iframe, so hand focus back to its own Back button when
   *  there's a parent, and only navigate directly when opened standalone.
   *  The delay lets the spoken confirmation start before the page goes. */
  function goToHub() {
    U.speak('Exiting to hub');
    setTimeout(() => {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ action: 'focusBackButton' }, '*');
      } else {
        window.location.href = '../../../index.html';
      }
    }, 700);
  }

  const MINIMAP_SIZE_LABEL = { large: 'Large', medium: 'Medium', none: 'Off' };
  const onOff = (v) => (v ? 'On' : 'Off');

  /** Applies a settings change and re-announces the row without losing the
   *  player's place in the list — every Settings row toggles or cycles in
   *  place rather than opening a sub-screen, so Return on a row never costs
   *  a scan position. */
  function afterSettingChange(speech) {
    renderOverlay();
    U.speak(speech);
  }

  function cycleMinimapSize() {
    const order = ['large', 'medium', 'none'];
    const next = order[(order.indexOf(G.save.minimapSize || 'large') + 1) % order.length];
    G.setMinimapSize(next);
    applyMinimapSize();
    afterSettingChange(`Minimap size: ${MINIMAP_SIZE_LABEL[next]}`);
  }
  function toggleSteadyCamera() {
    const next = !G.steadyCameraOn();
    G.setSteadyCamera(next);
    afterSettingChange(next
      ? 'Steady Camera on. The view stays still through every shot.'
      : 'Steady Camera off. The camera chases the bolt and cuts to the impact.');
  }
  function toggleEndlessBolts() {
    const next = !G.save.endlessBolts;
    G.setEndlessBolts(next);
    afterSettingChange(next
      ? 'Endless Bolts on. You can never run out.'
      : 'Endless Bolts off. Running out of bolts ends the attempt.');
  }
  /** Sound is stored under RT.util's shared `rt-sound` key rather than in this
   *  game's own save, matching Race Tracks and FishMaster — one sound
   *  preference across the RT games, the way the hub treats its TTS toggle.
   *  Speech is deliberately NOT affected: that has its own hub-level control,
   *  and someone who plays by ear needs to be able to mute the crashes while
   *  keeping the narration. */
  /* Same four profiles, same ids and names, as FishMaster's Settings screen
     (ui.js:43 there) — a player who learns "High Contrast" in one game finds
     the same words in this one. */
  const THEMES = [
    { id: 'ben',      name: "Ben's" },
    { id: 'dark',     name: 'Dark' },
    { id: 'light',    name: 'Light' },
    { id: 'contrast', name: 'High Contrast' }
  ];
  function currentTheme() {
    return THEMES.find((t) => t.id === G.getTheme()) || THEMES[0];
  }
  function cycleTheme() {
    const i = THEMES.findIndex((t) => t.id === G.getTheme());
    const next = THEMES[(i + 1) % THEMES.length];
    G.setTheme(next.id);
    refreshMinimapPalette();
    afterSettingChange(`Colour profile, ${next.name}.`);
  }

  function soundOn() { return RT.audio ? RT.audio.isEnabled() : false; }
  function toggleSound() {
    if (!RT.audio) return;
    const next = !soundOn();
    RT.audio.setEnabled(next);
    if (next) RT.audio.resume();
    afterSettingChange(next
      ? 'Sound on. You will hear the shot land and the castle come down.'
      : 'Sound off. Speech still works.');
  }

  /** The one definition of every overlay screen. */
  function screenDef() {
    const phase = G.CAM.phase;

    if (phase === 'RESULTS_MENU') {
      const r = G.lastResult || { stars: 0, earned: 0, newAmmo: null };
      const par = level().par;
      const nextIx = (G.levelIx + 1) % LV.LEVELS.length;
      const starStr = '★'.repeat(r.stars) + '☆'.repeat(3 - r.stars);
      const starsSpoken = r.stars === 3 ? 'three stars' : r.stars === 2 ? 'two stars' : 'one star';
      let speech = `Castle destroyed! ${starsSpoken}. You used ${G.boltsUsed} ${G.boltsUsed === 1 ? 'bolt' : 'bolts'}, `
        + `and the target for this level is ${par}. You scored ${r.earned} points.`;
      if (r.newAmmo) speech += ` New ammunition unlocked: ${r.newAmmo.name}. ${r.newAmmo.sub}.`;
      return {
        title: 'Level Cleared!',
        sub: `<span class="stars">${starStr}</span> &nbsp; ${G.boltsUsed} `
          + `${G.boltsUsed === 1 ? 'bolt' : 'bolts'} used (par ${par}) &middot; <b>${r.earned}</b> points`
          + (r.newAmmo ? `<br>New ammunition unlocked: <b>${r.newAmmo.name}</b> — ${r.newAmmo.sub}.` : ''),
        note: `Total score: <b>${G.save.totalScore}</b> &middot; `
          + `Levels cleared: <b>${Object.keys(G.save.stars).length}</b> of ${LV.LEVELS.length}`,
        items: [{ label: '▶ Next Level', sub: LV.LEVELS[nextIx].name, action: G.confirmResults }],
        speech: speech + ' Press space then return to move to the next level.'
      };
    }

    if (phase === 'OUTOFBOLTS') {
      const lvl = level();
      return {
        title: 'Out of Bolts',
        sub: `You used all ${lvl.bolts} bolts on "${lvl.name}" without destroying every crown.`,
        note: 'Endless Bolts lets you keep firing forever — it only affects '
          + 'your star rating, never whether you can finish.',
        items: [
          { label: '🔁 Try Again', sub: lvl.name, action: G.retryLevel },
          { label: '♾ Turn On Endless Bolts', sub: 'Never run out again', action: G.enableEndlessAndContinue }
        ],
        speech: `Out of bolts. You used all ${lvl.bolts} without destroying every crown. `
          + 'Press space to choose: try again, or turn on endless bolts so you never run out.'
      };
    }

    if (menuScreen === 'howto') {
      return {
        title: 'How to Play',
        sub: 'Knock down every <b>gold crown</b> to clear the castle. A crown doesn’t have to be '
          + 'in your line of fire — you can bring it down by smashing whatever holds it up, '
          + 'or by burying it in falling rubble.'
          + '<br><br><b>Pick ammunition</b> (once you’ve unlocked more than one), then '
          + '<b>sweep the aim</b> left and right, then <b>set the range</b>. The dotted arc and '
          + 'the minimap crosshair always show exactly where the shot will land.'
          + '<br><br>Letting go early never weakens a shot — the range meter picks '
          + '<i>where</i> it lands, never how hard it hits.',
        note: '<b>Space</b> hold: move the meter, let go to stop &middot; '
          + '<b>Return</b>: lock it in / fire &middot; '
          + '<b>Return</b> hold: back up, or open this menu.',
        items: [{ label: '← Back', sub: '', action: () => gotoMenuScreen('root') }],
        speech: 'How to play. Knock down every gold crown to clear the castle. A crown does not have '
          + 'to be in your line of fire — you can bring it down by smashing what holds it up, or by '
          + 'burying it in falling rubble. Sweep the aim, then set the range. Letting go early never '
          + 'weakens a shot. Press return to go back.'
      };
    }

    if (menuScreen === 'settings') {
      return {
        title: 'Settings',
        sub: 'Adjust how Benny’s Ballista looks and plays.',
        note: 'Minimap Size sets how big the top-down map gets while you’re composing a shot. '
          + 'Steady Camera holds one fixed view instead of chasing the bolt. '
          + 'Endless Bolts means running out never blocks you — it only affects your star rating. '
          + 'Sound turns the shot and impact effects on or off; it does not affect speech. '
          + 'Colour Profile repaints the whole game, the 3D world included — High Contrast '
          + 'uses solid colours and white outlines on black.',
        items: [
          { label: '🎨 Colour Profile', sub: currentTheme().name, action: cycleTheme },
          { label: '🗺 Minimap Size', sub: MINIMAP_SIZE_LABEL[G.save.minimapSize || 'large'], action: cycleMinimapSize },
          { label: '🎥 Steady Camera', sub: onOff(G.steadyCameraOn()), action: toggleSteadyCamera },
          { label: '♾ Endless Bolts', sub: onOff(G.save.endlessBolts), action: toggleEndlessBolts },
          { label: '🔊 Sound', sub: onOff(soundOn()), action: toggleSound },
          { label: '← Back', sub: '', action: () => gotoMenuScreen('root') }
        ],
        speech: 'Settings. Press space to scan, return to change the highlighted option.'
      };
    }

    // menuScreen === 'root'
    const lvl = level();
    const stars = G.save.stars[G.levelIx] || 0;
    return {
      title: 'Menu',
      sub: `Level ${G.levelIx + 1} of ${LV.LEVELS.length} — <b>${lvl.name}</b>`
        + (stars ? ` &middot; <span class="stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span> best` : ''),
      note: `Total score: <b>${G.save.totalScore}</b> &middot; `
        + `Levels cleared: <b>${Object.keys(G.save.stars).length}</b> of ${LV.LEVELS.length}`,
      items: [
        { label: '▶ Resume', sub: 'Back to aiming', action: G.closeMenu },
        { label: '🔁 Restart Level', sub: lvl.name, action: G.retryLevel },
        { label: '❓ How to Play', sub: '', action: () => gotoMenuScreen('howto') },
        { label: '⚙ Settings', sub: '', action: () => gotoMenuScreen('settings') },
        { label: '🏠 Exit Game', sub: 'Back to the hub', action: goToHub }
      ],
      speech: 'Menu. Resume, Restart Level, How to Play, Settings, or Exit Game. '
        + 'Press space to scan, return to choose.'
    };
  }

  function overlayItems() { return overlayPhase() ? screenDef().items : []; }

  function renderOverlay() {
    if (!overlayPhase()) { els.overlay.classList.remove('on'); return; }
    const def = screenDef();

    els.panelTitle.textContent = def.title;
    els.panelSub.innerHTML = def.sub;
    els.panelNote.innerHTML = def.note;

    const holder = els.panelList;
    holder.innerHTML = '';
    def.items.forEach((it, i) => {
      const b = document.createElement('button');
      b.className = 'mi' + (i === overlayIx ? ' focus' : '');
      b.type = 'button';
      b.innerHTML = it.sub ? `${it.label}<span class="mval">${it.sub}</span>` : it.label;
      b.addEventListener('click', () => {
        if (!overlayPhase()) return;
        overlayIx = i; renderOverlay(); overlaySelect();
      });
      holder.appendChild(b);
    });

    els.overlay.classList.add('on');
  }

  /** Menu labels carry a leading emoji/arrow as a visual cue, which a screen
   *  reader would otherwise announce as noise ("black right-pointing triangle
   *  Resume"). Strip anything before the first letter/digit for speech only —
   *  the label itself keeps its icon. */
  function itemSpeech(it) {
    const spoken = String(it.label).replace(/^[^\p{L}\p{N}]+/u, '');
    return it.sub ? `${spoken}. ${it.sub}` : spoken;
  }

  function overlayScanStep(dir) {
    const n = overlayItems().length;
    let v = (overlayIx === -1) ? n : overlayIx;
    v = (v + dir + (n + 1)) % (n + 1);
    overlayIx = (v === n) ? -1 : v;
    renderOverlay();
    if (overlayIx === -1) { sfx('hover', 0.25); return; }
    sfx('hover', 0.5);
    const it = overlayItems()[overlayIx];
    if (it) U.speak(itemSpeech(it));
  }

  function overlaySelect() {
    if (overlayIx === -1) { U.speak('Nothing highlighted. Press space to keep scanning.'); return; }
    const it = overlayItems()[overlayIx];
    if (!it) return;
    sfx('select', 0.6);
    stopAutoScan();
    it.action();
  }

  function enterOverlay() {
    // Every fresh open of the context menu starts at its root screen — a
    // stale 'settings'/'howto' from last time would otherwise reopen there
    // — unless whatever opened it asked for a specific screen (the header's
    // Help/Settings buttons do).
    if (G.CAM.phase === 'MENU') {
      menuScreen = pendingMenuScreen || 'root';
      pendingMenuScreen = null;
    }
    overlayIx = -1;
    /* The result sting lands as the panel opens, not when the crown died —
       that happens mid-cinematic, several seconds earlier, and a fanfare over
       a still-collapsing castle reads as part of the collapse. */
    if (G.CAM.phase === 'RESULTS_MENU') audioFn('win', (G.lastResult || {}).stars || 1);
    else if (G.CAM.phase === 'OUTOFBOLTS') audioFn('outOfBolts');
    renderOverlay();
    resetAutoScan();
    U.speak(screenDef().speech);
  }

  /* ── Ammo list ────────────────────────────────────────────────────────── */
  function laneItems() {
    return unlockedAmmo().map((a, i) => ({ label: a.name, sub: a.sub, ix: i, remaining: G.ammoRemaining(a) }));
  }
  function laneLen() { return laneItems().length; }

  function renderChips() {
    const show = stageOrder().indexOf('ammo') !== -1;
    els.laneAmmo.hidden = !show;
    if (!show) return;

    const holder = els.chipsAmmo;
    holder.innerHTML = '';
    laneItems().forEach((it) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      const sub = isFinite(it.remaining) ? `${it.sub} · ${it.remaining} left` : it.sub;
      b.innerHTML = sub ? `${it.label}<span class="sub">${sub}</span>` : it.label;
      if (it.remaining <= 0) b.classList.add('depleted');
      if (state.locked.ammo && state.pick.ammo === it.ix) b.classList.add('picked');
      if (!state.locked.ammo && state.last.ammo === it.ix) b.classList.add('last');
      if (state.stage === 'ammo' && state.scan === it.ix) b.classList.add('focus');
      b.addEventListener('click', () => {
        if (!canAct() || state.stage !== 'ammo') return;
        state.scan = it.ix; renderChips(); updatePreview(true); commit();
      });
      holder.appendChild(b);
    });
    els.laneAmmo.classList.toggle('locked', !!state.locked.ammo);
  }

  function scanStep(dir) {
    if (overlayPhase()) { overlayScanStep(dir); return; }
    if (state.stage !== 'ammo') return;
    const n = laneLen();
    let v = (state.scan === -1) ? n : state.scan;
    v = (v + dir + (n + 1)) % (n + 1);
    state.scan = (v === n) ? -1 : v;

    renderChips(); updatePreview(true); updateFooter();
    if (state.scan === -1) sfx('hover', 0.25);
    else { sfx('hover', 0.5); announceFocus(); }
  }
  function announceFocus() {
    const it = laneItems()[state.scan];
    if (!it) return;
    const remText = isFinite(it.remaining) ? ` ${it.remaining} left this level.` : '';
    U.speak(`${it.label}. ${it.sub}.${remText}`);
  }

  /* ── Meters ───────────────────────────────────────────────────────────── */
  // Never true while an overlay is open, regardless of whatever `state.stage`
  // was left over from before the shot that triggered it — otherwise Space
  // resumes the (hidden) aim/range meter instead of moving overlay focus.
  function meterStage() { return !overlayPhase() && (state.stage === 'aim' || state.stage === 'range'); }

  function renderMeters() {
    const h = yawHalfDeg();
    const yawPct = (clampYaw(state.yawDeg) + h) / (2 * h) * 100;
    const deg = Math.round(state.yawDeg);
    const pct = Math.round(state.rangePct);

    els.fillAim.style.width = yawPct.toFixed(1) + '%';
    els.valAim.textContent = (deg > 0 ? '+' : '') + deg + '°';
    els.meterAim.setAttribute('aria-valuemin', Math.round(-h));
    els.meterAim.setAttribute('aria-valuemax', Math.round(h));
    els.meterAim.setAttribute('aria-valuenow', deg);

    els.fillPower.style.width = state.rangePct.toFixed(1) + '%';
    els.valPower.textContent = pct + '%';
    els.meterPower.setAttribute('aria-valuenow', pct);

    els.laneAim.classList.toggle('active', state.stage === 'aim');
    els.laneAim.classList.toggle('moving', state.aiming);
    els.laneAim.classList.toggle('locked', !!state.locked.aim);
    els.lanePower.classList.toggle('active', state.stage === 'range');
    els.lanePower.classList.toggle('moving', state.charging);
    els.lanePower.classList.toggle('locked', !!state.locked.range);
    els.meterPower.classList.toggle('dim', state.stage !== 'range');
    els.btnLockAim.disabled = state.stage !== 'aim';
    els.btnFire.disabled = state.stage !== 'range';
  }

  function updateFooter() {
    const names = { ammo: 'Ammo', aim: 'Aim', range: 'Range' };
    els.ftrMode.textContent = names[state.stage] || state.stage;
    els.ftrTarget.textContent = previewTrace ? previewPhrase() : '';
  }

  /**
   * The four status pills across the top: level, crowns left, bolts used,
   * score.
   *
   * These were static markup — `#pLevel` / `#pCrowns` / `#pBolts` / `#pScore`
   * existed in index.html from the step-2 rewrite and nothing ever wrote to
   * them, so they permanently read "Level 1 / Crowns 0 / Bolts 0 / Score 0"
   * however the game was going. Four large indicators that always say zero are
   * worse than none: AGENTS.md asks for large state indicators precisely
   * because Ben reads state off them, and these were quietly lying.
   *
   * Crowns counts what is LEFT rather than what has been destroyed — it is the
   * win condition, so "how many still to go" is the number that matters, and
   * it ticks down to zero exactly as the level is cleared.
   */
  function updateStatus() {
    if (!els.pLevel) return;
    const bolts = G.boltsUsed;
    const lvl = level();
    const cap = (G.save && G.save.endlessBolts) ? '' : ` / ${lvl.bolts}`;
    const crowns = G.crownPositions().length;
    const score = G.levelScore;
    /* Cheap change-detect: this runs every frame and these are DOM writes. */
    const sig = `${G.levelIx}|${crowns}|${bolts}|${cap}|${score}`;
    if (sig === lastStatusSig) return;
    lastStatusSig = sig;

    els.pLevel.textContent = `Level ${G.levelIx + 1}`;
    setPill(els.pCrowns, crowns);
    setPill(els.pBolts, `${bolts}${cap}`);
    setPill(els.pScore, score);
  }
  let lastStatusSig = null;

  /** Each pill is "Label <b>value</b>" — only the bold part changes. */
  function setPill(el, value) {
    if (!el) return;
    const b = el.querySelector('b');
    if (b) b.textContent = String(value);
  }

  function startMeter() {
    if (!meterStage()) return;
    stopAutoScan();
    if (state.stage === 'aim') {
      if (state.aiming) return;
      if (state.yawSwept) state.yawDir *= -1;   // every press after the first reverses
      state.yawSwept = true;
      state.aiming = true;
    } else {
      if (state.charging) return;
      state.charging = true;
    }
    sfx('hover', 0.35);
    renderMeters(); updateFooter();
  }

  function releaseMeter() {
    if (state.aiming) stopAim();
    else if (state.charging) stopCharge();
  }

  function stopAim() {
    state.aiming = false;
    updatePreview(true);
    renderMeters(); updateFooter();
    sfx('hover', 0.5);
    U.speak(`${Math.round(state.yawDeg)} degrees. This shot ${previewPhrase()}. Press return to lock it in.`);
  }

  function stopCharge() {
    state.charging = false;
    updatePreview(true);
    renderMeters(); updateFooter();
    sfx('hover', 0.5);
    const full = state.rangePct >= 100;
    U.speak(`${full ? 'Full range. ' : ''}${Math.round(state.rangePct)} percent. This shot ${previewPhrase()}. `
      + (full ? 'Press return to fire, or hold return to go back and set the range again.'
               : 'Press return to fire, or hold space to charge further.'));
  }

  function stepMeters(dt) {
    let moved = false;
    if (state.stage === 'aim' && state.aiming) {
      const h = yawHalfDeg();
      state.yawDeg += state.yawDir * CFG.YAW_DEG_PER_S * dt;
      if (state.yawDeg >= h) { state.yawDeg = h; state.yawDir = -1; }
      if (state.yawDeg <= -h) { state.yawDeg = -h; state.yawDir = 1; }
      const tick = Math.round(state.yawDeg / CFG.YAW_TICK_DEG);
      /* Panned by yaw, so which way the ballista is pointing is audible and
         not only visible — the sweep reads with the screen ignored. */
      if (tick !== state.yawTick) {
        state.yawTick = tick;
        audioFn('aimTick', h > 0 ? U.clamp(state.yawDeg / h, -1, 1) : 0);
      }
      moved = true;
    }
    if (state.stage === 'range' && state.charging) {
      state.rangePct = Math.min(100, state.rangePct + CFG.RANGE_PCT_PER_S * dt);
      state.charged = true;
      const step = Math.floor(state.rangePct / CFG.RANGE_TICK_PCT);
      /* A rising ladder rather than a repeated blip: how far along the charge
         is gets carried by pitch, per AGENTS.md's charge-feedback rule. */
      if (step !== state.rangeTick) {
        state.rangeTick = step;
        audioFn('chargeStep', state.rangePct, 100);
      }
      if (state.rangePct >= 100) { stopCharge(); return; }
      moved = true;
    }
    if (moved) { updatePreview(); renderMeters(); updateFooter(); }
  }

  /* ── Preview — same traceShot() the real shot fires with ─────────────── */
  function currentAmmo() {
    const list = unlockedAmmo();
    let ix = state.pick.ammo;
    if (state.stage === 'ammo' && state.scan !== -1) ix = state.scan;
    return list[Math.min(ix, list.length - 1)] || list[0];
  }

  function updatePreview(force) {
    const now = performance.now();
    if (!force && now - state.previewAt < CFG.METER_PREVIEW_MS) return;
    state.previewAt = now;
    const yawRad = clampYaw(state.yawDeg) * Math.PI / 180;
    previewTrace = G.traceShot(currentAmmo(), yawRad, state.rangePct);
    G.updateAimPreview(previewTrace);
    drawMinimap();
  }

  /* ── Minimap ──────────────────────────────────────────────────────────────
   * A top-down read of the same window the meters already work in: the
   * castle's footprint, every surviving crown as its own objective marker,
   * the yaw sweep's cone, and where the current trace actually lands — the
   * ballista's own -Z-forward, +X-right axes (see data.js's coordinate-
   * system note) mapped straight onto the canvas with "up" as downrange, no
   * separate projection math to keep in sync. Thick strokes and an ink
   * outline behind every bright marker on purpose — same "big, high-
   * contrast, no fine detail" language the 3D art already uses for Ben's
   * low vision (see js/art.js's ink()/outline()). syncMinimapSize() in
   * tick() drives whether this is even legible-sized right now; drawing
   * always happens at the canvas's one native resolution regardless.
   */
  /** Applies the Settings overlay's Minimap Size choice to the live element
   *  — 'none' hides it outright (both shrunk and while aiming), 'medium'
   *  shrinks how big the .big (aiming) state gets via the CSS variable
   *  index.html's #minimap.big rule reads, 'large' is the CSS default so
   *  it just needs the variable put back. The shrunk (locked-in) size never
   *  changes — this setting is only about how big it gets *while aiming*. */
  const MM_BIG = { large: ['520px', '632px'], medium: ['300px', '364px'] };
  function applyMinimapSize() {
    if (!els.minimap) return;
    const size = (G.save && G.save.minimapSize) || 'large';
    els.minimap.classList.toggle('mm-hidden', size === 'none');
    const [w, h] = MM_BIG[size] || MM_BIG.large;
    els.minimap.style.setProperty('--mm-big-w', w);
    els.minimap.style.setProperty('--mm-big-h', h);
  }

  /* ── Minimap palette ──────────────────────────────────────────────────────
   * Read once per theme change, never per frame. drawMinimap() runs on every
   * frame a meter is moving, and getComputedStyle is far too slow for that —
   * the same rule js/game.js's palette cache follows, and the same reason.
   *
   * The ink and the two greys used to be literals here, which meant the
   * minimap ignored the colour profile entirely: dark-brown ink and
   * translucent white sat on High Contrast's black just as they did on Ben's
   * Default, so the map lost exactly the contrast that profile exists to add.
   */
  const MM_FALLBACK = { ink: '#2f231a', crown: '#ffc93c', focus: '#ffd400',
                        text: '#f2f4f8' };
  let MM = Object.assign({}, MM_FALLBACK);

  function refreshMinimapPalette() {
    const cs = getComputedStyle(document.body);
    const get = (n, fb) => cs.getPropertyValue('--' + n).trim() || fb;
    MM = {
      ink:   get('ink', MM_FALLBACK.ink),
      crown: get('crown', MM_FALLBACK.crown),
      focus: get('focus', MM_FALLBACK.focus),
      text:  get('text', MM_FALLBACK.text)
    };
  }

  /** Semi-transparent version of a palette colour, for the fills that need to
   *  sit under the markers without competing with them. Handles the #rgb and
   *  #rrggbb the profiles actually use, and falls back to the colour as-is. */
  function fade(hex, alpha) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  function drawMinimap() {
    const cvs = els.minimap;
    if (!cvs) return;
    const ctx = els.minimapCtx;
    const w = cvs.width, h = cvs.height, pad = 14;
    ctx.clearRect(0, 0, w, h);

    const lvl = level();
    const bounds = D.castleBounds(lvl);
    const win = D.rangeWindow(lvl);
    const yawH = yawHalfDeg() * Math.PI / 180;

    const maxDist = win.max * 1.08;
    const maxLat = Math.max(bounds.halfWidth + CFG.YAW_PAD_CELLS, maxDist * Math.sin(yawH)) * 1.15;
    const scale = Math.min((w - pad * 2) / (maxLat * 2), (h - pad * 2) / maxDist);
    const originX = w / 2, originY = h - pad;
    const toCanvas = (x, dist) => [originX + x * scale, originY - dist * scale];

    /* Sweep cone — how far the aim meter can swing left/right at this range.
       Drawn from --text rather than --line: --line is a border colour, light
       in every profile, so on the Light profile's near-white minimap it was
       invisible (as the hardcoded white it replaced had been). --text is the
       one variable guaranteed to contrast with the panel in all four. */
    ctx.strokeStyle = fade(MM.text, 0.38);
    ctx.lineWidth = 4;
    ctx.setLineDash([7, 10]);
    [-yawH, yawH].forEach((yaw) => {
      const [ex, ey] = toCanvas(Math.sin(yaw) * maxDist, Math.cos(yaw) * maxDist);
      ctx.beginPath(); ctx.moveTo(originX, originY); ctx.lineTo(ex, ey); ctx.stroke();
    });
    ctx.setLineDash([]);

    // The castle's footprint.
    const [cx1, cy1] = toCanvas(-bounds.halfWidth, bounds.far);
    const [cx2, cy2] = toCanvas(bounds.halfWidth, bounds.near);
    ctx.fillStyle = fade(MM.text, 0.34);
    ctx.strokeStyle = fade(MM.text, 0.85);
    ctx.lineWidth = 4;
    ctx.fillRect(cx1, cy1, cx2 - cx1, cy2 - cy1);
    ctx.strokeRect(cx1, cy1, cx2 - cx1, cy2 - cy1);

    const INK = MM.ink, crownColor = MM.crown, focus = MM.focus;

    // Objectives — every crown still alive, wherever it actually sits (a
    // crown can be a legitimate target while fully hidden behind another
    // layer; this marks it regardless of line of sight). An open ring, not
    // a filled dot, on purpose: the landing crosshair below is a filled
    // dot, and the two markers legitimately coincide whenever a shot is
    // actually lined up on a crown — a ring reads through a dot on top of
    // it, a dot on top of a dot would just merge into one blob.
    G.crownPositions().forEach((c) => {
      const [px, py] = toCanvas(c.x, -c.z);
      ctx.beginPath(); ctx.arc(px, py, 15, 0, Math.PI * 2);
      ctx.lineWidth = 7; ctx.strokeStyle = INK; ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 15, 0, Math.PI * 2);
      ctx.lineWidth = 4; ctx.strokeStyle = crownColor; ctx.stroke();
    });

    // The ballista itself.
    ctx.fillStyle = focus;
    ctx.strokeStyle = INK; ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(originX, originY - 15); ctx.lineTo(originX - 13, originY + 8); ctx.lineTo(originX + 13, originY + 8);
    ctx.closePath(); ctx.fill(); ctx.stroke();

    // Landing crosshair — the brightest, boldest thing on the map, since
    // it's the one answer the whole minimap exists to give.
    if (previewTrace) {
      const last = previewTrace.points[previewTrace.points.length - 1];
      const [lx, ly] = toCanvas(last.x, -last.z);
      const arm = 21;
      ctx.lineWidth = 8; ctx.strokeStyle = INK;
      ctx.beginPath(); ctx.moveTo(lx - arm, ly); ctx.lineTo(lx + arm, ly); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(lx, ly - arm); ctx.lineTo(lx, ly + arm); ctx.stroke();
      ctx.lineWidth = 4; ctx.strokeStyle = focus;
      ctx.beginPath(); ctx.moveTo(lx - arm, ly); ctx.lineTo(lx + arm, ly); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(lx, ly - arm); ctx.lineTo(lx, ly + arm); ctx.stroke();
      ctx.beginPath(); ctx.arc(lx, ly, 5, 0, Math.PI * 2); ctx.fillStyle = focus; ctx.fill();
    }
  }

  function previewPhrase() {
    if (!previewTrace) return 'flies off the field';
    const h = previewTrace.hit;
    if (h.type === 'block') return `hits the ${h.block.mat.name}`;
    if (h.type === 'ground') return 'lands on the ground';
    return 'flies off the field';
  }

  /* ── Stage machine ────────────────────────────────────────────────────── */
  function stageHint() {
    if (state.stage === 'ammo') return 'Choose ammunition. Press space to scan.';
    if (state.stage === 'aim') return autoScanOn()
      ? 'Aiming. The aim is sweeping — press return to stop it.'
      : 'Aiming. Hold space to sweep left and right, let go to stop it.';
    return autoScanOn()
      ? 'Range. The meter is filling — press return to stop it.'
      : 'Range. Hold space to charge, let go to stop.';
  }

  function beginStage(stage, opts) {
    opts = opts || {};
    state.stage = stage;
    state.aiming = false;
    state.charging = false;
    stopAutoScan();

    if (stage === 'ammo') {
      if (!opts.keep) state.scan = -1;
      resetAutoScan();
    } else if (stage === 'aim') {
      if (!opts.keep) { state.yawDir = 1; state.yawSwept = false; }
      if (autoScanOn()) { state.aiming = true; state.yawSwept = true; }
    } else if (stage === 'range') {
      if (!opts.keep) { state.rangePct = 0; state.charged = false; state.rangeTick = 0; }
      if (autoScanOn()) state.charging = true;
    }
    renderChips(); renderMeters(); updatePreview(true); updateFooter();
  }

  function enterShot(fresh) {
    state.locked = {};
    state.scan = -1;
    state.yawDeg = clampYaw(state.last.yawDeg);
    state.rangePct = state.last.rangePct;
    state.charged = false;
    state.yawTick = 0; state.rangeTick = 0;
    beginStage(stageOrder()[0]);
    if (fresh) U.speak(stageHint());
  }

  function commit() {
    if (overlayPhase()) return overlaySelect();
    if (state.stage === 'ammo') return commitAmmo();
    if (state.stage === 'aim') return lockAim();
    if (state.stage === 'range') return confirmShot();
  }

  function commitAmmo() {
    if (state.scan === -1) { U.speak('Nothing highlighted. Press space to keep scanning.'); return; }
    const chosen = laneItems()[state.scan];
    if (chosen.remaining <= 0) { U.speak(`No ${chosen.label} left this level. Press space to keep scanning.`); return; }
    state.pick.ammo = state.scan;
    state.locked.ammo = true;
    sfx('select', 0.6);
    const it = laneItems()[state.scan];
    const order = stageOrder();
    beginStage(order[order.indexOf('ammo') + 1]);
    U.speak(`${it.label} locked. ${stageHint()}`);
  }

  function lockAim() {
    if (state.aiming) { stopAim(); return; }
    state.locked.aim = true;
    sfx('select', 0.6);
    const deg = Math.round(state.yawDeg);
    beginStage('range');
    U.speak(`${deg} degrees locked. ${stageHint()}`);
  }

  function confirmShot() {
    if (state.charging) { stopCharge(); return; }
    if (!state.charged) {
      U.speak('No range yet. ' + (autoScanOn()
        ? 'The meter fills by itself — press return to stop it where you want it.'
        : 'Hold space to charge the shot, then press return to fire.'));
      return;
    }
    state.locked.range = true;
    sfx('select', 0.6);
    U.speak(`Firing at ${Math.round(state.rangePct)} percent range.`);
    doFire();
  }

  function doFire() {
    const ammo = unlockedAmmo()[state.pick.ammo];
    const yawRad = clampYaw(state.yawDeg) * Math.PI / 180;
    G.fire(ammo, yawRad, state.rangePct);
    state.last = { ammo: state.pick.ammo, yawDeg: state.yawDeg, rangePct: state.rangePct };
    sfx('bust', 0.35);
    // No enterShot() here — the camera director (js/game.js) now owns the
    // whole FLIGHT/IMPACT/SETTLE/RESULTS sequence, and canAct() blocks input
    // until it returns to AIM. tick()'s edge-detect calls enterShot(false)
    // the moment that happens.
  }

  function backOut() {
    // Inside the context menu, Return-hold walks back the way it came:
    // sub-screen -> root -> closed. Same gesture, one level at a time.
    if (G.CAM.phase === 'MENU') {
      sfx('hover', 0.5);
      if (menuScreen !== 'root') { gotoMenuScreen('root'); return; }
      G.closeMenu();
      return;
    }
    if (overlayPhase()) { U.speak('Nothing to go back to here — press space then return to choose.'); return; }
    const order = stageOrder();
    const i = order.indexOf(state.stage);
    if (i <= 0) {
      // Nothing left to back out of, so this is the context menu — AGENTS.md's
      // "Return-hold opens Pause/Context from every screen" rule. It still
      // can't be opened mid-cinematic (that needs a real freeze/resume of the
      // camera director, not a phase swap), which is the one part of that
      // rule still outstanding.
      sfx('select', 0.5);
      G.openMenu();   // tick()'s overlay edge-detect renders/announces it next frame
      return;
    }
    const prev = order[i - 1];
    state.locked[state.stage] = false;
    state.locked[prev] = false;
    if (state.stage === 'range') {
      state.rangePct = state.last.rangePct;
      state.charged = false;
    }
    beginStage(prev);
    if (prev === 'ammo') {
      state.scan = state.pick.ammo;
      renderChips(); updatePreview(true); updateFooter();
    }
    sfx('hover', 0.5);
    U.speak(`Back to ${prev}. ${stageHint()}`);
  }

  /* ── List scanning vs. direct-hold meters ────────────────────────────────
   * Space-hold means "scan backwards" in the ammo list and "move the meter"
   * in the aim/range stages — scoping it by stage is what lets both be true
   * without either one surprising the player.
   */
  function inScanList() { return state.stage === 'ammo' || overlayPhase(); }
  function scanNext() { scanStep(1); resetAutoScan(); }
  function scanPrev() { scanStep(-1); }
  function selectCurrent() { commit(); }

  function startHoldScan() {
    const dir = CFG.SCAN_DIR_ON_HOLD;
    const step = () => (dir < 0 ? scanPrev() : scanNext());
    step();
    timers.spaceRepeat = setInterval(step, scanInterval());
  }

  function resetAutoScan() {
    stopAutoScan();
    if (!autoScanOn()) return;
    if (!inScanList()) return;            // the meters move themselves, not by ticks
    const iv = scanInterval();
    if (iv > 0) timers.auto = setInterval(() => {
      if (!inScanList()) { stopAutoScan(); return; }
      scanStep(1);
    }, iv);
  }
  function stopAutoScan() {
    if (timers.auto) { clearInterval(timers.auto); timers.auto = null; }
  }

  /* ── Input ────────────────────────────────────────────────────────────── */
  function onKeyDown(e) {
    /* Browsers hold an AudioContext suspended until a user gesture. The shared
       ios-audio-fix.js resumes every context on the first touch/click/keydown,
       but this game can be played entirely from the keyboard inside an iframe,
       so ask directly too rather than depending on that. Cheap and idempotent
       once the context is running. */
    audioFn('resume');
    if (e.repeat || (!canAct() && !overlayPhase())) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (input.spaceDown) return;
      input.spaceDown = true;
      if (meterStage()) {
        startMeter();               // aim and range move from the first instant of the hold
      } else {
        timers.space = setTimeout(() => {
          timers.space = null;
          startHoldScan();
        }, CFG.SPACE_HOLD_MS);
      }
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      if (input.retDown) return;
      input.retDown = true;
      input.retLong = false;
      timers.ret = setTimeout(() => {
        timers.ret = null;
        input.retLong = true;
        backOut();
      }, CFG.RETURN_HOLD_MS);
    }
  }

  function onKeyUp(e) {
    if (e.code === 'Space') {
      e.preventDefault();
      if (!input.spaceDown) return;
      input.spaceDown = false;
      if (timers.space) { clearTimeout(timers.space); timers.space = null; }
      const wasHolding = !!timers.spaceRepeat;
      if (timers.spaceRepeat) { clearInterval(timers.spaceRepeat); timers.spaceRepeat = null; }
      if (meterStage()) { releaseMeter(); return; }
      if (!wasHolding) scanNext();    // short press only, and only on release
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      if (!input.retDown) return;
      input.retDown = false;
      if (timers.ret) { clearTimeout(timers.ret); timers.ret = null; }
      if (!input.retLong) selectCurrent();
      input.retLong = false;
    }
  }

  /** Mouse/touch is an optional extra for a caregiver, never required —
   *  press and hold to move a meter, let go to stop it, same gesture as
   *  everywhere else in the hub. */
  function bindMeter(box, stage) {
    const down = (e) => {
      if (!canAct() || state.stage !== stage) return;
      e.preventDefault();
      startMeter();
    };
    box.addEventListener('mousedown', down);
    box.addEventListener('touchstart', down, { passive: false });
  }

  function init() {
    els = {
      laneAmmo: U.$('laneAmmo'), chipsAmmo: U.$('chipsAmmo'),
      laneAim: U.$('laneAim'), meterAim: U.$('meterAim'), fillAim: U.$('fillAim'),
      valAim: U.$('valAim'), btnLockAim: U.$('btnLockAim'),
      lanePower: U.$('lanePower'), meterPower: U.$('meterPower'), fillPower: U.$('fillPower'),
      valPower: U.$('valPower'), btnFire: U.$('btnFire'),
      ftrMode: U.$('ftrMode'), ftrTarget: U.$('ftrTarget'),
      overlay: U.$('overlay'), panelTitle: U.$('panelTitle'), panelSub: U.$('panelSub'),
      panelList: U.$('panelList'), panelNote: U.$('panelNote'),
      minimap: U.$('minimap'),
      pLevel: U.$('pLevel'), pCrowns: U.$('pCrowns'),
      pBolts: U.$('pBolts'), pScore: U.$('pScore'),
      btnHelp: U.$('btnHelp'), btnSet: U.$('btnSet'), btnExit: U.$('btnExit')
    };
    if (els.minimap) els.minimapCtx = els.minimap.getContext('2d');
    applyMinimapSize();
    // The saved profile is already on <body> by now (game.js's loadAttract
    // sets it before the world is built), so this reads the right palette.
    refreshMinimapPalette();

    bindMeter(els.meterAim, 'aim');
    bindMeter(els.meterPower, 'range');
    window.addEventListener('mouseup', () => { if (meterStage()) releaseMeter(); });
    window.addEventListener('touchend', () => { if (meterStage()) releaseMeter(); });
    els.btnLockAim.addEventListener('click', () => { if (canAct() && state.stage === 'aim') lockAim(); });
    els.btnFire.addEventListener('click', () => { if (canAct() && state.stage === 'range') confirmShot(); });

    /* Header buttons are a mouse/touch shortcut into the very same context
       menu Return-hold opens — never a separate path with its own state, so
       there's nothing a pointer can reach that a switch can't. Each one just
       opens the menu and jumps to the screen it names. */
    function openMenuAt(screen) {
      if (!canAct()) return;
      sfx('select', 0.5);
      pendingMenuScreen = screen;   // consumed by enterOverlay() on the next tick
      G.openMenu();
    }
    if (els.btnHelp) els.btnHelp.addEventListener('click', () => openMenuAt('howto'));
    if (els.btnSet) els.btnSet.addEventListener('click', () => openMenuAt('settings'));
    if (els.btnExit) els.btnExit.addEventListener('click', () => openMenuAt('root'));

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    if (U.sm()) U.sm().subscribe(() => resetAutoScan());

    wasActable = canAct();   // usually false here — physics/camera aren't ready yet
    enterShot(true);
  }

  /** The moment the camera director's phase returns to AIM, the next shot's
   *  meters are ready — edge-detected here rather than timed independently,
   *  so this always matches what the player is actually looking at. */
  let wasActable = true;
  /** Same idea for the results/out-of-bolts overlay: render and announce it
   *  exactly once, the frame CAM.phase actually becomes one of those two,
   *  not the instant the underlying win/out-of-bolts condition is true (the
   *  SETTLE/RESULTS cinematic still gets to play out first). */
  let wasOverlay = false;
  function tick(dt) {
    stepMeters(dt);
    updateStatus();
    const actable = canAct();
    if (actable && !wasActable) enterShot(false);
    wasActable = actable;
    // Big and legible while actually composing a shot; shrinks out of the
    // way the instant it's locked in (canAct() goes false the moment
    // doFire() hands off to the camera director) and again while an
    // overlay owns the screen.
    if (els.minimap) els.minimap.classList.toggle('big', actable);

    const inOverlay = overlayPhase();
    if (inOverlay && !wasOverlay) enterOverlay();
    else if (!inOverlay && wasOverlay) renderOverlay();   // takes the early-return branch, clears '.on'
    wasOverlay = inOverlay;
  }

  return {
    init, tick,
    __test: {
      state() { return JSON.parse(JSON.stringify(state)); },
      previewPhrase, canAct,
      overlayPhase, overlayItems,
      overlayIx() { return overlayIx; },
      pressSpace() { onKeyDown({ code: 'Space', preventDefault() {} }); },
      releaseSpace() { onKeyUp({ code: 'Space', preventDefault() {} }); },
      pressReturn() { onKeyDown({ code: 'Enter', preventDefault() {} }); },
      releaseReturn() { onKeyUp({ code: 'Enter', preventDefault() {} }); }
    }
  };
})();
