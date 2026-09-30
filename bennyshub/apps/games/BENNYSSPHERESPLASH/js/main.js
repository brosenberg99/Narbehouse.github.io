/** Benny's Sphere Splash - renderer, adaptive quality, frame loop and boot.
 *  The quality loop is NARBE Racer's (NARBEKART/js/main.js): sample the frame rate,
 *  drop shadows then pixel ratio when it sags, step back up when there is headroom. */
SS.main = (function () {
  'use strict';
  let renderer, scene, camera, running = false, last = 0, t = 0;
  const frames = [], steps = [0.66, 0.8, 1, 1.25, 1.5, 2];
  let ratio = 3, sampleTime = 0, sampleFrames = 0, fps = 60, errors = 0, errorAt = 0;

  function resize() {
    if (!renderer) return;
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  }
  function quality(dt) {
    sampleTime += dt; sampleFrames++;
    if (sampleTime < 3) return;
    fps = sampleFrames / sampleTime; sampleTime = sampleFrames = 0;
    const cap = Math.min(window.devicePixelRatio || 1, 2);
    if (fps < 48 && ratio > 0) { ratio--; renderer.setPixelRatio(Math.min(cap, steps[ratio])); resize(); }
    else if (fps > 59 && ratio < steps.length - 1 && steps[ratio] < cap) { ratio++; renderer.setPixelRatio(Math.min(cap, steps[ratio])); resize(); }
  }
  function fail(err) {
    console.error("Benny's Sphere Splash:", err && err.stack || err);
    running = false;
    const el = document.getElementById('loading');
    if (!el) return;
    el.replaceChildren(); el.style.display = 'flex';
    const h = document.createElement('h1'); h.textContent = 'The game needs a restart';
    const b = document.createElement('button'); b.textContent = 'Restart game'; b.onclick = () => location.reload();
    el.append(h, b);
    window.addEventListener('keyup', e => { if (['Enter', 'NumpadEnter', 'Space'].includes(e.code)) location.reload(); }, true);
    if (window.NarbeVoiceManager) NarbeVoiceManager.speak('The game needs a restart. Press Enter or Space to restart.');
  }
  function loop(now) {
    requestAnimationFrame(loop); if (!running) return;
    const raw = Math.max(0, (now - last) / 1000); last = now;
    if (!raw || document.hidden) return;
    try {
      if (now - errorAt > 4000) errors = 0;
      quality(raw); const dt = Math.min(raw, 0.05); t += dt;
      frames.forEach(fn => fn(dt, t));
      renderer.info.reset(); renderer.render(scene, camera);
    } catch (err) {
      errorAt = now; errors++;
      if (errors >= 5) fail(err); else console.error('frame:', err && err.stack || err);
    }
  }
  function init() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 900);
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping; renderer.info.autoReset = false;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, steps[ratio]));
    document.getElementById('canvasWrap').appendChild(renderer.domElement);
    resize(); window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => { last = performance.now(); });
    renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); fail(new Error('Graphics context lost')); });
  }
  function start() { running = true; last = performance.now(); requestAnimationFrame(loop); }
  function perf() {
    if (!renderer) return null;
    return { fps: +fps.toFixed(1), calls: renderer.info.render.calls, tris: renderer.info.render.triangles,
      pixelRatio: renderer.getPixelRatio(), geometries: renderer.info.memory.geometries };
  }
  SS.perf = perf;

  async function boot() {
    try {
      init();
      await SS.models.load();
      SS.world.build(scene);
      SS.worldui.init(camera);
      SS.director.init(camera);
      SS.hud.build();
      SS.game.init({ scene, camera });
      SS.ui.init();
      frames.push((dt, time) => { SS.world.update(dt, time); SS.game.update(dt, time); SS.worldui.update(); perfHud(time); });
      document.getElementById('loading').style.display = 'none';
      SS.ui.setScreen('title');
      start();
    } catch (err) { fail(err); }
  }
  /* Frame rate readout for testing: add ?perf to the address. */
  const showPerf = /[?&]perf\b/.test(location.search);
  let perfT = 0;
  function perfHud(time) {
    if (!showPerf || time - perfT < 0.5) return;
    perfT = time;
    const el = document.getElementById('perf'), p = perf();
    el.classList.add('on');
    el.textContent = `${p.fps} fps · ${p.calls} draws · ${(p.tris / 1000).toFixed(0)}k tris · ×${p.pixelRatio}`;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else setTimeout(boot, 0);
  return { perf, get renderer() { return renderer; }, get scene() { return scene; }, get camera() { return camera; } };
})();
