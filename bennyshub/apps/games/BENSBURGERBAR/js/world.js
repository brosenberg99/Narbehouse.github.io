/** Ben's Burger Bar - the kitchen in 3D, as box art (M1 greybox; the cel-shaded diner is M3).
 *
 *  World.sync(kitchen, customer) redraws the food from the kitchen state, which is plain
 *  JSON (js/core/items.js), so what is on screen is always what the rules say. Each
 *  station has a fixed close-up camera; moving between them glides, or cuts with Motion
 *  Reduced. The scan's targets are the things themselves: every bin is labelled and
 *  holds what it gives, and the screens pin their labels and choice plates to the 3D
 *  objects (World.pin). They are DOM elements placed from projected points every
 *  frame, so they stay big and readable at any distance.
 *
 *  Doneness shows as colour AND marks: a cooked face gets one grill line per stage, so
 *  colour is never the only signal. Names here (patty, cheese...) are only how things
 *  look; what they do comes from the pack's traits, never from this file.
 */
(function () {
  'use strict';
  const pack = BBPacks.diner;
  const hubGraphics = NarbeGraphics.openGame('bensburgerbar');

  /* ── where things are ─────────────────────────────────────────────────── */
  // M1 builds the grill, the board and the counter (DESIGN.md "Milestones").
  const PLACES = {
    grill:   { x: -5, top: 'grill' },
    board:   { x: 0, top: 'board' },
    counter: { x: 5, top: 'counter' },
  };
  const TOP_Y = 0.92, WIDTH = 3.4;
  const CAMS = {
    grill:   { pos: [-5, 3.0, 3.2], at: [-5, 0.8, -0.1] },
    board:   { pos: [0, 3.0, 3.2], at: [0, 0.8, -0.1] },
    counter: { pos: [5, 2.4, 3.1], at: [5, 1.15, -0.7] },
  };
  const GLIDE_S = 0.6;

  /* ── how things look ──────────────────────────────────────────────────── */
  const LOOK = {
    bun: 0xe2a75c, cheese: 0xffc82e, lettuce: 0x5dbb3f, tomato: 0xe0422f,
    pickles: 0x6f9a32, onion: 0xf1ead8, ketchup: 0xc8231a, mustard: 0xf2c21b, mayo: 0xf8f3e3,
    plate: 0xfafafa, tray: 0x9b5a2e,
  };
  // Raw to well past done, by stage index; Burnt is nearly black.
  const COOK = {
    patty: [0xe48b86, 0xc66a62, 0xa4524a, 0x8a4c34, 0x6c3d26, 0x45291a, 0x161010],
    bacon: [0xf0a3a0, 0xc8605a, 0x8f3d26, 0x4c2412, 0x161010],
  };
  const lambert = c => new THREE.MeshLambertMaterial({ color: c });
  const mats = new Map();
  const mat = c => { if (!mats.has(c)) mats.set(c, lambert(c)); return mats.get(c); };
  const MARK = mat(0x1a0e08);

  let renderer, scene, camera, wrap, layer, frameEl;
  const food = new THREE.Group(), bins = new THREE.Group();
  const keyed = new Map();            // 'obj:<uid>' | 'bin:<id>' | 'customer' -> Object3D
  const tags = [];                    // the customer's name tag: { el, point, key }
  const pins = new Map();             // el -> { key, how }: screen elements that follow a thing
  const binLabels = new Map();        // bin key -> its label element
  let customerMesh = null, echo = null;
  let cam = { from: null, to: null, t: 1 };
  let last = 0, reduced = () => document.body.dataset.motion === 'reduced';

  /* ── the room ─────────────────────────────────────────────────────────── */
  function box(w, h, d, c) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c)); }
  function cyl(r, h, c, seg) { return new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg || 28), mat(c)); }

  function room() {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 20), mat(0xd9cbb6));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const wall = box(40, 6, 0.2, 0xe9d7b0); wall.position.set(0, 3, -2.8); scene.add(wall);
    const stripe = box(40, 0.35, 0.22, 0xc8322a); stripe.position.set(0, 1.6, -2.78); scene.add(stripe);
    for (const sid of Object.keys(PLACES)) {
      const x = PLACES[sid].x;
      const base = box(WIDTH, TOP_Y - 0.06, 1.7, sid === 'counter' ? 0xb53a2c : 0x8d9aa3);
      base.position.set(x, (TOP_Y - 0.06) / 2, 0); scene.add(base);
      const topC = { grill: 0x2b2b2e, board: 0xc89b62, counter: 0xf3efe6 }[sid];
      const top = box(WIDTH + 0.08, 0.06, 1.78, topC); top.position.set(x, TOP_Y - 0.03, 0); scene.add(top);
      if (sid === 'grill') for (let i = 0; i < 9; i++) {
        const bar = box(WIDTH - 0.4, 0.015, 0.03, 0x555559); bar.position.set(x, TOP_Y + 0.005, -0.5 + i * 0.12); scene.add(bar);
      }
    }
  }

  /* ── food ─────────────────────────────────────────────────────────────── */
  const stageColour = (o, face) => {
    const set = COOK[o.ing] || COOK.patty;
    return set[Math.min(set.length - 1, face ? face.s : 0)];
  };
  /** Grill lines on a cooked face: one per stage past raw. */
  function marks(group, face, y, r, flip) {
    for (let i = 0; i < face.s; i++) {
      const m = box(r * 1.5, 0.012, 0.022, 0);
      m.material = MARK;
      m.position.set(0, y + (flip ? -0.004 : 0.004), -r * 0.6 + (i + 0.5) * (r * 1.2 / Math.max(1, face.s)));
      m.rotation.y = 0.5;
      group.add(m);
    }
  }
  /** One thing, built from its parts, bottom first. Returns { g, h } (height). */
  function build(o, where) {
    const g = new THREE.Group();
    let h = 0;
    const I0 = pack.ingredients[o.ing];
    if (o.ing === 'tray') {
      const t = box(1.7, 0.05, 1, LOOK.tray); t.position.y = 0.025; g.add(t);
      o.parts.forEach((p, i) => {
        const b = build(p);
        b.g.position.set(-0.55 + (i % 3) * 0.55, 0.05, i >= 3 ? 0.25 : -0.1);
        g.add(b.g);
      });
      return { g, h: 0.05 };
    }
    if (I0 && I0.traits.includes('container')) {
      const plate = cyl(0.44, 0.035, LOOK.plate); plate.position.y = 0.0175; g.add(plate);
      h = 0.035;
    } else if (o.faces && o.faces.length === 2) {
      // Two sides: the bottom half and the top half each show their own stage.
      const r = 0.3, hh = 0.05;
      const lo = cyl(r, hh, stageColour(o, o.faces[0])); lo.position.y = hh / 2; g.add(lo);
      const up = cyl(r * 0.98, hh, stageColour(o, o.faces[1])); up.position.y = hh * 1.5; g.add(up);
      marks(g, o.faces[1], hh * 2, r, false);
      h = hh * 2;
    } else if (o.faces) {
      const s = box(0.6, 0.035, 0.14, stageColour(o, o.faces[0])); s.position.y = 0.0175; g.add(s);
      marks(g, o.faces[0], 0.035, 0.12, false);
      h = 0.035;
    } else {
      const amount = o.amount === undefined ? 0.66 : o.amount;
      const c = LOOK[o.ing] === undefined ? 0x9a9a9a : LOOK[o.ing];
      let m;
      // A bun's shape follows where it sits: a heel, a thin middle slice, a domed top.
      if (o.ing === 'bun' && where === 'top') { m = new THREE.Mesh(new THREE.SphereGeometry(0.34, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(c)); m.scale.y = 0.55; h = 0.19; }
      else if (o.ing === 'bun' && where === 'middle') { m = cyl(0.33, 0.05, c); m.position.y = 0.025; h = 0.05; }
      else if (o.ing === 'bun') { m = cyl(0.34, 0.09, c); m.position.y = 0.045; h = 0.09; }
      else if (o.ing === 'cheese') { m = box(0.56, 0.018, 0.56, c); m.rotation.y = Math.PI / 4; m.position.y = 0.009; h = 0.018; }
      else if (o.ing === 'lettuce') { m = cyl(0.37, 0.022, c); m.position.y = 0.011; h = 0.022; }
      else if (o.ing === 'tomato') { m = cyl(0.29, 0.03, c); m.position.y = 0.015; h = 0.03; }
      else if (o.ing === 'onion') { m = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.028, 8, 24), mat(c)); m.rotation.x = Math.PI / 2; m.position.y = 0.028; h = 0.05; }
      else if (o.ing === 'pickles') {
        m = new THREE.Group();
        [[-0.12, 0], [0.12, 0.03], [0, -0.13]].forEach(([x, z]) => { const d = cyl(0.08, 0.016, c, 14); d.position.set(x, 0.008, z); m.add(d); });
        h = 0.016;
      } else if (I0 && I0.amounts) {
        // A sauce: a puddle as wide as the amount poured.
        m = cyl(0.1 + 0.2 * amount, 0.012, c); m.position.y = 0.006; h = 0.012;
      } else { m = box(0.3, 0.08, 0.3, c); m.position.y = 0.04; h = 0.08; }
      g.add(m);
    }
    for (let i = 0; i < o.parts.length; i++) {
      const b = build(o.parts[i], BB.words.layer(pack, o, i));
      b.g.position.y = h;
      g.add(b.g);
      h += b.h;
    }
    return { g, h };
  }

  /** Where a slot sits on its station: in a row along the front. */
  function slotPos(sid, slotId) {
    const st = pack.stations[sid];
    const x = PLACES[sid].x;
    if (sid === 'counter') return new THREE.Vector3(x, TOP_Y, 0.1);
    const list = st.slots;
    const i = list.findIndex(s => s.id === slotId), n = list.length;
    return new THREE.Vector3(x - WIDTH / 2 + (WIDTH / n) * (i + 0.5), TOP_Y, 0.2);
  }
  /** Bins along the back: one row, or two staggered rows when there are many, so
   *  neighbouring labels never sit side by side. */
  function binPos(sid, i, n) {
    const x = PLACES[sid].x;
    const row = n > 5 ? i % 2 : 0;
    const span = WIDTH - 0.5;
    return new THREE.Vector3(x - span / 2 + span * (n > 1 ? i / (n - 1) : 0.5), TOP_Y, -0.38 - row * 0.4);
  }
  /** What a bin holds, so it is obvious what comes out of it: a little heap of the
   *  thing itself, or a squeeze bottle for a sauce. */
  function contents(ingId) {
    const g = new THREE.Group();
    const I0 = pack.ingredients[ingId];
    if (I0.amounts) {
      const c = LOOK[ingId] === undefined ? 0x9a9a9a : LOOK[ingId];
      const bottle = cyl(0.075, 0.26, c, 18); bottle.position.y = 0.13; g.add(bottle);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.09, 14), mat(c)); cap.position.y = 0.305; g.add(cap);
      const band = cyl(0.077, 0.06, 0xffffff, 18); band.position.y = 0.13; g.add(band);
      return g;
    }
    const sample = { ing: ingId, n: 0, parts: [] };
    if (I0.traits.includes('cookable')) sample.faces = I0.traits.includes('twoSided') ? [{ s: 0 }, { s: 0 }] : [{ s: 0 }];
    [0, 1].forEach(k => {
      const b = build(sample, ingId === 'bun' ? (k ? 'top' : 'bottom') : null);
      b.g.scale.setScalar(0.42);
      b.g.position.set(k * 0.02, 0.085 + k * 0.05, 0);
      b.g.rotation.y = k * 0.35;
      g.add(b.g);
    });
    return g;
  }
  function binMeshes() {
    for (const sid of Object.keys(PLACES)) {
      const list = pack.stations[sid].bins;
      list.forEach((bin, i) => {
        const tub = new THREE.Group();
        const shell = box(0.36, 0.08, 0.32, 0xc9d0d6); shell.position.y = 0.04; tub.add(shell);
        const inner = box(0.32, 0.01, 0.28, 0x8c949a); inner.position.y = 0.081; tub.add(inner);
        tub.add(contents(bin.ing));
        tub.position.copy(binPos(sid, i, list.length));
        bins.add(tub);
        const key = 'bin:' + bin.id + '@' + sid;
        keyed.set(key, tub);
        // Every bin is labelled on its front, whether or not it can be used right now.
        const el = document.createElement('div');
        el.className = 'tag binlabel';
        el.dataset.name = BB.words.name(pack, bin.ing);
        el.innerHTML = '<b>' + el.dataset.name + '</b>';
        layer.appendChild(el);
        binLabels.set(key, el);
        pins.set(el, { key, how: 'front' });
      });
    }
  }
  /** A bin's label, for the screens to make a scan target of (World.resetBinLabels undoes it). */
  const binLabel = key => binLabels.get(key) || null;
  function resetBinLabels() {
    for (const el of binLabels.values()) { el.className = 'tag binlabel'; el.innerHTML = '<b>' + el.dataset.name + '</b>'; }
  }

  /* ── tags ─────────────────────────────────────────────────────────────── */
  function addTag(el, point, obj, key) {
    layer.appendChild(el);
    const t = { el, point, obj, key };
    tags.push(t);
    return t;
  }

  /** Redraw every thing in the kitchen. customer: the ticket's customer, or null. */
  function sync(k, customer) {
    if (!scene) return;
    while (food.children.length) food.remove(food.children[0]);
    for (const key of [...keyed.keys()]) if (key.startsWith('obj:')) keyed.delete(key);
    for (const sid of Object.keys(PLACES)) {
      const slots = k.stations[sid].slots;
      for (const sl of pack.stations[sid].slots) {
        const o = slots[sl.id];
        if (!o) continue;
        const b = build(o);
        b.g.position.copy(slotPos(sid, sl.id));
        food.add(b.g);
        keyed.set('obj:' + o.uid, b.g);
        // Things on the tray are scan targets too (Take, Bin It).
        if (sl.fixed) b.g.children.slice(1).forEach((child, i) => { if (o.parts[i]) keyed.set('obj:' + o.parts[i].uid, child); });
      }
    }
    setCustomer(customer);
  }

  function setCustomer(c) {
    const id = c ? c.id : null;
    if (customerMesh && customerMesh.userData.id === id) return;
    if (customerMesh) { scene.remove(customerMesh); keyed.delete('customer'); }
    for (let i = tags.length - 1; i >= 0; i--) if (tags[i].key === 'customer') { tags[i].el.remove(); tags.splice(i, 1); }
    customerMesh = null;
    if (!c) return;
    let hash = 0;
    for (const ch of c.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const shirt = [0x3f7fd8, 0x8a4fc0, 0x2f9d6a, 0xd07a2a, 0xc0405a, 0x4a5a6a][hash % 6];
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.9, 6, 16), mat(shirt)); body.position.y = 1.05; g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 16), mat([0xf2c9a0, 0xd6a27a, 0x9c6a48, 0x6e4a32][(hash >> 3) % 4])); head.position.y = 2.0; g.add(head);
    [-0.11, 0.11].forEach(x => { const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), mat(0x1a1410)); eye.position.set(x, 2.05, 0.28); g.add(eye); });
    g.position.set(PLACES.counter.x, 0, -1.6);
    g.userData.id = id;
    scene.add(g);
    customerMesh = g;
    keyed.set('customer', g);
    const el = document.createElement('div');
    el.className = 'tag who';
    el.textContent = c.name;
    addTag(el, new THREE.Vector3(PLACES.counter.x, 2.55, -1.6), null, 'customer');
  }

  /* ── projection ───────────────────────────────────────────────────────── */
  const _v = new THREE.Vector3(), _box = new THREE.Box3();
  function toScreen(p) {
    _v.copy(p).project(camera);
    if (_v.z > 1) return null;
    return { x: (_v.x * 0.5 + 0.5) * window.innerWidth, y: (0.5 - _v.y * 0.5) * window.innerHeight };
  }
  /** Screen rectangle round a thing, at least 64 px each way (ACCESSIBILITY.md §9). */
  function rectOf(key, pad, min) {
    if (!camera) return null;
    const obj = keyed.get(key);
    if (!obj) return null;
    _box.setFromObject(obj);
    if (_box.isEmpty()) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? _box.max.x : _box.min.x, i & 2 ? _box.max.y : _box.min.y, i & 4 ? _box.max.z : _box.min.z);
      const s = toScreen(p);
      if (!s) return null;
      x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y);
    }
    if (pad === undefined) pad = 10;
    if (min === undefined) min = 64;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const w = Math.max(min, x1 - x0 + pad * 2), h = Math.max(min, y1 - y0 + pad * 2);
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  /** The 3D thing the lit choice is about gets the bracket frame. */
  function setEcho(key, paused) {
    if (!frameEl) return;
    echo = key || null;
    frameEl.classList.toggle('paused', !!paused);
  }

  /** Keep a screen element on a thing. how: 'label' sits just above it (the tray's
   *  Serve); 'front' sits on its front edge (a bin's label, food); 'beside' hangs a
   *  cluster of choice plates next to it, clear of it. All stay wholly on screen; an
   *  element whose thing is gone or out of view hides. */
  function pin(el, key, how) { pins.set(el, { key, how: how || 'label' }); if (camera) placeOne(el, pins.get(el)); }
  function unpin(el) { pins.delete(el); }
  function placeOne(el, p) {
    const r = rectOf(p.key, 0, 0);
    const W = window.innerWidth, H = window.innerHeight;
    // A thing at another station is out of view: its label hides rather than cling to an edge.
    const cx = r && r.x + r.w / 2, cy = r && r.y + r.h / 2;
    if (!r || cx < 0 || cx > W || cy < 0 || cy > H) { el.style.visibility = 'hidden'; return; }
    el.style.visibility = '';
    const w = el.offsetWidth, h = el.offsetHeight, m = 8;
    let x, y;
    if (p.how === 'beside') {
      const gap = 28;
      x = r.x + r.w + gap;
      if (x + w > W - m) x = r.x - gap - w;            // no room on the right: the left
      y = r.y + r.h / 2 - h / 2;
    } else if (p.how === 'front') { x = r.x + r.w / 2 - w / 2; y = r.y + r.h - h * 0.55; }
    else { x = r.x + r.w / 2 - w / 2; y = r.y - h - 4; }
    x = Math.max(m, Math.min(W - w - m, x));
    y = Math.max(m, Math.min(H - h - m, y));
    el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(y) + 'px';
  }

  function place() {
    for (const t of tags) {
      const s = t.point && toScreen(t.point);
      if (!s) { t.el.style.display = 'none'; continue; }
      t.el.style.display = '';
      t.el.style.left = s.x + 'px'; t.el.style.top = s.y + 'px';
    }
    for (const [el, p] of pins) placeOne(el, p);
    const r = echo && rectOf(echo);
    frameEl.classList.toggle('on', !!r);
    if (r) Object.assign(frameEl.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  }

  /* ── camera ───────────────────────────────────────────────────────────── */
  const vec = a => new THREE.Vector3(a[0], a[1], a[2]);
  function goTo(sid, instant) {
    if (!camera) return;
    const c = CAMS[sid] || CAMS.counter;
    const to = { pos: vec(c.pos), at: vec(c.at) };
    if (instant || reduced() || !cam.to) { cam = { from: to, to, t: 1 }; apply(to); return; }
    cam = { from: current(), to, t: 0 };
  }
  const current = () => ({ pos: camera.position.clone(), at: cam.to ? cam.to.at.clone() : new THREE.Vector3() });
  function apply(v) { camera.position.copy(v.pos); camera.lookAt(v.at); }
  function moveCamera(dt) {
    if (cam.t >= 1) return;
    cam.t = Math.min(1, cam.t + dt / GLIDE_S);
    const e = cam.t < 0.5 ? 2 * cam.t * cam.t : 1 - Math.pow(-2 * cam.t + 2, 2) / 2;
    apply({ pos: cam.from.pos.clone().lerp(cam.to.pos, e), at: cam.from.at.clone().lerp(cam.to.at, e) });
  }

  /* ── renderer and loop ────────────────────────────────────────────────── */
  function resize() {
    if (!renderer) return;
    renderer.setPixelRatio(hubGraphics.pixelRatio(Math.min(window.devicePixelRatio || 1, 2), window.innerWidth, window.innerHeight));
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 0);
    last = now;
    hubGraphics.frame(now);
    moveCamera(dt);
    renderer.render(scene, camera);
    place();
  }

  async function init() {
    await hubGraphics.ready;
    wrap = document.getElementById('canvasWrap');
    layer = document.getElementById('worldLayer');
    frameEl = document.getElementById('scanFrame');
    renderer = new THREE.WebGLRenderer(hubGraphics.rendererOptions({ antialias: true, powerPreference: 'high-performance' }));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    wrap.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4e4c1);
    camera = new THREE.PerspectiveCamera(46, 1, 0.1, 80);
    scene.add(new THREE.HemisphereLight(0xfff6e8, 0x6a5040, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3); sun.position.set(2, 6, 4); scene.add(sun);
    scene.add(food, bins);
    room();
    binMeshes();
    goTo('counter', true);
    resize();
    hubGraphics.subscribe(resize);
    window.addEventListener('resize', resize);
    requestAnimationFrame(loop);
  }

  /** The bin key for a menu id at a station (the board and the griddle both have cheese). */
  const binKey = (id, sid) => 'bin:' + id + '@' + sid;

  BB.world = { init, sync, goTo, setEcho, rectOf, binKey, pin, unpin, binLabel, resetBinLabels, has: sid => !!PLACES[sid] };
})();
