/**
 * Benny's Ballista — Ammo.js (Bullet) physics adapter.
 *
 * The game deals in plain Three.js meshes and world-unit numbers; nothing
 * outside this file touches Ammo's raw API. Every block is a real dynamic
 * rigid body — there is no hand-written "is this held up" check anywhere.
 * Bullet's own contact solver is what keeps a well-built castle standing and
 * what makes a knocked-out one topple and crash into its neighbours, exactly
 * as the 2D version's Box2D adapter (js/ballista-physics.js, now retired)
 * worked.
 *
 * ── Loading ──────────────────────────────────────────────────────────────
 * `window.Ammo` (from js/ammo.js) is an Emscripten module factory. It hands
 * back a `.then(cb)` of its own rather than a real Promise — `.then=function
 * (a){if(d.calledRun)a(d);else{...}}` — with no `catch`, no rejection path,
 * and (confirmed while building this) `await`-ing it directly hangs rather
 * than resolving, in at least some environments. init() below wraps that
 * callback in a real `new Promise(...)` and never `await`s the raw factory
 * — chain `.then()`/`.catch()` off `RT.physics.init()` itself, which is a
 * genuine native Promise, same as Bowling's own `Ammo().then((Ammo) => ...)`
 * already does.
 *
 * ── Memory discipline ────────────────────────────────────────────────────
 * Ammo objects are compiled C++ wrapped in a thin JS shell — they are NOT
 * garbage-collected, and a leaked one just sits in the Emscripten heap
 * forever. Read-only accessors that hand back a reference to memory Bullet
 * already owns (getCenterOfMassTransform(), getOrigin(), getRotation(),
 * getLinearVelocity()) are cheap to call every frame. Anything this file
 * constructs itself with `new Ammo.btWhatever(...)` is different: those are
 * either kept once and reused forever (the scratch vectors/transform below,
 * used for every block this game creates across every level of a session)
 * or explicitly destroyed the moment their job is done. A single level here
 * can create and destroy dozens of bodies, and a session loads a dozen
 * levels — the leak Bowling's static-track setup accepts once at boot would
 * accumulate badly here.
 */
RT.physics = (function () {
  'use strict';

  const CFG = RT.data.CFG;

  let Ammo = null;    // the resolved module, once init() has awaited it
  let world = null;
  let groundBody = null;

  /* Reused for every block's construction — Bullet copies the values it's
     given (into the shape, the motion state, the construction info), so one
     scratch instance is safe to hand to many bodies in a row. Never reused
     *across* frames of live simulation; only across the synchronous
     construction of one body. Created in init(), once Ammo exists. */
  let _v0, _v1, _t0;

  /* Shapes are cached by size, the same way art.js caches materials by
     colour — most blocks in a level share a handful of sizes (the base
     cell, and whatever merged-run widths a level uses), so this keeps shape
     count far below block count. Shared, so destroyBlock() never disposes
     one — they live for the session. */
  const shapeCache = {};
  function boxShape(w, h, d) {
    const key = w + '|' + h + '|' + d;
    let s = shapeCache[key];
    if (!s) {
      s = new Ammo.btBoxShape(new Ammo.btVector3(w / 2, h / 2, d / 2));
      shapeCache[key] = s;
    }
    return s;
  }

  function init() {
    return new Promise((resolve) => {
      window.Ammo().then((resolved) => {
        Ammo = resolved;

        _v0 = new Ammo.btVector3(0, 0, 0);
        _v1 = new Ammo.btVector3(0, 0, 0);
        _t0 = new Ammo.btTransform();

        const collisionConfig = new Ammo.btDefaultCollisionConfiguration();
        const dispatcher = new Ammo.btCollisionDispatcher(collisionConfig);
        const broadphase = new Ammo.btDbvtBroadphase();
        const solver = new Ammo.btSequentialImpulseConstraintSolver();
        world = new Ammo.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, collisionConfig);

        const gravity = new Ammo.btVector3(0, -CFG.GRAVITY, 0);
        world.setGravity(gravity);
        Ammo.destroy(gravity);

        /* One static ground slab, wide enough for every level's whole range
           window plus a margin. Created once and never touched again. */
        const groundShape = new Ammo.btBoxShape(new Ammo.btVector3(200, 0.5, 200));
        const groundTransform = new Ammo.btTransform();
        groundTransform.setIdentity();
        groundTransform.setOrigin(new Ammo.btVector3(0, CFG.GROUND_Y - 0.5, 0));
        const motionState = new Ammo.btDefaultMotionState(groundTransform);
        const zero = new Ammo.btVector3(0, 0, 0);
        const info = new Ammo.btRigidBodyConstructionInfo(0, motionState, groundShape, zero);
        groundBody = new Ammo.btRigidBody(info);
        groundBody.setFriction(CFG.GROUND_FRICTION);
        groundBody.setRestitution(CFG.GROUND_RESTITUTION);
        world.addRigidBody(groundBody);
        Ammo.destroy(info);
        Ammo.destroy(zero);

        resolve();
      });
    });
  }

  /**
   * @param {number} mass  0 makes a static body (steel girders).
   * @returns {Ammo.btRigidBody}
   */
  function addBlock(x, y, z, w, h, d, mass, friction, restitution) {
    const shape = boxShape(w, h, d);

    _t0.setIdentity();
    _v0.setValue(x, y, z);
    _t0.setOrigin(_v0);
    const motionState = new Ammo.btDefaultMotionState(_t0);

    _v1.setValue(0, 0, 0);
    if (mass > 0) shape.calculateLocalInertia(mass, _v1);
    const info = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, _v1);
    const body = new Ammo.btRigidBody(info);
    body.setFriction(friction === undefined ? CFG.BLOCK_FRICTION : friction);
    body.setRestitution(restitution === undefined ? CFG.BLOCK_RESTITUTION : restitution);
    body.setDamping(CFG.LINEAR_DAMPING, CFG.ANGULAR_DAMPING);
    body.setSleepingThresholds(CFG.SLEEP_LINEAR, CFG.SLEEP_ANGULAR);

    world.addRigidBody(body);
    Ammo.destroy(info);
    return body;
  }

  /** The shape is shared (see boxShape() above) and outlives this body, so
   *  only the body's own motion state and the body itself are destroyed. */
  function destroyBlock(body) {
    world.removeRigidBody(body);
    const ms = body.getMotionState();
    if (ms) Ammo.destroy(ms);
    Ammo.destroy(body);
  }

  function step(dt) {
    world.stepSimulation(dt, CFG.MAX_SUBSTEPS, CFG.DT);
  }

  /** Copies a body's live transform onto the mesh that represents it. */
  function sync(mesh, body) {
    const t = body.getCenterOfMassTransform();
    const p = t.getOrigin();
    mesh.position.set(p.x(), p.y(), p.z());
    const q = t.getRotation();
    mesh.quaternion.set(q.x(), q.y(), q.z(), q.w());
  }

  function isAwake(body) {
    return body.isActive();
  }

  function speed(body) {
    const v = body.getLinearVelocity();
    return Math.hypot(v.x(), v.y(), v.z());
  }

  /** Adds a knock (world units/s) on top of whatever velocity the body
   *  already has, and wakes it — used for a direct bolt hit, never by the
   *  general sim. */
  function addVelocity(body, vx, vy, vz) {
    body.activate(true);
    const v = body.getLinearVelocity();
    _v0.setValue(v.x() + vx, v.y() + vy, v.z() + vz);
    body.setLinearVelocity(_v0);
  }

  function dispose() {
    if (!world) return;
    for (const key in shapeCache) { Ammo.destroy(shapeCache[key]); delete shapeCache[key]; }
    if (groundBody) {
      world.removeRigidBody(groundBody);
      Ammo.destroy(groundBody.getMotionState());
      Ammo.destroy(groundBody);
      groundBody = null;
    }
    Ammo.destroy(world);
    world = null;
  }

  return { init, addBlock, destroyBlock, step, sync, speed, isAwake, addVelocity, dispose };
})();
