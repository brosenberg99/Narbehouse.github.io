/**
 * Benny's Ballista — game state and camera director.
 *
 * STEP 5 SLICE replaces the placeholder AIM/FLIGHT split with the real
 * six-phase director: ATTRACT / AIM / FLIGHT / IMPACT / SETTLE / RESULTS,
 * the impact-seat scorer, screen shake, and the Steady Camera setting.
 * js/ui.js drives the meters and input and calls into the fire()/
 * traceShot() API at the bottom of this file; everything about the world,
 * the castle and the camera stays here.
 *
 * No real level system yet (js/levels.js is work-order step 6), and no
 * results/pause overlay (that needs the level system's stars/progress to
 * mean anything) — RESULTS below is a camera hold over the wreckage with
 * no panel drawn over it yet.
 */
RT.game = (function () {
  'use strict';

  const U = RT.util;
  const A = RT.art;
  const W = RT.world;
  const D = RT.data;
  const P = RT.physics;
  const CFG = D.CFG;

  let scene, camera, renderer;
  let world = null;      // world.js handles (sky/ground/lights)
  let ballista = null;   // { root, pivot }
  let physicsReady = false;
  let blocks = [];       // { mesh, body, mat, half:Vector3, hp, alive } — the test castle, for now
  let shots = [];        // live bolts: { mesh, ammo, trace, t, resolved }
  let levelWon = false;

  /** Auto-enabled under prefers-reduced-motion, same as FishMaster's
   *  reducedMotion(). Exposed mutable so a future settings menu (steps 6-7)
   *  can toggle it; __test.setSteadyCamera() is the only way in for now. */
  const REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let steadyCamera = REDUCED_MOTION;

  /**
   * Stands in for js/levels.js's per-level object (work-order step 6) —
   * `dist`/`_cols`/`_depth` are exactly what RT.data's rangeWindow()/
   * yawLimit()/castleBounds() read, so the meters scale correctly against
   * this hand-made castle the same way they will against a real level.
   */
  const TEST_LEVEL = { name: 'Test Castle', dist: 20, _cols: 2.2, _depth: 1.6 };

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
   *  all camera personality happens after Return is pressed. */
  const AIM_POS = new THREE.Vector3(0, 3.6, 7.5);
  const AIM_LOOKAT = new THREE.Vector3(0, 2.0, -TEST_LEVEL.dist);

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
   * put a real, physically simulated castle on screen to fire at.
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

  function destroyBlockRec(b) {
    if (!b.alive) return;
    b.alive = false;
    scene.remove(b.mesh);
    P.destroyBlock(b.body);
  }

  function clearBlocks() {
    for (const b of blocks) if (b.alive) P.destroyBlock(b.body);
    blocks = [];
  }

  /**
   * A baseline structure, built before any camera work, per Bryan's reference
   * screenshots (Angry Birds' wooden/stone towers): long thin support
   * members, wide flat floors spanning between them, several differently
   * sized blocks as loose set-dressing debris. The single-cell-cube tower
   * this replaced never exercised non-cubic proportions at all — this is
   * the shape the physics and the paper-craft art actually have to handle
   * once real levels (ASCII layers, step 6) exist. Deliberately much
   * simpler than the references: two tiers, one crown, a handful of loose
   * debris — enough to judge stability and legibility, not a finished level.
   *
   *   tier 2 roof  (wood, wide+flat)         <- crown sits on this
   *   tier 2 legs  (2 thin wood columns)
   *   tier 1 floor (stone, wide+flat)        <- the main "knock this out" target
   *   tier 1 legs  (4 thin wood columns)
   *   ground       loose debris scattered around the base, not load-bearing
   */
  function buildTestCastle() {
    clearBlocks();
    for (const s of shots) scene.remove(s.mesh);
    shots = [];
    levelWon = false;
    const cz = -TEST_LEVEL.dist;

    // Tier 1: four thin corner columns holding up a wide, flat stone floor.
    const legW = 0.22, legH = 2.4, legD = 0.22;
    const legY = legH / 2;
    [[-0.85, -0.6], [0.85, -0.6], [-0.85, 0.6], [0.85, 0.6]].forEach(([dx, dz]) => {
      spawnBlock('W', dx, legY, cz + dz, legW, legH, legD);
    });

    const floor1Y = legH + 0.11;
    spawnBlock('S', 0, floor1Y, cz, 2.0, 0.22, 1.4);

    // Tier 2: two thinner, shorter columns on the floor, holding a smaller
    // wood roof. Fewer legs and a narrower span than tier 1 on purpose — a
    // real level would taper a tower the same way for the same reason: it
    // reads as "this part is easier to knock over."
    const floor1Top = floor1Y + 0.11;
    const leg2W = 0.2, leg2H = 1.0, leg2D = 0.2;
    const leg2Y = floor1Top + leg2H / 2;
    [[-0.4, 0], [0.4, 0]].forEach(([dx, dz]) => {
      spawnBlock('W', dx, leg2Y, cz + dz, leg2W, leg2H, leg2D);
    });

    const roofY = floor1Top + leg2H + 0.09;
    spawnBlock('W', 0, roofY, cz, 1.2, 0.18, 0.9);

    const roofTop = roofY + 0.09;
    spawnBlock('K', 0, roofTop + 0.3, cz, 0.6, 0.6, 0.6);

    // Loose debris: not attached to the structure, just resting on the
    // ground around it — set dressing, and extra rubble once things start
    // flying. Deliberately several different sizes/materials.
    spawnBlock('s', -1.6, 0.2, cz + 1.0, 0.4, 0.4, 0.4);
    spawnBlock('w', 1.5, 0.175, cz - 1.2, 0.35, 0.35, 0.35);
    spawnBlock('i', -1.3, 0.15, cz - 1.3, 0.3, 0.3, 0.3);
    spawnBlock('S', 1.7, 0.3, cz + 0.8, 0.6, 0.6, 0.6);
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
   * no damage. `level` defaults to the live TEST_LEVEL so preview calls
   * from js/ui.js don't need to know that stand-in exists.
   */
  function traceShot(ammo, yawRad, rangePct, level) {
    const launch = D.launchFor(ammo, level || TEST_LEVEL, yawRad, rangePct);
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
      U.speak('Level cleared! All crowns destroyed.');
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
          CAM.phase = 'AIM';   // a clean miss has nothing worth a cinematic cut for
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
    if (!world) buildWorldAndBallista();
    if (!physicsReady) {
      // Ammo's module factory resolves asynchronously (see js/physics.js) —
      // the scene renders and the attract camera runs on its own in the
      // meantime; update() below simply doesn't step physics until this
      // resolves, so there's nothing to block on here.
      P.init().then(() => {
        physicsReady = true;
        buildTestCastle();
        // No main menu yet (that's later polish) — go straight to aiming
        // against the test castle rather than orbiting forever.
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
      if (CAM.resultsT > CFG.WIN_PAUSE) CAM.phase = 'AIM';
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

  /**
   * All four ammo, always unlocked. Real progression (`unlockAt` gated by
   * `save.level`) needs the level system and persistence — work-order
   * steps 6-7 — so there's nothing to gate against yet.
   */
  function unlockedAmmo() { return D.AMMO; }
  function currentLevel() { return TEST_LEVEL; }

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
    rangeWindow() { return D.rangeWindow(TEST_LEVEL); },
    yawLimitDeg() { return D.yawLimit(TEST_LEVEL) * 180 / Math.PI; },
    rebuildCastle: buildTestCastle,
    camState() {
      return {
        phase: CAM.phase, shake: CAM.shake,
        impactPoint: CAM.impactPoint.toArray(), seatPos: CAM.seatPos.toArray(),
        camPos: camera.position.toArray()
      };
    },
    isSteadyCamera() { return steadyCamera; },
    setSteadyCamera(on) { steadyCamera = !!on; },
    isReducedMotion() { return REDUCED_MOTION; }
  };

  return {
    init, loadAttract, update,
    onThemeChanged, isFlat,
    unlockedAmmo, currentLevel, fire, traceShot,
    get CAM() { return CAM; },
    __test: __test
  };
})();
