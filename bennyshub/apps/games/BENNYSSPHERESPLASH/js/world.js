/** Benny's Sphere Splash - the arena: a floating sphere of water inside a stadium bowl.
 *
 * No post-processing library (EffectComposer is not in the hub's vendored Three): the
 * underwater look is built from cheap parts that each cost one draw call -
 *  - the sphere's skin: a Fresnel shader, clear when you look straight out, silver at
 *    a grazing angle, with slow ripples, so the stadium shows through the water;
 *  - caustics: a light pattern computed in the shader of everything that opts in via
 *    addCaustics(material), so swimmers glitter as they cross the light;
 *  - light shafts (additive cones), rising bubbles (Points) and teal depth fog.
 * techBurst() is a technique's sparkle round the player; goalBurst() is the net's part of a goal: bubbles burst out of it, a ring of the
 * scorers' colour spreads across the mouth, the net lights up and the crowd jumps.
 */
SS.world = (function () {
  'use strict';

  const R = 20;                         // sphere radius in metres; the whole pool
  const GOAL_Z = R - 2.2;               // goals hang just inside the skin at the poles
  const uniforms = { uTime: { value: 0 }, uCaustic: { value: 0.32 }, uCheer: { value: 0 } };
  let scene, shafts = [], bubbles, crowd, bubbleTex, goals = [], bursts = [], cheer = 0;

  /* ── caustics, injected into any lit material ─────────────────────────── */
  const CAUSTIC_GLSL = `
    uniform float uTime; uniform float uCaustic; uniform float uCausticSelf; varying vec3 vCWorld;
    float causticAt(vec3 p) {
      vec2 q = p.xz * 0.55 + vec2(p.y * 0.21, -p.y * 0.17);
      float a = sin(q.x + uTime * 0.9) + sin(q.y * 1.3 - uTime * 0.7) + sin((q.x + q.y) * 0.7 + uTime * 1.1);
      float b = sin(q.x * 1.7 - uTime * 0.5) + sin(q.y * 0.9 + uTime * 1.3);
      float c = 1.0 - abs(a * 0.33 + b * 0.25);
      return pow(clamp(c, 0.0, 1.0), 6.0);
    }`;
  /** mat.userData.caustic.value scales the light on this material alone (1 = as everything else). */
  function addCaustics(mat) {
    mat.userData.caustic = { value: 1 };
    mat.onBeforeCompile = shader => {
      shader.uniforms.uTime = uniforms.uTime; shader.uniforms.uCaustic = uniforms.uCaustic; shader.uniforms.uCausticSelf = mat.userData.caustic;
      shader.vertexShader = 'varying vec3 vCWorld;\n' + shader.vertexShader.replace(
        '#include <project_vertex>', '#include <project_vertex>\n  vCWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = CAUSTIC_GLSL + '\n' + shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        'outgoingLight += vec3(0.75, 0.95, 1.0) * causticAt(vCWorld) * uCaustic * uCausticSelf;\n#include <opaque_fragment>');
    };
  }

  /* ── the sphere's skin ─────────────────────────────────────────────────── */
  /* Seen from inside, the skin is the backdrop of every play, so it is also the depth of the
     water: a haze that softens the stadium's tiers behind the swimmers (Bryan picked a light
     one, so the stadium still shows as soft shapes), bright above (the surface) and deeper
     below, so up and down read at a glance. Teal, not blue: blue water hid the blue kits.
     From outside the skin stays clear glass: the near side is a window, and through it the
     far side is the same water (the inside of the skin is always water, the outside glass). */
  const WATER = { haze: 0.55, top: 0xb8f3f0, mid: 0x4fc4c8, deep: 0x2a8fa8, surface: 0.5 };
  const skinU = { uTime: uniforms.uTime, uTint: { value: new THREE.Color(0x1fb3c9) }, uRim: { value: new THREE.Color(0xdff9ff) },
    uHaze: { value: WATER.haze }, uSurface: { value: WATER.surface },
    uTop: { value: new THREE.Color(WATER.top) }, uMid: { value: new THREE.Color(WATER.mid) }, uDeep: { value: new THREE.Color(WATER.deep) } };
  function waterSkin() {
    const mat = new THREE.ShaderMaterial({
      uniforms: skinU,
      vertexShader: `
        varying vec3 vN; varying vec3 vView; varying vec3 vW;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
          vN = normalize(mat3(modelMatrix) * normal); vView = normalize(cameraPosition - w.xyz);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `
        uniform float uTime; uniform vec3 uTint; uniform vec3 uRim;
        uniform float uHaze; uniform float uSurface; uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uDeep;
        varying vec3 vN; varying vec3 vView; varying vec3 vW;
        void main() {
          vec3 n = normalize(vN + 0.06 * vec3(sin(vW.y * 0.9 + uTime), sin(vW.z * 0.8 - uTime * 1.2), sin(vW.x * 0.7 + uTime * 0.8)));
          float f = pow(1.0 - abs(dot(n, vView)), 2.2);
          float glint = pow(max(0.0, sin(vW.x * 1.3 + vW.y * 0.7 + uTime * 1.5)), 12.0) * 0.35;
          vec3 col = mix(uTint, uRim, f) + glint;
          float a = mix(0.16, 0.85, f);
          // Inside: the water's own colour, by height on the sphere.
          float h = normalize(vW).y;
          vec3 depth = h > 0.0 ? mix(uMid, uTop, smoothstep(0.0, 0.85, h)) : mix(uMid, uDeep, smoothstep(0.0, -0.8, h));
          float sheen = pow(max(0.0, sin(vW.x * 0.35 + uTime * 0.6) * sin(vW.z * 0.3 - uTime * 0.45)), 3.0);
          depth += vec3(0.9, 1.0, 1.0) * uSurface * smoothstep(0.55, 0.95, h) * (0.25 + 0.35 * sheen);
          // No glint inside: its bands read as rings across the top of the picture.
          gl_FragColor = gl_FrontFacing ? vec4(col, a) : vec4(depth, max(a, uHaze));
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const skin = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), mat);
    skin.renderOrder = 10;
    return skin;
  }

  /* ── goals: big triangular frames, one per pole ───────────────────────── */
  function goal(z, colour) {
    const g = new THREE.Group();
    const s = 3.6, pts = [0, 1, 2].map(i => new THREE.Vector3(Math.sin(i * 2.094) * s, Math.cos(i * 2.094) * s, 0));
    const frameMat = new THREE.MeshToonMaterial({ color: colour, gradientMap: null }); addCaustics(frameMat);
    for (let i = 0; i < 3; i++) {
      const a = pts[i], b = pts[(i + 1) % 3], len = a.distanceTo(b);
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, len, 12), frameMat);
      bar.position.copy(a).add(b).multiplyScalar(0.5);
      bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      g.add(bar);
    }
    const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.y)));
    const net = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
    g.add(net);
    g.position.z = z;
    goals.push({ group: g, net, z, colour: new THREE.Color(colour), flash: 0, shake: 0 });
    return g;
  }

  /* ── a goal: the net bursts ───────────────────────────────────────────────
     One flash, never a flicker: the net lights up in the scorers' colour and fades over
     a second and a half. ~140 bubbles (white and the team colour) fly out of where the
     ball went in, slow down in the water and rise; a ring spreads across the goal mouth;
     the frame shudders; the crowd jumps for four seconds. */
  const BURST_LIFE = 2.4, RING_LIFE = 0.8;
  function goalBurst(at, colour, opts) {
    const gl = goals.reduce((a, b) => Math.abs(b.z - at.z) < Math.abs(a.z - at.z) ? b : a, goals[0]);
    const into = Math.sign(gl.z) || 1;                              // the pool is the other way: -into
    gl.flash = 1; gl.shake = 1; gl.net.material.color.set(colour);
    // Out of the net into the pool: a wide cone, mostly away from the goal. A replay's
    // camera is right at the net, so its burst has no ring (it would fill the view).
    burst(at, colour, { n: 140, cone: new THREE.Vector3(0, 0, -into), spread: 1.15, speed: [4, 11], size: 0.5,
      ring: !(opts && opts.ring === false), ringAt: new THREE.Vector3(at.x, at.y, at.z - into * 0.3), ringGrow: 2.6 });
    cheer = 4;
  }
  /* ── a technique: a sparkle burst round the player who used it ─────────────
     Its colour (game.js picks it: violet stings, blue snoozes, gold blasts...), all
     round them, smaller and quicker than a goal's; the ring faces the camera. */
  function techBurst(at, colour, cameraQuat) {
    burst(at, colour, { n: 70, cone: null, speed: [2.5, 5.5], size: 0.38, ring: true, ringQuat: cameraQuat, ringGrow: 0.9, mix: 2 });
  }
  /** Bubbles flying out of `at` (a cone round o.cone, or every way), and a spreading ring. */
  function burst(at, colour, o) {
    const n = o.n, fx = new THREE.Color(colour), white = new THREE.Color(0xffffff), c = new THREE.Color();
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), vel = [];
    const q = o.cone ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), o.cone) : null;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = at.x; pos[i * 3 + 1] = at.y; pos[i * 3 + 2] = at.z;
      const sp = o.speed[0] + Math.random() * (o.speed[1] - o.speed[0]);
      const v = new THREE.Vector3();
      if (q) {
        const a = Math.random() * Math.PI * 2, spread = Math.random() * o.spread;
        v.set(Math.cos(a) * Math.sin(spread), Math.sin(a) * Math.sin(spread), Math.cos(spread)).applyQuaternion(q);
        v.y += 0.25;
      } else v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      vel.push(v.multiplyScalar(sp));
      c.copy(i % (o.mix || 3) ? white : fx).toArray(col, i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: o.size, map: bubbleTex, vertexColors: true, transparent: true,
      opacity: 1, depthWrite: false, sizeAttenuation: true }));
    pts.frustumCulled = false; pts.renderOrder = 15;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.15, 48), new THREE.MeshBasicMaterial({ color: fx, transparent: true,
      opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    ring.position.copy(o.ringAt || at); ring.renderOrder = 15;
    if (o.ringQuat) ring.quaternion.copy(o.ringQuat);
    ring.visible = !!o.ring;
    scene.add(pts, ring);
    bursts.push({ t: 0, pts, vel, ring, ringOn: ring.visible, grow: o.ringGrow || 2.6 });
  }
  function updateGoals(dt) {
    goals.forEach(g => {
      if (g.flash > 0) {
        g.flash = Math.max(0, g.flash - dt / 1.5);
        g.net.material.opacity = 0.22 + 0.6 * g.flash;
        if (!g.flash) g.net.material.color.copy(g.colour);
      }
      if (g.shake > 0) {
        g.shake = Math.max(0, g.shake - dt / 0.9);
        const k = g.shake * g.shake * 0.18;
        g.group.position.set(Math.sin(g.shake * 47) * k, Math.sin(g.shake * 61) * k, g.z);
      }
    });
    for (let b = bursts.length - 1; b >= 0; b--) {
      const br = bursts[b];
      br.t += dt;
      const a = br.pts.geometry.attributes.position.array, drag = Math.exp(-dt * 2.6);
      br.vel.forEach((v, i) => {
        v.multiplyScalar(drag); v.y += dt * 1.6;                       // the water slows them; then they rise
        a[i * 3] += v.x * dt; a[i * 3 + 1] += v.y * dt; a[i * 3 + 2] += v.z * dt;
      });
      br.pts.geometry.attributes.position.needsUpdate = true;
      br.pts.material.opacity = 1 - Math.max(0, (br.t - BURST_LIFE * 0.5) / (BURST_LIFE * 0.5));
      const r = Math.min(1, br.t / RING_LIFE);
      br.ring.scale.setScalar(1 + r * br.grow);       // a goal's: out to the goal's own size
      br.ring.material.opacity = 0.9 * (1 - r);
      br.ring.visible = br.ringOn && r < 1;
      if (br.t >= BURST_LIFE) {
        scene.remove(br.pts, br.ring);
        br.pts.geometry.dispose(); br.pts.material.dispose(); br.ring.geometry.dispose(); br.ring.material.dispose();
        bursts.splice(b, 1);
      }
    }
    if (cheer > 0) cheer = Math.max(0, cheer - dt);
    uniforms.uCheer.value = Math.min(1, cheer / 1.2);
  }

  /* ── light shafts from the surface above ──────────────────────────────── */
  function lightShafts() {
    const mat = new THREE.MeshBasicMaterial({ color: 0xbff6ff, transparent: true, opacity: 0.07,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    for (let i = 0; i < 7; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(2.2 + Math.random() * 2, R * 2.1, 24, 1, true), mat);
      cone.position.set((Math.random() - 0.5) * R, 0, (Math.random() - 0.5) * R);
      cone.userData.phase = Math.random() * 6.28;
      scene.add(cone); shafts.push(cone);
    }
  }

  /* ── bubbles ──────────────────────────────────────────────────────────── */
  function makeBubbles(n) {
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) randomInSphere(pos, i, R * 0.95);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'); g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 6;
    g.beginPath(); g.arc(32, 32, 24, 0, Math.PI * 2); g.stroke();
    const tex = bubbleTex = new THREE.CanvasTexture(c);
    return new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.28, map: tex, transparent: true,
      opacity: 0.65, depthWrite: false, sizeAttenuation: true }));
  }
  function randomInSphere(arr, i, r) {
    let x, y, z;
    do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; } while (x * x + y * y + z * z > 1);
    arr[i * 3] = x * r; arr[i * 3 + 1] = y * r; arr[i * 3 + 2] = z * r;
  }

  /* ── the stadium bowl, pylons and crowd ───────────────────────────────── */
  function stadium() {
    const g = new THREE.Group();
    const tiers = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      tiers.push(new THREE.Vector2(R + 9 + t * 34, -R - 6 + t * 30 + (i % 2) * 1.2));
    }
    const bowlMat = new THREE.MeshToonMaterial({ color: 0x3b3f63 });
    const bowl = new THREE.Mesh(new THREE.LatheGeometry(tiers, 96), bowlMat);
    bowlMat.side = THREE.DoubleSide;
    g.add(bowl);
    // Four pylons holding the sphere up from the courtyard floor.
    const pylonMat = new THREE.MeshToonMaterial({ color: 0xc9b37e });
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.6, 22, 12), pylonMat);
      p.position.set(Math.cos(a) * (R + 3), -R - 1, Math.sin(a) * (R + 3));
      p.rotation.z = Math.cos(a) * 0.35; p.rotation.x = -Math.sin(a) * 0.35;
      g.add(p);
    }
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R + 12, 64), new THREE.MeshToonMaterial({ color: 0x5b6b8a }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -R - 8; g.add(floor);
    g.add(makeCrowd(tiers));
    return g;
  }
  function makeCrowd(tiers) {
    const per = 260, rows = tiers.length - 2, n = per * rows;
    const geo = new THREE.PlaneGeometry(0.9, 1.3);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: false });
    mat.onBeforeCompile = shader => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace('#include <begin_vertex>',
        `#include <begin_vertex>
         float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
         transformed.y += max(0.0, sin(uTime * 3.0 + ph)) * 0.35;`);
    };
    crowd = new THREE.InstancedMesh(geo, mat, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), c = new THREE.Color();
    // Muted on purpose: the swimmers must be the brightest, most saturated things on screen.
    const palette = [0x6c5a78, 0x7d6a55, 0x55667d, 0x8a7560, 0x5f5f73, 0x736070, 0x6b7a6b];
    let k = 0;
    for (let r = 1; r <= rows; r++) {
      const t = tiers[r];
      for (let i = 0; i < per; i++, k++) {
        const a = (i / per) * Math.PI * 2 + r * 0.13;
        p.set(Math.cos(a) * (t.x - 0.4), t.y + 0.9, Math.sin(a) * (t.x - 0.4));
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a - Math.PI / 2);
        m.compose(p, q, s); crowd.setMatrixAt(k, m);
        crowd.setColorAt(k, c.set(palette[(i * 7 + r * 3) % palette.length]));
      }
    }
    return crowd;
  }

  function sky() {
    const c = document.createElement('canvas'); c.width = 4; c.height = 256;
    const g = c.getContext('2d'), grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#2d6bd8'); grad.addColorStop(0.5, '#8fd3ff'); grad.addColorStop(1, '#ffe7c2');
    g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }));
  }

  function build(targetScene) {
    scene = targetScene;
    scene.fog = new THREE.FogExp2(0x0e6f86, 0.011);
    scene.background = new THREE.Color(0x0e6f86);
    scene.add(new THREE.HemisphereLight(0xcff6ff, 0x0b3a52, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3); sun.position.set(12, 30, 8); scene.add(sun);
    scene.add(sky(), stadium(), waterSkin());
    scene.add(goal(GOAL_Z, 0xff8a3d), goal(-GOAL_Z, 0xff4f9a));
    lightShafts();
    bubbles = makeBubbles(420); scene.add(bubbles);
  }

  function update(dt, t) {
    uniforms.uTime.value = t;
    updateGoals(dt);
    shafts.forEach(s => { s.rotation.z = Math.sin(t * 0.2 + s.userData.phase) * 0.12; s.material.opacity = 0.06 + Math.sin(t * 0.5 + s.userData.phase) * 0.02; });
    if (bubbles) {
      const a = bubbles.geometry.attributes.position.array;
      for (let i = 0; i < a.length; i += 3) {
        a[i + 1] += dt * (0.6 + (i % 7) * 0.08); a[i] += Math.sin(t * 2 + i) * dt * 0.05;
        if (a[i] * a[i] + a[i + 1] * a[i + 1] + a[i + 2] * a[i + 2] > R * R * 0.9) { randomInSphere(a, i / 3, R * 0.9); a[i + 1] = -Math.abs(a[i + 1]); }
      }
      bubbles.geometry.attributes.position.needsUpdate = true;
    }
  }

  /* ── the ball's trail ──────────────────────────────────────────────────────
     A ribbon of light behind a ball that is in the air or loose, so a low-vision player
     can follow a pass or a shot and see where it came from. It is built from where the
     ball is DRAWN each frame, so slow motion and replays get it for free. Length is in
     metres of path, not seconds, so slow motion does not shrink it. Caught, it shrinks
     away into the hands; a jump (a kickoff reset) clears it. */
  function makeTrail(scene, { length = 4.5, width = 0.4, colour = 0xffc21a, core = 0xfffbe6 } = {}) {
    const MAX = 80, STEP = 0.05;
    const pos = new Float32Array(MAX * 2 * 3), col = new Float32Array(MAX * 2 * 4);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    const idx = [];
    for (let i = 0; i < MAX - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    // Solid colour, not additive light: light washes out against the bright water.
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, fog: false }));
    mesh.frustumCulled = false; mesh.renderOrder = 5;
    scene.add(mesh);
    const pts = [], base = new THREE.Color(colour), hot = new THREE.Color(core), c = new THREE.Color();
    let budget = 0;
    const t = new THREE.Vector3(), side = new THREE.Vector3(), view = new THREE.Vector3();
    function clear() { pts.length = 0; budget = 0; geo.setDrawRange(0, 0); }
    function update(dt, ball, camera, free) {
      if (pts.length && pts[0].distanceTo(ball) > 4) clear();           // teleported
      if (!pts.length || pts[0].distanceTo(ball) > STEP) pts.unshift(ball.clone());
      else pts[0].copy(ball);
      budget = free ? length : Math.max(0, budget - dt * 14);           // caught: shrink into the hands
      let run = 0;                                                      // trim the tail to the budget
      for (let i = 1; i < pts.length; i++) {
        const d = pts[i].distanceTo(pts[i - 1]);
        if (run + d > budget) {
          if (budget > run) { pts[i].lerpVectors(pts[i - 1], pts[i], (budget - run) / d); pts.length = i + 1; } else pts.length = i;
          break;
        }
        run += d;
      }
      if (pts.length > MAX) pts.length = MAX;
      const n = pts.length;
      if (n < 2) { geo.setDrawRange(0, 0); return; }
      let along = 0;
      for (let i = 0; i < n; i++) {
        if (i) along += pts[i].distanceTo(pts[i - 1]);
        const k = Math.max(0, 1 - along / length);                      // 1 at the ball, 0 at the tail
        t.subVectors(pts[Math.max(0, i - 1)], pts[Math.min(n - 1, i + 1)]).normalize();
        view.subVectors(camera.position, pts[i]).normalize();
        side.crossVectors(t, view).normalize().multiplyScalar(width * 0.5 * Math.sqrt(k));
        pos.set([pts[i].x + side.x, pts[i].y + side.y, pts[i].z + side.z, pts[i].x - side.x, pts[i].y - side.y, pts[i].z - side.z], i * 6);
        c.copy(base).lerp(hot, Math.max(0, k * 2 - 1));                // white-hot at the ball, gold behind
        const a = Math.min(1, k * 1.6);
        col.set([c.r, c.g, c.b, a, c.r, c.g, c.b, a], i * 8);
      }
      geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
      geo.setDrawRange(0, (n - 1) * 6);
    }
    return { update, clear, mesh };
  }

  return { build, update, addCaustics, goalBurst, techBurst, makeTrail, R, GOAL_Z };
})();
