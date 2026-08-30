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
 * Also owns progress: stars, score, ammo unlocks and the results/out-of-
 * bolts overlays (RESULTS_MENU / OUTOFBOLTS, two more CAM phases alongside
 * the camera director's own six), and the save file itself — one combined
 * object under RT.util's `rt-ballista` key, same shape as FishMaster's save.
 * Endless Bolts defaults on (the hub's no-fail default), so OUTOFBOLTS is
 * mostly dormant until a future settings menu can actually turn it off —
 * `__test.setEndlessBolts(false)` is the only way there for now. Still no
 * pause menu, minimap, or per-material audio (later polish).
 */
RT.game = (function () {
  'use strict';

  const U = RT.util;
  const A = RT.art;
  const W = RT.world;
  const D = RT.data;
  const LV = RT.levels;
  const P = RT.physics;
  const CFG = D.CFG;

  let scene, camera, renderer;
  let world = null;      // world.js handles (sky/ground/lights)
  let ballista = null;   // { root, pivot }
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
      endlessBolts: true // recommended default, matches the hub's no-fail philosophy
    };
  }
  function loadSave() {
    const raw = U.load(SAVE_KEY, null);
    save = (raw && raw.version === SAVE_VERSION) ? Object.assign(defaultSave(), raw) : defaultSave();
  }
  function persistSave() { U.save(SAVE_KEY, save); }

  /** Auto-enabled under prefers-reduced-motion, same as FishMaster's
   *  reducedMotion(). Exposed mutable so a future settings menu (steps 6-7)
   *  can toggle it; __test.setSteadyCamera() is the only way in for now. */
  const REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let steadyCamera = REDUCED_MOTION;

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

  function buildWorldAndBallista() {
    refreshPalette();
    world = W.build(scene, {
      sky1: css('sky1'), sky2: css('sky2'), ground: css('ground')
    });
    ballista = A.buildBallista(css('wood'), css('steel'));
    scene.add(ballista.root);
  }

  /* ── Blocks ───────────────────────────────────────────────────────────────
   * Ties one Ammo body to one Three.js mesh — loadLevel() below is what
   * calls this once per parsed block spec from RT.levels.parseLevel().
   */
  function spawnBlock(matId, x, y, z, w, h, d) {
    const mat = D.MAT[matId];
    const color = css(mat.css.replace('--', ''));
    const mesh = A.buildBlock(w, h, d, color, { glow: !!mat.crown });
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

  /** Points for a kill are 500 for a crown, 100 for anything else — ported
   *  from the 2D version's damageBlock(), folded in here since every kill
   *  (a direct hit via applyHit(), or collateral via
   *  stepPhysicsWithImpacts()) already funnels through this one function. */
  function destroyBlockRec(b) {
    if (!b.alive) return;
    b.alive = false;
    levelScore += b.mat.crown ? 500 : 100;
    scene.remove(b.mesh);
    disposeBlockMesh(b.mesh);
    P.destroyBlock(b.body);
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

  /** Every crown is hittable: for each level, sweep (ammo x yaw x range) and
   *  assert at least one combination's deterministic trace lands a direct
   *  hit on each crown. Coarse sampling — this only needs to prove a
   *  solution exists somewhere in the window, not find the best one. */
  function auditReach() {
    const YAW_STEPS = 6, RANGE_STEPS = 8;
    for (let ix = 0; ix < LV.LEVELS.length; ix++) {
      loadLevel(ix);
      const lvl = LV.LEVELS[ix];
      const name = lvl.name;
      const yawHalfDeg = D.yawLimit(lvl) * 180 / Math.PI;
      const crowns = blocks.filter((b) => b.mat.crown);
      for (const crown of crowns) {
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
        if (!hitOk) throw new Error(`auditReach: "${name}" has a crown no (ammo, yaw, range) combination in the sampled window can hit`);
      }
    }
  }

  /** Runs both audits (each leaves the last level it built live in the
   *  scene) and, once both pass, resumes at the furthest level the save
   *  file has reached. A failure throws synchronously to the caller — see
   *  loadAttract() for how that gets surfaced instead of just hanging
   *  silently. */
  function runBootAudits() {
    auditLevels();
    auditReach();
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
    return { points: points, hit: hit, ammo: ammo, impactVel: vel.clone() };
  }

  /** Fires for real: traces the shot, spawns the bolt mesh, and queues it
   *  for updateShots() to play back and resolve. Returns the trace (same
   *  shape the preview uses) so ui.js can narrate the outcome immediately —
   *  the outcome is already fully determined, only the *watching* of it
   *  takes time. */
  function fire(ammo, yawRad, rangePct) {
    const trace = traceShot(ammo, yawRad, rangePct);
    if (!trace) return null;
    boltsUsed++;
    const mesh = A.buildBolt(ammo.r);
    mesh.position.copy(trace.points[0]);
    scene.add(mesh);
    shots.push({ mesh: mesh, trace: trace, t: 0, resolved: false });
    CAM.phase = 'FLIGHT';
    return trace;
  }

  function applyHit(b, ammo, impactVel) {
    if (!b.alive) return;
    const dmg = D.damageFor(ammo, b.mat);
    b.hp -= dmg;
    if (!b.mat.static) {
      P.addVelocity(b.body, impactVel.x * CFG.KNOCK_SCALE, impactVel.y * CFG.KNOCK_SCALE, impactVel.z * CFG.KNOCK_SCALE);
    }
    if (b.hp <= 0) destroyBlockRec(b);
    checkWin();
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
      if (idx >= s.trace.points.length - 1) {
        s.resolved = true;
        scene.remove(s.mesh);
        if (s.trace.hit.type === 'block') {
          const impactPos = s.trace.points[s.trace.points.length - 1];
          applyHit(s.trace.hit.block, s.trace.ammo, s.trace.impactVel);
          beginImpact(impactPos, s.trace.impactVel);
        } else {
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
      if (b.alive && !b.mat.static) b._preSpeed = P.speed(b.body);
    }
    P.step(dt);
    for (const b of blocks) {
      if (!b.alive) continue;
      P.sync(b.mesh, b.body);
      if (b.mat.static) continue;
      const drop = (b._preSpeed || 0) - P.speed(b.body);
      if (drop > CFG.IMPACT_THRESHOLD) {
        b.hp -= (drop - CFG.IMPACT_THRESHOLD) * CFG.IMPACT_DMG_SCALE;
        if (b.hp <= 0) destroyBlockRec(b);
      }
    }
    checkWin();
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
    if (!save) loadSave();   // before ui.js's synchronous init() reads unlockedAmmo()/liveLevel
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
    if (CAM.shake <= 0 || steadyCamera || REDUCED_MOTION) return;
    const s = CAM.shake * 0.12;
    camera.position.x += (Math.random() * 2 - 1) * s;
    camera.position.y += (Math.random() * 2 - 1) * s;
  }

  function update(dt) {
    if (physicsReady) {
      stepPhysicsWithImpacts(dt);
      updateShots(dt);
    }

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
    } else {
      CAM.phase = 'AIM';
      updateAim();
    }

    // One fixed wide view for every phase — still runs the state machine
    // above (so js/ui.js's input gate on CAM.phase === 'AIM' keeps working),
    // just overrides what gets rendered.
    if (steadyCamera) updateAim();

    updateShake(dt);
  }

  /** Every ammo whose `unlockAt` is at or below the furthest level reached —
   *  same gate as the 2D version's unlockedAmmo(). */
  function unlockedAmmo() { return D.AMMO.filter((a) => a.unlockAt === 0 || save.level >= a.unlockAt); }
  function currentLevel() { return liveLevel; }

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

  /**
   * Console-driven checks — no results panel or narration for a miss/hit
   * exists yet beyond the "Level cleared" line, so behaviour is verified by
   * hand: fire a shot, read back state, screenshot the outcome. See the
   * ballista-3d plan's verification section for how this gets driven from
   * outside the page via mcp__chrome-devtools__evaluate_script.
   */
  const __test = {
    blockCount() { return blocks.length; },
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
    camState() {
      return {
        phase: CAM.phase, shake: CAM.shake,
        impactPoint: CAM.impactPoint.toArray(), seatPos: CAM.seatPos.toArray(),
        camPos: camera.position.toArray()
      };
    },
    isSteadyCamera() { return steadyCamera; },
    setSteadyCamera(on) { steadyCamera = !!on; },
    isReducedMotion() { return REDUCED_MOTION; },
    boltsUsed() { return boltsUsed; },
    levelScore() { return levelScore; },
    save() { return save; },
    lastResult() { return lastResult; },
    setEndlessBolts(on) {
      // No settings menu exists yet to reach this by hand — Endless Bolts
      // defaults on (see defaultSave()), so this is here purely so the
      // out-of-bolts path can be exercised/verified before that menu exists.
      save.endlessBolts = !!on;
      persistSave();
    },
    resetSave() { save = defaultSave(); persistSave(); }
  };

  return {
    init, loadAttract, update,
    onThemeChanged, isFlat,
    unlockedAmmo, currentLevel, fire, traceShot,
    confirmResults, retryLevel, enableEndlessAndContinue,
    get CAM() { return CAM; },
    get levelIx() { return levelIx; },
    get lastResult() { return lastResult; },
    get boltsUsed() { return boltsUsed; },
    get save() { return save; },
    __test: __test
  };
})();
