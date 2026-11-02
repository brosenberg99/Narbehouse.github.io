/** Ben's Burger Bar - the kitchen in 3D, as box art (M1 greybox; the cel-shaded diner is M3).
 *
 *  World.sync(kitchen, customer) redraws the food from the kitchen state, which is plain
 *  JSON (js/core/items.js), so what is on screen is always what the rules say. Each
 *  station has a fixed close-up camera; moving between them glides, or cuts with Motion
 *  Reduced. Labels and the scan's bracket frame are DOM elements placed from projected
 *  points every frame, so they stay big and readable at any distance.
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
    bunBottom: 0xe0a458, bunTop: 0xe8ae5e, cheese: 0xffc82e, lettuce: 0x5dbb3f, tomato: 0xe0422f,
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
  const tags = [];                    // { el, obj, key }
  let customerMesh = null, echo = null, litTag = null;
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
  function build(o) {
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
      if (o.ing === 'bunTop') { m = new THREE.Mesh(new THREE.SphereGeometry(0.34, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(c)); m.scale.y = 0.55; h = 0.19; }
      else if (o.ing === 'bunBottom') { m = cyl(0.34, 0.09, c); m.position.y = 0.045; h = 0.09; }
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
    for (const p of o.parts) {
      const b = build(p);
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
  function binPos(sid, i, n) {
    const x = PLACES[sid].x;
    const row = n > 5 ? i % 2 : 0;
    return new THREE.Vector3(x - WIDTH / 2 + 0.25 + (WIDTH - 0.5) * (n > 1 ? i / (n - 1) : 0.5), TOP_Y, -0.45 - row * 0.32);
  }

  function binMeshes() {
    for (const sid of Object.keys(PLACES)) {
      const list = pack.stations[sid].bins;
      list.forEach((bin, i) => {
        const c = LOOK[bin.ing] !== undefined ? LOOK[bin.ing] : (COOK[bin.ing] || COOK.patty)[0];
        const tub = new THREE.Group();
        const shell = box(0.28, 0.16, 0.24, 0xbfc6cc); shell.position.y = 0.08; tub.add(shell);
        const fill = box(0.24, 0.02, 0.2, c); fill.position.y = 0.165; tub.add(fill);
        tub.position.copy(binPos(sid, i, list.length));
        bins.add(tub);
        keyed.set('bin:' + bin.id + '@' + sid, tub);
      });
    }
  }

  /* ── tags ─────────────────────────────────────────────────────────────── */
  function addTag(el, point, obj, key) {
    layer.appendChild(el);
    const t = { el, point, obj, key };
    tags.push(t);
    return t;
  }
  function clearFoodTags() {
    for (let i = tags.length - 1; i >= 0; i--) if (tags[i].food) { tags[i].el.remove(); tags.splice(i, 1); }
  }

  /** Redraw every thing in the kitchen. customer: the ticket's customer, or null. */
  function sync(k, customer) {
    if (!scene) return;
    while (food.children.length) food.remove(food.children[0]);
    for (const key of [...keyed.keys()]) if (key.startsWith('obj:')) keyed.delete(key);
    clearFoodTags();
    for (const sid of Object.keys(PLACES)) {
      const slots = k.stations[sid].slots;
      for (const sl of pack.stations[sid].slots) {
        const o = slots[sl.id];
        if (!o) continue;
        const b = build(o);
        b.g.position.copy(slotPos(sid, sl.id));
        food.add(b.g);
        keyed.set('obj:' + o.uid, b.g);
        if (sl.fixed) {
          // Things on the tray are scan targets too (Take, Bin It).
          b.g.children.slice(1).forEach((child, i) => { if (o.parts[i]) keyed.set('obj:' + o.parts[i].uid, child); });
          o.parts.forEach((p, i) => tagFor(BB.words.thing(pack, p).split(',')[0], b.g.children[i + 1], 'obj:' + p.uid));
        } else tagFor(BB.words.thing(pack, o).split(',')[0], b.g, 'obj:' + o.uid);
      }
    }
    setCustomer(customer);
    paintLit();
  }
  function tagFor(text, obj, key) {
    const el = document.createElement('div');
    el.className = 'tag';
    el.textContent = text;
    const t = addTag(el, null, obj, key);
    t.food = true;
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
  function rectOf(key) {
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
    const pad = 10, min = 64;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const w = Math.max(min, x1 - x0 + pad * 2), h = Math.max(min, y1 - y0 + pad * 2);
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  /** The 3D thing the lit choice is about gets the bracket frame and a lit tag. */
  function setEcho(key, paused) {
    if (!frameEl) return;
    echo = key || null;
    frameEl.classList.toggle('paused', !!paused);
    paintLit();
  }
  function paintLit() {
    if (litTag) litTag.el.classList.remove('lit');
    litTag = tags.find(t => t.key && t.key === echo) || null;
    if (litTag) litTag.el.classList.add('lit');
    // A bin has no standing tag: it gets one while it is lit.
    for (let i = tags.length - 1; i >= 0; i--) if (tags[i].binTag && tags[i].key !== echo) { tags[i].el.remove(); tags.splice(i, 1); }
    if (echo && echo.startsWith('bin:') && !litTag && keyed.get(echo)) {
      const el = document.createElement('div');
      el.className = 'tag bin lit';
      const id = echo.slice(4).split('@')[0];
      el.textContent = BB.words.name(pack, (pack.stations[echo.split('@')[1]].bins.find(b => b.id === id) || {}).ing || id);
      litTag = addTag(el, null, keyed.get(echo), echo);
      litTag.binTag = true;
    }
  }

  function place() {
    for (const t of tags) {
      let p = t.point;
      if (t.obj) { _box.setFromObject(t.obj); p = new THREE.Vector3((_box.min.x + _box.max.x) / 2, _box.max.y + 0.05, (_box.min.z + _box.max.z) / 2); }
      const s = p && toScreen(p);
      if (!s) { t.el.style.display = 'none'; continue; }
      t.el.style.display = '';
      t.el.style.left = s.x + 'px'; t.el.style.top = s.y + 'px';
    }
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
    // Centre the station in the room left of the choices column (beside it on wide
    // screens; under it, on narrow ones, the column takes the bottom instead).
    // The column's width is css/bb.css --side: clamp(300px, 30vw, 460px). It may be hidden now.
    const w = window.innerWidth, h = window.innerHeight, sw = Math.min(460, Math.max(300, w * 0.3));
    if (w > 760) camera.setViewOffset(w, h, sw / 2, 0, w, h);
    else camera.setViewOffset(w, h, 0, h * 0.2, w, h);
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

  BB.world = { init, sync, goTo, setEcho, rectOf, binKey, has: sid => !!PLACES[sid] };
})();
