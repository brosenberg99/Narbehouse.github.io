/** Benny's Sphere Splash - UI pinned to the 3D world.
 *
 * Choices in a match are not a menu bar: they sit on the scene. A plate hangs beside
 * the swimmer it belongs to, a number badge floats over every player, and one
 * focus marker - Fish Mystery's corner brackets - slides between whatever is focused,
 * whether that is a swimmer in the water or a button on screen. One marker, one
 * meaning, everywhere.
 *
 * Plates are DOM elements positioned each frame from a projected world point, so
 * they stay crisp, big and readable at any distance and never clip into geometry.
 */
SS.worldui = (function () {
  'use strict';

  const _v = new THREE.Vector3(), _box = new THREE.Box3();
  let camera, layer, frame, badges = [], plates = [];

  function init(cam) {
    camera = cam;
    layer = document.getElementById('worldLayer');
    frame = document.getElementById('scanFrame');
  }

  /** World point -> CSS pixels, or null when it is behind the camera. */
  function toScreen(p) {
    _v.copy(p).project(camera);
    if (_v.z > 1) return null;
    return { x: (_v.x * 0.5 + 0.5) * window.innerWidth, y: (0.5 - _v.y * 0.5) * window.innerHeight };
  }

  /** Screen rectangle around an object (Fish Mystery's focusScreenRect), clamped to the view. */
  function rectOf(obj) {
    _box.setFromObject(obj);
    if (_box.isEmpty()) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, seen = 0;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? _box.max.x : _box.min.x, i & 2 ? _box.max.y : _box.min.y, i & 4 ? _box.max.z : _box.min.z).project(camera);
      if (_v.z > 1) continue;
      seen++;
      x0 = Math.min(x0, _v.x); x1 = Math.max(x1, _v.x); y0 = Math.min(y0, _v.y); y1 = Math.max(y1, _v.y);
    }
    if (seen < 2) return null;
    const W = window.innerWidth, H = window.innerHeight;
    const l = Math.max(0, (x0 * 0.5 + 0.5) * W), r = Math.min(W, (x1 * 0.5 + 0.5) * W);
    const t = Math.max(0, (0.5 - y1 * 0.5) * H), b = Math.min(H, (0.5 - y0 * 0.5) * H);
    if (r - l < 8 || b - t < 8) return null;
    return { x: l, y: t, w: r - l, h: b - t };
  }

  /* ── number badges over every swimmer ─────────────────────────────────── */
  function addBadge(anchor, { number, team, shape, lift = 0.5 }) {
    const el = document.createElement('div');
    el.className = 'badge ' + (shape || 'round') + ' team-' + team;
    el.textContent = number;
    layer.appendChild(el);
    badges.push({ el, anchor, lift });
    return el;
  }

  /* ── choice plates, pinned beside a swimmer ───────────────────────────── */
  /** `offset` is in screen pixels from the anchor's projected point: the cluster
   *  fans out around the swimmer instead of stacking on top of them. */
  function addPlate(anchor, { label, sub, odds, offset }) {
    const el = document.createElement('div');
    el.className = 'plate';
    el.innerHTML = '<b></b><span class="sub"></span><span class="odds"><i></i><em></em></span>';
    el.querySelector('b').textContent = label;
    el.querySelector('.sub').textContent = sub || '';
    if (odds) {
      el.querySelector('.odds i').style.setProperty('--p', odds.p);
      el.querySelector('.odds em').textContent = odds.word;
      el.dataset.odds = odds.word.toLowerCase().replace(/\s+/g, '-');
    } else el.querySelector('.odds').remove();
    layer.appendChild(el);
    const plate = { el, anchor, offset: offset || { x: 0, y: -90 } };
    plates.push(plate);
    return plate;
  }
  function clearPlates() { plates.forEach(p => p.el.remove()); plates = []; }

  /* ── focus: one bracket marker for world objects and DOM alike ─────────── */
  let focus = null;              // { el } | { obj } | null
  function setFocus(target) {
    focus = target;
    plates.forEach(p => p.el.classList.toggle('focused', !!target && target.el === p.el));
    frame.classList.toggle('on', !!target);
  }
  function placeFrame() {
    if (!focus) return;
    let r = null;
    if (focus.el) {
      const b = focus.el.getBoundingClientRect(); r = { x: b.left - 8, y: b.top - 8, w: b.width + 16, h: b.height + 16 };
    } else if (focus.obj) r = rectOf(focus.obj);
    if (!r) { frame.classList.remove('on'); return; }
    frame.classList.add('on');
    Object.assign(frame.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  }

  const _head = new THREE.Vector3();
  function anchorPoint(anchor, lift) {
    anchor.getWorldPosition(_head); _head.y += lift; return _head;
  }

  /** Called once per frame after the camera moves. */
  function update() {
    const W = window.innerWidth, H = window.innerHeight;
    badges.forEach(b => {
      const s = toScreen(anchorPoint(b.anchor, b.lift));
      b.el.style.display = s ? '' : 'none';
      if (s) b.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`;
    });
    plates.forEach(p => {
      const s = toScreen(anchorPoint(p.anchor, 0.6));
      if (!s) { p.el.style.display = 'none'; return; }
      p.el.style.display = '';
      // Keep the whole plate on screen: a choice you cannot see is not a choice.
      const w = p.el.offsetWidth, h = p.el.offsetHeight, m = 12;
      const x = Math.min(W - w / 2 - m, Math.max(w / 2 + m, s.x + p.offset.x));
      const y = Math.min(H - h - m, Math.max(m, s.y + p.offset.y - h / 2));
      p.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, 0)`;
    });
    placeFrame();
  }

  return { init, addBadge, addPlate, clearPlates, setFocus, update, toScreen, rectOf, get plates() { return plates; } };
})();
