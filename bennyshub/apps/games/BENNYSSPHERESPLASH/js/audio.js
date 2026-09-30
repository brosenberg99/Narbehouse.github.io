/** Benny's Sphere Splash - sound effects, synthesised as WAV files and played through
 *  SafeAudio. No AudioContext anywhere (ACCESSIBILITY.md §5: it can take down the
 *  desktop build's renderer). This is M2's grey-box set - a whistle, a goal horn,
 *  a bloop for the ball, a thud for a tackle, and the rising ticks of the pause hold.
 *  Every sound is a clean tone: filtered noise (an early crowd roar and a swish) came
 *  out as static right over the commentary, so there is no noise in any of them. A real
 *  crowd is M3's job. M3 replaces this
 *  with a full pack and music, NARBE Racer's way.
 *
 *  Each sound is rendered once, the first time it is wanted, into a Blob URL. */
SS.audio = (function () {
  'use strict';

  const RATE = 22050;
  const made = {};

  function wavUrl(samples) {
    const n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  /** A buffer of `sec` seconds, filled by fn(t, i) -> sample, with a short fade at each end. */
  function render(sec, fn) {
    const n = Math.floor(sec * RATE), out = new Float32Array(n), fade = Math.floor(RATE * 0.004);
    for (let i = 0; i < n; i++) {
      let s = fn(i / RATE, i);
      if (i < fade) s *= i / fade; else if (i > n - fade) s *= (n - i) / fade;
      out[i] = s;
    }
    return out;
  }
  const env = (t, a, d, len) => t < a ? t / a : Math.max(0, 1 - (t - a) / Math.max(1e-3, len - a)) ** d;

  const RECIPES = {
    // The pause hold: one tick per second, each a step higher, so it works eyes-closed.
    tick1: () => tone(660), tick2: () => tone(784), tick3: () => tone(988), tick4: () => tone(1175), tick5: () => tone(1319),
    whistle: () => render(0.7, t => {
      const trill = 1 + 0.03 * Math.sin(t * 2 * Math.PI * 28);
      return Math.sin(2 * Math.PI * 2350 * trill * t) * 0.3 * env(t, 0.02, 1.2, 0.7);
    }),
    horn: () => render(1.5, t => {
      const f = 196, e = env(t, 0.05, 0.6, 1.5);
      return (Math.sin(2 * Math.PI * f * t) * 0.3 + Math.sin(2 * Math.PI * f * 1.5 * t) * 0.2 + Math.sin(2 * Math.PI * f * 2 * t) * 0.1) * e;
    }),
    // The ball leaving a hand underwater: a round, falling bloop.
    bloop: () => { let ph = 0; return render(0.28, t => { ph += 2 * Math.PI * (520 - t * 1100) / RATE; return Math.sin(ph) * 0.45 * env(t, 0.004, 2, 0.28); }); },
    thud: () => { let ph = 0; return render(0.3, t => { ph += 2 * Math.PI * (130 - t * 220) / RATE; return Math.sin(ph) * 0.7 * env(t, 0.003, 2, 0.3); }); },
    decision: () => render(0.35, t => (Math.sin(2 * Math.PI * 880 * t) * (t < 0.12 ? 1 : 0) + Math.sin(2 * Math.PI * 1320 * t) * (t >= 0.12 ? 1 : 0)) * 0.3 * env(t, 0.005, 1, 0.35)),
  };
  function tone(f) { return render(0.14, t => (Math.sin(2 * Math.PI * f * t) * 0.35 + Math.sign(Math.sin(2 * Math.PI * f * t)) * 0.08) * env(t, 0.003, 1.5, 0.14)); }

  function on() { return SS.save.settings.get('sfx') !== false && window.SafeAudio; }
  function play(name, vol) {
    if (!on()) return;
    try {
      if (!made[name]) {
        if (!RECIPES[name]) return;
        made[name] = true;
        SafeAudio.preload('ss-' + name, wavUrl(RECIPES[name]()));
      }
      SafeAudio.play('ss-' + name, vol == null ? 0.7 : vol);
    } catch (e) { /* sound is never worth a crash */ }
  }
  /** Menu blips: SafeAudio's own built-ins (preloaded with NO url, so they stay built-in). */
  function menu(kind) {
    if (!on()) return;
    try { SafeAudio.play(kind === 'move' ? 'hover' : kind === 'select' ? 'select' : 'bust', kind === 'blocked' ? 0.2 : 0.35); } catch (e) { /* ignore */ }
  }
  function tick(sec) { play('tick' + Math.max(1, Math.min(5, sec)), 0.55); }
  function stopAll() { try { if (window.SafeAudio) SafeAudio.stopAll(); } catch (e) { /* ignore */ } }

  return { play, menu, tick, stopAll };
})();
