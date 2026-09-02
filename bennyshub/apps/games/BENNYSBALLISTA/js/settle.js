/**
 * Benny's Ballista — physics settling and collateral damage.
 *
 * Extracted from js/game.js's stepPhysicsWithImpacts()/applyCrush() (see
 * commit history around the level editor's stability-test rewrite) so the
 * level editor's stability test can settle a candidate castle with the exact
 * same damage model the real game's boot audit (auditLevels()) uses, instead
 * of a bare P.step() that can't see a crown getting crushed in place by a
 * falling block. game.js's own stepPhysicsWithImpacts() is now a thin wrapper
 * over step() below, passing hooks for the things that are genuinely
 * game-specific (sound, score, scene teardown, splash-chain explosions) —
 * everything portable (peak-speed tracking, hp loss, crush detection) lives
 * here so both callers can never quietly drift apart.
 *
 * `recs` is any array of block-like records with these fields, mutated in
 * place: { body, mesh, mat, hp, alive, _peakSpeed, _peakResolved,
 * _lastHitSpeed }. `mesh` MUST be a real THREE.Mesh with geometry sized to the
 * block's extents — not a bare Object3D — because applyCrush()'s overlap test
 * calls Box3.setFromObject(), which needs actual geometry to compute a
 * bounding box from; a geometry-less Object3D silently produces an empty box
 * and crush damage would never fire. game.js's real blocks[] already satisfy
 * this (their mesh IS the rendered block); a caller building throwaway test
 * records — the editor's stability test — has to give each one a matching
 * BoxGeometry even though nothing ever renders it.
 */
RT.settle = (function () {
  'use strict';

  const D = RT.data;
  const CFG = D.CFG;
  const P = RT.physics;

  const _crushBox = new THREE.Box3(), _otherBox = new THREE.Box3();

  /** A hard-landing block doesn't just hurt itself — it hurts whatever it's
   *  now resting directly on top of. Geometric, not a contact listener: real
   *  XZ footprint overlap plus `b`'s bottom sitting at (not through, not
   *  beside) `other`'s top, a tight tolerance so this never fires for two
   *  blocks merely standing side by side. */
  function applyCrush(recs, b, drop, hooks) {
    const crushDmg = (drop - CFG.IMPACT_THRESHOLD) * CFG.CRUSH_DMG_SCALE;
    _crushBox.setFromObject(b.mesh);
    for (const other of recs) {
      if (!other.alive || other === b) continue;
      _otherBox.setFromObject(other.mesh);
      const xzOverlap = _crushBox.max.x > _otherBox.min.x && _crushBox.min.x < _otherBox.max.x &&
                         _crushBox.max.z > _otherBox.min.z && _crushBox.min.z < _otherBox.max.z;
      if (!xzOverlap) continue;
      const gap = _crushBox.min.y - _otherBox.max.y;
      if (gap < -0.05 || gap > 0.1) continue;  // resting ON other, not through or beside it
      other._lastHitSpeed = drop;
      if (hooks.onImpact) hooks.onImpact(other, drop);
      other.hp -= crushDmg * (other.mat.fallDmgMult || 1);
      if (!other.mat.static) P.addVelocity(other.body, 0, -drop * 0.28, 0);
      if (other.hp <= 0 && hooks.onDestroy) hooks.onDestroy(other);
    }
  }

  /**
   * One physics step, plus the collateral damage that comes with it: blocks
   * smashing into each other during a collapse, detected as a before/after
   * speed check rather than an Ammo contact listener.
   *
   * `hooks`: { onImpact(rec, drop), onDestroy(rec) }, both optional. Neither
   * is told WHY — self-damage vs. crush both call onImpact the same way — the
   * distinction a caller might want (sound design, say) is available via
   * `rec` itself, not a separate parameter, to keep this the same call shape
   * for both paths.
   */
  function step(recs, dt, hooks) {
    hooks = hooks || {};
    for (const b of recs) {
      if (b.alive && !b.mat.static) b._peakSpeed = Math.max(b._peakSpeed || 0, P.speed(b.body));
    }
    P.step(dt);
    for (const b of recs) {
      if (!b.alive) continue;
      P.sync(b.mesh, b.body);
      if (b.mat.static) continue;
      const cur = P.speed(b.body);
      /* Peak-since-last-rest, evaluated once the block is actually settled
         (below SLEEP_LINEAR), not frame-to-frame — see the long comment on
         the original in js/game.js's history for why frame-to-frame or
         first-crossing comparisons under-credit a real fall. */
      const peak = b._peakSpeed || 0;
      if (peak > CFG.IMPACT_THRESHOLD && cur < CFG.SLEEP_LINEAR && !b._peakResolved) {
        const drop = peak - cur;
        b._lastHitSpeed = drop;
        if (hooks.onImpact) hooks.onImpact(b, drop);
        b.hp -= (drop - CFG.IMPACT_THRESHOLD) * CFG.IMPACT_DMG_SCALE * (b.mat.fallDmgMult || 1);
        applyCrush(recs, b, drop, hooks);
        b._peakResolved = true;
        if (b.hp <= 0 && hooks.onDestroy) hooks.onDestroy(b);
      }
      if (cur > peak) {
        b._peakSpeed = cur;
        b._peakResolved = false;   // a fresh fall — allow this one to register too
      }
    }
  }

  /** Convenience for a caller that just wants an end state after N seconds of
   *  simulated settling, rather than driving step() itself frame by frame —
   *  the editor's stability test is exactly this shape. Mutates only what's
   *  passed in (`recs`' bodies/hp/alive/mesh transforms); never touches a
   *  scene, a save, or anything else. */
  function settle(recs, seconds, hooks) {
    const steps = Math.ceil(seconds / CFG.DT);
    for (let i = 0; i < steps; i++) step(recs, CFG.DT, hooks);
    return { steps: steps };
  }

  return { step: step, settle: settle, DEFAULT_SECONDS: 4 };
})();
