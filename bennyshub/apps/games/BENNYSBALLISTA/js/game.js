/**
 * Benny's Ballista — game state and camera director.
 *
 * STEP 2 SLICE: palette plumbing, world/ballista construction, and the
 * ATTRACT camera phase only. No shot pipeline, no physics — those land in
 * later steps of the work order (see the ballista-3d plan). This file grows
 * in place rather than being replaced, so later steps add to what's here
 * instead of forking it.
 */
RT.game = (function () {
  'use strict';

  const U = RT.util;
  const A = RT.art;
  const W = RT.world;
  const D = RT.data;

  let scene, camera, renderer;
  let world = null;      // world.js handles (sky/ground/lights)
  let ballista = null;   // { root, pivot }

  /* ── Theming ──────────────────────────────────────────────────────────────
   * getComputedStyle is far too slow to call per frame, so the palette is
   * read once per theme change and served from a cache — same pattern
   * FishMaster uses (game.js:270-295 there). Anything added here MUST also
   * exist as a CSS custom property in index.html or it silently comes out
   * black (getPropertyValue returns '').
   */
  const PALETTE_VARS = [
    'sky1', 'sky2', 'ground',
    'wood', 'stone', 'glass', 'barrel', 'crown', 'steel'
  ];
  let PAL = {};

  function refreshPalette() {
    const cs = getComputedStyle(document.body);
    PAL = {};
    for (const v of PALETTE_VARS) {
      PAL[v] = cs.getPropertyValue('--' + v).trim() || '#888';
    }
  }
  function css(name) { return PAL[name] || '#888'; }

  /** True for the High Contrast profile, which wants unlit flat geometry
   *  rather than the paper-craft shading — not yet wired to art.js (that's
   *  polish-step work per the plan), but callers can already check this. */
  function isFlat() { return document.body.dataset.theme === 'contrast'; }

  /* ── Camera phases ──────────────────────────────────────────────────────
   * Only ATTRACT exists yet. AIM/FLIGHT/IMPACT/SETTLE/RESULTS arrive with the
   * shot pipeline and camera director in later steps.
   */
  const CAM = {
    phase: 'ATTRACT',
    attractT: 0
  };

  function buildWorldAndBallista() {
    refreshPalette();
    world = W.build(scene, {
      sky1: css('sky1'), sky2: css('sky2'), ground: css('ground')
    });
    ballista = A.buildBallista(css('wood'), css('steel'));
    scene.add(ballista.root);
  }

  /** Call after a theme change (settings menu) to repaint the live scene. */
  function onThemeChanged() {
    if (!world) return;
    refreshPalette();
    W.refresh(world, {
      sky1: css('sky1'), sky2: css('sky2'), ground: css('ground')
    });
  }

  function init(opts) {
    scene = opts.scene;
    camera = opts.camera;
    renderer = opts.renderer;
  }

  function loadAttract() {
    if (!world) buildWorldAndBallista();
    CAM.phase = 'ATTRACT';
    CAM.attractT = 0;
  }

  /** Slow orbit around the ballista behind the (not-yet-built) menu. */
  function updateAttract(dt) {
    CAM.attractT += dt;
    const radius = 9, height = 4.2;
    const speed = 0.12; // full turn every ~52s — meant to be glanced at, not watched
    const a = CAM.attractT * speed;
    camera.position.set(Math.sin(a) * radius, height, Math.cos(a) * radius);
    camera.lookAt(0, 1.4, -2);
  }

  function update(dt) {
    if (CAM.phase === 'ATTRACT') updateAttract(dt);
  }

  return {
    init, loadAttract, update,
    onThemeChanged, isFlat,
    get CAM() { return CAM; }
  };
})();
