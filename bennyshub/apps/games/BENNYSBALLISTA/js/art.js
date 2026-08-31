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

  /* ── Materials ────────────────────────────────────────────────────────────
   * This module never reads the DOM or the theme; it is *told* what to look
   * like, the same way world.js is handed its colours rather than fetching
   * them. game.js reads the CSS custom properties once per theme change and
   * calls setFlat()/setInk() here.
   */

  let matCache = {};
  let flatProfile = false;

  /**
   * High Contrast wants unlit, solid-fill geometry rather than the paper-craft
   * shading — flat colour and heavy outlines, no gradients, no texture. That
   * is a different *material class*, not a different colour, so it has to be
   * decided here where materials are made. game.js drives it from isFlat().
   */
  function setFlat(on) {
    on = !!on;
    if (on === flatProfile) return false;
    flatProfile = on;
    clearMatCache();
    return true;                        // caller needs to rebuild/repaint
  }
  function isFlatProfile() { return flatProfile; }

  /** Materials are cached and shared across every block, so nothing may
   *  dispose them per-mesh (see game.js's disposeBlockMesh). Dropping the
   *  cache wholesale is how a theme change gets clean materials — without
   *  this, the cache key (colour + opts) matches across themes and the OLD
   *  material is handed back, so the world keeps the previous profile's look.
   *
   *  Deliberately does NOT dispose the old materials. Live meshes still hold
   *  references until game.js repaints them, and disposing a material that is
   *  still on a mesh is a use-after-free waiting on someone forgetting to
   *  repaint one thing. The cost of not disposing is a handful of tiny
   *  materials per theme switch, which is not worth that risk. */
  function clearMatCache() { matCache = {}; }

  /** The workhorse: flat-shaded, papery, no shine — or unlit solid fill in
   *  the High Contrast profile. */
  function paper(color, opts) {
    opts = opts || {};
    const key = (flatProfile ? 'f|' : 'p|') + color + '|' + JSON.stringify(opts);
    if (matCache[key]) return matCache[key];

    let m;
    if (flatProfile) {
      /* Unlit: the colour on screen is exactly the palette colour, with no
         light, no shadow and no paper fibre to wash it out. An emissive glow
         has no meaning here — an unlit material is already at full value —
         so the crown/tyrant simply renders as its own solid colour, which in
         this profile is the brightest thing on a black field anyway. */
      m = new THREE.MeshBasicMaterial({
        color: color,
        side: opts.side || THREE.FrontSide,
        transparent: !!opts.transparent,
        opacity: opts.opacity === undefined ? 1 : opts.opacity,
        fog: false                      // distance must not eat contrast
      });
    } else {
      m = new THREE.MeshStandardMaterial({
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
    }
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

  /* One shared ink material for every outline in the scene. Two reasons it is
   * shared rather than one material per outline: there is an outline on every
   * block of every castle, and — the point here — re-inking for a new theme is
   * then a single colour assignment that every existing outline picks up,
   * with no traversal and nothing to rebuild. */
  const INK = 0x2f231a;                 // the paper-craft default, still the fallback
  const inkMat = new THREE.LineBasicMaterial({ color: INK });

  function setInk(color) {
    try { inkMat.color.set(color || INK); } catch (e) { inkMat.color.set(INK); }
  }

  function outline(mesh, color, angle) {
    try {
      const edges = new THREE.EdgesGeometry(mesh.geometry, angle === undefined ? 26 : angle);
      /* A caller asking for a specific colour gets its own material; everything
         else shares the themed one. Nothing currently passes a colour, but the
         parameter predates this and removing it would be a silent behaviour
         change for any caller added since. */
      const mat = color === undefined ? inkMat : new THREE.LineBasicMaterial({ color: color });
      const line = new THREE.LineSegments(edges, mat);
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

  /* ── Environment scenery ──────────────────────────────────────────────────
   * Ported from BENNYSRACETRACKS' art.js (cloud/hillBackdrop, unchanged) —
   * the ATTRACT/SETTLE camera orbits the arena, so the horizon needs real
   * geometry that reads correctly from every angle, not a single painted
   * backdrop (see the ballista-3d plan on why this is fully procedural).
   */

  /** Always near-white regardless of theme; broken out so world.js can
   *  re-fetch it after a profile change flips paper() between the lit and
   *  unlit material class (clouds don't repaint via A.repaint() since they
   *  carry no palette key — there is nothing about their colour that varies
   *  by theme, only the material class does). */
  function cloudMaterial() {
    return paper(0xfffefb, { roughness: 1, flat: false, noMap: true });
  }

  /** Chunky stacked-lobe cloud. Smooth spheres rather than facets — a soft
   *  cut-out shape reads as weather; a faceted one reads as rubble. */
  function cloud(r) {
    const g = new THREE.Group();
    const white = cloudMaterial();
    const n = r.int(4, 6);
    let x = 0;
    for (let i = 0; i < n; i++) {
      const rad = r.range(4.2, 7.0) * (1 - Math.abs(i - (n - 1) / 2) / (n * 1.5));
      g.add(part(new THREE.SphereGeometry(rad, 12, 9), white, {
        pos: [x, r.range(-0.4, 0.8), r.range(-1.2, 1.2)],
        scale: [1, r.range(0.62, 0.8), 1],
        cast: false
      }));
      x += rad * r.range(1.0, 1.35);
    }
    g.position.x = -x / 2;
    const wrap = new THREE.Group();
    wrap.add(g);
    return wrap;
  }

  /** Big soft shape along the horizon so the world doesn't end at the fog.
   *  Tagged 'hill' so a theme change repaints it the same way as any other
   *  palette-driven part (see repaint()). */
  function hillBackdrop(r, colors) {
    const g = new THREE.Group();
    const rad = r.range(45, 90);
    const mesh = part(new THREE.SphereGeometry(rad, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2), paper(r.pick(colors)), {
      pos: [0, -rad * r.range(0.35, 0.55), 0],
      scale: [r.range(1.2, 2.2), r.range(0.3, 0.5), 1],
      cast: false
    });
    mesh.userData.pal = 'hill';
    g.add(mesh);
    return g;
  }

  /* Extra material options per palette entry, so repaint() can rebuild the
     exact material a part was first given rather than a plain one. */
  const PAL_OPTS = { wood: undefined, steel: { roughness: 0.5, metalness: 0.15 } };

  /**
   * Repaint an already-built assembly for a new palette.
   *
   * A mesh holds whatever material it was handed when it was built, so a
   * palette change does not reach it on its own — clearing the material cache
   * only affects things built *after* the switch. Each part records which
   * palette entry it was painted from (`userData.pal`), which makes this a
   * lookup rather than a rebuild: the ballista keeps its live aim rotation and
   * nothing has to be removed from the scene.
   *
   * @param {THREE.Object3D} root
   * @param {object} colors  palette entry name -> css colour
   */
  function repaint(root, colors) {
    root.traverse((o) => {
      const key = o.isMesh && o.userData ? o.userData.pal : null;
      if (!key || colors[key] === undefined) return;
      o.material = paper(colors[key], PAL_OPTS[key]);
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
    const mat = opts.glow ? glow(color) : paper(color);
    const mesh = part(blockGeometry(w, h, d, opts.shape), mat,
                      { cast: true, receive: true, outline: true });
    return mesh;
  }

  /**
   * Two things Ben has to tell apart must differ in SHAPE as well as colour —
   * a marking or a shade alone does not survive low vision. Materials that are
   * always a single cell can therefore afford their own silhouette, and the
   * powder keg is the clearest case: as a box it was indistinguishable from
   * every other block until it exploded.
   *
   * Only ever called for non-mergeable materials, whose runs are always one
   * cell (see levels.js's rowRuns — it only extends a run when mat.mergeable),
   * so a shaped mesh can never be asked to stretch across a merged wall. The
   * physics body stays the same box either way, which is fine at this scale
   * and keeps js/physics.js free of shape special cases.
   */
  function blockGeometry(w, h, d, shape) {
    if (shape === 'barrel') {
      const r = Math.min(w, d) * 0.5;
      // 10 sides, not 16: chunky and faceted reads as craft, and gives
      // EdgesGeometry real corners to ink instead of a smooth tube.
      return new THREE.CylinderGeometry(r, r, h, 10);
    }
    if (shape === 'crown') {
      /* The crown is the win condition, so it is the one thing that must
       * never be ambiguous — and up to now it relied on glow()'s emissive to
       * stand out. That works in the three lit profiles and does nothing at
       * all in High Contrast, where materials are unlit and every colour is
       * already at full value: there the crown was a yellow box among orange
       * boxes, i.e. distinguished by hue alone, in exactly the profile that
       * exists because hue alone is not enough. A real humanoid silhouette
       * (the baked tyrant model, once approved — see js/models.js) solves
       * that on shape alone, same as every other block here; the faceted
       * gem is the fallback for as long as that model isn't baked yet. */
      const tyrant = RT.models.geometry('tyrant');
      if (tyrant) return tyrant;
      /* Sized to the cell's inscribed radius so it fills the cell without
       * overhanging it (the interpenetration audit has to stay honest). */
      return new THREE.OctahedronGeometry(Math.min(w, h, d) * 0.5);
    }
    return new THREE.BoxGeometry(w, h, d);
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
    const steel = paper(steelColor || 0x4a5160, PAL_OPTS.steel);

    /* Tag each part with the palette entry it was painted from, so
       repaint() can re-colour the whole engine on a theme change without
       rebuilding it and losing the pivot's current aim. */
    const tag = (mesh, pal) => { mesh.userData.pal = pal; return mesh; };

    const root = new THREE.Group();
    root.name = 'ballista';

    /* Base sled: a low, wide plank the whole engine sits on. */
    const base = part(new THREE.BoxGeometry(1.6, 0.32, 2.6), wood, {
      pos: [0, 0.16, 0], outline: true
    });
    root.add(tag(base, 'wood'));

    /* Two wheels, one either side, purely for silhouette — the engine never
       rolls. */
    [-0.95, 0.95].forEach((x) => {
      const wheel = part(new THREE.CylinderGeometry(0.55, 0.55, 0.22, 16), wood, {
        pos: [x, 0.55, 0.7], rot: [0, 0, Math.PI / 2], outline: true
      });
      root.add(tag(wheel, 'wood'));
    });

    /* A-frame uprights that carry the pivot. */
    [-0.55, 0.55].forEach((x) => {
      const upright = part(new THREE.BoxGeometry(0.26, 1.7, 0.3), wood, {
        pos: [x, 0.32 + 0.85, -0.1], outline: true
      });
      root.add(tag(upright, 'wood'));
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
    pivot.add(tag(armPart, 'steel'));

    /* Bow arms, splayed out from the front of the arm — pure silhouette, the
       two-curve shape that reads as "ballista" at a glance. */
    [-1, 1].forEach((side) => {
      const bow = part(new THREE.BoxGeometry(0.14, 0.14, 1.3), wood, {
        pos: [side * 0.55, 0, -1.7],
        rot: [0, side * 0.5, 0],
        outline: true
      });
      pivot.add(tag(bow, 'wood'));
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

  /**
   * A baked hero model (see js/models.js), painted and outlined exactly like
   * every procedural part above. Returns null when the name hasn't been
   * baked yet, so a caller can no-op rather than build a placeholder — same
   * "not approved yet" convention `RT.models.geometry()` itself documents.
   */
  function buildModel(name, color, pal) {
    const geo = RT.models.geometry(name);
    if (!geo) return null;
    const mesh = part(geo, paper(color), { outline: true });
    if (pal) mesh.userData.pal = pal;
    return mesh;
  }

  return {
    paperTexture, skyTexture,
    paper, glow, outline, ink, part, setShadow, buildModel,
    buildBlock, blockGeometry, buildBallista, buildBolt,
    setFlat, isFlatProfile, clearMatCache, setInk, repaint,
    cloudMaterial, cloud, hillBackdrop,
    INK
  };
})();
