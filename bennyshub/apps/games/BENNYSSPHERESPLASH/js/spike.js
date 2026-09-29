/** M0 tech spike - NOT the game. Proves the stack before any game code is written:
 *  12 skinned, toon-outlined swimmers animating in the water sphere at frame rate, a
 *  carrier with the ball, and one world-pinned decision (Pass / Shoot / Dribble plates
 *  beside the carrier, the bracket marker stepping through them on Space).
 *  Replaced by js/game.js in M2. */
SS.spike = (function () {
  'use strict';

  const TEAMS = [
    { kit: 0xff8a1f, accent: 0xffe14d, shape: 'round' },     // home: orange + yellow, round badges
    { kit: 0xd6246e, accent: 0x2b1b5a, shape: 'diamond' },   // away: magenta + deep purple, diamond badges
  ];
  const SKINS = [0xf1c7a1, 0xc68b5f, 0x8d5a3b, 0xe0a987, 0x5e3a28, 0xf6d5b8];
  const HAIR = [0x2a1b10, 0xe9c46a, 0x6b3a1e, 0x111111, 0xb5452b, 0x3a2a1c];

  let camera, swimmers = [], ball, carrier, focusIndex = -1, targets = [];

  function init(ctx) {
    camera = ctx.camera;
    for (let team = 0; team < 2; team++) {
      for (let i = 0; i < 6; i++) {
        const n = team * 6 + i;
        const s = SS.models.makeSwimmer({
          body: i % 2 ? 'female' : 'male', kit: TEAMS[team].kit, accent: TEAMS[team].accent,
          skin: SKINS[(i + team * 2) % SKINS.length], hair: HAIR[(i + team) % HAIR.length],
        });
        s.play(i === 5 ? 'tread' : 'swim');
        s.mixer.update(Math.random() * 2);
        // Each swimmer rides a gentle 3D loop through the pool.
        s.path = { r: 5 + i * 1.6, h: (i - 2.5) * 1.8, speed: 0.12 + i * 0.015, phase: n * 0.9 + team * 3.1, dir: team ? -1 : 1 };
        ctx.scene.add(s.group);
        SS.worldui.addBadge(s.head, { number: [7, 9, 4, 11, 3, 1][i], team, shape: TEAMS[team].shape });
        swimmers.push(s);
      }
    }
    carrier = swimmers[0];
    carrier.setCarry(true);
    ball = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16), new THREE.MeshBasicMaterial({ color: 0xfff6c9 }));
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.28, 24, 16), new THREE.MeshBasicMaterial({
      color: 0xffe066, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }));
    ball.add(glow);
    ctx.scene.add(ball);
    ball.add(new THREE.PointLight(0xffe7a0, 2, 4));

    // The decision cluster: three plates fanned around the carrier, plus Pause.
    targets = [
      SS.worldui.addPlate(carrier.group, { label: 'Pass', sub: 'to #9 · open', odds: { word: 'Good chance', p: 0.8 }, offset: { x: -210, y: -40 } }),
      SS.worldui.addPlate(carrier.group, { label: 'Shoot', sub: '2 blockers', odds: { word: 'Risky', p: 0.3 }, offset: { x: 0, y: -170 } }),
      SS.worldui.addPlate(carrier.group, { label: 'Dribble', sub: 'break through', odds: { word: 'Fair', p: 0.55 }, offset: { x: 210, y: -40 } }),
    ].map(p => ({ el: p.el, speak: p.el.textContent }));
    targets.push({ el: document.getElementById('pauseBtn'), speak: 'Pause' });

    window.addEventListener('keyup', e => {
      if (e.code === 'Space') { e.preventDefault(); step(1); }
      if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); choose(); }
    });
    window.addEventListener('keydown', e => { if (e.code === 'Space') e.preventDefault(); });
  }

  function say(text) { if (window.NarbeVoiceManager) NarbeVoiceManager.speak(text); }
  function step(dir) {
    // A deadzone slot (-1) before the list wraps, as every hub scan list has.
    focusIndex = focusIndex + dir;
    if (focusIndex >= targets.length) focusIndex = -1;
    const t = targets[focusIndex];
    SS.worldui.setFocus(t ? { el: t.el } : null);
    if (t) say(t.el.querySelector('b') ? t.el.querySelector('b').textContent + '. ' + (t.el.querySelector('em') || {}).textContent : t.speak);
  }
  function choose() {
    const t = targets[focusIndex];
    if (t) say('Selected ' + (t.el.querySelector('b') ? t.el.querySelector('b').textContent : t.speak));
  }

  const _p = new THREE.Vector3(), _ahead = new THREE.Vector3(), _hand = new THREE.Vector3(), _cam = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const camRig = { dist: 7.5, lift: 2.2, spin: 0.08, angle: null };
  let first = true;
  function pathAt(s, t, out) {
    const p = s.path, a = p.phase + t * p.speed * p.dir;
    return out.set(Math.cos(a) * p.r, p.h + Math.sin(a * 2) * 1.2, Math.sin(a) * p.r * 1.25);
  }
  function update(dt, t) {
    swimmers.forEach(s => {
      pathAt(s, t, _p); pathAt(s, t + 0.5, _ahead);
      s.group.position.copy(_p);
      s.group.lookAt(_ahead);
      s.update(dt);
    });
    // The ball sits where the carry holds it, tucked against the belly.
    ball.position.copy(carrier.ballPoint);
    // Broadcast camera: close on the carrier, slowly circling, eased so it never jerks.
    // camRig.angle (radians, relative to the carrier's heading) pins a review angle.
    const c = carrier.group.position, R = camRig;
    let a = t * R.spin;
    if (R.angle !== null) { carrier.group.getWorldDirection(_fwd); a = Math.atan2(_fwd.z, _fwd.x) + R.angle; }
    _cam.set(c.x + Math.cos(a) * R.dist, c.y + R.lift, c.z + Math.sin(a) * R.dist);
    camera.position.lerp(_cam, first ? 1 : Math.min(1, dt * 2)); first = false;
    camera.lookAt(c);
    const hud = document.getElementById('perf');
    if (hud && Math.floor(t * 2) !== hud._t) { hud._t = Math.floor(t * 2); const p = SS.perf(); hud.textContent = `${p.fps} fps · ${p.calls} draws · ${(p.tris / 1000).toFixed(0)}k tris · ×${p.pixelRatio}`; }
  }

  return { init, update, get swimmers() { return swimmers; }, step, choose, camRig, get carrier() { return carrier; } };
})();
