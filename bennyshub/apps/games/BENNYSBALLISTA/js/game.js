/**
 * Benny's Ballista — game state and camera director.
 *
 * Runs the real six-phase camera director (ATTRACT / AIM / FLIGHT / IMPACT /
 * SETTLE / RESULTS, the impact-seat scorer, screen shake, Steady Camera —
 * work-order step 5) over real levels loaded from RT.levels (the stacked-
 * ASCII-layer format, 16 castles, and the auditLevels() boot check — step 6).
 * js/ui.js drives the meters and input and calls into the fire()/traceShot()
 * API at the bottom of this file; everything about the world, the live castle
 * and the camera stays here.
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
 * routes through, and note that `auditing` is what keeps the one remaining
 * boot audit (auditLevels()) silent while it settles all sixteen castles.
 *
 * A former second boot audit, auditReach() ("every crown is destroyable by
 * some single sampled shot"), was removed — it only ever tested a single
 * shot per candidate, so a level whose intended solution is a sequence
 * (break the support, then hit the now-exposed crown) failed it despite
 * being perfectly playable, and its simulated tier had already proven
 * order-dependent in practice (see commit 2f1c6b9: passed in a warm test
 * session, failed on a genuine fresh boot). A crown never needed a clear
 * shot — it's an ordinary hp-bearing body, destroyable by direct hit,
 * collateral impact, or a fall — so that's now true by construction rather
 * than proved by sampling. Recoverable at 2f1c6b9:js/game.js:524-623 if a
 * future session wants to look at it. The one genuine authoring bug it ever
 * caught (a castle placed beyond an ammo's physical max range — see commit
 * 64b1aca) is now checked separately and deterministically by
 * js/data.js's ammoReachReport(), surfaced here via auditAmmoOffers()
 * (warn-only, never blocks a boot).
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
  let shotKeyKills = 0; // guards+tyrant killed by the CURRENT bolt (direct/splash/seam/linger) — reset in fire()

  /** Per-level ammo scarcity — id -> uses left, only for AMMO entries that
   *  carry a `limit`. Reset every loadLevel() (including a retry), never
   *  persisted, so scarcity is a per-attempt puzzle constraint, not a
   *  session-wide one. See D.AMMO's limit field. */
  let ammoLeft = {};
  /* Deliberately iterates D.AMMO, not availableAmmo() — loadLevel() (below)
   * calls this BEFORE it assigns the new liveLevel, so an ammo-aware version
   * here would reset limits against the PREVIOUS level's offered set, not the
   * one about to load. Extra map entries for ammo the new level doesn't even
   * offer are inert — ammoRemaining() is never asked about an ammo the player
   * can't select. */
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
  /** Set while runBootAudits() is settling every level (auditLevels(), below)
   *  — that settling steps stepPhysicsWithImpacts(), which can legitimately
   *  kill a level's only crown via collateral/fall damage and trip
   *  checkWin()/finishLevel(), which would otherwise write bogus progress
   *  into the player's real save. runBootAudits() also snapshots/restores
   *  `save` itself around the whole audit, so this is defense in depth, not
   *  the only guard — see that function's own comment for why both halves
   *  are independently required. */
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
    'sky1', 'sky2', 'sky3', 'sun', 'ground', 'hill', 'dirt', 'focus', 'ink',
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
      sky1: css('sky1'), sky2: css('sky2'), sky3: css('sky3'),
      ground: css('ground'), hill: css('hill'), dirt: css('dirt'),
      wood: css('wood'), sunColor: css('sun'),
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
       auditLevels(). Baked hero models (see js/models.js, Part D); stand
       beside each wheel, facing -Z like the ballista itself. */
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

  /** The ring's own geometry lies flat in its local XY plane (normal along
   *  local +Z). Three fixed orientations cover the three faces a shot can
   *  land on — flush against the surface either way, not just tilted to
   *  "read okay from the aim camera": a wall's front face wants the same
   *  Z-facing default the ring already has, a roof/ground hit wants it
   *  tipped to face +Y (the one case this used to handle), and a side face
   *  (rare — a pillar's flank) wants it turned to face +X. Built once, not
   *  per frame. */
  const _RING_FLAT_Q  = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const _RING_FRONT_Q = new THREE.Quaternion();
  const _RING_SIDE_Q  = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const _previewLocal = new THREE.Vector3();
  const _previewNormal = new THREE.Vector3();
  const _previewInvQuat = new THREE.Quaternion();

  function buildAimPreview() {
    /* depthTest:false alone isn't enough this far from the camera: this
     * game's near/far planes (see the camera director) span a wide enough
     * ratio that depth-buffer precision at ~25-30 units out is coarser than
     * the ring's few-centimetre stand-off from a block's surface, so the
     * block can still win the depth test and cover the ring — invisible
     * against the ground (a shallow, near-perpendicular offset) but glaring
     * against a wall (the offset runs straight along the view axis there,
     * exactly where precision is worst). depthWrite:false plus a high
     * renderOrder sidesteps the whole precision question: the ring/dots
     * never touch the depth buffer and always paint dead last, so nothing
     * drawn before them — at any distance, on any face — can cover them. */
    previewMat = new THREE.MeshBasicMaterial({ color: css('focus'), depthTest: false, depthWrite: false });
    previewGroup = new THREE.Group();
    previewGroup.visible = false;
    previewGroup.renderOrder = 999;

    const dotGeo = new THREE.SphereGeometry(0.08, 8, 6);
    for (let i = 0; i < PREVIEW_DOTS; i++) {
      const dot = new THREE.Mesh(dotGeo, previewMat);
      dot.castShadow = false;
      dot.renderOrder = 999;
      previewDots.push(dot);
      previewGroup.add(dot);
    }

    const ringGeo = new THREE.RingGeometry(0.32, 0.5, 24);
    previewRing = new THREE.Mesh(ringGeo, previewMat);
    previewRing.renderOrder = 999;
    previewRing.quaternion.copy(_RING_FLAT_Q);   // default: lying flat, as for a ground hit
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
    /* The ring used to sit flat on CFG.GROUND_Y no matter what — last.x/z (the
     * real impact column) were already right, but forcing ground height meant
     * a shot that actually stops on a wall/roof drew its reticle down at the
     * base of it instead, reading as if the shot had sailed straight through
     * to the ground behind the structure. last.y IS the real impact height
     * (findHitBlock() stops the trace within `r` of the block's own surface),
     * so use it directly — it already falls back to ground height on its own
     * for an unobstructed shot, since that's genuinely where those land.
     *
     * Orientation needs the same fix for the same reason: a ring lying flat
     * against a wall's vertical face reads as floating in front of it, not
     * resting on it. Which face got hit isn't reported by findHitBlock() (it
     * only returns the block), so it's re-derived here the same way that
     * function tests it — the axis with the least remaining margin inside
     * the block's (rotated) half-extents is the face the shot just crossed. */
    const last = pts[pts.length - 1];
    const hitBlock = trace.hit.type === 'block' ? trace.hit.block : null;
    if (hitBlock) {
      _previewInvQuat.copy(hitBlock.mesh.quaternion).invert();
      _previewLocal.copy(last).sub(hitBlock.mesh.position).applyQuaternion(_previewInvQuat);
      const mx = hitBlock.half.x - Math.abs(_previewLocal.x);
      const mz = hitBlock.half.z - Math.abs(_previewLocal.z);
      const my = hitBlock.half.y - Math.abs(_previewLocal.y);
      let faceQuat, axis;
      if (mx <= mz && mx <= my)      { faceQuat = _RING_SIDE_Q;  axis = 'x'; }
      else if (mz <= my)             { faceQuat = _RING_FRONT_Q; axis = 'z'; }
      else                           { faceQuat = _RING_FLAT_Q;  axis = 'y'; }
      previewRing.quaternion.copy(hitBlock.mesh.quaternion).multiply(faceQuat);
      const sign = Math.sign(_previewLocal[axis]) || 1;
      _previewNormal.set(axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0);
      _previewNormal.applyQuaternion(hitBlock.mesh.quaternion);
      previewRing.position.copy(last).addScaledVector(_previewNormal, 0.03);
    } else {
      previewRing.quaternion.copy(_RING_FLAT_Q);
      previewRing.position.set(last.x, last.y + 0.03, last.z);
    }

    if (ballista) {
      ballista.pivot.rotation.y = -trace.yaw;
      ballista.pivot.rotation.x = trace.elevation;
    }
  }

  /* ── Blocks ───────────────────────────────────────────────────────────────
   * Ties one Ammo body to one Three.js mesh — loadLevel() below is what
   * calls this once per parsed block spec from RT.levels.parseLevel().
   */
  /** `spec` is one js/levels.js parser block — {matId, x, y, z, w, h, d} plus
   *  the cell provenance (layer/row/col) the parser attaches. It's kept on
   *  the record so anything reporting a problem with a block can name the
   *  cell its author actually drew rather than a world-space coordinate. */
  function spawnBlock(spec) {
    const { matId, x, y, z, w, h, d } = spec;
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
      hp: mat.hp, spec: spec
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

  /** Points for a kill are 500 for a crown, 350 for a guard, 100 for anything
   *  else — ported from the 2D version's damageBlock() (crown/other split),
   *  folded in here since every kill (a direct hit via applyHit(), or
   *  collateral via stepPhysicsWithImpacts()) already funnels through this
   *  one function. Destruction audio funnels through here for the same
   *  reason: a crown toppled by collateral collapse has to sound exactly as
   *  final as one shot off its perch.
   *
   *  Guards and the crown ("key targets") also add an efficiency bonus here,
   *  immediately on kill — bigger the earlier boltsUsed is, so killing one
   *  on an early bolt actually pays out more than limping to the same kill
   *  late. This is separate from (and stacks with) the flat per-kill value
   *  above and the existing unused-bolts bonus in finishLevel() — that one
   *  only ever looks at the FINAL total, not when a key target actually died.
   *  shotKeyKills also increments here, driving the combo bonus a few lines
   *  down — a kill counts toward it regardless of whether it came from the
   *  direct hit, a seam/linger neighbour, or a collateral chain the same
   *  shot set off, since destroyBlockRec() is the one place all of those
   *  paths already meet. Reset to 0 in fire() at the start of each shot. */
  function destroyBlockRec(b) {
    if (!b.alive) return;
    b.alive = false;
    if (b.mat.crown || b.mat.guard) {
      levelScore += b.mat.crown ? 500 : 350;
      levelScore += Math.max(0, CFG.KEY_BUDGET - boltsUsed) * CFG.KEY_BONUS_PER_BOLT;
      shotKeyKills++;
      /* Combo bonus, paid incrementally as each extra key kill in this same
         shot happens (rather than computed once at the end): the tyrant
         itself can be the kill that ends the level, and finishLevel() reads
         levelScore synchronously the instant checkWin() sees it die — so
         this has to already be folded in by then, not added later once the
         whole shot/collapse finishes. Total payout across a shot is the same
         either way; paying it here just means it can never miss a win. */
      if (shotKeyKills > 1) levelScore += CFG.COMBO_BONUS_PER_KILL;
    } else {
      levelScore += 100;
    }
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
    for (const b of parsed.blocks) spawnBlock(b);
    /* Bond touching boards into one assembly — spawnBlock() appends in the
       order it's called, so a weldPairs() index IS the blocks[] index. Every
       body has to exist before any weld references it, hence a second pass
       rather than welding inside the loop above. */
    for (const [i, j] of LV.weldPairs(parsed.blocks)) P.addWeld(blocks[i].body, blocks[j].body);

    AIM_LOOKAT.z = -liveLevel.dist;
    if (world) W.recenterShadow(world, liveLevel.dist);
  }

  /* ── Boot-time audits ─────────────────────────────────────────────────────
   * Replaces the check the old README asked a human to do by eye — "it must
   * stand up" — with an assertion run once at boot, throwing loudly if a
   * level fails it. Needs real physics steps (unlike a purely data-driven
   * audit like FishMaster's auditMissions()), so it runs from inside physics
   * init's callback rather than synchronously from init() — see
   * runBootAudits() below for how a failure still gets surfaced despite that.
   *
   * A second audit used to live here too — auditReach(), "every crown is
   * destroyable by some single sampled shot" — removed per this file's
   * header comment above. auditLevelData() and auditAmmoOffers() below are
   * its much cheaper, purely data-driven replacements for the one class of
   * real bug it ever caught (a level's own data being wrong), rather than
   * trying to prove solvability by sampling.
   */

  /** Every castle stands unaided: build it, step ~4 simulated seconds, and
   *  check no crown drifted and nothing is still awake. Reuses loadLevel()
   *  itself, so this is exercising the exact path the player's first look
   *  at each level goes through, not a parallel code path. */
  function auditLevels() {
    const wasAuditing = auditing;
    auditing = true;              // settling sixteen castles is not a thing to hear
    try {
      auditLevelsInner();
    } finally {
      auditing = wasAuditing;
    }
  }

  /** Describes a block the way a level author drew it — the cell provenance
   *  js/levels.js's parser attaches to every spec — since "the board at layer
   *  2, row 5, col 6" is something you can go and look at, and a world-space
   *  Y is not. */
  function whereBlock(b) {
    const s = b.spec;
    if (!s) return b.mat.id;
    return `${b.mat.name} at layer ${s.layer + 1}, row ${s.row + 1}, col ${s.col + 1}`;
  }

  function auditLevelsInner() {
    for (let ix = 0; ix < LV.LEVELS.length; ix++) {
      loadLevel(ix);
      const name = LV.LEVELS[ix].name;
      /* Same shared verdict the editor's stability button computes — see
         RT.settle.standingReport() for why asking "did anything move or die"
         beats asking "is it quiet yet", and for what shipped while the two
         callers were each asking their own narrower question. */
      const report = RT.settle.standingReport(blocks, undefined, {
        onImpact: (b, drop) => { sfx('impact', b.mat, drop, panFor(b.mesh.position)); },
        onDestroy: destroyBlockRec
      });
      checkWin();
      if (report.crownsLost.length) {
        throw new Error(`auditLevels: "${name}" lost a crown just from standing (${whereBlock(report.crownsLost[0])})`);
      }
      if (report.destroyed.length) {
        throw new Error(`auditLevels: "${name}" destroyed ${report.destroyed.length} piece(s) just from standing — first: ${whereBlock(report.destroyed[0])}. It doesn't stand on its own.`);
      }
      if (report.moved.length) {
        const w = report.worst;
        throw new Error(`auditLevels: "${name}" shifted ${report.moved.length} piece(s) while settling — worst: ${whereBlock(w.rec)} moved ${w.dist.toFixed(3)} units (limit ${RT.settle.STILL_EPS}). It doesn't stand on its own.`);
      }
      if (report.awake.length) {
        throw new Error(`auditLevels: "${name}" never settled to sleep within ${report.steps} steps (${report.awake.length} still awake, e.g. ${whereBlock(report.awake[0])})`);
      }
    }
  }

  /** Pure-data level sanity check — no physics, in the spirit of FishMaster's
   *  auditMissions(). THROWS: an `ammo` field that isn't a real array of real
   *  js/data.js AMMO ids is malformed, save-independent data with no tuning
   *  to get wrong — exactly the silent-typo class this codebase keeps getting
   *  bitten by (see js/data.js's MAT.css note, and the PALETTE_VARS comment
   *  above). A level with no `ammo` field is untouched by this — that's the
   *  common case and there's nothing to check. */
  function auditLevelData() {
    const ids = D.AMMO.map((a) => a.id);
    for (const lvl of LV.LEVELS) {
      if (lvl.ammo === undefined || lvl.ammo === null) continue;
      if (!Array.isArray(lvl.ammo)) {
        throw new Error(`auditLevelData: "${lvl.name}" has an ammo field that is not an array`);
      }
      if (!lvl.ammo.length) {
        throw new Error(`auditLevelData: "${lvl.name}" has an empty ammo array — omit the field entirely for "no restriction"`);
      }
      const seen = new Set();
      for (const id of lvl.ammo) {
        if (ids.indexOf(id) === -1) {
          throw new Error(`auditLevelData: "${lvl.name}" lists unknown ammo id "${id}" — every entry must match an id in data.js's AMMO (${ids.join(', ')})`);
        }
        if (seen.has(id)) throw new Error(`auditLevelData: "${lvl.name}" lists ammo id "${id}" more than once`);
        seen.add(id);
      }
    }
  }

  /** Boot-time ammo-offer sanity: pure arithmetic (js/data.js's
   *  ammoReachReport()), WARN ONLY, never throws — deliberately, since the
   *  whole point of removing auditReach() was that a check must not block
   *  creative level design, and an offered set can be narrowed by SAVE STATE
   *  (see availableAmmoAt() below), so a throwing version here would
   *  reintroduce exactly the save-dependent boot flakiness commit 2f1c6b9
   *  fixed the hard way. Prints nothing at all when every level is fine, so a
   *  clean boot stays a clean console — ammoReachReport()'s `notes` (e.g.
   *  "Powder Bomb can't reach this level's full meter range", true on every
   *  shipped level today) are deliberately never printed here, only
   *  returned, or every boot would emit noise nobody asked for. */
  function auditAmmoOffers() {
    const reports = [];
    for (let ix = 0; ix < LV.LEVELS.length; ix++) {
      const report = D.ammoReachReport(LV.LEVELS[ix], availableAmmoAt(ix));
      for (const p of report.problems) console.error('auditAmmoOffers: "' + report.name + '" — ' + p);
      for (const w of report.warnings) console.warn('auditAmmoOffers: "' + report.name + '" — ' + w);
      reports.push(report);
    }
    // Unlock visibility: a level that hides an ammo the PREVIOUS level just
    // announced as newly unlocked is a real, if minor, UX bug (finishLevel()
    // speaks "New ammunition unlocked: X" right before the player lands on a
    // level that then doesn't offer X) — worth a warning, not a throw, since
    // it's still playable.
    for (const a of D.AMMO) {
      if (a.unlockAt === 0) continue;
      const lvl = LV.LEVELS[a.unlockAt];
      if (lvl && lvl.ammo && lvl.ammo.indexOf(a.id) === -1) {
        console.warn('auditAmmoOffers: "' + lvl.name + '" unlocks ' + a.name + ' but its own ammo list hides it');
      }
    }
    return reports;
  }

  /** Runs the boot audit (auditLevels() leaves the last level it built live
   *  in the scene) and, once it passes, resumes at the furthest level the
   *  save file has reached. A failure throws synchronously to the caller —
   *  see loadAttract() for how that gets surfaced instead of just hanging
   *  silently.
   *
   *  The save snapshot/suppressSaveWrites guard below is NOT a leftover from
   *  the removed auditReach() (which used to fire real test shots) — it is
   *  independently required by auditLevelsInner() itself: that audit steps
   *  stepPhysicsWithImpacts(), which can kill a crown while merely settling
   *  (its own first assertion, above) via destroyBlockRec() -> checkWin() ->
   *  finishLevel(), which mutates `save` (stars/level/totalScore) and calls
   *  persistSave(). Suppressing the write alone is not enough either:
   *  finishLevel() mutates the live `save` object BEFORE persisting, so a
   *  suppressed write still leaves a corrupted in-memory save that the very
   *  next legitimate persistSave() (a theme change, the player's next real
   *  win) would faithfully write out. Both halves — the snapshot/restore AND
   *  suppressSaveWrites — are load-bearing on their own. Do not remove either
   *  just because auditReach() is gone. */
  function runBootAudits() {
    auditLevelData();
    const saveSnapshot = JSON.parse(JSON.stringify(save));
    suppressSaveWrites = true;
    try {
      auditLevels();
    } finally {
      suppressSaveWrites = false;
      save = saveSnapshot;
    }
    loadLevel(save.level);
    auditAmmoOffers();
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

  const _normLocal = new THREE.Vector3(), _normInvQuat = new THREE.Quaternion(), _normOut = new THREE.Vector3();
  /** World-space outward normal of whichever face of `b` is nearest `point` —
   *  the same least-margin-axis test findHitBlock() (above) and the aim
   *  reticle (updateAimPreview()) already use to find/orient a hit, re-derived
   *  here for the one thing neither of those needed before: a direction to
   *  deflect a lingering bolt off of (see startLinger()/stepLinger() below).
   *  Returns a shared scratch vector — clone it to keep it past the call. */
  function hitNormal(b, point) {
    _normInvQuat.copy(b.mesh.quaternion).invert();
    _normLocal.copy(point).sub(b.mesh.position).applyQuaternion(_normInvQuat);
    const mx = b.half.x - Math.abs(_normLocal.x);
    const mz = b.half.z - Math.abs(_normLocal.z);
    const my = b.half.y - Math.abs(_normLocal.y);
    let axis;
    if (mx <= mz && mx <= my) axis = 'x';
    else if (mz <= my) axis = 'z';
    else axis = 'y';
    const sign = Math.sign(_normLocal[axis]) || 1;
    _normOut.set(axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0);
    _normOut.applyQuaternion(b.mesh.quaternion);
    return _normOut;
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
    shotKeyKills = 0;
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
    if (impactPos) applySeamHit(ammo, impactPos, b);
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

  const _seamDir = new THREE.Vector3();
  const _seamLocal = new THREE.Vector3(), _seamInvQuat = new THREE.Quaternion();
  /** Every direct/linger hit also nicks whatever else the bolt is physically
   *  touching right at the impact point — independent of (and much tighter
   *  than) any ammo's own splashRadius, so a shot landing where two parts
   *  meet, or a guard standing flush against a wall, can take out both with
   *  one bolt instead of only whichever one findHitBlock() happened to pick.
   *  Shares applySplash()'s falloff/knockback shape on purpose (same recipe),
   *  just a much tighter radius and much less falloff: this represents the
   *  same solid bolt actually overlapping the neighbour, not a shockwave
   *  reaching it, so it stays close to full damage across its whole radius.
   *
   *  Distance is to the block's own (rotated) SURFACE, not its centre — same
   *  local-space test findHitBlock() uses, extended to a real distance rather
   *  than a boolean contains-point. applySplash()'s centre-to-centre distance
   *  is fine at its large blast radius, but a wide merged wall's centre can
   *  sit cells away from the edge actually touching the primary block, which
   *  would make this radius (deliberately much tighter) never register a
   *  seam at all — confirmed empirically: a guard standing directly against
   *  a 4-cell merged wall run took no seam damage until this was fixed. */
  function applySeamHit(ammo, impactPos, primaryBlock) {
    const radius = CFG.SEAM_RADIUS;
    for (const other of blocks) {
      if (!other.alive || other === primaryBlock) continue;
      _seamInvQuat.copy(other.mesh.quaternion).invert();
      _seamLocal.copy(impactPos).sub(other.mesh.position).applyQuaternion(_seamInvQuat);
      const dx = Math.max(0, Math.abs(_seamLocal.x) - other.half.x);
      const dy = Math.max(0, Math.abs(_seamLocal.y) - other.half.y);
      const dz = Math.max(0, Math.abs(_seamLocal.z) - other.half.z);
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > radius) continue;
      const falloff = 1 - (dist / radius) * 0.3;
      other._lastHitSpeed = ammo.speed * falloff;
      sfx('impact', other.mat, ammo.speed * falloff, panFor(other.mesh.position));
      other.hp -= D.damageFor(ammo, other.mat) * CFG.SEAM_DMG_SCALE * falloff;
      if (!other.mat.static) {
        _seamDir.subVectors(other.mesh.position, impactPos).normalize();
        const kick = ammo.speed * CFG.KNOCK_SCALE * falloff;
        P.addVelocity(other.body, _seamDir.x * kick, _seamDir.y * kick + kick * 0.4, _seamDir.z * kick);
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

  /** Kicks off the ~2s post-impact linger (see stepLinger() just below): the
   *  bolt deflects off the surface it just hit and keeps existing as a real,
   *  if simplified, moving object rather than vanishing on first contact —
   *  same deterministic step-under-gravity style traceShot() already uses,
   *  not a real Ammo.js body (this codebase's bolts have never been one). */
  function startLinger(s, primaryBlock, impactPos, impactVel) {
    s.linger = true;
    s.lingerT = 0;
    s.hitBlocks = new Set([primaryBlock]);
    s.lingerPos = impactPos.clone();
    const n = hitNormal(primaryBlock, impactPos);
    s.lingerVel = impactVel.clone().addScaledVector(n, -2 * impactVel.dot(n)).multiplyScalar(CFG.LINGER_RESTITUTION);
  }

  /** A scaled-down applyHit() for a bolt that already spent its main impact —
   *  same damage/knock/kill/checkWin shape, just decayed per additional
   *  linger hit (`decay`) so one bolt can't bulldoze an entire structure, and
   *  without ammo.splash's own big blast (only the PRIMARY impact triggers
   *  that) — applySeamHit() still applies, at its own small radius. */
  function lingerHit(b, ammo, vel, pos, decay) {
    if (!b.alive) return;
    const speed = vel.length();
    b._lastHitSpeed = speed;
    sfx('impact', b.mat, speed, panFor(pos));
    b.hp -= D.damageFor(ammo, b.mat) * decay;
    if (!b.mat.static) {
      P.addVelocity(b.body, vel.x * CFG.KNOCK_SCALE * decay, vel.y * CFG.KNOCK_SCALE * decay, vel.z * CFG.KNOCK_SCALE * decay);
    }
    if (b.hp <= 0) destroyBlockRec(b);
    applySeamHit(ammo, pos, b);
    checkWin();
  }

  /** Steps a lingering bolt one frame: gravity + its current (deflected)
   *  velocity, checking for a NEW block (anything this same bolt hasn't
   *  already hit) along the way. Ends on a timeout, on settling near-still,
   *  on touching the ground, or on leaving the same out-of-bounds box
   *  traceShot() already checks — whichever comes first. */
  function stepLinger(s, dt) {
    s.lingerT += dt;
    s.lingerVel.y -= CFG.GRAVITY * dt;
    s.lingerPos.addScaledVector(s.lingerVel, dt);
    s.mesh.position.copy(s.lingerPos);

    const b = findHitBlock(s.lingerPos, s.trace.ammo.r);
    if (b && !s.hitBlocks.has(b)) {
      s.hitBlocks.add(b);
      const decay = Math.pow(CFG.LINGER_DMG_DECAY, s.hitBlocks.size - 1);
      lingerHit(b, s.trace.ammo, s.lingerVel, s.lingerPos, decay);
      const n = hitNormal(b, s.lingerPos);
      s.lingerVel.addScaledVector(n, -2 * s.lingerVel.dot(n)).multiplyScalar(CFG.LINGER_RESTITUTION);
    }

    const done = s.lingerT > CFG.LINGER_MS / 1000 ||
                 s.lingerVel.lengthSq() < 0.4 ||
                 s.lingerPos.y <= CFG.GROUND_Y + 0.02 ||
                 Math.abs(s.lingerPos.x) > OUT_OF_BOUNDS_X ||
                 s.lingerPos.z < OUT_OF_BOUNDS_Z_FAR || s.lingerPos.z > OUT_OF_BOUNDS_Z_NEAR;
    if (done) {
      s.resolved = true;
      scene.remove(s.mesh);
    }
  }

  function updateShots(dt) {
    if (!shots.length) return;
    const dtStep = CFG.DT;
    for (const s of shots) {
      if (s.resolved) continue;
      if (s.linger) { stepLinger(s, dt); continue; }
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
        sfx('stopFlight');
        if (s.trace.hit.type === 'block') {
          const impactPos = s.trace.points[s.trace.points.length - 1];
          applyHit(s.trace.hit.block, s.trace.ammo, s.trace.impactVel, impactPos);
          beginImpact(impactPos, s.trace.impactVel);
          startLinger(s, s.trace.hit.block, impactPos, s.trace.impactVel);
        } else {
          s.resolved = true;
          scene.remove(s.mesh);
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
   *
   * The peak-speed tracking, hp loss and crush detection itself now live in
   * js/settle.js (RT.settle) — extracted so the level editor's stability test
   * can settle a candidate castle with this exact damage model instead of a
   * bare P.step() that can't see a crown getting crushed in place. This is a
   * thin wrapper supplying the two things that are genuinely game-specific:
   * sound (sfx/panFor) and destruction (destroyBlockRec, which also handles
   * score, a keg's splash chain, and waking whatever was resting on top).
   */
  function stepPhysicsWithImpacts(dt) {
    RT.settle.step(blocks, dt, {
      onImpact: (b, drop) => { sfx('impact', b.mat, drop, panFor(b.mesh.position)); },
      onDestroy: destroyBlockRec
    });
    checkWin();
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
    if (world) W.update(world, dt);

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
      // Also waits out a still-lingering bolt (see stepLinger()) — the
      // cinematic shouldn't cut away to results while it's still visibly
      // knocking things around.
      const stillMoving = blocks.some((b) => b.alive && !b.mat.static && P.isAwake(b.body)) ||
                           shots.some((s) => s.linger && !s.resolved);
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

  /** Every ammo whose `unlockAt` is at or below level index `levelIx` —
   *  parameterised on the index rather than reading `save` directly so the
   *  boot-time ammo-offer check (auditAmmoOffers(), above) can ask about
   *  every level without depending on the player's progress. A save-
   *  dependent boot check is exactly the shape of thing that bit this game
   *  once already, for a different reason (commit 2f1c6b9's physics
   *  simulation-order flakiness) — this keeps the new arithmetic check from
   *  ever being able to repeat that mistake. */
  function unlockedAmmoAt(levelIx) { return D.AMMO.filter((a) => a.unlockAt === 0 || levelIx >= a.unlockAt); }
  /** PROGRESSION ONLY — what the player has earned, same gate as the 2D
   *  version's unlockedAmmo(). Deliberately NOT what a level offers to play
   *  with right now; see availableAmmo() below for that. Kept off the public
   *  RT.game surface at the bottom of this file (only one external consumer
   *  ever existed, js/ui.js's own now-renamed wrapper) so no call site can
   *  reach the un-narrowed list by accident — that mistake would have no
   *  visible symptom until the day a level actually narrows its own list. */
  function unlockedAmmo() { return unlockedAmmoAt(save.level); }

  const _warnedAmmo = new Set();
  function warnOnceAmmo(level, reason) {
    const key = (level && level.name) + '|' + reason;
    if (_warnedAmmo.has(key)) return;
    _warnedAmmo.add(key);
    console.warn('availableAmmo: "' + (level && level.name) + '" ' + reason + ' — falling back to the full unlocked set.');
  }
  /** The intersection, plus the "never present zero ammo" rule the shot
   *  pipeline and the ammo scan lane both assume at least one entry exists.
   *  `warnOnceAmmo` matters here specifically because this sits on the hot
   *  path — every frame a meter is moving calls currentAmmo() ->
   *  availableAmmo() (js/ui.js:709-735) — so a bare console.warn would emit
   *  hundreds per second and bury the message it's trying to deliver. */
  function narrowToLevel(list, level) {
    const ids = level && level.ammo;
    if (ids === undefined || ids === null) return list;   // no field = today's behaviour, byte for byte
    if (!Array.isArray(ids)) { warnOnceAmmo(level, 'has an ammo field that is not an array'); return list; }
    // Filtering D.AMMO (via `list`) rather than mapping over `ids` keeps the
    // result in D.AMMO's canonical order regardless of how the level's own
    // array is ordered — the ammo lane is a scan list, and a chip's POSITION
    // is something a switch-scanning player learns; it must not move between
    // levels just because a level's authored list happens to be in a
    // different order.
    const set = new Set(ids);
    const narrowed = list.filter((a) => set.has(a.id));
    if (narrowed.length) return narrowed;
    warnOnceAmmo(level, 'lists ammo none of which the player has unlocked yet');
    return list;   // never present zero ammo — narrowing can empty a set, never the game
  }
  /** What THIS level actually offers to play with: (the level's own list) ∩
   *  (what progression has unlocked). Narrows, never grants — an early level
   *  can never hand out the Powder Bomb just by listing it. `level` defaults
   *  to whatever is live, the same convention traceShot() already uses. */
  function availableAmmo(level) { return narrowToLevel(unlockedAmmo(), level || liveLevel); }
  /** Save-independent form, for auditAmmoOffers() — see that function's own
   *  comment for why it must never depend on `save`. */
  function availableAmmoAt(ix) { return narrowToLevel(unlockedAmmoAt(ix), LV.LEVELS[ix]); }

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
      const ammo = availableAmmo()[ammoIx];
      if (!ammo) return null;
      const trace = fire(ammo, yawDeg * Math.PI / 180, rangePct);
      return trace && { hit: trace.hit.type, matHit: trace.hit.block ? trace.hit.block.mat.id : null };
    },
    availableAmmoIds() { return availableAmmo().map((a) => a.id); },
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
    auditLevels, auditLevelData, auditAmmoOffers,
    unlockedAmmo, availableAmmo, availableAmmoAt,
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
    availableAmmo, ammoRemaining, currentLevel, crownPositions, targetableBlocks, fire, traceShot, updateAimPreview,
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
