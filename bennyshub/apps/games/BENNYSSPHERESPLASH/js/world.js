/** Benny's Sphere Splash - the arena: a floating sphere of water inside a stadium bowl.
 *
 * No post-processing library (EffectComposer is not in the hub's vendored Three): the
 * underwater look is built from cheap parts that each cost one draw call -
 *  - the sphere's skin: a Fresnel shader, clear when you look straight out, silver at
 *    a grazing angle, with slow ripples, so the stadium shows through the water;
 *  - caustics: a light pattern computed in the shader of everything that opts in via
 *    addCaustics(material), so swimmers glitter as they cross the light;
 *  - light shafts (additive cones), rising bubbles (Points) and teal depth fog.
 */
SS.world = (function () {
  'use strict';

  const R = 20;                         // sphere radius in metres; the whole pool
  const GOAL_Z = R - 2.2;               // goals hang just inside the skin at the poles
  const uniforms = { uTime: { value: 0 }, uCaustic: { value: 0.32 } };
  let scene, shafts = [], bubbles, crowd;

  /* ── caustics, injected into any lit material ─────────────────────────── */
  const CAUSTIC_GLSL = `
    uniform float uTime; uniform float uCaustic; varying vec3 vCWorld;
    float causticAt(vec3 p) {
      vec2 q = p.xz * 0.55 + vec2(p.y * 0.21, -p.y * 0.17);
      float a = sin(q.x + uTime * 0.9) + sin(q.y * 1.3 - uTime * 0.7) + sin((q.x + q.y) * 0.7 + uTime * 1.1);
      float b = sin(q.x * 1.7 - uTime * 0.5) + sin(q.y * 0.9 + uTime * 1.3);
      float c = 1.0 - abs(a * 0.33 + b * 0.25);
      return pow(clamp(c, 0.0, 1.0), 6.0);
    }`;
  function addCaustics(mat) {
    mat.onBeforeCompile = shader => {
      shader.uniforms.uTime = uniforms.uTime; shader.uniforms.uCaustic = uniforms.uCaustic;
      shader.vertexShader = 'varying vec3 vCWorld;\n' + shader.vertexShader.replace(
        '#include <project_vertex>', '#include <project_vertex>\n  vCWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = CAUSTIC_GLSL + '\n' + shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        'outgoingLight += vec3(0.75, 0.95, 1.0) * causticAt(vCWorld) * uCaustic;\n#include <opaque_fragment>');
    };
  }

  /* ── the sphere's skin ─────────────────────────────────────────────────── */
  function waterSkin() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: uniforms.uTime, uTint: { value: new THREE.Color(0x1fb3c9) }, uRim: { value: new THREE.Color(0xdff9ff) } },
      vertexShader: `
        varying vec3 vN; varying vec3 vView; varying vec3 vW;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
          vN = normalize(mat3(modelMatrix) * normal); vView = normalize(cameraPosition - w.xyz);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `
        uniform float uTime; uniform vec3 uTint; uniform vec3 uRim;
        varying vec3 vN; varying vec3 vView; varying vec3 vW;
        void main() {
          vec3 n = normalize(vN + 0.06 * vec3(sin(vW.y * 0.9 + uTime), sin(vW.z * 0.8 - uTime * 1.2), sin(vW.x * 0.7 + uTime * 0.8)));
          float f = pow(1.0 - abs(dot(n, vView)), 2.2);
          float glint = pow(max(0.0, sin(vW.x * 1.3 + vW.y * 0.7 + uTime * 1.5)), 12.0) * 0.35;
          vec3 col = mix(uTint, uRim, f) + glint;
          gl_FragColor = vec4(col, mix(0.16, 0.85, f));
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
    return g;
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
    const tex = new THREE.CanvasTexture(c);
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

  return { build, update, addCaustics, R, GOAL_Z };
})();
