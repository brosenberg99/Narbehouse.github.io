/**
 * Benny's Ballista — paper-craft art kit.
 *
 * Every model is built procedurally out of chunky, flat-shaded primitives with
 * a shared paper-fibre texture, which is what sells the folded-paper diorama
 * look without shipping a single asset file. Ported from BENNYSRACETRACKS'
 * art.js core (paperTexture / paper / glow / outline / ink / part / setShadow,
 * lines 1-205 there) — byte-identical except for the road/cloud/hill helpers
 * this game has no use for, which were dropped rather than carried as dead
 * code (see AGENTS.md and the ballista-3d plan on FishMaster's world.js wart).
 *
 * Two rules run through all of it:
 *   1. Big, round, saturated shapes — toy-like rather than realistic.
 *   2. Anything the player must react to gets a dark ink outline. It reads as
 *      craft-paper edging and it is the cheapest way to buy the contrast
 *      Ben's low vision needs — every block gets one, and so does the crown.
 */
RT.art = (function () {
  'use strict';

  const U = RT.util;

  /* ── Shared texture ───────────────────────────────────────────────────── */

  let PAPER = null;

  /** Near-white so material.color can tint it freely. */
  function paperTexture() {
    if (PAPER) return PAPER;
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const r = U.rng(90210);

    g.fillStyle = '#f7f2e8';
    g.fillRect(0, 0, size, size);

    for (let i = 0; i < 2400; i++) {
      const x = r.range(0, size), y = r.range(0, size);
      const len = r.range(2, 10), ang = r.range(0, Math.PI * 2);
      g.strokeStyle = r.chance(0.5) ? 'rgba(130,112,90,0.07)' : 'rgba(255,255,255,0.5)';
      g.lineWidth = r.range(0.5, 1.3);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      g.stroke();
    }
    for (let i = 0; i < 180; i++) {
      g.fillStyle = 'rgba(150,132,108,0.08)';
      g.beginPath();
      g.arc(r.range(0, size), r.range(0, size), r.range(0.5, 1.7), 0, Math.PI * 2);
      g.fill();
    }

    PAPER = new THREE.CanvasTexture(c);
    PAPER.wrapS = PAPER.wrapT = THREE.RepeatWrapping;
    PAPER.colorSpace = THREE.SRGBColorSpace;
    PAPER.anisotropy = 4;
    return PAPER;
  }

  /** Vertical gradient sky, drawn into a dome. */
  function skyTexture(top, mid, bottom) {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.0, top);
    grad.addColorStop(0.58, mid);
    grad.addColorStop(1.0, bottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, 8, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /* ── Materials ────────────────────────────────────────────────────────── */

  const matCache = {};

  /** The workhorse: flat-shaded, papery, no shine. */
  function paper(color, opts) {
    opts = opts || {};
    const key = color + '|' + JSON.stringify(opts);
    if (matCache[key]) return matCache[key];
    const m = new THREE.MeshStandardMaterial({
      color: color,
      map: opts.noMap ? null : paperTexture(),
      roughness: opts.roughness === undefined ? 0.92 : opts.roughness,
      metalness: opts.metalness === undefined ? 0 : opts.metalness,
      flatShading: opts.flat === undefined ? true : opts.flat,
      side: opts.side || THREE.FrontSide,
      transparent: !!opts.transparent,
      opacity: opts.opacity === undefined ? 1 : opts.opacity,
      emissive: opts.emissive === undefined ? 0x000000 : opts.emissive,
      emissiveIntensity: opts.emissiveIntensity === undefined ? 1 : opts.emissiveIntensity
    });
    matCache[key] = m;
    return m;
  }

  /** Self-lit material for anything that should glow (the crown). */
  function glow(color, intensity) {
    return paper(color, {
      emissive: color,
      emissiveIntensity: intensity === undefined ? 0.9 : intensity,
      roughness: 0.55,
      noMap: true
    });
  }

  const INK = 0x2f231a;

  function outline(mesh, color, angle) {
    try {
      const edges = new THREE.EdgesGeometry(mesh.geometry, angle === undefined ? 26 : angle);
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: color === undefined ? INK : color })
      );
      line.raycast = function () {};
      mesh.add(line);
      return line;
    } catch (e) {
      return null;
    }
  }

  /** Outline every mesh in a group — used on gameplay-critical props only. */
  function ink(group, color) {
    group.traverse((o) => { if (o.isMesh) outline(o, color); });
    return group;
  }

  function part(geo, mat, opts) {
    opts = opts || {};
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = opts.cast !== false;
    m.receiveShadow = !!opts.receive;
    if (opts.outline) outline(m, opts.outlineColor, opts.outlineAngle);
    if (opts.pos) m.position.set(opts.pos[0], opts.pos[1], opts.pos[2]);
    if (opts.rot) m.rotation.set(opts.rot[0], opts.rot[1], opts.rot[2]);
    if (opts.scale) {
      if (typeof opts.scale === 'number') m.scale.setScalar(opts.scale);
      else m.scale.set(opts.scale[0], opts.scale[1], opts.scale[2]);
    }
    return m;
  }

  function setShadow(root, cast, receive) {
    root.traverse((o) => {
      if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; }
    });
    return root;
  }

  /**
   * A block of the siege wall — the visual half of a level cell. The physics
   * body (Ammo) is a separate box built to match these same dimensions;
   * see js/physics.js. Given an ink outline unconditionally: every block is
   * something the player is judging a shot against.
   */
  function buildBlock(w, h, d, color, opts) {
    opts = opts || {};
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = opts.glow ? glow(color) : paper(color);
    const mesh = part(geo, mat, { cast: true, receive: true, outline: true });
    return mesh;
  }

  /**
   * The ballista itself: a paper-craft siege engine sitting at the world
   * origin, facing -Z (downrange — see data.js's coordinate-system note).
   * Built from chunky primitives only, no imported model. Static dressing for
   * now; the shot pipeline (step 4) will need to swing the arm to the solved
   * elevation and yaw, so the whole assembly is returned with named parts a
   * later step can rotate rather than being baked into one mesh.
   */
  function buildBallista(woodColor, steelColor) {
    const wood = paper(woodColor || 0xa9682f);
    const steel = paper(steelColor || 0x4a5160, { roughness: 0.5, metalness: 0.15 });

    const root = new THREE.Group();
    root.name = 'ballista';

    /* Base sled: a low, wide plank the whole engine sits on. */
    const base = part(new THREE.BoxGeometry(1.6, 0.32, 2.6), wood, {
      pos: [0, 0.16, 0], outline: true
    });
    root.add(base);

    /* Two wheels, one either side, purely for silhouette — the engine never
       rolls. */
    [-0.95, 0.95].forEach((x) => {
      const wheel = part(new THREE.CylinderGeometry(0.55, 0.55, 0.22, 16), wood, {
        pos: [x, 0.55, 0.7], rot: [0, 0, Math.PI / 2], outline: true
      });
      root.add(wheel);
    });

    /* A-frame uprights that carry the pivot. */
    [-0.55, 0.55].forEach((x) => {
      const upright = part(new THREE.BoxGeometry(0.26, 1.7, 0.3), wood, {
        pos: [x, 0.32 + 0.85, -0.1], outline: true
      });
      root.add(upright);
    });

    /* The pivot group: everything that actually points at the target lives
       under here, so aiming (step 4) only ever has to set this group's
       rotation rather than rebuild geometry. Sits at MUZZLE_Y so a shot
       leaving here matches what data.js assumes. */
    const pivot = new THREE.Group();
    pivot.name = 'pivot';
    pivot.position.set(0, RT.data.CFG.MUZZLE_Y, 0);
    root.add(pivot);

    const armPart = part(new THREE.BoxGeometry(0.24, 0.24, 3.0), steel, {
      pos: [0, 0, -0.4], outline: true
    });
    pivot.add(armPart);

    /* Bow arms, splayed out from the front of the arm — pure silhouette, the
       two-curve shape that reads as "ballista" at a glance. */
    [-1, 1].forEach((side) => {
      const bow = part(new THREE.BoxGeometry(0.14, 0.14, 1.3), wood, {
        pos: [side * 0.55, 0, -1.7],
        rot: [0, side * 0.5, 0],
        outline: true
      });
      pivot.add(bow);
    });

    setShadow(root, true, false);

    return { root: root, pivot: pivot };
  }

  /** The projectile. A plain sphere is enough to read clearly against the
   *  paper-craft blocks without needing per-ammo models yet. No ink outline —
   *  a fast-moving sphere doesn't get the same "judge this at a glance"
   *  treatment as a static obstacle, and EdgesGeometry on a sphere is
   *  effectively a full wireframe. */
  function buildBolt(radius, color) {
    const geo = new THREE.SphereGeometry(radius, 10, 8);
    return part(geo, paper(color === undefined ? 0x3a3226 : color, { roughness: 0.7 }), {
      cast: true, receive: false
    });
  }

  return {
    paperTexture, skyTexture,
    paper, glow, outline, ink, part, setShadow,
    buildBlock, buildBallista, buildBolt,
    INK
  };
})();
