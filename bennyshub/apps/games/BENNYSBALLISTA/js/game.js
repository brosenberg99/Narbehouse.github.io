/**
 * Benny's Ballista — game state and camera director.
 *
 * Runs the real six-phase camera director (ATTRACT / AIM / FLIGHT / IMPACT /
 * SETTLE / RESULTS, the impact-seat scorer, screen shake, Steady Camera —
 * work-order step 5) over real levels loaded from RT.levels (the stacked-
 * ASCII-layer format, ~12 castles, and the auditLevels()/auditReach() boot
 * checks — step 6). js/ui.js drives the meters and input and calls into the
 * fire()/traceShot() API at the bottom of this file; everything about the
 * world, the live castle and the camera stays here.
 *
 * Also owns progress: stars, score, ammo unlocks, the results/out-of-bolts/
 * menu overlays (RESULTS_MENU / OUTOFBOLTS / MENU, three more CAM phases
 * alongside the camera director's own six), and the save file itself — one
 * combined object under RT.util's `rt-ballista` key, same shape as
 * FishMaster's save. Endless Bolts defaults on (the hub's no-fail default);
 * it, Steady Camera, Sound and minimap size are all reachable from the MENU
 * phase's Settings screen, which js/ui.js renders.
 *
 * Destruction audio is wired through this file into js/audio.js — see the
 * "Audio" block below `disposeBlockMesh()` for the two helpers everything
 * routes through, and note that `auditing` is what keeps the boot audits
 * silent while they settle twelve castles and fire real test shots.
 *
 * Still outstanding: no way to open MENU mid-cinematic (see js/ui.js's
 * header).
 */
RT.game = (function () {
  'use strict';

  const U = RT.util;
  const A = RT.art;
  const W = RT.world;
  const D = RT.data;
  const LV = RT.levels;
  const P = RT.physics;
  const AU = RT.audio;
  const CFG = D.CFG;

  let scene, camera, renderer;
  let world = null;      // world.js handles (sky/ground/lights)
  let ballista = null;   // { root, pivot }
  let guardDecor = null;  // decorative baked model beside the ballista, or null if not baked
  let guardDecor2 = null; // second decorative guard, mirrored on the other side
  let physicsReady = false;
  let blocks = [];       // { mesh, body, mat, half:Vector3, hp, alive } — the live level's blocks
  let shots = [];        // live bolts: { mesh, ammo, trace, t, resolved }
  let levelWon = false;
  let levelIx = 0;
  // Valid from module load (level 0), same as TEST_LEVEL used to be — ui.js
  // computes yaw/range windows against currentLevel() before physics (and so
  // loadLevel()) has run at all, and needs something real to read.
  let liveLevel = LV.LEVELS[0];
  let boltsUsed = 0;    // this level, since loadLevel() — resets to 0 there
  let levelScore = 0;   // this level's points, folded into save.totalScore on a win
  let lastResult = null; // { stars, earned, bonus, newAmmo } for the results overlay

  /** Per-level ammo scarcity — id -> uses left, only for AMMO entries that
   *  carry a `limit`. Reset every loadLevel() (including a retry), never
   *  persisted, so scarcity is a per-attempt puzzle constraint, not a
   *  session-wide one. See D.AMMO's limit field. */
  let ammoLeft = {};
  function resetAmmoLeft() {
    ammoLeft = {};
    for (const a of D.AMMO) if (a.limit != null) ammoLeft[a.id] = a.limit;
  }
  function ammoRemaining(ammo) {
    if (ammo.limit == null) return Infinity;
    const v = ammoLeft[ammo.id];
    return v == null ? ammo.limit : v;
  }

  /* ── Save / progress ──────────────────────────────────────────────────────
   * One combined object (progress + the one setting that affects rules),
   * same shape as FishMaster's save — not the bare `bennysballista_*` keys
   * the 2D version used, since this game is RT-based now and RT.util's
   * load()/save() already namespace everything under one `rt-` prefix.
   */
  const SAVE_KEY = 'ballista';
  const SAVE_VERSION = 1;
  let save = null;
  function defaultSave() {
    return {
      version: SAVE_VERSION,
      level: 0,          // furthest level reached (index) — also where a fresh boot resumes
      stars: {},         // levelIx -> best stars earned (1-3)
      totalScore: 0,
      endlessBolts: true, // recommended default, matches the hub's no-fail philosophy
      minimapSize: 'large', // 'large' | 'medium' | 'none' — js/ui.js's Settings screen
      theme: 'ben',      // 'ben' | 'dark' | 'light' | 'contrast' — the four colour profiles
      aimMode: 'sweep',  // 'sweep' | 'target' — js/ui.js's Settings screen
      // null = follow the OS's prefers-reduced-motion; true/false = the player
      // overrode it in Settings. Kept tri-state rather than baking the OS value
      // in at first save, so someone who later turns reduced-motion on still
      // gets Steady Camera automatically unless they explicitly chose otherwise.
      steadyCamera: null
    };
  }
  function loadSave() {
    const raw = U.load(SAVE_KEY, null);
    save = (raw && raw.version === SAVE_VERSION) ? Object.assign(defaultSave(), raw) : defaultSave();
  }
  /** Set while runBootAudits() is actually firing test shots (auditReach()'s
   *  simulated tier, below) — a test shot can legitimately clear a level's
   *  only crown and trip checkWin()/finishLevel(), which would otherwise
   *  write bogus progress into the player's real save. runBootAudits()
   *  also snapshots/restores `save` itself around the whole audit, so this
   *  is defense in depth, not the only guard. */
  let suppressSaveWrites = false;
  function persistSave() { if (!suppressSaveWrites) U.save(SAVE_KEY, save); }

  /** Auto-enabled under prefers-reduced-motion, same as FishMaster's
   *  reducedMotion() — unless the player explicitly overrode it from the
   *  menu's Settings screen (setSteadyCamera below). */
  const REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  /** Live value of the Steady Camera setting: the player's explicit choice
   *  if they made one in Settings, otherwise whatever the OS asks for. */
  function steadyCameraOn() {
    if (!save || save.steadyCamera == null) return REDUCED_MOTION;
    return !!save.steadyCamera;
  }

  /* ── Theming ──────────────────────────────────────────────────────────────
   * getComputedStyle is far too slow to call per frame, so the palette is
   * read once per theme change and served from a cache — same pattern
   * FishMaster uses (game.js:270-295 there). Anything added here MUST also
   * exist as a CSS custom property in index.html or it silently comes out
   * black (getPropertyValue returns '').
   */
  const PALETTE_VARS = [
    'sky1', 'sky2', 'ground', 'focus', 'ink',
    'wood', 'stone', 'glass', 'barrel', 'crown', 'steel', 'guard'
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
   *  rather than the paper-craft shading. */
  function isFlat() { return document.body.dataset.theme === 'contrast'; }

  /** Push the two things art.js can't work out for itself — which material
   *  class this profile wants, and what colour the ink is. art.js never reads
   *  the DOM (same rule as world.js), so it has to be told. */
  function applyProfileToArt() {
    A.setInk(css('ink'));
    return A.setFlat(isFlat());     // true when the material class actually changed
  }

  /* ── Camera phases ────────────────────────────────────────────────────── */
  const CAM = {
    phase: 'ATTRACT',
    attractT: 0,
    impactPoint: new THREE.Vector3(),
    seatPos: new THREE.Vector3(),
    impactT: 0,
    settleT: 0,
    resultsT: 0,
    shake: 0
  };

  /** The fixed pose everything about a shot is judged from. Never moves —
   *  all camera personality happens after Return is pressed. Its look-at
   *  point re-centres on whatever castle is live (see loadLevel()) so a
   *  distant level doesn't leave the frame aimed short of it. */
  const AIM_POS = new THREE.Vector3(0, 3.6, 7.5);
  const AIM_LOOKAT = new THREE.Vector3(0, 2.0, -20);

  /** The palette bundle world.js and art.js are handed. Built here in one
   *  place so build-time and theme-change-time can never drift apart. */
  function worldPalette() {
    return {
      sky1: css('sky1'), sky2: css('sky2'), ground: css('ground'),
      flat: isFlat()
    };
  }

  function buildWorldAndBallista() {
    refreshPalette();
    applyProfileToArt();
    world = W.build(scene, worldPalette());
    ballista = A.buildBallista(css('wood'), css('steel'));
    ballista.pivot.rotation.order = 'YXZ';   // yaw about world-up first, then pitch — a turret, not a gimbal
    scene.add(ballista.root);

    /* Decorative only — no physics body, not in `blocks[]`, invisible to
       auditLevels()/auditReach(). Baked hero models (see js/models.js, Part
       D); stand beside each wheel, facing -Z like the ballista itself. */
    guardDecor = A.buildModel('guard-spear', css('guard'), 'guard');
    if (guardDecor) { guardDecor.position.set(1.5, 0, 0.6); scene.add(guardDecor); }
    guardDecor2 = A.buildModel('guard-halberd', css('guard'), 'guard');
    if (guardDecor2) { guardDecor2.position.set(-1.5, 0, 0.6); scene.add(guardDecor2); }

    buildAimPreview();
  }

  /* ── Aim preview: the arm, a dotted flight path, and a ground reticle ──────
   * "The dots never lie" (see traceShot()'s header) used to mean only the
   * narrated outcome; this is the same trace made visible in the view the
   * player is actually watching, not just the minimap (js/ui.js) or the
   * footer text. Built once and repositioned rather than rebuilt, since
   * updatePreview() in js/ui.js calls in fairly often while a meter moves.
   */
  const PREVIEW_DOTS = 10;
  let previewGroup = null, previewDots = [], previewRing = null, previewMat = null;

  function buildAimPreview() {
    previewMat = new THREE.MeshBasicMaterial({ color: css('focus'), depthTest: false });
    previewGroup = new THREE.Group();
    previewGroup.visible = false;

    const dotGeo = new THREE.SphereGeometry(0.08, 8, 6);
    for (let i = 0; i < PREVIEW_DOTS; i++) {
      const dot = new THREE.Mesh(dotGeo, previewMat);
      dot.castShadow = false;
      previewDots.push(dot);
      previewGroup.add(dot);
    }

    const ringGeo = new THREE.RingGeometry(0.32, 0.5, 24);
    previewRing = new THREE.Mesh(ringGeo, previewMat);
    previewRing.rotation.x = -Math.PI / 2;   // lies flat on the ground
    previewGroup.add(previewRing);

    scene.add(previewGroup);
  }

  /** Repaints the arm/dots/reticle to match one trace (the exact object
   *  js/ui.js's updatePreview() just computed via traceShot()), or hides
   *  everything when there's nothing to show. Also points the ballista's
   *  arm at the shot — cosmetic, but "the arm points where you're about to
   *  fire" is the single biggest legibility win available here for free,
   *  since traceShot() already solves the elevation this needs. */
  function updateAimPreview(trace) {
    if (!previewGroup) return;
    if (!trace || CAM.phase !== 'AIM') { previewGroup.visible = false; return; }
    previewGroup.visible = true;

    const pts = trace.points;
    for (let i = 0; i < PREVIEW_DOTS; i++) {
      const t = i / (PREVIEW_DOTS - 1);
      const idx = Math.min(pts.length - 1, Math.round(t * (pts.length - 1)));
      previewDots[i].position.copy(pts[idx]);
    }
    const last = pts[pts.length - 1];
    previewRing.position.set(last.x, CFG.GROUND_Y + 0.03, last.z);

    if (ballista) {
      ballista.pivot.rotation.y = -trace.yaw;
      ballista.pivot.rotation.x = trace.elevation;
    }
  }

  /* ── Blocks ───────────────────────────────────────────────────────────────
   * Ties one Ammo body to one Three.js mesh — loadLevel() below is what
   * calls this once per parsed block spec from RT.levels.parseLevel().
   */
  function spawnBlock(matId, x, y, z, w, h, d) {
    const mat = D.MAT[matId];
    const color = css(mat.css.replace('--', ''));
    const mesh = A.buildBlock(w, h, d, color, { glow: !!mat.crown, shape: mat.shape });
    mesh.position.set(x, y, z);
    scene.add(mesh);

    const mass = mat.static ? 0 : w * h * d;   // mass ∝ volume, per the plan
    const body = P.addBlock(x, y, z, w, h, d, mass);

    const rec = {
      mesh: mesh, body: body, mat: mat, alive: true,
      half: new THREE.Vector3(w / 2, h / 2, d / 2),
      hp: mat.hp
    };
    blocks.push(rec);
    return rec;
  }

  /** Frees a mesh's own geometry and its ink-outline child's geometry.
   *  Materials are cached and shared (see art.js's paper()/glow()), so they
   *  outlive any one block and are never disposed here. */
  function disposeBlockMesh(mesh) {
    mesh.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }

  /* ── Audio ────────────────────────────────────────────────────────────────
   * Sound is never load-bearing: every call goes through these two helpers so
   * a missing or broken js/audio.js can only ever cost noise, never gameplay.
   */

  /** Set while the boot audits run. They fire real test shots that genuinely
   *  destroy blocks and can win a level — none of which the player should
   *  hear, any more than the save file should record it. */
  let auditing = false;

  const _panV = new THREE.Vector3();
  /** Where a world point sits across the screen, -1 (hard left) to 1 (hard
   *  right), so an impact arrives in the ear it happened on. Points behind the
   *  camera project with a flipped sign, so those fall back to centre rather
   *  than being confidently wrong. */
  function panFor(pos) {
    if (!camera || !pos) return 0;
    _panV.copy(pos).project(camera);
    if (!isFinite(_panV.x) || _panV.z > 1) return 0;
    return U.clamp(_panV.x, -1, 1);
  }

  function sfx(fn, a, b, c) {
    if (auditing || !AU) return;
    try { AU[fn](a, b, c); } catch (e) { /* audio is never load-bearing */ }
  }

  /** Points for a kill are 500 for a crown, 100 for anything else — ported
   *  from the 2D version's damageBlock(), folded in here since every kill
   *  (a direct hit via applyHit(), or collateral via
   *  stepPhysicsWithImpacts()) already funnels through this one function.
   *  Destruction audio funnels through here for the same reason: a crown
   *  toppled by collateral collapse has to sound exactly as final as one
   *  shot off its perch. */
  function destroyBlockRec(b) {
    if (!b.alive) return;
    b.alive = false;
    levelScore += b.mat.crown ? 500 : 100;
    sfx('destroy', b.mat, b._lastHitSpeed || 24, panFor(b.mesh.position));
    /* A powder keg's own death is an explosion, wired through the same
       applySplash() the Powder Bomb ammo uses. Runs before the mesh/body
       teardown below so impactPos still has somewhere to read a position
       from; a keg's blast can chain into a neighbouring keg (applySplash
       excludes only the primary block, so a second keg dies and calls back
       in here), which is the chain-reaction spectacle, not a bug. */
    if (b.mat.explodes) applySplash(D.KEG_BLAST, b.mesh.position, b);
    wakeBlocksAbove(b);
    scene.remove(b.mesh);
    disposeBlockMesh(b.mesh);
    P.destroyBlock(b.body);
  }

  const _wakeBox = new THREE.Box3(), _wakeOtherBox = new THREE.Box3();
  /** See physics.js's wake() for why this exists at all: removing a body
   *  from the world wakes nothing resting on it, so without this, anything
   *  asleep on top of a block that just died would float in place forever
   *  with nothing underneath it. Same geometric "resting directly on top
   *  of" test as applyCrush() below, just to wake rather than to damage —
   *  real gravity, not this function, decides whether it actually falls.
   *  Own scratch Box3s, not shared with applyCrush()'s, since this runs from
   *  inside destroyBlockRec() and applyCrush() can itself call
   *  destroyBlockRec() (a crushed block dying) while its own scratch boxes
   *  are still in use partway through its loop. */
  function wakeBlocksAbove(b) {
    _wakeBox.setFromObject(b.mesh);
    for (const other of blocks) {
      if (!other.alive || other === b || other.mat.static) continue;
      _wakeOtherBox.setFromObject(other.mesh);
      const xzOverlap = _wakeBox.max.x > _wakeOtherBox.min.x && _wakeBox.min.x < _wakeOtherBox.max.x &&
                         _wakeBox.max.z > _wakeOtherBox.min.z && _wakeBox.min.z < _wakeOtherBox.max.z;
      if (!xzOverlap) continue;
      const gap = _wakeOtherBox.min.y - _wakeBox.max.y;
      if (gap < -0.05 || gap > 0.1) continue;   // resting ON b, not through or beside it
      P.wake(other.body);
    }
  }

  /**
   * Tears down every block of whatever level is currently live. Loading a
   * new level (or replaying this one) always goes through here first —
   * this has to remove each mesh from the scene and dispose its geometry
   * itself, the same as destroyBlockRec() above, or every level swap leaks
   * one level's worth of draw calls forever (caught by RT.perf() climbing
   * well past its budget after cycling through a handful of levels).
   */
  function clearBlocks() {
    for (const b of blocks) {
      if (!b.alive) continue;
      scene.remove(b.mesh);
      disposeBlockMesh(b.mesh);
      P.destroyBlock(b.body);
    }
    blocks = [];
  }

  /**
   * Loads level `ix` from RT.levels.LEVELS: tears down whatever castle is
   * live, parses the new one's stacked ASCII layers, and spawns every
   * resulting block spec. The parser (js/levels.js) already did the row/
   * depth merge and the world-unit placement math — this is just the
   * spawn loop, identical in shape to the old hand-built test castle it
   * replaces.
   */
  function loadLevel(ix) {
    clearBlocks();
    for (const s of shots) scene.remove(s.mesh);
    shots = [];
    levelWon = false;
    boltsUsed = 0;
    levelScore = 0;
    lastResult = null;
    resetAmmoLeft();

    levelIx = ((ix % LV.LEVELS.length) + LV.LEVELS.length) % LV.LEVELS.length;
    liveLevel = LV.LEVELS[levelIx];
    const parsed = LV.parseLevel(liveLevel);
    for (const b of parsed.blocks) spawnBlock(b.matId, b.x, b.y, b.z, b.w, b.h, b.d);

    AIM_LOOKAT.z = -liveLevel.dist;
    if (world) W.recenterShadow(world, liveLevel.dist);
  }

  /* ── Boot-time audits ─────────────────────────────────────────────────────
   * Replace the two checks the old README asked a human to do by eye —
   * "it must stand up" and "it must be reachable" — with assertions run
   * once at boot, throwing loudly if a level fails either one. Both need
   * real physics steps (unlike a purely data-driven audit like FishMaster's
   * auditMissions()), so they run from inside physics init's callback
   * rather than synchronously from init() — see runBootAudits() below for
   * how a failure still gets surfaced despite that.
   */

  /** Every castle stands unaided: build it, step ~4 simulated seconds, and
   *  check no crown drifted and nothing is still awake. Reuses loadLevel()
   *  itself, so this is exercising the exact path the player's first look
   *  at each level goes through, not a parallel code path. */
  function auditLevels() {
    const wasAuditing = auditing;
    auditing = true;              // settling twelve castles is not a thing to hear
    try {
      auditLevelsInner();
    } finally {
      auditing = wasAuditing;
    }
  }

  function auditLevelsInner() {
    const steps = Math.ceil(4 / CFG.DT);
    for (let ix = 0; ix < LV.LEVELS.length; ix++) {
      loadLevel(ix);
      const name = LV.LEVELS[ix].name;
      const before = blocks.filter((b) => b.mat.crown).map((b) => b.mesh.position.clone());
      for (let i = 0; i < steps; i++) stepPhysicsWithImpacts(CFG.DT);
      const after = blocks.filter((b) => b.mat.crown);
      if (after.length !== before.length) {
        throw new Error(`auditLevels: "${name}" lost a crown just from standing (${before.length} -> ${after.length})`);
      }
      for (let i = 0; i < after.length; i++) {
        const moved = after[i].mesh.position.distanceTo(before[i]);
        if (moved > 0.05) {
          throw new Error(`auditLevels: "${name}" crown ${i} moved ${moved.toFixed(3)} units while settling — it doesn't stand on its own`);
        }
      }
      const awake = blocks.some((b) => b.alive && !b.mat.static && P.isAwake(b.body));
      if (awake) throw new Error(`auditLevels: "${name}" never settled to sleep within ${steps} steps`);
    }
  }

  /**
   * Every crown is DESTROYABLE — not necessarily hittable. A crown is a
   * legitimate target while fully obscured behind another layer; it only
   * has to be killable by *some* plan: a direct hit, collateral impact
   * damage from a collapsing neighbour, or fall damage once its support is
   * gone (see js/data.js's MAT.K — a crown is an ordinary dynamic body with
   * hp, so stepPhysicsWithImpacts()'s existing before/after speed check
   * already covers all three at runtime; this audit just has to actually
   * simulate a shot to see it, not assume "no direct hit" means "no plan").
   *
   * Tier 1 is the old cheap check — a deterministic traceShot() with no
   * physics, tried first since most crowns still are directly hittable and
   * it costs almost nothing. Only a crown tier 1 can't reach falls through
   * to tier 2: fire a real candidate shot (js/game.js's actual fire()) into
   * a freshly reloaded castle and step real physics forward, watching that
   * one crown specifically, so an obscured crown gets to prove itself the
   * same way a player firing at it for real would. Tier 2's grid is coarser
   * than tier 1's — each sample costs a full simulated settle, not one
   * cheap trace — and every candidate bails the instant the crown dies
   * rather than running the full settle window to the end.
   */
  function auditReach() {
    const wasAuditing = auditing;
    auditing = true;              // tier 2 fires real shots; none of them are heard
    try {
      auditReachInner();
    } finally {
      auditing = wasAuditing;
    }
  }

  function auditReachInner() {
    const YAW_STEPS = 6, RANGE_STEPS = 8;
    for (let ix = 0; ix < LV.LEVELS.length; ix++) {
      loadLevel(ix);
      const lvl = LV.LEVELS[ix];
      const name = lvl.name;
      const yawHalfDeg = D.yawLimit(lvl) * 180 / Math.PI;
      const crownCount = blocks.filter((b) => b.mat.crown).length;

      // Tier 2 reloads the level (and rebuilds every block, crown included)
      // per candidate it tries, which invalidates any earlier crown
      // reference — so each crown index gets its OWN fresh, untouched
      // loadLevel() right before it's checked, rather than sharing one load
      // across the whole level the way tier 1 alone used to.
      for (let ci = 0; ci < crownCount; ci++) {
        loadLevel(ix);
        const crown = blocks.filter((b) => b.mat.crown)[ci];
        let hitOk = false;
        for (const ammo of D.AMMO) {
          for (let yi = 0; yi <= YAW_STEPS && !hitOk; yi++) {
            const yawDeg = -yawHalfDeg + (2 * yawHalfDeg) * yi / YAW_STEPS;
            const yawRad = yawDeg * Math.PI / 180;
            for (let ri = 0; ri <= RANGE_STEPS; ri++) {
              const rangePct = 100 * ri / RANGE_STEPS;
              const trace = traceShot(ammo, yawRad, rangePct, lvl);
              if (trace && trace.hit.type === 'block' && trace.hit.block === crown) { hitOk = true; break; }
            }
          }
          if (hitOk) break;
        }

        if (!hitOk) hitOk = crownDestroyableBySimulation(ix, ci, yawHalfDeg);
        if (!hitOk) {
          throw new Error(`auditReach: "${name}" has a crown nothing in the sampled window can destroy — `
            + 'not by a direct hit, and not by collapse/fall damage from any candidate shot either');
        }
      }
    }
  }

  const SIM_YAW_STEPS = 4, SIM_RANGE_STEPS = 6, SIM_SECONDS = 6;
  /** Tier 2 of auditReach() above: actually fires candidate shots (via the
   *  real fire() pipeline) at a fresh copy of level `ix` and lets physics
   *  run forward, checking whether crown index `crownIx` (stable within one
   *  loadLevel() call, since nothing has been destroyed yet at the moment
   *  it's captured) dies — directly, or as collateral, or by falling.
   *  Bails out of a candidate the instant the crown dies rather than
   *  running the rest of its settle window. */
  function crownDestroyableBySimulation(ix, crownIx, yawHalfDeg) {
    const maxSteps = Math.ceil(SIM_SECONDS / CFG.DT);
    for (const ammo of D.AMMO) {
      for (let yi = 0; yi <= SIM_YAW_STEPS; yi++) {
        const yawDeg = -yawHalfDeg + (2 * yawHalfDeg) * yi / SIM_YAW_STEPS;
        const yawRad = yawDeg * Math.PI / 180;
        for (let ri = 0; ri <= SIM_RANGE_STEPS; ri++) {
          const rangePct = 100 * ri / SIM_RANGE_STEPS;
          loadLevel(ix);
          const target = blocks.filter((b) => b.mat.crown)[crownIx];
          if (!target || !fire(ammo, yawRad, rangePct)) continue;
          for (let i = 0; i < maxSteps; i++) {
            stepPhysicsWithImpacts(CFG.DT);
            updateShots(CFG.DT);
            if (!target.alive) return true;
          }
        }
      }
    }
    return false;
  }

  /** Runs both audits (each leaves the last level it built live in the
   *  scene) and, once both pass, resumes at the furthest level the save
   *  file has reached. A failure throws synchronously to the caller — see
   *  loadAttract() for how that gets surfaced instead of just hanging
   *  silently. */
  function runBootAudits() {
    // auditReach()'s simulated tier fires real test shots (see below) which
    // can legitimately win a level and touch `save` — snapshot/restore it so
    // none of that leaks into the player's actual progress, win or throw.
    // (Silence is handled by the audits themselves — each sets `auditing`, so
    // calling one on its own from the console is just as quiet as booting.)
    const saveSnapshot = JSON.parse(JSON.stringify(save));
    suppressSaveWrites = true;
    try {
      auditLevels();
      auditReach();
    } finally {
      suppressSaveWrites = false;
      save = saveSnapshot;
    }
    loadLevel(save.level);
  }

  /* ── Shot pipeline ──────────────────────────────────────────────────────
   * Bolts are hand-integrated (constant gravity, straight-line steps), never
   * Ammo bodies — see the plan's "Projectile" section. That means the whole
   * flight is deterministic given the launch state, so it's computed once,
   * in full, at fire time (traceShot()) rather than stepped incrementally;
   * updateShots() just plays that precomputed path back over time and
   * resolves the hit when playback reaches the end. The live shot and the
   * aim-time preview call the exact same traceShot() — "the dots never
   * lie" because there is only one function that can lie.
   */

  /** Oriented-box hit test against a block's *rendered* transform (not the
   *  raw Ammo body) — so a hit always matches what's on screen, including a
   *  block that's already toppling from an earlier hit this shot. */
  const _hitLocal = new THREE.Vector3();
  const _hitInvQuat = new THREE.Quaternion();
  function findHitBlock(point, r) {
    for (const b of blocks) {
      if (!b.alive) continue;
      _hitInvQuat.copy(b.mesh.quaternion).invert();
      _hitLocal.copy(point).sub(b.mesh.position).applyQuaternion(_hitInvQuat);
      if (Math.abs(_hitLocal.x) < b.half.x + r &&
          Math.abs(_hitLocal.y) < b.half.y + r &&
          Math.abs(_hitLocal.z) < b.half.z + r) {
        return b;
      }
    }
    return null;
  }

  const OUT_OF_BOUNDS_Z_FAR = -80, OUT_OF_BOUNDS_Z_NEAR = 20, OUT_OF_BOUNDS_X = 60;

  /**
   * Full deterministic flight for one shot, from muzzle to first contact
   * (or the ground, or flying off the field). Pure — spawns nothing, does
   * no damage. `level` defaults to whatever level is actually live, so
   * preview calls from js/ui.js don't need to track that themselves.
   */
  function traceShot(ammo, yawRad, rangePct, level) {
    const launch = D.launchFor(ammo, level || liveLevel, yawRad, rangePct);
    if (!launch) return null;

    const pos = new THREE.Vector3(launch.pos.x, launch.pos.y, launch.pos.z);
    const vel = new THREE.Vector3(launch.vel.x, launch.vel.y, launch.vel.z);
    const dt = CFG.DT;
    const points = [pos.clone()];
    let hit = { type: 'none' };

    const maxSteps = Math.ceil(6 / dt);
    for (let i = 0; i < maxSteps; i++) {
      vel.y -= CFG.GRAVITY * dt;
      pos.addScaledVector(vel, dt);
      points.push(pos.clone());

      const b = findHitBlock(pos, ammo.r);
      if (b) { hit = { type: 'block', block: b }; break; }
      if (pos.y <= CFG.GROUND_Y + 0.02) { hit = { type: 'ground' }; break; }
      if (Math.abs(pos.x) > OUT_OF_BOUNDS_X || pos.z < OUT_OF_BOUNDS_Z_FAR || pos.z > OUT_OF_BOUNDS_Z_NEAR) break;
    }
    return {
      points: points, hit: hit, ammo: ammo, impactVel: vel.clone(),
      yaw: yawRad, elevation: launch.elevation   // for the aim-preview arm/reticle, see updateAimPreview()
    };
  }

  /** Fires for real: traces the shot, spawns the bolt mesh, and queues it
   *  for updateShots() to play back and resolve. Returns the trace (same
   *  shape the preview uses) so ui.js can narrate the outcome immediately —
   *  the outcome is already fully determined, only the *watching* of it
   *  takes time. Returns null (and spends nothing) if this ammo is out for
   *  the level — js/ui.js already refuses to lock a depleted ammo in at
   *  commit time, so this is a backstop, not the primary gate. */
  function fire(ammo, yawRad, rangePct) {
    if (ammoRemaining(ammo) <= 0) return null;
    const trace = traceShot(ammo, yawRad, rangePct);
    if (!trace) return null;
    boltsUsed++;
    if (ammo.limit != null) ammoLeft[ammo.id] = ammoRemaining(ammo) - 1;
    const mesh = A.buildBolt(ammo.r);
    mesh.position.copy(trace.points[0]);
    scene.add(mesh);
    shots.push({ mesh: mesh, trace: trace, t: 0, resolved: false });
    sfx('fireShot', ammo);
    sfx('startFlight');
    CAM.phase = 'FLIGHT';
    return trace;
  }

  function applyHit(b, ammo, impactVel, impactPos) {
    if (!b.alive) return;
    const dmg = D.damageFor(ammo, b.mat);
    const speed = impactVel ? impactVel.length() : 24;
    b._lastHitSpeed = speed;
    /* The hit itself. If this kills the block, destroyBlockRec() adds the
       heavier kill layer on top a few lines down. */
    sfx('impact', b.mat, speed, panFor(impactPos || b.mesh.position));
    b.hp -= dmg;
    if (!b.mat.static) {
      P.addVelocity(b.body, impactVel.x * CFG.KNOCK_SCALE, impactVel.y * CFG.KNOCK_SCALE, impactVel.z * CFG.KNOCK_SCALE);
    }
    if (b.hp <= 0) destroyBlockRec(b);
    if (ammo.splash && impactPos) applySplash(ammo, impactPos, b);
    checkWin();
  }

  const _splashDir = new THREE.Vector3();
  /** Area damage around a splash ammo's direct hit — everything alive within
   *  `splashRadius` of the impact (the primary block excluded, it already
   *  took a full direct hit above) takes falloff-scaled damage and a knock
   *  away from the blast centre. Distance is measured to each block's centre
   *  rather than a real explosion-vs-box overlap test, which is plenty for
   *  a block grid this coarse. */
  function applySplash(ammo, impactPos, primaryBlock) {
    const radius = ammo.splashRadius || 0;
    if (radius <= 0) return;
    for (const other of blocks) {
      if (!other.alive || other === primaryBlock) continue;
      const dist = other.mesh.position.distanceTo(impactPos);
      if (dist > radius) continue;
      const falloff = 1 - dist / radius;
      /* Blast-driven hits are quieter than a direct strike and there can be a
         lot of them at once, so they lean on audio.js's voice cap to fold the
         tail of the ring into one rumble rather than a burst of clicks. */
      other._lastHitSpeed = ammo.speed * falloff;
      sfx('impact', other.mat, ammo.speed * falloff, panFor(other.mesh.position));
      other.hp -= D.damageFor(ammo, other.mat) * (ammo.splashDmgScale || 1) * falloff;
      if (!other.mat.static) {
        _splashDir.subVectors(other.mesh.position, impactPos).normalize();
        const kick = ammo.speed * CFG.KNOCK_SCALE * falloff;
        P.addVelocity(other.body, _splashDir.x * kick, _splashDir.y * kick + kick * 0.4, _splashDir.z * kick);
      }
      if (other.hp <= 0) destroyBlockRec(other);
    }
  }

  function checkWin() {
    if (levelWon) return;
    if (!blocks.some((b) => b.alive && b.mat.crown)) {
      levelWon = true;
      finishLevel();
    }
  }

  /** Stars/score/unlock, computed once the instant the last crown dies —
   *  not deferred to whenever the results overlay happens to open, so nothing
   *  is lost if that transition is ever interrupted. Formula ported from the
   *  2D version's levelComplete(). */
  function finishLevel() {
    const par = liveLevel.par;
    const stars = boltsUsed <= par ? 3 : (boltsUsed <= par + 2 ? 2 : 1);
    const bonus = save.endlessBolts ? 0 : Math.max(0, liveLevel.bolts - boltsUsed) * 150;
    const earned = levelScore + bonus;

    save.totalScore += earned;
    const prevStars = save.stars[levelIx] || 0;
    if (stars > prevStars) save.stars[levelIx] = stars;
    const nextIx = levelIx + 1;
    if (nextIx < LV.LEVELS.length && save.level < nextIx) save.level = nextIx;
    const newAmmo = D.AMMO.find((a) => a.unlockAt === save.level && a.unlockAt !== 0);
    persistSave();

    lastResult = { stars: stars, earned: earned, bonus: bonus, newAmmo: newAmmo || null };
    // Not spoken here — js/ui.js announces it once the results overlay
    // actually opens (after the SETTLE/RESULTS camera hold plays out), not
    // the instant the crown dies mid-cinematic.
  }

  /** What comes after a shot's cinematic (or its immediate miss) finishes:
   *  the results overlay on a win, the out-of-bolts overlay if this was the
   *  last bolt and Endless Bolts is off, or straight back to aiming. Shared
   *  by the clean-miss branch in updateShots() and the RESULTS timeout in
   *  update() below, so the two paths can't drift apart on this check. */
  function advanceAfterShot() {
    if (levelWon) {
      CAM.phase = 'RESULTS_MENU';
    } else if (!save.endlessBolts && boltsUsed >= liveLevel.bolts) {
      CAM.phase = 'OUTOFBOLTS';
    } else {
      CAM.phase = 'AIM';
    }
  }

  function updateShots(dt) {
    if (!shots.length) return;
    const dtStep = CFG.DT;
    for (const s of shots) {
      if (s.resolved) continue;
      s.t += dt;
      const idx = Math.min(s.trace.points.length - 1, Math.floor(s.t / dtStep));
      s.mesh.position.copy(s.trace.points[idx]);
      /* Whoosh follows the bolt: pitch from how fast it is actually moving
         along the traced path, stereo position from where it is on screen. */
      if (idx > 0) {
        const step = s.trace.points[idx].distanceTo(s.trace.points[idx - 1]) / dtStep;
        sfx('updateFlight', U.clamp(step / 45, 0, 1), panFor(s.mesh.position));
      }
      if (idx >= s.trace.points.length - 1) {
        s.resolved = true;
        sfx('stopFlight');
        scene.remove(s.mesh);
        if (s.trace.hit.type === 'block') {
          const impactPos = s.trace.points[s.trace.points.length - 1];
          applyHit(s.trace.hit.block, s.trace.ammo, s.trace.impactVel, impactPos);
          beginImpact(impactPos, s.trace.impactVel);
        } else {
          /* A clean miss still landed somewhere — a dull thud into the dirt,
             so "nothing happened" is never silent. */
          sfx('noise', 0.22, { freq: 380, freqTo: 60, vol: 0.13,
                               pan: panFor(s.trace.points[s.trace.points.length - 1]) });
          advanceAfterShot();   // a clean miss has nothing worth a cinematic cut for, but bolts still ran out
        }
      }
    }
    shots = shots.filter((s) => !s.resolved);
  }

  /**
   * One physics step, plus the collateral damage that comes with it: blocks
   * smashing into each other during a collapse, detected as a before/after
   * speed check rather than an Ammo contact listener — ported from the 2D
   * version's stepWorld(). "This block just got stopped hard" is exactly
   * what a sudden loss of speed means, whether that's landing or crashing
   * into a neighbour.
   */
  function stepPhysicsWithImpacts(dt) {
    for (const b of blocks) {
      if (b.alive && !b.mat.static) b._peakSpeed = Math.max(b._peakSpeed || 0, P.speed(b.body));
    }
    P.step(dt);
    for (const b of blocks) {
      if (!b.alive) continue;
      P.sync(b.mesh, b.body);
      if (b.mat.static) continue;
      const cur = P.speed(b.body);
      /* Peak-since-last-rest, evaluated once the block is actually settled
         (below SLEEP_LINEAR), not frame-to-frame: Bullet's own contact
         resolution spreads a hard stop's deceleration across several frames
         (a multi-unit fall measurably lands over ~10+ frames, not one), so
         comparing consecutive frames — or even resetting the peak the first
         frame a drop crosses the threshold — only ever catches a fragment of
         the real fall, never the whole energy lost. Waiting for it to settle
         and comparing against the PEAK it actually reached is what makes "a
         crown falls far enough to die" (see [[ballista-3d-rework]]) an event
         that can actually fire. */
      const peak = b._peakSpeed || 0;
      if (peak > CFG.IMPACT_THRESHOLD && cur < CFG.SLEEP_LINEAR && !b._peakResolved) {
        const drop = peak - cur;
        /* This is where a collapse gets its sound. Every block stopped hard
           this step is one impact; audio.js voices the loudest few and sums
           the rest into a rumble, which is what a wall coming down actually
           sounds like. */
        b._lastHitSpeed = drop;
        sfx('impact', b.mat, drop, panFor(b.mesh.position));
        b.hp -= (drop - CFG.IMPACT_THRESHOLD) * CFG.IMPACT_DMG_SCALE;
        applyCrush(b, drop);
        b._peakResolved = true;
        if (b.hp <= 0) destroyBlockRec(b);
      }
      if (cur > peak) {
        b._peakSpeed = cur;
        b._peakResolved = false;   // a fresh fall — allow this one to register too
      }
    }
    checkWin();
  }

  const _crushBox = new THREE.Box3(), _otherBox = new THREE.Box3();
  /** A hard-landing block (see stepPhysicsWithImpacts() above) doesn't just
   *  hurt itself — it hurts whatever it's now resting directly on top of, so
   *  a support knocked out from under a heavy span genuinely crushes what
   *  the span comes down on, rather than just thudding to a stop on its own
   *  account. Geometric, not a contact listener: real XZ footprint overlap
   *  plus `b`'s bottom sitting at (not through, not beside) `other`'s top,
   *  a tight tolerance so this never fires for two blocks merely standing
   *  side by side. Distinct from applySplash() (an explosion's outward area
   *  damage) and from the plain self-damage above — this is a third, purely
   *  vertical damage path. */
  function applyCrush(b, drop) {
    const crushDmg = (drop - CFG.IMPACT_THRESHOLD) * CFG.CRUSH_DMG_SCALE;
    _crushBox.setFromObject(b.mesh);
    for (const other of blocks) {
      if (!other.alive || other === b) continue;
      _otherBox.setFromObject(other.mesh);
      const xzOverlap = _crushBox.max.x > _otherBox.min.x && _crushBox.min.x < _otherBox.max.x &&
                         _crushBox.max.z > _otherBox.min.z && _crushBox.min.z < _otherBox.max.z;
      if (!xzOverlap) continue;
      const gap = _crushBox.min.y - _otherBox.max.y;
      if (gap < -0.05 || gap > 0.1) continue;  // resting ON other, not through or beside it
      other._lastHitSpeed = drop;
      sfx('impact', other.mat, drop, panFor(other.mesh.position));
      other.hp -= crushDmg;
      if (!other.mat.static) P.addVelocity(other.body, 0, -drop * 0.15, 0);
      if (other.hp <= 0) destroyBlockRec(other);
    }
  }

  /**
   * Call after a theme change (settings menu) to repaint the live scene.
   *
   * Repainting is not optional and it is not just the sky: a mesh keeps
   * whatever material it was handed when it was built, so switching profile
   * used to leave every block, and the ballista itself, painted in the
   * *previous* profile's colours — only the sky, ground and aim preview
   * followed. High Contrast made that impossible to miss, since the profile
   * changes the material class as well as the colours.
   */
  function onThemeChanged() {
    if (!world) return;
    refreshPalette();
    applyProfileToArt();
    W.refresh(world, worldPalette(), scene);
    repaintBlocks();
    if (ballista) A.repaint(ballista.root, { wood: css('wood'), steel: css('steel') });
    if (guardDecor) A.repaint(guardDecor, { guard: css('guard') });
    if (guardDecor2) A.repaint(guardDecor2, { guard: css('guard') });
    if (previewMat) previewMat.color.set(css('focus'));
  }

  /** Hand every live block a material from the current palette. Same colour
   *  lookup spawnBlock() uses, so a repainted castle and a freshly built one
   *  can't disagree. */
  function repaintBlocks() {
    for (const b of blocks) {
      if (!b.alive) continue;
      const color = css(b.mat.css.replace('--', ''));
      b.mesh.material = b.mat.crown ? A.glow(color) : A.paper(color);
    }
  }

  function init(opts) {
    scene = opts.scene;
    camera = opts.camera;
    renderer = opts.renderer;
  }

  function loadAttract() {
    if (!save) loadSave();   // before ui.js's synchronous init() reads unlockedAmmo()/liveLevel
    // The saved profile has to be on the body BEFORE the world is built, or
    // the first frame is painted from the default palette and only corrects
    // itself on the next theme change.
    if (save.theme) document.body.setAttribute('data-theme', save.theme);
    if (!world) buildWorldAndBallista();
    if (!physicsReady) {
      // Ammo's module factory resolves asynchronously (see js/physics.js) —
      // the scene renders and the attract camera runs on its own in the
      // meantime; update() below simply doesn't step physics until this
      // resolves, so there's nothing to block on here.
      P.init().then(() => {
        physicsReady = true;
        try {
          runBootAudits();
        } catch (err) {
          // An unhandled rejection here would just look like a silent hang
          // — surface it the same way main.js's own frame-loop errors do,
          // then still throw so it also lands loudly in the console.
          console.error('Ballista boot audit failed:', err);
          const el = document.getElementById('loading');
          if (el) {
            el.style.display = 'flex';
            el.innerHTML = '<div style="max-width:640px;text-align:center;padding:24px;font-size:1.1rem">'
              + '<div style="font-size:2rem;margin-bottom:12px">\u{1F635} Level audit failed</div>'
              + '<div style="opacity:.8">' + String(err && err.message ? err.message : err) + '</div></div>';
          }
          throw err;
        }
        // No main menu yet (that's later polish) — go straight to aiming
        // against level 0 rather than orbiting forever.
        CAM.phase = 'AIM';
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

  /**
   * AIM never moves — everything the player judges a shot by is in a fixed
   * frame; all camera personality happens after Return is pressed. That is
   * what keeps the cinematics below from becoming an accessibility problem.
   */
  function updateAim() {
    camera.position.copy(AIM_POS);
    camera.lookAt(AIM_LOOKAT);
  }

  const _flightEye = new THREE.Vector3();
  function updateFlight(dt) {
    const s = shots[0];
    if (!s) return;
    const p = s.mesh.position;
    _flightEye.set(p.x, p.y + 2.2, p.z + 5);
    camera.position.lerp(_flightEye, Math.min(1, dt * 2.5));
    camera.lookAt(p.x, p.y, p.z);
  }

  /* ── Impact-seat scorer ───────────────────────────────────────────────────
   * Score candidate poses on a ring around the impact point and take the
   * best. Three rules, in order of how hard they are: never cross the aim
   * camera's 180 degree line (a cut to the far side reverses left and right,
   * which is genuinely disorienting — this one is load-bearing, not just a
   * preference); prefer a three-quarter view over dead side-on; prefer
   * seeing the most destructible mass still in play.
   */
  const SEAT_RADIUS = 4.5, SEAT_HEIGHT = 2.4, SEAT_STEPS = 8;
  const THREE_QUARTER_RAD = 60 * Math.PI / 180;

  const _segPoint = new THREE.Vector3();
  /** Cheap occlusion test — reuses the same oriented-box test the shot
   *  itself hits blocks with, rather than a real ray query, so a candidate
   *  seat is rejected if any surviving block sits between it and the
   *  impact point. */
  function segmentBlocked(from, to) {
    for (let t = 0.2; t <= 0.8; t += 0.2) {
      _segPoint.lerpVectors(from, to, t);
      if (findHitBlock(_segPoint, 0.15)) return true;
    }
    return false;
  }

  const _toBlock = new THREE.Vector3(), _viewDir = new THREE.Vector3();
  /** How much destructible mass a pose can actually see, weighted toward
   *  what's roughly in front of it and closer. A proxy for "the most
   *  soon-to-move mass" — the real thing would need a frame of sleep-state
   *  history per block to classify "about to move" precisely, which isn't
   *  worth the complexity yet at this block count. */
  function visibleDynamicMass(pos, lookAt) {
    _viewDir.subVectors(lookAt, pos).normalize();
    let total = 0;
    for (const b of blocks) {
      if (!b.alive || b.mat.static) continue;
      _toBlock.subVectors(b.mesh.position, pos);
      const dist = _toBlock.length();
      if (dist < 0.001) continue;
      _toBlock.divideScalar(dist);
      const facing = _toBlock.dot(_viewDir);
      if (facing < 0.3) continue;                    // behind or well off to the side
      const vol = b.half.x * b.half.y * b.half.z * 8;
      total += vol * facing / Math.max(1, dist * 0.3);
    }
    return total;
  }

  function pickImpactSeat(impactPoint) {
    const homeX = AIM_POS.x - impactPoint.x, homeZ = AIM_POS.z - impactPoint.z;
    const homeAngle = Math.atan2(homeZ, homeX);

    let best = null, bestScore = -Infinity;
    for (let i = 0; i <= SEAT_STEPS; i++) {
      const off = -Math.PI / 2 + (i / SEAT_STEPS) * Math.PI;     // stays within +-90 of home
      const angle = homeAngle + off;
      const pos = new THREE.Vector3(
        impactPoint.x + Math.cos(angle) * SEAT_RADIUS,
        impactPoint.y + SEAT_HEIGHT,
        impactPoint.z + Math.sin(angle) * SEAT_RADIUS
      );
      if (pos.y < CFG.GROUND_Y + 0.3) continue;
      if (segmentBlocked(pos, impactPoint)) continue;

      const threeQuarter = 1 - Math.abs(Math.abs(off) - THREE_QUARTER_RAD) / (Math.PI / 2);
      const score = threeQuarter * 3 + visibleDynamicMass(pos, impactPoint);
      if (score > bestScore) { bestScore = score; best = pos; }
    }
    return best || new THREE.Vector3(impactPoint.x, impactPoint.y + SEAT_HEIGHT, impactPoint.z + SEAT_RADIUS);
  }

  function beginImpact(impactPoint, impactVel) {
    CAM.impactPoint.copy(impactPoint);
    CAM.seatPos.copy(pickImpactSeat(impactPoint));
    CAM.phase = 'IMPACT';
    CAM.impactT = 0;
    CAM.shake = Math.max(CAM.shake, Math.min(1, (impactVel ? impactVel.length() : 20) / 30));
  }

  const IMPACT_HOLD_S = 0.25;
  const SETTLE_ORBIT_RAD_PER_S = 6 * Math.PI / 180;

  const _seatOffset = new THREE.Vector3();
  /** Camera at CAM.seatPos, optionally drifting around the impact point by
   *  `extraAngle` radians (the slow SETTLE orbit) — always looking at the
   *  impact point. */
  function positionAtSeat(extraAngle) {
    _seatOffset.subVectors(CAM.seatPos, CAM.impactPoint);
    if (extraAngle) {
      const cos = Math.cos(extraAngle), sin = Math.sin(extraAngle);
      const x = _seatOffset.x * cos - _seatOffset.z * sin;
      const z = _seatOffset.x * sin + _seatOffset.z * cos;
      _seatOffset.x = x; _seatOffset.z = z;
    }
    camera.position.copy(CAM.impactPoint).add(_seatOffset);
    camera.lookAt(CAM.impactPoint);
  }

  /** Scales with impact energy, zeroed under reduced motion or Steady
   *  Camera. Applied after whatever positioned the camera this frame, as a
   *  small additive jitter rather than a replacement. */
  function updateShake(dt) {
    CAM.shake = Math.max(0, CAM.shake - dt * 1.5);
    if (CAM.shake <= 0 || steadyCameraOn()) return;
    const s = CAM.shake * 0.12;
    camera.position.x += (Math.random() * 2 - 1) * s;
    camera.position.y += (Math.random() * 2 - 1) * s;
  }

  function update(dt) {
    /* Flushes whatever the impact voice cap folded into a rumble this frame.
       Called before the physics step so a rumble follows the collapse it came
       from rather than lagging a frame behind it. */
    sfx('tick', dt);
    if (physicsReady) {
      stepPhysicsWithImpacts(dt);
      updateShots(dt);
    }

    // The preview is only ever *shown* from updateAimPreview() (called by
    // js/ui.js whenever it recomputes a trace), but it has to be *hidden*
    // the instant the phase leaves AIM even if ui.js never calls in again —
    // e.g. the moment a shot fires and the camera cuts to FLIGHT.
    if (previewGroup && CAM.phase !== 'AIM') previewGroup.visible = false;

    if (CAM.phase === 'ATTRACT') {
      updateAttract(dt);
    } else if (CAM.phase === 'FLIGHT') {
      updateFlight(dt);
    } else if (CAM.phase === 'IMPACT') {
      CAM.impactT += dt;
      positionAtSeat(0);
      if (CAM.impactT > IMPACT_HOLD_S) { CAM.phase = 'SETTLE'; CAM.settleT = 0; }
    } else if (CAM.phase === 'SETTLE') {
      CAM.settleT += dt;
      positionAtSeat(CAM.settleT * SETTLE_ORBIT_RAD_PER_S);
      const stillMoving = blocks.some((b) => b.alive && !b.mat.static && P.isAwake(b.body));
      if ((!stillMoving && CAM.settleT > CFG.SETTLE_MIN) || CAM.settleT > CFG.SETTLE_MAX) {
        CAM.phase = 'RESULTS'; CAM.resultsT = 0;
      }
    } else if (CAM.phase === 'RESULTS') {
      CAM.resultsT += dt;
      positionAtSeat(CAM.settleT * SETTLE_ORBIT_RAD_PER_S);   // hold the SETTLE framing
      if (CAM.resultsT > CFG.WIN_PAUSE) advanceAfterShot();
    } else if (CAM.phase === 'RESULTS_MENU') {
      // js/ui.js owns input now (the results overlay) — keep holding the
      // same wrecked-castle framing underneath it until confirmResults()
      // moves on to the next level.
      positionAtSeat(CAM.settleT * SETTLE_ORBIT_RAD_PER_S);
    } else if (CAM.phase === 'OUTOFBOLTS') {
      // Usually reached from a clean miss, so there's no wreckage worth
      // holding a shot of — the out-of-bolts overlay just sits over the
      // ordinary aim framing.
      updateAim();
    } else if (CAM.phase === 'MENU') {
      // Player-invoked, always from AIM (see openMenu()) — same fixed
      // framing underneath, same as OUTOFBOLTS.
      updateAim();
    } else {
      CAM.phase = 'AIM';
      updateAim();
    }

    // One fixed wide view for every phase — still runs the state machine
    // above (so js/ui.js's input gate on CAM.phase === 'AIM' keeps working),
    // just overrides what gets rendered.
    if (steadyCameraOn()) updateAim();

    updateShake(dt);
  }

  /** Every ammo whose `unlockAt` is at or below the furthest level reached —
   *  same gate as the 2D version's unlockedAmmo(). */
  function unlockedAmmo() { return D.AMMO.filter((a) => a.unlockAt === 0 || save.level >= a.unlockAt); }
  function currentLevel() { return liveLevel; }

  /** Every crown still standing, in world x/z — js/ui.js's minimap marks
   *  these as objectives regardless of whether they're actually exposed to
   *  a direct shot right now (a crown can be a legitimate target while
   *  fully hidden behind another layer — see the splash/collateral damage
   *  path). */
  function crownPositions() {
    return blocks.filter((b) => b.alive && b.mat.crown).map((b) => ({ x: b.mesh.position.x, z: b.mesh.position.z }));
  }

  /** Select-target aim mode's scan list: every alive, non-static block —
   *  steel girders excluded, same "never breaks, go around it" reasoning as
   *  crownPositions() only ever mattering for the destructible ones. Sorted
   *  left-to-right by yaw so a player who already knows the sweep meter
   *  carries the same mental model over, distance as a tiebreaker for two
   *  blocks stacked in depth at the same angle. */
  function targetableBlocks() {
    return blocks
      .filter((b) => b.alive && !b.mat.static)
      .map((b) => ({ x: b.mesh.position.x, z: b.mesh.position.z, matId: b.mat.id, matName: b.mat.name, crown: !!b.mat.crown }))
      .sort((a, c) => Math.atan2(a.x, -a.z) - Math.atan2(c.x, -c.z) || (Math.hypot(a.x, a.z) - Math.hypot(c.x, c.z)));
  }

  /* ── Results / out-of-bolts overlays ──────────────────────────────────────
   * js/ui.js renders these (the #overlay markup already in index.html) and
   * calls back into whichever of these the player picks. Both just resolve
   * CAM.phase back to 'AIM', which is what lets js/ui.js's existing
   * canAct()-edge-detect (enterShot() on the phase becoming 'AIM') pick the
   * meters back up exactly like it does after any other cinematic.
   */
  function confirmResults() {
    loadLevel(levelIx + 1);
    CAM.phase = 'AIM';
  }
  function retryLevel() {
    loadLevel(levelIx);
    CAM.phase = 'AIM';
  }
  function enableEndlessAndContinue() {
    save.endlessBolts = true;
    persistSave();
    CAM.phase = 'AIM';   // same wreckage, no rebuild — just allowed to keep firing
  }

  /** The context/pause menu — a third overlay phase alongside RESULTS_MENU/
   *  OUTOFBOLTS, but player-invoked (Return-hold, or the header's Help/
   *  Settings buttons) rather than reached automatically, so it only opens
   *  from AIM rather than interrupting a cinematic. js/ui.js owns which
   *  *screen* within it is showing (root / how-to-play / settings) and
   *  renders all of them through the same #overlay/#panel list machinery. */
  function openMenu() { if (CAM.phase === 'AIM') CAM.phase = 'MENU'; }
  function closeMenu() { CAM.phase = 'AIM'; }

  function setMinimapSize(size) {
    if (['large', 'medium', 'none'].indexOf(size) === -1) return;
    save.minimapSize = size;
    persistSave();
  }
  function setSteadyCamera(on) { save.steadyCamera = !!on; persistSave(); }

  function aimModeOn() { return (save && save.aimMode) === 'target'; }
  function setAimMode(mode) { save.aimMode = mode === 'target' ? 'target' : 'sweep'; persistSave(); }

  /* ── Colour profile ───────────────────────────────────────────────────────
   * index.html has carried four full palettes since the step-2 rewrite, but
   * nothing ever set `data-theme` and nothing ever called onThemeChanged() —
   * so three of the four profiles, High Contrast included, were unreachable.
   * Same shape as FishMaster's getTheme()/setTheme() (game.js:2862 there),
   * which js/ui.js's Settings screen drives.
   */
  function getTheme() { return (save && save.theme) || 'ben'; }
  function setTheme(t) {
    save.theme = t;
    document.body.setAttribute('data-theme', t);
    onThemeChanged();
    persistSave();
  }
  function setEndlessBolts(on) { save.endlessBolts = !!on; persistSave(); }

  /**
   * Console-driven checks — no results panel or narration for a miss/hit
   * exists yet beyond the "Level cleared" line, so behaviour is verified by
   * hand: fire a shot, read back state, screenshot the outcome. See the
   * ballista-3d plan's verification section for how this gets driven from
   * outside the page via mcp__chrome-devtools__evaluate_script.
   */
  const __test = {
    blockCount() { return blocks.length; },
    blockSpeed(index) { const b = blocks[index]; return b && b.alive ? P.speed(b.body) : null; },
    blockState() {
      return blocks.map((b) => ({
        alive: b.alive, hp: b.hp, mat: b.mat.id,
        y: b.mesh.position.y, awake: b.alive ? P.isAwake(b.body) : null
      }));
    },
    knock(index, vx, vy, vz) {
      const b = blocks[index];
      if (!b || !b.alive) return false;
      P.addVelocity(b.body, vx || 0, vy || 0, vz || 0);
      return true;
    },
    fire(ammoIx, yawDeg, rangePct) {
      const ammo = unlockedAmmo()[ammoIx];
      if (!ammo) return null;
      const trace = fire(ammo, yawDeg * Math.PI / 180, rangePct);
      return trace && { hit: trace.hit.type, matHit: trace.hit.block ? trace.hit.block.mat.id : null };
    },
    shotCount() { return shots.length; },
    shotDebug() {
      return shots.map((s) => ({
        t: s.t, resolved: s.resolved, points: s.trace.points.length,
        pos: s.mesh ? s.mesh.position.toArray() : null, hit: s.trace.hit.type
      }));
    },
    crownsAlive() { return blocks.filter((b) => b.alive && b.mat.crown).length; },
    levelWon() { return levelWon; },
    rangeWindow() { return D.rangeWindow(liveLevel); },
    yawLimitDeg() { return D.yawLimit(liveLevel) * 180 / Math.PI; },
    rebuildCastle() { loadLevel(levelIx); },
    levelCount() { return LV.LEVELS.length; },
    levelIx() { return levelIx; },
    levelName() { return liveLevel ? liveLevel.name : null; },
    loadLevel(ix) { loadLevel(ix); },
    auditLevels, auditReach,
    crownDestroyableBySimulation(ix, crownIx) {
      return crownDestroyableBySimulation(ix, crownIx, D.yawLimit(LV.LEVELS[ix]) * 180 / Math.PI);
    },
    camState() {
      return {
        phase: CAM.phase, shake: CAM.shake,
        impactPoint: CAM.impactPoint.toArray(), seatPos: CAM.seatPos.toArray(),
        camPos: camera.position.toArray()
      };
    },
    isSteadyCamera() { return steadyCameraOn(); },
    setSteadyCamera(on) { setSteadyCamera(on); },
    isReducedMotion() { return REDUCED_MOTION; },
    boltsUsed() { return boltsUsed; },
    levelScore() { return levelScore; },
    save() { return save; },
    lastResult() { return lastResult; },
    ammoLeft() { return Object.assign({}, ammoLeft); },
    /** Diagnostic, not a real audit: world-space AABB overlap between every
     *  pair of alive blocks, shrunk by `epsilon` first so flush resting
     *  contact doesn't count — only genuine interpenetration does. Used to
     *  sanity-check that real multi-layer levels aren't visibly clipping. */
    checkOverlaps(epsilon) {
      const eps = epsilon === undefined ? 0.03 : epsilon;
      const boxes = blocks.filter((b) => b.alive).map((b) => ({
        b: b, box: new THREE.Box3().setFromObject(b.mesh).expandByScalar(-eps)
      }));
      const overlaps = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          if (boxes[i].box.intersectsBox(boxes[j].box)) {
            overlaps.push({
              a: { mat: boxes[i].b.mat.id, pos: boxes[i].b.mesh.position.toArray() },
              b: { mat: boxes[j].b.mat.id, pos: boxes[j].b.mesh.position.toArray() }
            });
          }
        }
      }
      return overlaps;
    },
    pivotRotation() { return ballista ? { y: ballista.pivot.rotation.y, x: ballista.pivot.rotation.x } : null; },
    previewVisible() { return previewGroup ? previewGroup.visible : null; },
    previewDotCount() { return previewDots.length; },
    previewRingPos() { return previewRing ? previewRing.position.toArray() : null; },
    setEndlessBolts(on) { setEndlessBolts(on); },
    resetSave() { save = defaultSave(); persistSave(); }
  };

  return {
    init, loadAttract, update,
    onThemeChanged, isFlat,
    unlockedAmmo, ammoRemaining, currentLevel, crownPositions, targetableBlocks, fire, traceShot, updateAimPreview,
    confirmResults, retryLevel, enableEndlessAndContinue,
    openMenu, closeMenu, setMinimapSize, setSteadyCamera, setEndlessBolts, steadyCameraOn,
    getTheme, setTheme, aimModeOn, setAimMode,
    get CAM() { return CAM; },
    get levelIx() { return levelIx; },
    get lastResult() { return lastResult; },
    get boltsUsed() { return boltsUsed; },
    get levelScore() { return levelScore; },
    get save() { return save; },
    __test: __test
  };
})();
