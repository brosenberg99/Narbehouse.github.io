/**
 * Benny's Ballista — game state and camera director.
 *
 * STEP 3 SLICE adds Ammo.js physics: one hand-made castle stands in front of
 * the ballista so it and the physics adapter can be judged with something
 * real on screen. Still no shot pipeline or camera director — those are
 * work-order steps 4-5. This file grows in place rather than being replaced,
 * so later steps add to what's here instead of forking it.
 */
RT.game = (function () {
  'use strict';

  const U = RT.util;
  const A = RT.art;
  const W = RT.world;
  const D = RT.data;
  const P = RT.physics;

  let scene, camera, renderer;
  let world = null;      // world.js handles (sky/ground/lights)
  let ballista = null;   // { root, pivot }
  let physicsReady = false;
  let blocks = [];       // { mesh, body, mat } — the test castle, for now

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

  /* ── Blocks ───────────────────────────────────────────────────────────────
   * Ties one Ammo body to one Three.js mesh. Real level loading (js/levels.js
   * + the ASCII layer parser) is work-order step 6; this is just enough to
   * put a real, physically simulated castle on screen for step 3.
   */
  function spawnBlock(matId, x, y, z, w, h, d) {
    const mat = D.MAT[matId];
    const color = css(mat.css.replace('--', ''));
    const mesh = A.buildBlock(w, h, d, color, { glow: !!mat.crown });
    mesh.position.set(x, y, z);
    scene.add(mesh);

    const mass = mat.static ? 0 : w * h * d;   // mass ∝ volume, per the plan
    const body = P.addBlock(x, y, z, w, h, d, mass);

    const rec = { mesh: mesh, body: body, mat: mat };
    blocks.push(rec);
    return rec;
  }

  function clearBlocks() {
    for (const b of blocks) P.destroyBlock(b.body);
    blocks = [];
  }

  /**
   * One hand-made castle: a deliberately thin, top-heavy tower — knock the
   * stone base out and the wood above it should come down, per the design
   * philosophy carried over from the 2D levels ("knocking the legs out from
   * under a spindly structure is more fun than hitting the crown directly").
   * Real levels (ASCII layers) arrive in step 6; this one is just enough to
   * prove the physics adapter works.
   */
  function buildTestCastle() {
    clearBlocks();
    const cz = -8;
    spawnBlock('S', 0, 0.5, cz, 1, 1, 1);
    spawnBlock('W', 0, 1.5, cz, 1, 1, 1);
    spawnBlock('W', 0, 2.5, cz, 1, 1, 1);
    spawnBlock('K', 0, 3.45, cz, 0.8, 0.8, 0.8);
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
    if (!physicsReady) {
      // Ammo's module factory resolves asynchronously (see js/physics.js) —
      // the scene renders and the attract camera runs on its own in the
      // meantime; update() below simply doesn't step physics until this
      // resolves, so there's nothing to block on here.
      P.init().then(() => {
        physicsReady = true;
        buildTestCastle();
      });
    }
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
    if (physicsReady) {
      P.step(dt);
      for (const b of blocks) P.sync(b.mesh, b.body);
    }
  }

  /**
   * Console-driven checks for this step — no HP/damage system exists yet
   * (that lands with the shot pipeline, work-order step 4), so "get it
   * standing and collapsing" is verified by hand: watch it settle, then
   * knock() a block and watch it topple. See
   * mcp__chrome-devtools__evaluate_script in the ballista-3d plan's
   * verification section for how this gets driven from outside the page.
   */
  const __test = {
    blockCount() { return blocks.length; },
    blockState() { return blocks.map((b) => ({ y: b.mesh.position.y, awake: P.isAwake(b.body) })); },
    knock(index, vx, vy, vz) {
      const b = blocks[index];
      if (!b) return false;
      P.addVelocity(b.body, vx || 0, vy || 0, vz || 0);
      return true;
    },
    rebuildCastle: buildTestCastle
  };

  return {
    init, loadAttract, update,
    onThemeChanged, isFlat,
    get CAM() { return CAM; },
    __test: __test
  };
})();
