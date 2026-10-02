/** Benny's Sphere Splash - the big moves: a shooter's throw, a keeper's save, a block.
 *
 * The free animation library has no throw, dive or catch, so these are built the rig.js
 * way: the clip poses the body, then every frame each move re-poses what it needs -
 * the whole body (a lean or a dive, pivoting at the pelvis, via swimmer.setTilt) and
 * the arms (rig.twoBone), always blended in from the clip's own pose so nothing snaps.
 * Angles come from pose references (Projects/Assets/SphereSplash/pose-refs):
 *  - throw (water polo): upright, throwing hand cocked behind the head, elbow high and
 *    out, the other arm pointing at the target; then the arm whips straight forward at
 *    shoulder height while the other swings down and back;
 *  - dive: the body one straight line from feet to fingertips, pointed at the ball;
 *  - catch: ball clutched to the chest, forearms round it, elbows in;
 *  - punch: one fist through the ball, up and out, the other arm low for balance;
 *  - celebrate: arms up in a V, a twirl, two fist pumps.
 * A move only shows what the sim already decided; it never changes an outcome.
 */
SS.moves = (function () {
  'use strict';

  const ease = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
  const ramp = (t, a, b) => ease((t - a) / (b - a));
  const V = () => new THREE.Vector3();
  const _h = V(), _el = V(), _t = V(), _p = V(), _s = V(), _d = V(), _loc = V(), _shift = V(), _aim = V(), _pel = V();
  const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _qid = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);

  /** Reach one hand to `target` (world), elbow toward `pole`, blended by w from the clip. */
  function reach(sw, side, target, pole, w) {
    if (w <= 0.001) return;
    const b = sw.bones, R = side === 'R';
    const up = R ? b.upperR : b.upperL, lo = R ? b.lowerR : b.lowerL, hd = R ? b.handR : b.handL;
    hd.getWorldPosition(_h); lo.getWorldPosition(_el);
    _t.copy(_h).lerp(target, w); _p.copy(_el).lerp(pole, w);
    SS.rig.twoBone(up, lo, hd, _t, _p);
  }
  /** Lean the whole body so the head points along `dir` (world), pelvis moved by `shift` (world), by w. */
  function lean(sw, dir, shift, w) {
    _qi.copy(sw.group.quaternion).invert();
    _loc.copy(dir).applyQuaternion(_qi).normalize();
    _q.setFromUnitVectors(UP, _loc);
    _q.slerp(_qid.identity(), 1 - w);                     // slerp toward identity by (1 - w)
    _shift.copy(shift).applyQuaternion(_qi).multiplyScalar(w);
    sw.setTilt(_q, _shift);
  }
  function shoulder(sw, side, out) { return (side === 'R' ? sw.bones.upperR : sw.bones.upperL).getWorldPosition(out); }

  /* ── throw: the shooter's normal shot ──────────────────────────────────
     t (seconds since the shot): 0-0.45 wind up, 0.45-0.58 release, then settle. The
     ball stays in the right hand until the release (game.js reads ballPoint). */
  const THROW = { windup: 0.45, release: 0.58, end: 1.25 };
  const _hr = V(), _hl = V(), _pr = V(), _pl = V(), _sr = V(), _sl = V(), _head = V();
  function throwMove(sw, mv) {
    const t = mv.t, f = sw.frame;
    SS.rig.bodyFrame(sw.bones, f);
    _aim.subVectors(mv.opts.to, f.chest).normalize();
    shoulder(sw, 'R', _sr); shoulder(sw, 'L', _sl); sw.head.getWorldPosition(_head);
    const w = ramp(t, 0, 0.25) * (1 - ramp(t, 0.8, THROW.end));
    const k = ramp(t, THROW.windup, THROW.release);       // 0 = cocked, 1 = released
    // A small lean: back while cocking, into the throw on release.
    _d.copy(UP).applyAxisAngle(_s.crossVectors(UP, _aim).normalize(), -0.18 + 0.4 * k);
    lean(sw, _d, _pel.set(0, 0, 0), w);
    SS.rig.bodyFrame(sw.bones, f);
    shoulder(sw, 'R', _sr); shoulder(sw, 'L', _sl); sw.head.getWorldPosition(_head);
    // Right hand: behind the head, a little above, elbow high and out -> straight at the target.
    _hr.copy(_head).addScaledVector(f.forward, 0.16).addScaledVector(_aim, -0.28).addScaledVector(f.right, 0.14);
    _t.copy(_sr).addScaledVector(_aim, 0.6).addScaledVector(f.forward, 0.06);
    _hr.lerp(_t, k);
    _pr.copy(_sr).addScaledVector(f.right, 0.45).addScaledVector(f.forward, 0.35 - 0.5 * k).addScaledVector(_aim, -0.2 + 0.2 * k);
    reach(sw, 'R', _hr, _pr, w);
    // Left arm: points at the target, then drops down and back.
    _hl.copy(_sl).addScaledVector(_aim, 0.55);
    _t.copy(_sl).addScaledVector(_aim, -0.2).addScaledVector(f.forward, -0.45);
    _hl.lerp(_t, k);
    _pl.copy(_sl).addScaledVector(f.forward, -0.5).addScaledVector(f.right, -0.2);
    reach(sw, 'L', _hl, _pl, w);
    if (t < THROW.release + 0.02) sw.bones.handR.getWorldPosition(sw.ballPoint).addScaledVector(_aim, 0.12);
    return t >= THROW.end;
  }

  /* ── keeper: ready, reach, then catch / punch / miss ───────────────────
     From soccer-goalie and volleyball references (Bryan: the first dive threw the arms
     up, or behind the keeper). A shot is aimed at the goal, which is BEHIND the keeper
     (1.5 m on average), so the keeper goes for `to` = where the ball crosses them
     (game.js works it out), never the aim point. Ready is the goalie's set position:
     hands in front of the chest, palms out, elbows down. The reach goes the short way
     from there, always in front of the body, arms leading and the body following: a
     small lean for a ball close by, a full stretch only for one far out.
     opts: { to (where the ball crosses the keeper, world), ball (its live position),
     result: 'catch' | 'parry' | 'goal', progress: () => 0..1, 1 = the ball reaches them }. */
  const _k = V(), _dir = V(), _hand = V(), _pole = V(), _side = V(), _ready = V();
  function keeperMove(sw, mv) {
    const o = mv.opts, f = sw.frame, p = o.progress();
    if (p >= 1 && mv.arrived == null) mv.arrived = mv.t;
    const ta = mv.arrived == null ? -1 : mv.t - mv.arrived;
    const miss = o.result === 'goal';
    SS.rig.bodyFrame(sw.bones, f);
    _k.copy(f.chest);
    _dir.subVectors(o.to, _k); const dist = _dir.length(); _dir.divideScalar(dist || 1);
    // The reach: from 35% of the ball's way to the keeper, done as it arrives.
    let reachK = ease((p - 0.35) / 0.65);
    // After arrival: a catch or a punch comes back up; a miss hangs, then sags.
    const back = ta < 0 ? 0 : miss ? ramp(ta, 0.35, 1.2) : ramp(ta, 0.15, 0.6);
    reachK *= 1 - back;
    const w = ramp(mv.t, 0, 0.25) * (1 - ramp(ta, 1.0, 1.5));
    // The body follows the arms, as far as the ball is out of reach: a ball half a metre
    // away is taken with the arms and a small lean; a full-length dive only past ~1.6 m.
    // Never head-down: the lean takes the sideways and upward part of the way (volleyball
    // digs lean forward, head up), the drop to a low ball is the hips moving down.
    // A ball above the shoulders turns the whole body to it however close it is, so it
    // ends up straight over the head and the arms go up in line with the body (Bryan: a
    // high diagonal save left the body upright and the arms crossed over the face).
    const high = ramp(_dir.y, 0.2, 0.55);
    const stretch = Math.max(miss ? 0.6 : 0, ramp(dist, 0.5, 1.6), high);   // beaten: a committed stretch
    _shift.copy(_dir).multiplyScalar(Math.max(0, Math.min(1.2, dist - 0.8)));
    _d.copy(_dir).setY(0).addScaledVector(UP, Math.max(0, _dir.y) + 0.3).normalize();
    _d.lerp(_dir, high).normalize();                        // a high ball: the body points right at it
    lean(sw, _d, _shift, reachK * stretch * w);
    SS.rig.bodyFrame(sw.bones, f);
    const up = f.forward;
    ['L', 'R'].forEach(side => {
      shoulder(sw, side, _s);
      _side.copy(f.right).multiplyScalar(side === 'R' ? 1 : -1);
      // Ready: hands in front of the chest, a hand's width apart, elbows down and out.
      _ready.copy(f.chest).addScaledVector(f.belly, 0.32).addScaledVector(up, 0.1).addScaledVector(_side, 0.14);
      _hand.copy(_ready);
      _pole.copy(_s).addScaledVector(_side, 0.3).addScaledVector(up, -0.45).addScaledVector(f.belly, 0.1);
      // Reach: both hands to where the ball crosses, palms to it (a miss: fingertips short).
      if (miss) _t.copy(_k).addScaledVector(_dir, Math.max(0.35, dist - 0.4)).addScaledVector(_side, 0.1);
      else _t.copy(o.to).lerp(o.ball, ramp(p, 0.85, 1)).addScaledVector(_side, 0.12);
      _hand.lerp(_t, reachK);
      // Elbows out to the side and a little back from the reach, never flipped up.
      _pole.lerp(_d.copy(_s).addScaledVector(_side, 0.35).addScaledVector(_dir, -0.25).addScaledVector(up, -0.15), reachK);
      if (ta >= 0 && o.result === 'catch') {
        // Clutch it to the chest, forearms round it.
        const c = ramp(ta, 0, 0.3);
        _t.copy(f.chest).addScaledVector(f.belly, 0.26).addScaledVector(_side, 0.13);
        _hand.lerp(_t, c);
        _pole.lerp(_d.copy(_s).addScaledVector(_side, 0.35).addScaledVector(up, -0.45), c);
      } else if (ta >= 0 && o.result === 'parry' && side === 'R') {
        // Punch on through the ball.
        _t.copy(o.to).addScaledVector(_dir, 0.25);
        _hand.lerp(_t, 1 - ramp(ta, 0.25, 0.7));
      }
      reach(sw, side, _hand, _pole, w);
    });
    if (ta >= 0 && o.result === 'catch') sw.chest.getWorldPosition(sw.ballPoint).addScaledVector(f.belly, 0.3);
    return ta > 1.5;
  }

  /* ── block: a defender reaches for the ball where it stops ─────────────
     opts: { to (where the ball stops), ball, result: 'blocked' | 'intercepted', progress }. */
  function blockMove(sw, mv) {
    const o = mv.opts, f = sw.frame, p = o.progress();
    if (p >= 1 && mv.arrived == null) mv.arrived = mv.t;
    const ta = mv.arrived == null ? -1 : mv.t - mv.arrived;
    SS.rig.bodyFrame(sw.bones, f);
    sw.pelvis.getWorldPosition(_k);
    _dir.subVectors(o.to, _k); const dist = _dir.length(); _dir.divideScalar(dist || 1);
    const r = ease((p - 0.35) / 0.65) * (1 - ramp(ta, 0.3, 0.9));
    const w = ramp(mv.t, 0, 0.2) * (1 - ramp(ta, 0.8, 1.2));
    // A partial lean toward the ball, not a full dive.
    _d.copy(UP).lerp(_dir, 0.45).normalize();
    _shift.copy(_dir).multiplyScalar(Math.max(0, Math.min(0.8, dist - 1.1)));
    lean(sw, _d, _shift, r * w);
    SS.rig.bodyFrame(sw.bones, f);
    // The arm on the ball's side reaches; an interception takes it with both.
    const rightSide = _s.subVectors(o.to, _k).dot(f.right) >= 0;
    const sides = o.result === 'intercepted' ? ['L', 'R'] : [rightSide ? 'R' : 'L'];
    sides.forEach(side => {
      shoulder(sw, side, _s);
      _side.copy(f.right).multiplyScalar(side === 'R' ? 1 : -1);
      _hand.copy(o.ball).addScaledVector(_side, 0.1);
      _pole.copy(_s).addScaledVector(_side, 0.45).addScaledVector(f.forward, -0.2);
      reach(sw, side, _hand, _pole, r * w);
    });
    return ta > 1.2;
  }

  /* ── kick: a technique shot, the flashy one (Bryan: throws for normal shots, kicks
     for techniques). A volley: the ball is let go in front of the shins, the body leans
     back to counter, the right leg cocks behind and then swings straight through at
     the target, arms out wide for balance. Same timing as the throw. */
  const _hip = V(), _foot = V(), _knee = V(), _spot = V();
  function kickMove(sw, mv) {
    const t = mv.t, f = sw.frame;
    SS.rig.bodyFrame(sw.bones, f);
    _aim.subVectors(mv.opts.to, f.chest).normalize();
    const w = ramp(t, 0, 0.2) * (1 - ramp(t, 0.85, THROW.end));
    const k = ramp(t, THROW.windup, THROW.release);
    // Lean back, away from the target: more as the leg comes through.
    _d.copy(UP).applyAxisAngle(_s.crossVectors(UP, _aim).normalize(), -(0.55 + 0.35 * k));
    lean(sw, _d, _pel.set(0, 0, 0), w);
    SS.rig.bodyFrame(sw.bones, f);
    const b = sw.bones;
    b.thighR.getWorldPosition(_hip);
    // The foot: cocked behind and under, then straight through at the target.
    _foot.copy(_hip).addScaledVector(_aim, -0.45).addScaledVector(f.forward, -0.55);
    _t.copy(_hip).addScaledVector(_aim, 0.9).addScaledVector(f.forward, -0.15);
    _foot.lerp(_t, k);
    _knee.copy(_hip).addScaledVector(_aim, 0.7).addScaledVector(f.forward, -0.2);
    if (w > 0.001) { b.footR.getWorldPosition(_h); b.calfR.getWorldPosition(_el);
      _t.copy(_h).lerp(_foot, w); _p.copy(_el).lerp(_knee, w); SS.rig.twoBone(b.thighR, b.calfR, b.footR, _t, _p); }
    // Arms out wide.
    ['L', 'R'].forEach(side => {
      shoulder(sw, side, _s);
      _side.copy(f.right).multiplyScalar(side === 'R' ? 1 : -1);
      _hand.copy(_s).addScaledVector(_side, 0.55).addScaledVector(_aim, -0.1).addScaledVector(f.forward, 0.1);
      _pole.copy(_s).addScaledVector(f.forward, -0.4).addScaledVector(_side, 0.2);
      reach(sw, side, _hand, _pole, w);
    });
    // The ball: let go from the carry, it hangs in front of the shins for the strike.
    _spot.copy(_hip).addScaledVector(_aim, 0.75).addScaledVector(f.forward, -0.2);
    if (t < THROW.release + 0.02) sw.ballPoint.lerp(_spot, ramp(t, 0.05, 0.3));
    return t >= THROW.end;
  }

  /* ── celebrate: the scorer, facing the camera (game.js turns them to it) ─────
     Big and simple, to read from across the pool: both arms shoot up into a V, fists
     high, chest out (a small lean back); the whole body twirls once round, rising in
     the water; then two fist pumps (fists down beside the head and back up) and the V
     held to the end. The legs keep the tread clip's kick. */
  const CELEBRATE = { spin: [0.25, 1.05], pumps: [1.25, 2.65], end: 3.4 };
  const _spinQ = new THREE.Quaternion(), _leanQ = new THREE.Quaternion(), _rise = V(), X = new THREE.Vector3(1, 0, 0);
  function celebrateMove(sw, mv) {
    const t = mv.t, f = sw.frame, C = CELEBRATE;
    const w = ramp(t, 0, 0.3) * (1 - ramp(t, C.end - 0.45, C.end));
    // The body: a twirl about its own upright axis, rising ~0.4 m, leaning back a little.
    _spinQ.setFromAxisAngle(UP, Math.PI * 2 * ease((t - C.spin[0]) / (C.spin[1] - C.spin[0])));
    _leanQ.setFromAxisAngle(X, -0.2 * w);
    _spinQ.multiply(_leanQ);
    _rise.set(0, 0.4 * ramp(t, 0.15, 0.7) * w, 0);
    sw.setTilt(_spinQ, _rise);
    SS.rig.bodyFrame(sw.bones, f);
    const up = f.forward;
    // Two pumps: 0 = arms straight up in the V, 1 = fists down beside the head.
    const pp = (t - C.pumps[0]) / (C.pumps[1] - C.pumps[0]);
    const pump = pp > 0 && pp < 1 ? 0.5 - 0.5 * Math.cos(pp * Math.PI * 4) : 0;
    const armsUp = ramp(t, 0.05, 0.3);
    ['L', 'R'].forEach(side => {
      shoulder(sw, side, _s);
      _side.copy(f.right).multiplyScalar(side === 'R' ? 1 : -1);
      _hand.copy(_s).addScaledVector(up, 0.5).addScaledVector(_side, 0.28).addScaledVector(f.belly, 0.06);       // the V
      _t.copy(_s).addScaledVector(up, 0.18).addScaledVector(_side, 0.3).addScaledVector(f.belly, 0.16);         // fist by the head
      _hand.lerp(_t, pump);
      _pole.copy(_s).addScaledVector(_side, 0.45).addScaledVector(f.belly, -0.1).addScaledVector(up, -0.1);
      reach(sw, side, _hand, _pole, w * armsUp);
    });
    return t >= C.end;
  }

  const MOVES = { throw: throwMove, keeper: keeperMove, block: blockMove, kick: kickMove, celebrate: celebrateMove };
  /** Pose a swimmer for its move this frame (after the clip and the carry). True = finished. */
  function apply(sw, mv) { const fn = MOVES[mv.name]; return fn ? fn(sw, mv) : true; }

  return { apply, THROW, CELEBRATE };
})();
