/**
 * Benny's Ballista — tunables, materials and ammunition.
 *
 * Everything a designer might want to move lives here, in one object, so the
 * rest of the game can be read without hunting for magic numbers.
 *
 * ── Coordinate system ──────────────────────────────────────────────────────
 * One block is ONE world unit, which is also what keeps Bullet happy (it is
 * tuned for objects roughly 0.1–10 units across).
 *
 *   +X  lateral, right as the player sees it   (the aim sweep moves along this)
 *   +Y  up
 *   -Z  downrange, away from the ballista      (the range meter moves along this)
 *
 * "Range" is always stored as a POSITIVE distance downrange, and only the
 * scene placement negates it into a Z coordinate. That way every piece of
 * ballistics maths below reads in plain positive numbers.
 *
 * ── The one rule that shapes the whole game ────────────────────────────────
 * POWER SETS RANGE, NOT FORCE. The muzzle speed of a given ammunition never
 * changes; the range meter picks a distance and the launch elevation is
 * *solved* to land there. So impact damage cannot depend on how long the
 * player held the switch, and an early release costs accuracy but never
 * effect. There is no such thing as an undercharged dud.
 */
RT.data = (function () {
  'use strict';

  const U = RT.util;

  /* ── Tunables ─────────────────────────────────────────────────────────── */
  const CFG = {
    /* Input, matching the rest of the hub. See ../../../../AGENTS.md. */
    SPACE_HOLD_MS   : 3000,   // hold Space this long in a list to scan by itself
    RETURN_HOLD_MS  : 3000,   // hold Return this long to back out / open Pause
    SCAN_DIR_ON_HOLD: -1,     // -1 = backward, matching every other hub game

    /* ── The two meters ───────────────────────────────────────────────────
     * Both crawl on purpose: the player has to be able to watch one approach
     * the value they want and let go, not catch it. Neither has a deadline,
     * the sweep bounces at its ends instead of stopping, and the range meter
     * clamps at full instead of wrapping, so there is no moment to miss.
     *
     * Both limits are derived per level (see rangeWindow / yawLimit below)
     * rather than being absolute, so a meter never has dead travel at one end
     * just because a castle happens to sit close in or far out.
     */
    YAW_DEG_PER_S   : 6,      // sweep speed; ~5.3s from one edge to the other
    YAW_TICK_DEG    : 3,      // soft tick every this many degrees while sweeping
    YAW_PAD_CELLS   : 2.0,    // sweep this far past each side of the castle
    YAW_MIN_HALF_DEG: 7,      // ...but never a sweep narrower than this

    RANGE_PCT_PER_S : 12,     // 0 -> 100% in 8.3s
    RANGE_TICK_PCT  : 10,     // beep every this much
    RANGE_PAD_NEAR  : 7.0,    // meter starts this far short of the castle front
    RANGE_PAD_FAR   : 7.0,    // ...and ends this far past its back
    DEFAULT_RANGE_PCT: 50,    // what the very first shot of a session aims at

    METER_PREVIEW_MS: 60,     // re-run the arc at most this often while moving

    /* ── Physics ──────────────────────────────────────────────────────────
     * GRAVITY is well above real-world for a 1-unit block, which is what makes
     * a collapse read as chunky and toy-like rather than floaty. It is also
     * the single number every ballistics result depends on, so changing it
     * means re-checking reachability (RT.game.__test.auditReach()).
     */
    GRAVITY         : 14,     // units/s^2, downward
    DT              : 1 / 120,  // physics substep
    MAX_SUBSTEPS    : 8,

    BLOCK_FRICTION    : 0.62,
    BLOCK_RESTITUTION : 0.04,
    GROUND_FRICTION   : 0.9,
    GROUND_RESTITUTION: 0.05,
    LINEAR_DAMPING    : 0.02,
    ANGULAR_DAMPING   : 0.06,
    /* Bullet puts a body to sleep below these for half a second. Sleep is what
       tells the camera a collapse has finished, so these matter to pacing as
       well as to cost. */
    SLEEP_LINEAR      : 0.28,
    SLEEP_ANGULAR     : 0.35,

    /* Impact damage is a before/after speed check rather than a contact
       listener: "this block just got stopped hard" is exactly what a sudden
       loss of speed means, whether that is landing or crashing into a
       neighbour. Ported from the 2D version and re-tuned for 3D masses. */
    IMPACT_THRESHOLD  : 7.5,   // units/s of lost speed before damage starts
    IMPACT_DMG_SCALE  : 5.0,
    /* Crush damage: a hard-landing block (same drop check as IMPACT_DMG_SCALE
       above) also hurts whatever it's now resting directly on top of, using
       the same drop speed but its own scale — "getting crushed" reads as
       worse than "you personally hit something hard", and tuning one must not
       force-tune the other. See js/game.js's applyCrush(). */
    CRUSH_DMG_SCALE   : 8.0,
    KNOCK_SCALE       : 0.75,  // how much of a bolt's velocity goes to what it hits

    /* ── Level geometry ───────────────────────────────────────────────────── */
    MUZZLE_Y        : 2.35,   // height the bolt leaves the ballista at
    GROUND_Y        : 0,

    /* ── Pacing ───────────────────────────────────────────────────────────── */
    SETTLE_MIN      : 0.55,   // hold after the last body sleeps
    SETTLE_MAX      : 9.0,    // safety net, in case something never sleeps
    WIN_PAUSE       : 1.9     // beat on the wreckage before the results panel
  };

  /* ── Ammunition ─────────────────────────────────────────────────────────
   * Each one is better at something rather than simply stronger, and — new in
   * the 3D version — each one carries its own TRAJECTORY. `lob: true` takes
   * the high solution of the ballistics equation instead of the low one, so
   * it drops onto a target from above rather than driving into its front
   * face. That folds the choice of elevation into a list that is already
   * scannable, instead of spending a third meter on it.
   *
   *   speed  muzzle velocity, units/s. FIXED — never touched by the meter.
   *   dmg    damage multiplier on impact. Also fixed.
   *   r      collision radius of the projectile.
   *   limit  max uses PER LEVEL (resets on loadLevel()/retryLevel()).
   *          Omitted (undefined) means unlimited — every ammo below except
   *          the bomb. See js/game.js's ammoLeft/ammoRemaining().
   *   splash, splashRadius, splashDmgScale — area damage on top of the
   *          direct hit, see js/game.js's applySplash(). Falls off linearly
   *          to zero at splashRadius; splashDmgScale scales the whole thing
   *          down relative to a direct hit so splash is a bonus, not a second
   *          direct hit for every neighbour.
   */
  const AMMO = [
    { id:'stone',    name:'Stone Bolt', sub:'Flat and true',   speed:23.0, dmg:1.00, r:0.22, lob:false, unlockAt:0 },
    { id:'boulder',  name:'Boulder',    sub:'Lobs, smashes rock', speed:21.5, dmg:2.20, r:0.38, lob:true,  unlockAt:3 },
    { id:'fire',     name:'Fire Bolt',  sub:'Flat, burns wood', speed:24.0, dmg:1.00, r:0.20, lob:false, unlockAt:6 },
    { id:'splitter', name:'Splitter',   sub:'Lobs, splits in 3', speed:22.0, dmg:0.62, r:0.20, lob:true,  unlockAt:9 },
    { id:'bomb',     name:'Powder Bomb', sub:'Lobs, blasts a wide radius — one per level',
      speed:19.0, dmg:1.40, r:0.34, lob:true, unlockAt:10, limit:1, splash:true, splashRadius:3.2, splashDmgScale:0.6 }
  ];

  /* A powder keg's own death-explosion, fed through the same applySplash()
   * the Powder Bomb uses (js/game.js) rather than separate blast physics.
   * Not a real AMMO entry (never fired, never listed) — just enough of the
   * shape applySplash()/damageFor() expect: id (won't match either ammo-
   * specific damage bonus above, which is correct — a keg isn't a fire bolt
   * or a boulder), dmg/speed for damageFor()'s base and the outward kick,
   * splashRadius/splashDmgScale for the falloff. Deliberately more modest
   * than the bomb's own blast — this is a bonus chain-reaction, not a second
   * bomb hiding in every level. */
  const KEG_BLAST = { id:'keg', speed:14.0, dmg:0.55, splashRadius:2.0, splashDmgScale:0.7 };

  /* ── Materials ──────────────────────────────────────────────────────────
   * `family` is what ammo bonuses check (fire vs wood, boulder vs stone) and
   * is shared between a material and its small-rubble version, so a Fire Bolt
   * still triples damage on a small wood chunk.
   *
   * `mergeable` lets the level builder weld a run of the same letter into one
   * rigid body — along a row, and now also through consecutive depth layers,
   * so a wall is one slab rather than a stack of thin plates.
   *
   * `static` replaces the old `hp: Infinity` special case: steel is simply a
   * zero-mass Bullet body, which is both cheaper and less surprising.
   *
   * Colours are CSS custom-property names, read back through the palette so
   * all four colour profiles repaint the 3D world. Anything added here MUST
   * also appear in PALETTE_VARS (see game.js) or it silently comes out grey.
   */
  const MAT = {
    W:{ id:'W', name:'wood beam',         hp: 40,  css:'--wood',   family:'wood',  mergeable:true },
    S:{ id:'S', name:'stone block',       hp: 90,  css:'--stone',  family:'stone', mergeable:true },
    I:{ id:'I', name:'glass pane',        hp: 12,  css:'--glass',  family:'glass', mergeable:true, glass:true },
    /* `shape` gives a material its own silhouette instead of the default box.
       Only ever set on non-mergeable materials — a run of those is always a
       single cell, so a shaped mesh can never be asked to stretch across a
       merged wall (see js/art.js's blockGeometry). Two things the player must
       tell apart have to differ in SHAPE, not just colour. A material that
       only needs a different PROPORTION (a thin board vs a full cube) does
       NOT need `shape` — the plain `new THREE.BoxGeometry(w,h,d)` fallthrough
       already stretches to whatever w/h/d js/levels.js hands it, so `B` below
       stays mergeable with a plain box, never `shape:'board'`. */
    T:{ id:'T', name:'powder keg',        hp: 20,  css:'--barrel', explodes:true, shape:'barrel' },
    /* fallDmgMult: the crown model is a person (the tyrant), not a slab of
       stone — a fall that only chips a stone block should kill him. Scales
       ONLY the impact/crush damage he takes (see js/game.js's
       stepPhysicsWithImpacts/applyCrush), not IMPACT_THRESHOLD itself, so
       what counts as "a real fall" — and every other material's collapse
       survivability, already covered by auditLevels()'s standing-castle
       check — stays exactly as tuned. 3x makes a single castle-layer's worth
       of fall height (~3 units) reliably lethal on its own; confirmed
       against auditLevels()/auditReach() still passing, not just eyeballed. */
    K:{ id:'K', name:'crown',             hp: 25,  css:'--crown',  crown:true, shape:'crown', fallDmgMult: 3.0 },
    X:{ id:'X', name:'steel girder',      hp: Infinity, css:'--steel', mergeable:true, static:true },
    /* `plank` is read only by js/levels.js's parser (matches the existing
       small/static/glass/explodes pattern) — it thins the block to
       PLANK_FRAC of a cell and sits it flush on its own row's floor instead
       of filling the cell, for ceilings/floors/bridges. See js/levels.js and
       the board authoring rule in README.md. */
    B:{ id:'B', name:'timber board',      hp: 24,  css:'--wood',   family:'wood',  mergeable:true, plank:true },
    w:{ id:'w', name:'small wood chunk',  hp: 14,  css:'--wood',   family:'wood',  small:true },
    s:{ id:'s', name:'small stone chunk', hp: 30,  css:'--stone',  family:'stone', small:true },
    i:{ id:'i', name:'small glass shard', hp: 5,   css:'--glass',  family:'glass', small:true, glass:true }
  };

  /* ── Ballistics ─────────────────────────────────────────────────────────
   * Given a muzzle speed and a target distance, what elevation lands there?
   *
   * The target sits `h` BELOW the muzzle (the ground), so the flat-ground
   * formula would be wrong by a little at every range. The exact solution for
   * hitting a point (d, -h) relative to the launch point is:
   *
   *   tan(phi) = ( v^2 +/- sqrt( v^4 - g*(g*d^2 - 2*h*v^2) ) ) / (g*d)
   *
   * The minus root is the flat, direct shot; the plus root is the lob. Both
   * land in the same place by different paths, which is the whole tactical
   * point of the ammunition list.
   *
   * Returns null when the range is genuinely out of reach, so callers have to
   * deal with it rather than silently firing at NaN degrees. This includes the
   * direct-fire (non-lob) root going negative: a flat shot fired dead level
   * from muzzle height already lands at minRange() below, so nothing closer
   * than that is reachable without pointing the ballista downward, which we
   * don't do. Flooring that case to phi=0 used to fire anyway and land at
   * minRange() regardless of the requested distance — silently desyncing the
   * shot from the range meter. Returning null instead makes that an honest
   * "can't reach this with this ammo", same as the too-far case.
   */
  function solveElevation(speed, dist, lob, height) {
    const g = CFG.GRAVITY;
    const h = height === undefined ? CFG.MUZZLE_Y : height;
    const d = dist;
    if (!(d > 0) || !(speed > 0)) return null;

    const v2 = speed * speed;
    const disc = v2 * v2 - g * (g * d * d - 2 * h * v2);
    if (disc < 0) return null;                 // out of reach at this speed

    const root = Math.sqrt(disc);
    const tan = ((lob ? v2 + root : v2 - root)) / (g * d);
    const phi = Math.atan(tan);
    if (!isFinite(phi) || phi < 0) return null;
    return phi;
  }

  /** The furthest this speed can reach at all, from muzzle height to ground. */
  function maxRange(speed, height) {
    const g = CFG.GRAVITY;
    const h = height === undefined ? CFG.MUZZLE_Y : height;
    const v2 = speed * speed;
    return Math.sqrt(v2 * v2 + 2 * g * h * v2) / g;
  }

  /**
   * The nearest a dead-level direct shot can land — a flat trajectory fired at
   * phi=0 still carries forward this far before gravity brings it down from
   * muzzle height. Only meaningful for non-lob ammo; a lob shot can drop
   * almost straight down, so it has no comparable floor.
   */
  function minRange(speed, height) {
    const g = CFG.GRAVITY;
    const h = height === undefined ? CFG.MUZZLE_Y : height;
    return speed * Math.sqrt(2 * h / g);
  }

  /**
   * Where a shot actually ends up, integrated rather than solved, so this can
   * be compared against solveElevation() as a check on the algebra. Used by
   * the audit, not by the game loop.
   */
  function flatRangeOf(speed, phi, height) {
    const g = CFG.GRAVITY;
    const h = height === undefined ? CFG.MUZZLE_Y : height;
    const vy = speed * Math.sin(phi);
    const vh = speed * Math.cos(phi);
    // Time to fall from h with initial upward vy: solve h + vy*t - g/2 t^2 = 0
    const t = (vy + Math.sqrt(vy * vy + 2 * g * h)) / g;
    return vh * t;
  }

  /* ── Per-level meter windows ────────────────────────────────────────────
   * Both meters are scaled to the castle in front of the player rather than
   * being fixed, which is what stops either one having dead travel at an end.
   * The README's old "check a part-charged shot can still reach the near face"
   * authoring rule is satisfied by construction now.
   */
  function castleBounds(level) {
    const cols = level._cols || 1;
    const deep = level._depth || 1;
    return {
      halfWidth: cols / 2,
      near: level.dist - deep / 2,     // downrange distance to the front face
      far : level.dist + deep / 2,
      centre: level.dist
    };
  }

  /** Furthest of every non-lob ammo's minRange() — the closest distance ANY
   *  unlocked ammo can be relied on to hit. Lob ammo has no such floor, so
   *  only flat ammo constrains this. */
  function flatMinReach() {
    let worst = 0;
    for (const a of AMMO) {
      if (a.lob) continue;
      worst = Math.max(worst, minRange(a.speed));
    }
    return worst;
  }

  function rangeWindow(level) {
    const b = castleBounds(level);
    const min = Math.max(3, b.near - CFG.RANGE_PAD_NEAR, flatMinReach());
    return {
      min: min,
      max: Math.max(min, b.far + CFG.RANGE_PAD_FAR)
    };
  }

  /** Half-angle of the lateral sweep, in radians. */
  function yawLimit(level) {
    const b = castleBounds(level);
    const reach = b.halfWidth + CFG.YAW_PAD_CELLS;
    const deg = Math.max(CFG.YAW_MIN_HALF_DEG,
                         Math.atan2(reach, Math.max(1, b.centre)) * 180 / Math.PI);
    return deg * Math.PI / 180;
  }

  /** Meter percentage -> downrange distance, and back. */
  function pctToRange(level, pct) {
    const w = rangeWindow(level);
    return w.min + (U.clamp(pct, 0, 100) / 100) * (w.max - w.min);
  }
  function rangeToPct(level, dist) {
    const w = rangeWindow(level);
    const span = w.max - w.min;
    return span <= 0 ? 0 : U.clamp((dist - w.min) / span * 100, 0, 100);
  }

  /**
   * Select-target aim mode's whole solver: given a block's world x/z, what
   * yaw and range meter reading points the ballista straight at it? The
   * muzzle sits at the world origin (see launchFor() above), so this is
   * just the inverse of the polar coordinates the sweep/charge meters
   * already work in — `withinYaw` tells the caller whether the sweep could
   * physically reach that far around without the yaw meter clamping it.
   */
  function solveTarget(level, x, z) {
    const yawRad = Math.atan2(x, -z);
    const dist = Math.sqrt(x * x + z * z);
    return { yawRad: yawRad, dist: dist, rangePct: rangeToPct(level, dist),
             withinYaw: Math.abs(yawRad) <= yawLimit(level) };
  }

  /**
   * Full launch state for a shot. `yaw` is radians, + to the player's right.
   * Returns null if the requested range is unreachable, which the caller must
   * handle — though rangeWindow() is built so it never should be.
   */
  function launchFor(ammo, level, yaw, rangePct) {
    const dist = pctToRange(level, rangePct);
    const phi = solveElevation(ammo.speed, dist, ammo.lob);
    if (phi === null) return null;
    const vh = ammo.speed * Math.cos(phi);
    return {
      ammo: ammo,
      dist: dist,
      yaw: yaw,
      elevation: phi,
      pos: { x: 0, y: CFG.MUZZLE_Y, z: 0 },
      vel: {
        x: vh * Math.sin(yaw),
        y: ammo.speed * Math.sin(phi),
        z: -vh * Math.cos(yaw)
      }
    };
  }

  /**
   * Damage a bolt does to a block. Deliberately takes NO velocity or meter
   * value — this is the "always powerful enough" rule expressed as code. The
   * audit asserts the result is identical at every range.
   */
  function damageFor(ammo, mat) {
    let d = 34 * ammo.dmg;
    if (ammo.id === 'fire'    && mat.family === 'wood')  d *= 3.0;
    if (ammo.id === 'boulder' && mat.family === 'stone') d *= 1.6;
    return d;
  }

  return {
    CFG, AMMO, MAT, KEG_BLAST,
    solveElevation, maxRange, minRange, flatRangeOf,
    castleBounds, rangeWindow, yawLimit,
    pctToRange, rangeToPct, launchFor, damageFor, solveTarget
  };
})();
