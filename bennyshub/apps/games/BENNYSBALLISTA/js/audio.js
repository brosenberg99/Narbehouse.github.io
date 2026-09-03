/**
 * Benny's Ballista — audio.
 *
 * Every REACTIVE sound (impacts, destruction, fanfare, UI blips) is still
 * synthesised at runtime — that part of the design is unchanged, and is what
 * keeps THOSE sounds working from a bare file:// page with nothing to fetch or
 * fail to load. A single AudioContext is shared for the whole session, and
 * every entry point is wrapped defensively: if Web Audio misbehaves inside the
 * Electron iframe the game keeps running silently rather than throwing.
 *
 * The one exception is the background music loop (see "Music" below): a real
 * file, played through a plain HTML5 `<audio>` element, deliberately NOT
 * routed through the AudioContext at all. See that section's own comment for
 * why a loop wants different tools than a one-shot effect does, and
 * README.md's "Third-party audio" section for the file's source and licence.
 *
 * The core (ensure / resume / chain / tone / noise / setEnabled) is ported from
 * BENNYSRACETRACKS' js/audio.js lines 1-252, including its `broken` flag and
 * its mirror into SafeAudio.setEnabled() so one toggle silences both systems.
 *
 * AGENTS.md:185-190 tells games to prefer the shared SafeAudio over Web Audio,
 * because an AudioContext can take down the renderer in the Electron desktop
 * build. This module is a deliberate divergence, following the precedent Race
 * Tracks and FishMaster already set, and it is only acceptable because of the
 * defensive wrapping above. The reason for diverging is specific: a siege game
 * lives or dies on destruction audio, and destruction has to be *continuous* —
 * a stone hit at 8 m/s and the same hit at 40 m/s are not the same sound, and
 * an impact behind the player's left shoulder should arrive in the left ear.
 * SafeAudio bakes a fixed waveform at preload time and has no panner, so it
 * cannot express either. It stays loaded for the UI blips it is good at.
 *
 * Two deliberate differences from the Race Tracks core, both driven by how
 * much more often this game makes noise than that one does:
 *
 *   1. The white-noise buffer is generated once and reused. Race Tracks calls
 *      noise() a handful of times a race; a collapsing castle calls it dozens
 *      of times a second, and allocating a fresh Float32Array per impact is
 *      real GC pressure during exactly the frames that can least afford it.
 *   2. There is a voice cap. See `budget()` below — without it a collapse
 *      machine-guns and turns into static.
 */
RT.audio = (function () {
  'use strict';

  const U = RT.util;

  let ctx = null;
  let master = null;
  let broken = false;
  /* Shared with the other RT games under the same `rt-sound` key, the way
     Race Tracks and FishMaster already do it — turning sound off in one turns
     it off in all of them, which matches how the hub treats its TTS toggle. */
  let enabled = U.load('sound', true);
  /* Separate from `enabled` on purpose — see the "Music" section below for
     why a player might want one on without the other. Its own key (not
     shared with `sound`) because no other RT game has a music loop yet; if
     one grows one, sharing this key the way `sound` is shared is the right
     move then, not now. */
  let musicEnabled = U.load('music', true);

  /* Continuous flight whoosh */
  let flyGain = null, flyFilter = null, flySrc = null;
  let flyRunning = false;

  function ensure() {
    if (broken) return null;
    if (ctx) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { broken = true; return null; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
    } catch (e) {
      broken = true;
      return null;
    }
    return ctx;
  }

  /** Browsers start the context suspended until a user gesture. */
  function resume() {
    const c = ensure();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  }

  function now() { return ctx ? ctx.currentTime : 0; }

  /**
   * Build a gain → (optional pan) → master chain.
   * StereoPannerNode is what puts an impact in the ear it happened on, which
   * is the whole point of passing screen position down from game.js.
   */
  function chain(pan) {
    const g = ctx.createGain();
    if (pan !== undefined && pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = U.clamp(pan, -1, 1);
      g.connect(p);
      p.connect(master);
    } else {
      g.connect(master);
    }
    return g;
  }

  /** One shaped oscillator note. */
  function tone(freq, dur, opts) {
    if (!enabled) return;
    const c = ensure();
    if (!c) return;
    opts = opts || {};
    try {
      const t0 = now() + (opts.delay || 0);
      const g = chain(opts.pan);
      const osc = c.createOscillator();
      osc.type = opts.type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (opts.slideTo) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slideTo), t0 + dur);
      }
      const vol = (opts.vol === undefined ? 0.16 : opts.vol);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.02, dur * 0.25));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch (e) { /* ignore */ }
  }

  /* One second of white noise, generated once. Every noise() call and the
     flight whoosh read from this same buffer at a random offset. */
  let NOISE_BUF = null;
  function noiseBuffer(c) {
    if (NOISE_BUF && NOISE_BUF.sampleRate === c.sampleRate) return NOISE_BUF;
    const frames = Math.floor(c.sampleRate);
    const buf = c.createBuffer(1, frames, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    NOISE_BUF = buf;
    return buf;
  }

  /** Filtered noise — cracks, grinds, shatters, whooshes. */
  function noise(dur, opts) {
    if (!enabled) return;
    const c = ensure();
    if (!c) return;
    opts = opts || {};
    try {
      const t0 = now() + (opts.delay || 0);
      const buf = noiseBuffer(c);

      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = true;

      const filt = c.createBiquadFilter();
      filt.type = opts.filterType || 'lowpass';
      filt.frequency.setValueAtTime(opts.freq || 900, t0);
      if (opts.freqTo) filt.frequency.exponentialRampToValueAtTime(Math.max(40, opts.freqTo), t0 + dur);
      filt.Q.value = opts.q || 1;

      const g = chain(opts.pan);
      const vol = (opts.vol === undefined ? 0.22 : opts.vol);
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      src.connect(filt); filt.connect(g);
      /* Random offset so repeated hits don't replay the identical noise
         fragment, which is audible as a "texture" once you notice it. */
      src.start(t0, Math.random() * 0.9);
      src.stop(t0 + dur + 0.02);
    } catch (e) { /* ignore */ }
  }

  /* ── Voice cap ────────────────────────────────────────────────────────────
   * A castle coming down produces dozens of contacts within a few frames.
   * Played individually they stop being distinguishable and turn into static,
   * so only a few of the loudest get their own voice; the rest are summed and
   * flushed by tick() as a single rumble, which is what a collapse actually
   * sounds like anyway.
   */
  const VOICE_WINDOW_S = 0.06;
  const VOICE_LIMIT = 4;
  let voiceTimes = [];
  let pendingRumble = 0;
  let rumbleCooldown = 0;

  /* Deliberately performance.now() and not the AudioContext clock: ctx may not
     exist yet (it is created lazily, and stays suspended until a gesture), and
     now() returns a flat 0 until it does — which would make every timestamp
     identical, fill the window on the fourth impact, and then silently fold
     every impact for the rest of the session into the rumble. */
  function budget() {
    const t = performance.now() / 1000;
    voiceTimes = voiceTimes.filter((v) => t - v < VOICE_WINDOW_S);
    if (voiceTimes.length >= VOICE_LIMIT) return false;
    voiceTimes.push(t);
    return true;
  }

  /** Call once per frame from game.update(). `phase` (game.js's CAM.phase)
   *  is optional — omitting it just leaves the music wherever it already
   *  was, which is what every OTHER caller of tick() (auditLevels() never
   *  calls it at all; it doesn't run the frame loop) already expects. */
  function tick(dt, phase) {
    if (rumbleCooldown > 0) rumbleCooldown -= dt;
    if (pendingRumble > 0.2 && rumbleCooldown <= 0) {
      const v = U.clamp(0.06 + pendingRumble * 0.05, 0.06, 0.30);
      noise(0.45, { freq: 260, freqTo: 55, vol: v, q: 0.7 });
      tone(56, 0.5, { type: 'sine', vol: v * 0.6, slideTo: 34 });
      rumbleCooldown = 0.25;
    }
    pendingRumble *= Math.max(0, 1 - dt * 4);
    if (phase !== undefined) musicTick(dt, phase);
  }

  /* ── Music ─────────────────────────────────────────────────────────────
   * A single looping background track — war drums, playing under a shot
   * being composed. Everything else in this file is a one-shot effect built
   * from oscillators/noise because a one-shot needs pitch/force/pan control
   * the Web Audio graph gives for free; a LOOP needs none of that; it needs
   * to play one file, forever, at a volume that drifts with what's on
   * screen. A plain HTML5 `<audio loop>` element already does exactly that,
   * with none of the AudioContext-in-Electron risk this file's header
   * warns about — so the music is deliberately NOT part of the `ctx`/
   * `master` graph above, and keeps playing (or stays correctly silent)
   * whether or not that graph ever gets built. See README.md's "Third-party
   * audio" section for where the file came from and its licence.
   *
   * Volume, not play/pause, is how this responds to the game — see
   * musicTick()'s phase table. Actually pausing/resuming a real media
   * element on every phase change risks an audible restart chirp and a
   * decode hiccup on resume; fading the SAME playing loop up and down never
   * does either. The one time this genuinely pauses is the Music setting
   * itself being switched off — that has to stop real hardware activity,
   * not just go quiet — and the very first start, which still waits for a
   * user gesture the same way `resume()` above does for the AudioContext.
   */
  const MUSIC_SRC = 'audio/music/horde-war-drums-130bpm.mp3';
  /* Per-phase target volume. AIM is the only phase with no clock on it —
     the player may sit there for an hour — so it's the one place the music
     gets to be a real presence. Everything from FLIGHT through RESULTS is
     the cinematic: destruction audio there is load-bearing (README — a
     player who can't resolve the blocks visually still has to be able to
     tell what just broke), so music ducks well under it rather than
     competing for the same frequency space. RESULTS_MENU/OUTOFBOLTS duck
     further still, under whichever sting (win()/outOfBolts() below) is
     playing right then. MENU (pause) goes to zero, same as any game pausing
     its music, but still by fading rather than pausing the element. */
  const MUSIC_VOL = { AIM: 0.022, ATTRACT: 0.022, CINEMATIC: 0.011, RESULT: 0.0055, MENU: 0 };
  const MUSIC_FADE_PER_S = 1.0; // full-scale fade takes ~1s; a phase change is never that abrupt

  let musicEl = null;
  let musicVol = 0;

  function ensureMusic() {
    if (musicEl) return musicEl;
    try {
      musicEl = new Audio(MUSIC_SRC);
      musicEl.loop = true;
      musicEl.volume = 0;
    } catch (e) { musicEl = null; }
    return musicEl;
  }

  /** Starts the loop. Call from the same first-gesture handler that calls
   *  resume() — browsers block a real `<audio>` element's playback before a
   *  gesture exactly the same way they suspend an AudioContext, so this
   *  needs the identical trigger. Safe to call again on every subsequent
   *  gesture too: a second `.play()` on an already-playing element is a
   *  harmless no-op. */
  function musicResume() {
    if (!musicEnabled) return;
    const el = ensureMusic();
    if (!el) return;
    try { if (el.paused) el.play().catch(() => {}); } catch (e) { /* ignore */ }
  }

  function musicTarget(phase) {
    if (phase === 'MENU') return MUSIC_VOL.MENU;
    if (phase === 'RESULTS_MENU' || phase === 'OUTOFBOLTS') return MUSIC_VOL.RESULT;
    if (phase === 'AIM' || phase === 'ATTRACT') return MUSIC_VOL.AIM;
    return MUSIC_VOL.CINEMATIC; // FLIGHT / IMPACT / SETTLE / RESULTS
  }

  function musicTick(dt, phase) {
    if (!musicEl || !musicEnabled) return;
    const target = musicTarget(phase);
    musicVol += U.clamp(target - musicVol, -MUSIC_FADE_PER_S * dt, MUSIC_FADE_PER_S * dt);
    try { musicEl.volume = U.clamp(musicVol, 0, 1); } catch (e) { /* ignore */ }
  }

  /** Actually stops playback — used only by the Music setting itself, never
   *  by a phase change (see the section header above for why). */
  function stopMusic() {
    musicVol = 0;
    if (!musicEl) return;
    try { musicEl.pause(); } catch (e) { /* ignore */ }
  }

  function setMusicEnabled(on) {
    musicEnabled = !!on;
    U.save('music', musicEnabled);
    if (musicEnabled) musicResume(); else stopMusic();
  }
  function isMusicEnabled() { return musicEnabled; }

  /* ── Material impacts ─────────────────────────────────────────────────────
   * `energy` is an impact speed in world units; `pan` is -1..1 screen position.
   * Each family gets a different noise band and a different pitched component,
   * because the point of this is that a player who cannot resolve the blocks
   * visually can still tell what just broke.
   */

  /** MAT entries for the one-off pieces carry no `family`, so derive one. */
  function familyOf(mat) {
    if (!mat) return 'stone';
    if (mat.family) return mat.family;
    if (mat.crown) return 'crown';
    if (mat.explodes) return 'barrel';
    if (mat.static) return 'steel';
    return 'stone';
  }

  /** 0..1, how hard was this. Impact speeds run roughly 8-45. */
  function force(energy) {
    return U.clamp((energy === undefined ? 20 : energy) / 34, 0.12, 1);
  }

  function impact(mat, energy, pan) {
    if (!enabled) return;
    const fam = familyOf(mat);
    const f = force(energy);
    if (!budget()) { pendingRumble += f; return; }

    switch (fam) {
      case 'wood':
        noise(0.10 + f * 0.10, { freq: 1400, freqTo: 260, vol: 0.10 + f * 0.16, q: 1.4, pan: pan });
        tone(150 + f * 60, 0.10, { type: 'square', vol: 0.05 + f * 0.07, slideTo: 80, pan: pan });
        break;
      case 'stone':
        noise(0.16 + f * 0.16, { freq: 520, freqTo: 70, vol: 0.11 + f * 0.19, q: 0.8, pan: pan });
        tone(78, 0.16, { type: 'sine', vol: 0.05 + f * 0.09, slideTo: 44, pan: pan });
        break;
      case 'glass':
        noise(0.20 + f * 0.14, { freq: 5200, freqTo: 1800, vol: 0.09 + f * 0.15,
                                 filterType: 'bandpass', q: 1.1, pan: pan });
        /* Three bright inharmonic pings — the "tinkle" after the break. */
        [2400, 3150, 4100].forEach((base, i) => {
          tone(base * (0.9 + Math.random() * 0.25), 0.16, {
            type: 'sine', vol: 0.04 + f * 0.05, delay: 0.02 + i * 0.05, pan: pan
          });
        });
        break;
      case 'barrel':
        noise(0.26 + f * 0.18, { freq: 300, freqTo: 45, vol: 0.14 + f * 0.22, q: 0.9, pan: pan });
        tone(96, 0.30, { type: 'square', vol: 0.08 + f * 0.12, slideTo: 38, pan: pan });
        break;
      case 'steel':
        /* Inharmonic partials are what make metal sound like metal. */
        [1180, 1790, 2630].forEach((base, i) => {
          tone(base, 0.26 - i * 0.05, {
            type: 'triangle', vol: (0.05 + f * 0.07) / (i + 1), delay: i * 0.006, pan: pan
          });
        });
        noise(0.07, { freq: 3400, freqTo: 1200, vol: 0.05 + f * 0.07, filterType: 'bandpass', q: 2, pan: pan });
        break;
      case 'guard':
        guardDown(pan, f);
        break;
      case 'crown':
        noise(0.14, { freq: 2600, freqTo: 700, vol: 0.08 + f * 0.10, filterType: 'bandpass', q: 1.4, pan: pan });
        tone(880, 0.18, { type: 'triangle', vol: 0.07 + f * 0.07, pan: pan });
        break;
      default:
        noise(0.14, { freq: 700, freqTo: 160, vol: 0.10 + f * 0.12, pan: pan });
    }
  }

  /** A kill, not just a hit — the same voice with more weight behind it. */
  function destroy(mat, energy, pan) {
    if (!enabled) return;
    const fam = familyOf(mat);
    if (fam === 'crown') { crownTopple(); return; }
    if (fam === 'guard') { guardDown(pan, 1); return; }
    impact(mat, (energy === undefined ? 24 : energy) * 1.35, pan);
    /* A low thud underneath, so a destroyed block is audibly different from a
       block that merely got hit. */
    if (budget()) tone(64, 0.22, { type: 'sine', vol: 0.10, slideTo: 40, pan: pan });
  }

  /** Rubble settling. Fed by the voice cap's overflow as well as directly. */
  function collapse(intensity) {
    pendingRumble += U.clamp(intensity === undefined ? 1 : intensity, 0, 6);
  }

  /* ── Named cues ───────────────────────────────────────────────────────── */

  /** Comedic, not violent — a guard is flavour, and a wince-inducing hit
   *  sound would be the wrong read for this game entirely. */
  function guardDown(pan, f) {
    const v = 0.09 + (f === undefined ? 0.6 : f) * 0.07;
    tone(560, 0.26, { type: 'triangle', vol: v, slideTo: 180, pan: pan });
    noise(0.16, { freq: 900, freqTo: 200, vol: v * 0.5, pan: pan, delay: 0.14 });
  }

  /** The win condition. Deliberately the brightest thing in the game — it must
   *  never be ambiguous that the tyrant just went down. */
  function crownTopple() {
    noise(0.34, { freq: 3600, freqTo: 900, vol: 0.18, filterType: 'bandpass', q: 1.2 });
    [784, 988, 1319].forEach((f, i) =>
      tone(f, 0.34, { type: 'triangle', vol: 0.19, delay: i * 0.075 }));
    tone(96, 0.42, { type: 'square', vol: 0.15, slideTo: 44, delay: 0.05 });
  }

  function fireShot(ammo) {
    /* Heavier ammunition launches lower and longer. */
    const heavy = ammo && ammo.speed ? U.clamp(1 - (ammo.speed - 22) / 26, 0, 1) : 0.5;
    noise(0.14 + heavy * 0.10, { freq: 1900, freqTo: 300, vol: 0.20, q: 1.1 });
    tone(190 - heavy * 70, 0.20, { type: 'square', vol: 0.16, slideTo: 70 });
  }

  /* The bolt in flight: looped noise through a bandpass that opens up with
     speed, panned by where the bolt is on screen. */
  function startFlight() {
    if (!enabled || flyRunning) return;
    const c = ensure();
    if (!c) return;
    try {
      flyGain = c.createGain();
      flyGain.gain.value = 0.0001;
      flyGain.connect(master);

      flyFilter = c.createBiquadFilter();
      flyFilter.type = 'bandpass';
      flyFilter.frequency.value = 700;
      flyFilter.Q.value = 1.1;
      flyFilter.connect(flyGain);

      flySrc = c.createBufferSource();
      flySrc.buffer = noiseBuffer(c);
      flySrc.loop = true;
      flySrc.connect(flyFilter);
      flySrc.start();

      flyGain.gain.exponentialRampToValueAtTime(0.07, now() + 0.10);
      flyRunning = true;
    } catch (e) { /* ignore */ }
  }

  /** @param {number} speedNorm 0..1  @param {number} pan -1..1 screen x */
  function updateFlight(speedNorm, pan) {
    if (!flyRunning || !ctx) return;
    try {
      const t = now();
      const s = U.clamp(speedNorm, 0, 1);
      flyFilter.frequency.setTargetAtTime(420 + s * 1700, t, 0.06);
      flyGain.gain.setTargetAtTime(enabled ? (0.035 + s * 0.075) : 0.0001, t, 0.08);
    } catch (e) { /* ignore */ }
  }

  function stopFlight() {
    if (!flyRunning) return;
    try {
      flyGain.gain.setTargetAtTime(0.0001, now(), 0.06);
      const s = flySrc;
      setTimeout(() => { try { s.stop(); } catch (e) {} }, 300);
    } catch (e) { /* ignore */ }
    flySrc = flyFilter = flyGain = null;
    flyRunning = false;
  }

  /* ── Meters ───────────────────────────────────────────────────────────────
   * AGENTS.md:99-102: charge feedback is a visible meter AND non-speech audio,
   * and it must not be speech because speech lags the meter.
   */

  /** Yaw sweep. Panned by yaw so which way the ballista is pointing is
   *  audible, not only visible. */
  function aimTick(pan) {
    tone(520, 0.045, { type: 'square', vol: 0.055, pan: pan });
  }

  /** Range charge: a rising pentatonic ladder, so "how far along am I" is
   *  carried by pitch rather than by repetition. Mirrors the Minigolf ladder
   *  AGENTS.md cites as the pattern to copy. */
  const LADDER = [523, 587, 659, 784, 880, 1047];
  function chargeStep(i, n) {
    const total = Math.max(1, n || LADDER.length);
    const ix = U.clamp(Math.round((i / total) * (LADDER.length - 1)), 0, LADDER.length - 1);
    tone(LADDER[ix], 0.075, { type: 'triangle', vol: 0.085 });
  }

  /* ── Menus and results ────────────────────────────────────────────────── */

  function menuMove() { tone(660, 0.07, { type: 'square', vol: 0.09 }); }
  function menuSelect() {
    tone(523, 0.09, { type: 'square', vol: 0.12 });
    tone(784, 0.13, { type: 'square', vol: 0.10, delay: 0.07 });
  }
  function menuBlocked() { tone(150, 0.16, { type: 'square', vol: 0.10 }); }

  /** Result sting. Longer and higher the more stars were earned. */
  function win(stars) {
    const n = U.clamp(stars || 1, 1, 3);
    const notes = [523, 659, 784, 1047, 1319].slice(0, 2 + n);
    notes.forEach((f, i) => tone(f, 0.38, { type: 'triangle', vol: 0.19, delay: i * 0.12 }));
    tone(1568, 0.6, { type: 'sine', vol: 0.14, delay: notes.length * 0.12 });
  }

  function outOfBolts() {
    [440, 392, 330, 262].forEach((f, i) =>
      tone(f, 0.3, { type: 'triangle', vol: 0.17, delay: i * 0.14 }));
  }

  /* ── Settings ─────────────────────────────────────────────────────────── */

  function setEnabled(on) {
    enabled = !!on;
    U.save('sound', enabled);
    if (!enabled) {
      stopFlight();
      pendingRumble = 0;
    }
    if (window.SafeAudio && window.SafeAudio.setEnabled) {
      try { window.SafeAudio.setEnabled(enabled); } catch (e) {}
    }
  }
  function isEnabled() { return enabled; }

  /* Keep SafeAudio in step with the persisted preference from the start,
     rather than only when the player toggles it. */
  if (window.SafeAudio && window.SafeAudio.setEnabled) {
    try { window.SafeAudio.setEnabled(enabled); } catch (e) {}
  }

  return {
    resume, tick, setEnabled, isEnabled,
    impact, destroy, collapse, familyOf,
    fireShot, startFlight, updateFlight, stopFlight,
    aimTick, chargeStep,
    guardDown, crownTopple, win, outOfBolts,
    menuMove, menuSelect, menuBlocked,
    tone, noise,
    musicResume, setMusicEnabled, isMusicEnabled,

    /* Same convention as js/game.js and js/ui.js. The context is created
     * lazily by the first sound that actually plays, which makes `ctxExists`
     * a direct answer to "has this module made any noise yet" — that is how
     * the boot audits are checked to be silent, rather than by trusting that
     * they are. */
    __test: {
      ctxExists: () => !!ctx,
      ctxState: () => (ctx ? ctx.state : 'none'),
      broken: () => broken,
      flightRunning: () => flyRunning,
      pendingRumble: () => pendingRumble,
      liveVoices: () => voiceTimes.length,
      musicEnabled: () => musicEnabled,
      musicExists: () => !!musicEl,
      musicPaused: () => (musicEl ? musicEl.paused : null),
      musicVolume: () => (musicEl ? musicEl.volume : null),
      musicTarget: (phase) => musicTarget(phase)
    }
  };
})();
