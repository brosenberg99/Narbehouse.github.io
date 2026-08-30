/**
 * Benny's Ballista — input, meters, ammo list.
 *
 * No menus, no pause overlay, no minimap yet (later work-order steps). The
 * game starts straight into aiming against the test castle from js/game.js.
 *
 * Input only responds while the camera director (js/game.js) is in its AIM
 * phase — canAct() below. Once a shot fires, the director owns FLIGHT
 * through RESULTS on its own timing, and the next shot's meters reset the
 * moment it returns to AIM (see the edge-detect in tick()), not the instant
 * Return is pressed. There's no pause menu yet to interrupt that with
 * (AGENTS.md wants Return-hold to open Pause from every screen, including
 * mid-flight — noted as a gap until steps 6-7 build the menu system).
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
  const CFG = D.CFG;

  let els = null;

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

  function sfx(name, vol) {
    if (!window.SafeAudio) return;
    try { SafeAudio.play(name, vol); } catch (e) { /* audio is never load-bearing */ }
  }
  function autoScanOn() { const m = U.sm(); return m ? m.getSettings().autoScan : false; }
  function scanInterval() { const m = U.sm(); return m ? m.getScanInterval() : 2000; }

  /* ── Ammo list ────────────────────────────────────────────────────────── */
  function laneItems() { return unlockedAmmo().map((a, i) => ({ label: a.name, sub: a.sub, ix: i })); }
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
      b.innerHTML = it.sub ? `${it.label}<span class="sub">${it.sub}</span>` : it.label;
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
    if (it) U.speak(`${it.label}. ${it.sub}`);
  }

  /* ── Meters ───────────────────────────────────────────────────────────── */
  function meterStage() { return state.stage === 'aim' || state.stage === 'range'; }

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
      if (tick !== state.yawTick) { state.yawTick = tick; sfx('hover', 0.16); }
      moved = true;
    }
    if (state.stage === 'range' && state.charging) {
      state.rangePct = Math.min(100, state.rangePct + CFG.RANGE_PCT_PER_S * dt);
      state.charged = true;
      const step = Math.floor(state.rangePct / CFG.RANGE_TICK_PCT);
      if (step !== state.rangeTick) { state.rangeTick = step; sfx('hover', 0.3); }
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
    if (state.stage === 'ammo') return commitAmmo();
    if (state.stage === 'aim') return lockAim();
    if (state.stage === 'range') return confirmShot();
  }

  function commitAmmo() {
    if (state.scan === -1) { U.speak('Nothing highlighted. Press space to keep scanning.'); return; }
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
    const order = stageOrder();
    const i = order.indexOf(state.stage);
    if (i <= 0) {
      U.speak('No pause menu yet.');   // steps 5-7 build the menu system
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
  function inScanList() { return state.stage === 'ammo'; }
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
    if (e.repeat || !canAct()) return;
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
      ftrMode: U.$('ftrMode'), ftrTarget: U.$('ftrTarget')
    };

    bindMeter(els.meterAim, 'aim');
    bindMeter(els.meterPower, 'range');
    window.addEventListener('mouseup', () => { if (meterStage()) releaseMeter(); });
    window.addEventListener('touchend', () => { if (meterStage()) releaseMeter(); });
    els.btnLockAim.addEventListener('click', () => { if (canAct() && state.stage === 'aim') lockAim(); });
    els.btnFire.addEventListener('click', () => { if (canAct() && state.stage === 'range') confirmShot(); });

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
  function tick(dt) {
    stepMeters(dt);
    const actable = canAct();
    if (actable && !wasActable) enterShot(false);
    wasActable = actable;
  }

  return {
    init, tick,
    __test: {
      state() { return JSON.parse(JSON.stringify(state)); },
      previewPhrase, canAct,
      pressSpace() { onKeyDown({ code: 'Space', preventDefault() {} }); },
      releaseSpace() { onKeyUp({ code: 'Space', preventDefault() {} }); },
      pressReturn() { onKeyDown({ code: 'Enter', preventDefault() {} }); },
      releaseReturn() { onKeyUp({ code: 'Enter', preventDefault() {} }); }
    }
  };
})();
