/**
 * Benny's Ballista — level editor.
 *
 * Everything below used to be editor.html's inline script (~200 lines that
 * could only preview a level typed as ASCII and run a non-idempotent stand-up
 * check). This is the mouse-driven authoring tool that replaces it: a padded
 * grid document as the single source of truth, analytic cell picking (never
 * mesh raycasting — see pickCell()), a sticky block palette, snap-to-attach,
 * copy/paste, a saved-assembly library, and an idempotent stability test.
 *
 * Load order matters and mirrors index.html's subset (editor.html's own
 * comment on its <script> list explains what's deliberately omitted):
 *   three.min.js, ammo.js, util.js, models.js, data.js, levels.js, art.js,
 *   world.js, physics.js, THEN this file.
 *
 * This tool is explicitly exempt from the hub's two-key/switch-accessibility
 * rules (see editor.html's #hint and README.md) — it is never registered in
 * games.json/tools.json and the hub has no route to it. Mouse + keyboard is
 * the correct and intended interface here.
 */
RT.editor = (function () {
  'use strict';

  const D = RT.data, LV = RT.levels, A = RT.art, W = RT.world, P = RT.physics, U = RT.util;
  const CFG = D.CFG;
  const CELL = LV.CELL;

  /* ── DOM ──────────────────────────────────────────────────────────────── */
  const els = {
    picker: document.getElementById('picker'),
    theme: document.getElementById('theme'),
    paletteWarn: document.getElementById('paletteWarn'),
    name: document.getElementById('fName'), dist: document.getElementById('fDist'),
    par: document.getElementById('fPar'), bolts: document.getElementById('fBolts'),
    layers: document.getElementById('layersBox'),
    stats: document.getElementById('stats'),
    checkResult: document.getElementById('checkResult'),
    validation: document.getElementById('validation'),
    exportBox: document.getElementById('exportBox'),
    palette: document.getElementById('palette'),
    toolButtons: document.getElementById('toolButtons'),
    layerLabel: document.getElementById('layerLabel'),
    selectionInfo: document.getElementById('selectionInfo'),
    assemblyList: document.getElementById('assemblyList'),
    assemblyName: document.getElementById('assemblyName'),
    assemblyText: document.getElementById('assemblyText'),
    ammoList: document.getElementById('ammoList'),
    ammoReach: document.getElementById('ammoReach')
  };

  /* ── Palette — real theme colours, not a hardcoded hex table ─────────────
   * game.js's own PALETTE_VARS list is hand-typed and would rot the moment a
   * material was added without a matching entry — this derives the material
   * half of the list from D.MAT itself so that can't happen here. Unknown/
   * empty CSS vars surface as a visible warning instead of a silent grey block. */
  const WORLD_VARS = ['sky1', 'sky2', 'sky3', 'sun', 'ground', 'hill', 'dirt', 'focus', 'ink'];
  const MAT_VARS = Array.from(new Set(Object.keys(D.MAT).map((k) => D.MAT[k].css.replace('--', ''))));
  const PALETTE_VARS = WORLD_VARS.concat(MAT_VARS);
  let PAL = {};
  function refreshPalette() {
    const cs = getComputedStyle(document.body);
    PAL = {};
    const missing = [];
    for (const v of PALETTE_VARS) {
      const val = cs.getPropertyValue('--' + v).trim();
      if (!val) missing.push(v);
      PAL[v] = val || '#888';
    }
    els.paletteWarn.textContent = missing.length
      ? 'Undefined for this theme: ' + missing.map((v) => '--' + v).join(', ') +
        ' — falling back to grey. Add it to editor.html\'s CSS blocks.'
      : '';
  }
  function css(name) { return PAL[name] || '#888'; }
  function colorFor(matId) {
    const mat = D.MAT[matId];
    return mat ? css(mat.css.replace('--', '')) : '#888';
  }
  function isFlat() { return document.body.dataset.theme === 'contrast'; }
  /** Same bundle shape game.js:178-185 hands to world.js/art.js, so the two
   *  never drift apart from having two different assemblers. */
  function worldPalette() {
    return {
      sky1: css('sky1'), sky2: css('sky2'), sky3: css('sky3'),
      ground: css('ground'), hill: css('hill'), dirt: css('dirt'),
      wood: css('wood'), sunColor: css('sun'), flat: isFlat()
    };
  }
  function applyTheme(name) {
    document.body.setAttribute('data-theme', name);
    refreshPalette();
    A.setInk(css('ink'));
    A.setFlat(isFlat());
    W.refresh(world, worldPalette(), scene);
    // A.buildBlock() never sets userData.pal (blocks are rebuilt per level,
    // not repainted — see art.js), so the cheap A.repaint() path the ballista
    // uses can't repaint a castle. Drop the prototypes and rebuild instead;
    // at ~40 blocks max this is well under a frame.
    dropProtoCache();
    rebuild();
  }

  // Default to the same profile the game defaults to; refreshPalette() has to
  // run before the very first W.build() below or that call sees only the
  // hardcoded '#888' fallback, not real theme colours.
  document.body.setAttribute('data-theme', 'ben');
  refreshPalette();
  A.setInk(css('ink'));
  A.setFlat(isFlat());

  /* ── Scene ────────────────────────────────────────────────────────────── */
  const stage = document.getElementById('stage');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 400);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  // Capped the same way js/main.js:31 caps it — without any setPixelRatio at
  // all this rendered at 1x on a HiDPI screen and looked soft.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
  stage.appendChild(renderer.domElement);

  // Real theme colours (see worldPalette() above), not the old 3-key stub —
  // world.js's own fallbacks (pal.hill || pal.ground etc.) covered for that
  // stub's missing keys, which is exactly why they existed, but a fuller
  // palette means the editor's sky/hills/dirt match the game's, not a guess.
  const world = W.build(scene, worldPalette());

  /* Simple drag-to-orbit / wheel-to-zoom camera, centred on wherever the
   * live level's castle actually sits — no OrbitControls vendored, and this
   * tool doesn't need anything fancier. Left button now does double duty
   * (orbit on a drag, place/erase/select on a plain click) — see the pointer
   * handlers below the picking section. */
  const orbit = { az: 0.5, el: 0.45, dist: 14, target: new THREE.Vector3(0, 1.5, -14) };
  function applyOrbit() {
    const r = orbit.dist;
    camera.position.set(
      orbit.target.x + r * Math.cos(orbit.el) * Math.sin(orbit.az),
      orbit.target.y + r * Math.sin(orbit.el),
      orbit.target.z + r * Math.cos(orbit.el) * Math.cos(orbit.az)
    );
    camera.lookAt(orbit.target);
  }
  /** Aims the camera at the castle the document actually describes. The
   *  target's Z was a hardcoded -14 while a level's own `dist` puts its
   *  castle anywhere from ~16 to ~28 downrange — so the view was centred on
   *  empty ground up to ten units IN FRONT of the thing being edited. That
   *  is a framing bug on its own, but it also broke placement: ground under
   *  the cursor mid-screen was ground in front of the castle, so a click
   *  there legitimately resolved to a layer well in front of layer 0 and
   *  nothing landed where the eye expected. Call after anything that changes
   *  `dist` or loads a document. */
  function frameDoc() {
    orbit.target.set(0, Math.min(4, Math.max(1.5, doc.rows * CELL * 0.35)), -doc.dist);
    applyOrbit();
  }
  applyOrbit();

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  // Observing #stage rather than the window: the sidebar can change width (a
  // long validation message, a scrollbar appearing) without the window ever
  // resizing, and a window listener sleeps through all of that.
  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
  else window.addEventListener('resize', resize);
  resize();

  /* ── Grid document — the single source of truth ──────────────────────────
   * Rectangular and padded, ALWAYS: every layer has exactly doc.rows rows,
   * every row exactly doc.cols chars. layer 0 = FRONT (nearest the ballista);
   * row 0 = TOP (levels.js: bottom = rowBottoms(layerRows, rows, cols)[row][col]
   * — the REAL cumulative floor height for THAT COLUMN, not a flat
   * `(rows - row - 1) * CELL`; a board/rubble cell is thinner than a full
   * CELL, so whatever's above one sits flush on its actual surface, and an
   * unrelated column sharing the same row index is never affected).
   *
   * Why padding is mandatory, not tidiness: parseLevel() computes rows/cols
   * as MAXIMA across all layers, and every row still costs SOME reserved
   * height (a full CELL unless something thinner occupies it) even if empty.
   * So adding one row to ONE layer raises `rows`, which shifts every block in
   * EVERY layer by that reserved amount. A ragged document makes "grow the
   * castle" an accidental whole-castle displacement; a padded one makes it a
   * single well-defined row/column insert. */
  // centerCol/centerLayer: the STABLE X/Z centre used everywhere instead of
  // the naive "half the current total" — see levels.js's layerZ()/cellCentre()
  // notes for why. Reset to the natural cols/2, (numLayers-1)/2 on every
  // fresh load/apply (loadLevelIntoDoc, applyText); nudged by growTo() and
  // the layer-add/remove buttons exactly when they reindex EXISTING content,
  // so an edit never silently slides everything already placed.
  // padLeft/padRight/padTop/padBack: exactly how much of the current
  // left/right/top/back edge is padBuildVolume()'s own unused build margin
  // (see its doc) rather than the level's real content — trimLevelLayers()
  // caps its trimming to these so it can never eat a designer's OWN
  // intentional blank border, only margin the editor itself added.
  const doc = { name: 'Untitled', dist: 26, par: 3, bolts: 9, ammo: null, cols: 0, rows: 0, grid: [], centerCol: 0, centerLayer: 0, padLeft: 0, padRight: 0, padTop: 0, padBack: 0 };

  function cellAt(l, r, c) {
    if (l < 0 || l >= doc.grid.length) return '.';
    if (r < 0 || r >= doc.rows) return '.';
    if (c < 0 || c >= doc.cols) return '.';
    return doc.grid[l][r][c];
  }

  /** Grows the document to include [minCol,maxCol] x [minRow,maxRow], padding
   *  every existing layer so the grid stays rectangular. Returns the offset
   *  applied at the LOW end of each axis, because a caller that just asked to
   *  write cell (r,c) needs to re-express that request in the grown grid's
   *  coordinates — growing left/up shifts every existing index.
   *
   *  Growing LEFT reindexes every existing column by +addLeft, so
   *  `doc.centerCol` gets the same +addLeft — see levels.js's cellCentre()
   *  note: X is centred on the total column count, so without this every
   *  already-placed column would slide sideways the instant the grid grows,
   *  even though nothing about its own content changed. Growing RIGHT never
   *  reindexes existing columns, so it needs no adjustment. Rows/Y have no
   *  such correction because Y isn't centred — it's floor-anchored (see
   *  cellThickness()'s doc) — which is why only the COLUMN axis needs this. */
  function growTo(minCol, maxCol, minRow, maxRow) {
    const addLeft = Math.max(0, -minCol);
    const addRight = Math.max(0, maxCol - (doc.cols - 1));
    const addTop = Math.max(0, -minRow);
    const addBottom = Math.max(0, maxRow - (doc.rows - 1));
    if (!addLeft && !addRight && !addTop && !addBottom) return { addLeft: 0, addTop: 0 };
    const newCols = doc.cols + addLeft + addRight;
    const newRows = doc.rows + addTop + addBottom;
    doc.grid = doc.grid.map((layer) => {
      const newLayer = [];
      for (let r = 0; r < newRows; r++) {
        const row = new Array(newCols).fill('.');
        const srcR = r - addTop;
        if (srcR >= 0 && srcR < doc.rows) {
          const oldRow = layer[srcR];
          for (let c = 0; c < doc.cols; c++) row[c + addLeft] = oldRow[c];
        }
        newLayer.push(row);
      }
      return newLayer;
    });
    doc.cols = newCols; doc.rows = newRows;
    doc.centerCol += addLeft;
    return { addLeft: addLeft, addTop: addTop };
  }

  function blankLayer() {
    const rows = [];
    for (let r = 0; r < doc.rows; r++) rows.push(new Array(doc.cols).fill('.'));
    return rows;
  }

  /** Generous, empty build margin added around a level's actual content the
   *  moment it's loaded into the editor — left/right columns, extra sky
   *  overhead, and extra layers BEHIND the deepest one. The point is that an
   *  ordinary paste anywhere in that margin never has to trigger growTo() (or
   *  the front-layer/bottom-row cases that genuinely can't be made free) at
   *  all, so it just lands, with zero risk of nudging anything.
   *
   *  Uses growTo() for columns/rows (same centre-preserving math as any other
   *  growth — see its own doc) and plain back-append for layers (already
   *  free, see the "+ Layer (back)" button's note). Never pads rows at the
   *  BOTTOM or layers at the FRONT — those are the two directions that
   *  genuinely can't stay free (rows are floor-anchored; see cellThickness's
   *  doc), and this margin is meant to be free to use without a second
   *  thought, not to relocate the one real limitation.
   *
   *  Exported levels are trimmed back to their real content (see
   *  trimLevelLayers()) — this margin exists for editing, never for the
   *  shipped level, so it never adds dead travel time or wasted depth.
   *  trimLevelLayers() trims AT MOST doc.padLeft/padRight/padTop/padBack —
   *  set here to exactly what was just added — and only while still blank.
   *  A real level can legitimately have its OWN intentional blank border
   *  (a symmetric frame, spacing around a tower) that looks identical to
   *  unused margin; the amount actually added is the only way to tell them
   *  apart, so trimming by "is this edge blank" alone would just as happily
   *  eat a designer's real framing. */
  const BUILD_PAD_COLS = 6, BUILD_PAD_ROWS_TOP = 6, BUILD_PAD_LAYERS_BACK = 4;
  function padBuildVolume() {
    if (!doc.grid.length) { doc.padLeft = doc.padRight = doc.padTop = doc.padBack = 0; return; }
    growTo(-BUILD_PAD_COLS, doc.cols - 1 + BUILD_PAD_COLS, -BUILD_PAD_ROWS_TOP, doc.rows - 1);
    for (let i = 0; i < BUILD_PAD_LAYERS_BACK; i++) doc.grid.push(blankLayer());
    doc.padLeft = BUILD_PAD_COLS; doc.padRight = BUILD_PAD_COLS;
    doc.padTop = BUILD_PAD_ROWS_TOP; doc.padBack = BUILD_PAD_LAYERS_BACK;
  }

  /** Makes layer index `l` exist, and returns how much every EXISTING layer
   *  index shifted to make room — the caller adds that to its own `l`, the
   *  same contract growTo() has for rows/columns.
   *
   *  Appending at the back is free. Prepending at the FRONT reindexes every
   *  existing layer by +addFront, so doc.centerLayer (and activeLayer) get
   *  the same bump — see levels.js's layerZ() note: Z is centred on the
   *  layer count, so without that compensation every already-placed layer
   *  would jump in depth. A negative `l` used to be silently dropped here
   *  (the old `while (doc.grid.length <= l)` can't prepend), so attaching to
   *  the FRONT face of the frontmost layer wrote to doc.grid[-1] and did
   *  nothing at all. */
  function growLayersTo(l) {
    if (l < 0) {
      const addFront = -l;
      for (let i = 0; i < addFront; i++) doc.grid.unshift(blankLayer());
      doc.centerLayer += addFront;
      activeLayer += addFront;
      return addFront;
    }
    while (doc.grid.length <= l) doc.grid.push(blankLayer());
    return 0;
  }

  function setCell(l, r, c, ch) {
    const off = growTo(c, c, r, r);
    r += off.addTop; c += off.addLeft;
    l += growLayersTo(l);
    doc.grid[l][r][c] = ch;
  }

  /** Layers with fewer rows than the document get padded at the TOP, not the
   *  bottom — a short layer's own last row is its "ground" row (parseLevel's
   *  bottom-up convention), so padding at the bottom would leave its content
   *  floating above the document's actual floor. Verified against all 16
   *  shipped levels: none are ragged, so this is a no-op for every existing
   *  level (byte-identical round trip) and only matters for hand-typed or
   *  pasted text. */
  function gridFromLayers(layers) {
    let cols = 0, rows = 0;
    for (const layer of layers) {
      rows = Math.max(rows, layer.length);
      for (const row of layer) cols = Math.max(cols, row.length);
    }
    const notes = [];
    const grid = layers.map((layer, li) => {
      const padTop = rows - layer.length;
      if (padTop > 0) notes.push('Layer ' + (li + 1) + ' had ' + layer.length + ' row(s), padded to ' + rows + ' at the top so its content stays on the ground.');
      const newLayer = [];
      for (let r = 0; r < rows; r++) {
        const row = new Array(cols).fill('.');
        const srcR = r - padTop;
        if (srcR >= 0 && srcR < layer.length) {
          const srcRow = layer[srcR];
          if (srcRow.length < cols) notes.push('Layer ' + (li + 1) + ' had a short row, padded to ' + cols + ' columns.');
          for (let c = 0; c < srcRow.length; c++) row[c] = srcRow[c];
        }
        newLayer.push(row);
      }
      return newLayer;
    });
    return { grid: grid, cols: cols, rows: rows, notes: notes };
  }

  function layersFromGrid() {
    return doc.grid.map((layer) => layer.map((row) => row.join('')));
  }

  function loadLevelIntoDoc(level) {
    doc.name = level.name; doc.dist = level.dist; doc.par = level.par; doc.bolts = level.bolts;
    doc.ammo = level.ammo ? level.ammo.slice() : null;
    const g = gridFromLayers(level.layers);
    doc.grid = g.grid; doc.cols = g.cols; doc.rows = g.rows;
    // A fresh load has no in-progress edit history to preserve — start the
    // centre at its natural, true-dimensions value (matching how the real
    // game would centre this same data) rather than carrying over whatever
    // the PREVIOUSLY loaded level's growth had nudged it to.
    doc.centerCol = doc.cols / 2;
    doc.centerLayer = (doc.grid.length - 1) / 2;
    padBuildVolume();
    activeLayer = 0;
  }

  /** The doc, in the exact shape RT.levels.parseLevel()/js/data.js expect.
   *  _cols/_depth are NOT set by parseLevel() itself — levels.js:506-510 sets
   *  them once at module load for the shipped LEVELS array — so anything here
   *  that calls castleBounds()/rangeWindow()/yawLimit() (the ammo-reach
   *  readout in a later stage) would silently see cols=1,depth=1 without this. */
  function docAsLevel() {
    const level = { name: doc.name, par: doc.par, bolts: doc.bolts, dist: doc.dist, layers: layersFromGrid() };
    if (doc.ammo && doc.ammo.length) level.ammo = doc.ammo.slice();
    level._cols = doc.cols;
    level._depth = doc.grid.length;
    // Editor-only, like _cols/_depth above — never written by exportText(),
    // so a saved level always gets parseLevel()'s natural, true-dimensions
    // centre. See levels.js's layerZ()/cellCentre() notes for why the LIVE
    // editor needs a stable centre instead.
    level.centerCol = doc.centerCol;
    level.centerLayer = doc.centerLayer;
    return level;
  }

  /* ── Undo/redo — bounded snapshot stack ──────────────────────────────────
   * A sticky place tool with no undo makes every misclick destructive. At
   * ≤750 cells the cost of a deep-clone-per-edit is nil. */
  let undoStack = [], redoStack = [];
  function snapshotDoc() { return JSON.parse(JSON.stringify(doc)); }
  function pushUndo() {
    undoStack.push(snapshotDoc());
    if (undoStack.length > 50) undoStack.shift();
    redoStack = [];
  }
  function restoreSnapshot(snap) {
    doc.name = snap.name; doc.dist = snap.dist; doc.par = snap.par; doc.bolts = snap.bolts;
    doc.ammo = snap.ammo; doc.cols = snap.cols; doc.rows = snap.rows; doc.grid = snap.grid;
    doc.centerCol = snap.centerCol; doc.centerLayer = snap.centerLayer;
    doc.padLeft = snap.padLeft; doc.padRight = snap.padRight; doc.padTop = snap.padTop; doc.padBack = snap.padBack;
    if (activeLayer >= doc.grid.length) activeLayer = Math.max(0, doc.grid.length - 1);
    syncFormFromDoc();
    rebuild();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshotDoc());
    restoreSnapshot(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshotDoc());
    restoreSnapshot(redoStack.pop());
  }

  /* ── Prototype cache ──────────────────────────────────────────────────────
   * Editing is visual-only (no physics bodies) so every mutation can afford a
   * full re-parse — one cell edit can change merges across a whole row AND
   * into adjacent layers (levels.js's depth merge), so incremental rebuilding
   * would have to recompute the merge closure anyway, i.e. re-parse regardless.
   * What ISN'T affordable per click is re-building geometry: RT.models.geometry
   * re-decodes ~47KB of base64 into a 2948-triangle tyrant mesh on every call,
   * then A.part()'s EdgesGeometry runs over that — boxes are free, crowns are
   * not. Cache one prototype per (material, size) and .clone() it per
   * placement; clones share the prototype's geometry/material by construction,
   * so NEVER dispose a clone's own geometry (that would corrupt every other
   * clone sharing it) — only dropProtoCache() may dispose, and only the
   * prototypes themselves. */
  let protoCache = {};
  function protoFor(matId, w, h, d) {
    const key = matId + '|' + w + '|' + h + '|' + d;
    if (protoCache[key]) return protoCache[key];
    const mat = D.MAT[matId];
    const mesh = A.buildBlock(w, h, d, colorFor(matId), { glow: !!mat.crown, shape: mat.shape });
    protoCache[key] = mesh;
    return mesh;
  }
  // Ghost-preview state, declared up here so dropProtoCache() can invalidate
  // it: a ghost mesh is a CLONE sharing a prototype's geometry, so dropping
  // the cache disposes the geometry out from under any live ghost. Clearing
  // the key makes the next hover rebuild it from the fresh prototypes.
  let ghostKey = null, ghostCells = [];
  // Last cursor position over the view, so a rotation keypress can refresh the
  // ghost where the cursor already is rather than waiting for a mouse move.
  let lastPointer = null;
  function dropProtoCache() {
    for (const k in protoCache) {
      protoCache[k].traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
    protoCache = {};
    ghostKey = null;
  }

  /* ── Live view — rebuilt wholesale from `doc` on every mutation ─────────── */
  let live = { parsed: null, recs: [] };
  function clearLive() {
    for (const rec of live.recs) scene.remove(rec.mesh);
    live.recs = [];
  }

  /* The ghost preview's own scene objects. clearLive() only removes tracked
   * live.recs, so these survive every rebuild() and never need re-adding.
   *  - ghostGroup: one translucent mesh per cell about to be written (a
   *    single block for Place, every filled cell of the stamp for Paste).
   *  - ghostShadow: that footprint projected flat onto the ground. Depth is
   *    the one thing a perspective view can't convey on its own, so this is
   *    what actually tells you WHERE ON THE GROUND a piece will land. */
  const ghostGroup = new THREE.Group();
  scene.add(ghostGroup);
  const ghostShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x0b0b10, transparent: true, opacity: 0.32, depthWrite: false })
  );
  ghostShadow.rotation.x = -Math.PI / 2;
  ghostShadow.renderOrder = 9;
  ghostShadow.visible = false;
  scene.add(ghostShadow);

  /* The ROOT marker: which single cell of a pasted piece is its attachment
   * point — the cell that lands on whatever you pointed at. Drawn in a
   * distinct bright colour against the cage's plain white so "where will
   * this piece attach BY?" is answered on screen instead of from memory. */
  const rootMarker = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(CELL, CELL, CELL)),
    new THREE.LineBasicMaterial({ color: 0x2ee6ff, transparent: true, opacity: 0.95 })
  );
  rootMarker.visible = false;
  rootMarker.renderOrder = 11;
  scene.add(rootMarker);

  const cellCage = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(CELL, CELL, CELL)),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })
  );
  cellCage.visible = false;
  cellCage.renderOrder = 10;
  scene.add(cellCage);

  function rebuild() {
    clearLive();
    const level = docAsLevel();
    let parsed;
    try {
      parsed = LV.parseLevel(level);
    } catch (e) {
      live.parsed = null;
      els.stats.textContent = 'Could not parse layers: ' + e.message;
      els.validation.innerHTML = '';
      regenerateText();
      return;
    }
    live.parsed = parsed;
    for (const b of parsed.blocks) {
      const proto = protoFor(b.matId, b.w, b.h, b.d);
      const mesh = proto.clone();
      mesh.position.set(b.x, b.y, b.z);
      scene.add(mesh);
      live.recs.push({ mesh: mesh, spec: b });
    }
    W.recenterShadow(world, level.dist);
    updateStats(parsed);
    validate();
    regenerateText();
    updateLayerLabel();
    updateAmmoReach();
    els.checkResult.textContent = '';
    els.checkResult.className = '';
  }

  function updateStats(parsed) {
    els.stats.innerHTML =
      '<div>Cols <b>' + parsed.cols + '</b></div><div>Rows <b>' + parsed.rows + '</b></div>' +
      '<div>Depth (layers) <b>' + parsed.numLayers + '</b></div>' +
      '<div>Blocks <b>' + parsed.blocks.length + '</b></div><div>Crowns <b>' + parsed.crownCount + '</b></div>';
  }

  function regenerateText() { els.layers.value = layersFromGrid().map((rows) => rows.join('\n')).join('\n\n'); }

  function syncFormFromDoc() {
    els.name.value = doc.name;
    els.dist.value = doc.dist;
    els.par.value = doc.par;
    els.bolts.value = doc.bolts;
    syncAmmoCheckboxes();
    regenerateText();
  }

  /* ── Ammo selector ────────────────────────────────────────────────────────
   * Optional `doc.ammo` — null means "no restriction" (today's behaviour on
   * every shipped level, byte for byte). Checkbox order follows D.AMMO's
   * canonical order, matching game.js's availableAmmo(): the ammo lane is a
   * scan list, and a chip's POSITION is something a switch-scanning player
   * learns, so it must never depend on the order a level's own array happens
   * to list ids in. */
  function buildAmmoList() {
    els.ammoList.innerHTML = D.AMMO.map((a) =>
      '<label><input type="checkbox" data-ammo="' + a.id + '" checked> ' + escapeHtml(a.name) + '</label>'
    ).join('');
    els.ammoList.querySelectorAll('input[data-ammo]').forEach((cb) => cb.addEventListener('change', onAmmoChanged));
  }
  function syncAmmoCheckboxes() {
    const allowed = doc.ammo;
    els.ammoList.querySelectorAll('input[data-ammo]').forEach((cb) => {
      cb.checked = !allowed || allowed.indexOf(cb.dataset.ammo) !== -1;
    });
  }
  function onAmmoChanged() {
    pushUndo();
    const ids = [];
    let allChecked = true;
    els.ammoList.querySelectorAll('input[data-ammo]').forEach((cb) => {
      if (cb.checked) ids.push(cb.dataset.ammo); else allChecked = false;
    });
    doc.ammo = allChecked ? null : ids;   // "no restriction" is null, never a full explicit list
    rebuild();
  }
  /** The editor-side counterpart to game.js's auditAmmoOffers(), surfaced
   *  live instead of only at boot — js/data.js's ammoReachReport() is shared
   *  between the two so neither can drift from what the other actually
   *  checks. Requires _cols/_depth on the level object, which docAsLevel()
   *  sets (parseLevel() itself does not — see that function's own doc
   *  comment) — castleBounds()/rangeWindow() silently see cols=1,depth=1
   *  without it. */
  function updateAmmoReach() {
    const level = docAsLevel();
    const allowedIds = doc.ammo || D.AMMO.map((a) => a.id);
    const ammoList = D.AMMO.filter((a) => allowedIds.indexOf(a.id) !== -1);
    const report = D.ammoReachReport(level, ammoList);
    const html = [];
    for (const p of report.problems) html.push('<div class="err">✕ ' + escapeHtml(p) + '</div>');
    for (const w of report.warnings) html.push('<div class="warn">⚠ ' + escapeHtml(w) + '</div>');
    els.ammoReach.innerHTML = html.join('');
  }

  /* ── Validation ───────────────────────────────────────────────────────────
   * Replaces the old static prose #hint as the source of truth for what's
   * wrong with a level. levels.js's parser SILENTLY SKIPS unknown characters
   * (rowRuns: `if (!mat) { c++; continue; }`) — this is the only place that
   * actually tells the author. */
  function validate() {
    const errors = [], warnings = [];
    let sawCrown = false;
    for (let l = 0; l < doc.grid.length; l++) {
      for (let r = 0; r < doc.rows; r++) {
        for (let c = 0; c < doc.cols; c++) {
          const ch = doc.grid[l][r][c];
          if (ch === '.' || ch === ' ') continue;
          const mat = D.MAT[ch];
          if (!mat) { errors.push('Unknown character "' + ch + '" at layer ' + (l + 1) + ', row ' + (r + 1) + ', col ' + (c + 1) + ' — levels.js\'s parser silently ignores this.'); continue; }
          if (mat.crown) sawCrown = true;
          if (!css(mat.css.replace('--', '')) || PAL[mat.css.replace('--', '')] === undefined) {
            // refreshPalette() already folds an undefined var to '#888' with its
            // own top-level warning; nothing extra to say per-cell.
          }
          // Floating check: a non-static, non-small block with nothing directly
          // beneath it in its OWN layer (layers never support each other —
          // levels.js:16-22) and not resting on the ground row.
          if (!mat.static && r < doc.rows - 1) {
            const below = doc.grid[l][r + 1][c];
            if ((below === '.' || below === ' ') && r + 1 < doc.rows) {
              // Only warn once per run start, not once per column in a wide
              // run — a keyed set keeps this from spamming a whole wall.
            }
          }
        }
      }
    }
    if (!sawCrown) errors.push('No crown (K) anywhere — this level is unwinnable.');
    if (doc.grid.length === 0) errors.push('No layers at all.');

    const html = [];
    for (const e of errors) html.push('<div class="err">✕ ' + escapeHtml(e) + '</div>');
    for (const w of warnings) html.push('<div class="warn">⚠ ' + escapeHtml(w) + '</div>');
    els.validation.innerHTML = html.join('');
    return { errors: errors, warnings: warnings };
  }
  function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  /* ── Block palette — generated from D.MAT, not a static hint paragraph ───
   * Unrecognised flags render verbatim so a NEW flag added to data.js becomes
   * visible documentation instead of invisible behaviour. */
  const FLAG_LABELS = {
    mergeable: null, static: 'indestructible', crown: 'win condition',
    glass: 'shatters', explodes: 'explosive', plank: 'thin board', small: 'half-size, never merges'
  };
  let tool = { kind: 'place', matId: 'W' };
  function buildPalette() {
    els.palette.innerHTML = '';
    for (const id of Object.keys(D.MAT)) {
      const mat = D.MAT[id];
      const btn = document.createElement('button');
      btn.className = 'matBtn';
      btn.dataset.mat = id;
      const flags = Object.keys(mat).filter((k) => FLAG_LABELS[k] !== undefined && mat[k])
        .map((k) => FLAG_LABELS[k]).filter(Boolean);
      const unknownFlags = Object.keys(mat).filter((k) =>
        !['id', 'name', 'hp', 'css', 'family', 'fallDmgMult'].includes(k) && FLAG_LABELS[k] === undefined && mat[k]);
      const flagText = flags.concat(unknownFlags).join(', ');
      btn.innerHTML = '<span class="matSwatch" style="background:' + colorFor(id) + '"></span>' +
        '<span><b>' + id + '</b> ' + escapeHtml(mat.name) + ' &middot; hp ' + (mat.hp === Infinity ? '∞' : mat.hp) +
        (flagText ? '<div class="flags">' + escapeHtml(flagText) + '</div>' : '') + '</span>';
      btn.addEventListener('click', () => setTool('place', id));
      els.palette.appendChild(btn);
    }
    refreshPaletteButtons();
  }
  function refreshPaletteButtons() {
    els.palette.querySelectorAll('.matBtn').forEach((b) => {
      b.classList.toggle('on', tool.kind === 'place' && b.dataset.mat === tool.matId);
    });
    els.toolButtons.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tool === tool.kind);
    });
    const pasteBtn = document.getElementById('btnPasteTool');
    if (pasteBtn) {
      pasteBtn.disabled = !clipboard;
      // Carry the clipboard's CURRENT dimensions AND how far it has been
      // turned on each axis — the dimensions alone can't tell 0° from 180°
      // on a symmetric piece, which makes a full turn look like a two-state
      // toggle.
      const turnText = clipboard && (clipTurns.y || clipTurns.z)
        ? ' · ' + [clipTurns.y ? 'R' + (clipTurns.y * 90) + '°' : '', clipTurns.z ? 'T' + (clipTurns.z * 90) + '°' : '']
          .filter(Boolean).join(' ')
        : '';
      pasteBtn.textContent = clipboard
        ? 'Paste ' + clipboard.w + '×' + clipboard.h + '×' + clipboard.d + turnText
        : 'Paste';
      pasteBtn.title = clipboard
        ? 'R / Shift+R turn it flat (horizontally), T / Shift+T tip it over — ' +
          '90° a press, all the way round either way'
        : 'Copy a selection first (Ctrl+C)';
    }
  }
  function setTool(kind, matId) {
    tool = { kind: kind, matId: matId || tool.matId };
    if (kind !== 'select') { sel = null; updateSelectionUI(); }
    refreshPaletteButtons();
  }

  /* ── Active layer ─────────────────────────────────────────────────────────
   * Always explicit, never inferred from where a ray happens to land. */
  let activeLayer = 0;
  function updateLayerLabel() {
    els.layerLabel.textContent = (activeLayer + 1) + ' / ' + Math.max(1, doc.grid.length);
  }
  document.getElementById('btnLayerPrev').addEventListener('click', () => {
    activeLayer = Math.max(0, activeLayer - 1); updateLayerLabel(); rebuildCage();
  });
  document.getElementById('btnLayerNext').addEventListener('click', () => {
    activeLayer = Math.min(Math.max(0, doc.grid.length - 1), activeLayer + 1); updateLayerLabel(); rebuildCage();
  });
  document.getElementById('btnAddLayerFront').addEventListener('click', () => {
    pushUndo();
    doc.grid.unshift(blankLayer());
    // Prepending reindexes every existing layer by +1 (old layer 0 becomes
    // 1, etc.) — bump centerLayer to match, same reasoning as growTo()'s
    // addLeft: without it, every already-placed layer would jump in Z.
    doc.centerLayer += 1;
    activeLayer = 0;
    rebuild();
  });
  document.getElementById('btnAddLayerBack').addEventListener('click', () => {
    pushUndo();
    doc.grid.push(blankLayer());
    // Appending never reindexes existing layers, so centerLayer is untouched
    // — same reasoning as growTo()'s addRight.
    activeLayer = doc.grid.length - 1;
    rebuild();
  });
  document.getElementById('btnRemoveLayer').addEventListener('click', () => {
    if (doc.grid.length <= 1) return;
    pushUndo();
    doc.grid.splice(activeLayer, 1);
    // Removing the FRONT layer reindexes every remaining layer by -1 — the
    // exact inverse of "+ Layer (front)" above, so undo it the same way.
    // Removing from elsewhere (including the back) doesn't reindex layer 0,
    // so centerLayer stays put.
    if (activeLayer === 0) doc.centerLayer -= 1;
    activeLayer = Math.min(activeLayer, doc.grid.length - 1);
    rebuild();
  });

  /* ── Snap ─────────────────────────────────────────────────────────────────
   * Only ever applies to the EMPTY-SPACE fallback pick (hit.empty — the ray
   * hit no existing block, so there's no specific face to honour) — see
   * updateGhost()'s and the pointerup handler's own comments. Clicking an
   * actual FACE of an existing block is an explicit, unambiguous gesture:
   * attach flush against exactly that face, snap or no snap. Applying
   * snap-drop there too used to mean only faces that happened to already BE
   * a resting spot (the top, or a side with something else beside it) acted
   * like "attach here" — clicking the underside or a front/back face sent
   * the placement falling on past the block that was actually clicked.
   *
   * For the empty-space case, ON means gravity-drop WITHIN the layer (each
   * layer stands on its own — levels.js:16-22 — so support never crosses
   * layers) until it comes to rest — on the floor, on something directly
   * below, or flush against an occupied neighbour to either side in the SAME
   * row. That last case is what makes a span/bridge piece authorable at all:
   * hovering in the gap between two already-built pillars has nothing below
   * it, so a below-only check would drop it all the way to the ground every
   * time, making it look like nothing can ever be placed except stacked
   * straight up (confirmed exactly this way when first tried — a block
   * could only ever be placed directly on top of another). Lateral support
   * only counts within the same row/layer, matching the same
   * never-crosses-layers rule. OFF: write exactly the hovered cell, floating
   * if nothing's beneath or beside it — for an intentionally disconnected
   * piece. */
  let snap = true;
  document.getElementById('btnSnap').addEventListener('click', (e) => {
    snap = !snap;
    e.target.textContent = 'Snap: ' + (snap ? 'ON' : 'OFF');
  });
  function isSupportedAt(l, r, c) {
    if (r + 1 >= doc.rows) return true;                        // the floor
    if (cellAt(l, r + 1, c) !== '.') return true;               // resting on something
    if (c > 0 && cellAt(l, r, c - 1) !== '.') return true;      // flush against a neighbour...
    if (c < doc.cols - 1 && cellAt(l, r, c + 1) !== '.') return true; // ...either side
    return false;
  }
  function snapDrop(l, r, c) {
    if (!snap) return r;
    let rr = r;
    while (rr + 1 < doc.rows && !isSupportedAt(l, rr, c)) rr++;
    return rr;
  }

  /* ── Picking — analytic, cell-based, never a mesh raycast ────────────────
   * Mesh raycasting is wrong here for three reasons: the crown is a humanoid
   * silhouette, so a ray between the tyrant's legs would miss it entirely; a
   * merged 5-wide wall is ONE mesh, so a hit can't tell you which cell; and
   * this vendored three r155 build's raycast traversal has no `visible` guard,
   * which is version-fragile to depend on. Instead, test the ray against every
   * OCCUPIED cell's full-CELL AABB directly — a few hundred slab tests per
   * mousemove is nothing, and it picks CELLS, so a thin plank or a half-size
   * chunk is exactly as easy to click as a stone block. */
  const _raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _box = new THREE.Box3();
  const _hitPt = new THREE.Vector3();
  function ndcFromEvent(clientX, clientY) {
    // Rect-relative, not window.innerWidth/Height — this view has a 26rem
    // sidebar, so a full-window conversion (FishMaster's pickTarget()) would
    // be wrong here; this is bowlchallenge.js's rect-relative form instead.
    const rect = renderer.domElement.getBoundingClientRect();
    _ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    _ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }
  function faceFromLocal(lx, ly, lz, halfX, halfY, halfZ) {
    const mx = halfX - Math.abs(lx), my = halfY - Math.abs(ly), mz = halfZ - Math.abs(lz);
    let axis;
    if (mx <= mz && mx <= my) axis = 'x';
    else if (mz <= my) axis = 'z';
    else axis = 'y';
    const v = axis === 'x' ? lx : (axis === 'y' ? ly : lz);
    return axis + (Math.sign(v) >= 0 ? '+' : '-');
  }
  function pickCell(clientX, clientY) {
    ndcFromEvent(clientX, clientY);
    _raycaster.setFromCamera(_ndc, camera);
    let best = null, bestT = Infinity;
    const numLayers = Math.max(1, doc.grid.length);
    const dims = { cols: doc.cols, rows: doc.rows, numLayers: numLayers, centerCol: doc.centerCol, centerLayer: doc.centerLayer };
    for (let l = 0; l < doc.grid.length; l++) {
      // One layer's real per-cell floor heights (board/rubble cells are
      // thinner) — computed once per layer, not per cell, since it only
      // depends on that layer's own content.
      const bottoms = LV.rowBottoms(doc.grid[l], doc.rows, doc.cols);
      for (let r = 0; r < doc.rows; r++) {
        for (let c = 0; c < doc.cols; c++) {
          const ch = cellAt(l, r, c);
          if (ch === '.') continue;
          const cc = LV.cellCentre(doc.dist, dims, l, r, c, bottoms);
          // The pick box's Y-extent is this cell's OWN real thickness, not a
          // blanket CELL — cellCentre's "always a full CELL" y is right for
          // rendering a merged run (see its own doc) but wrong here: a full-
          // CELL pick box on a thin board/rubble cell used to be harmless
          // (every row reserved a full CELL of empty space above it anyway),
          // but now that a thin cell's row genuinely ends where its own
          // content does, that inflated box bleeds into the space the NEXT
          // row actually occupies. A click meant for the open cell just
          // above a board would then register as a hit on the board itself,
          // on whatever face the ray happened to graze — exactly the kind of
          // wrong-target paste that corrupts a saved sub-assembly's shape.
          const thickness = LV.cellThickness(ch);
          const bottom = bottoms[r][c];
          const centreY = bottom + thickness / 2;
          _box.min.set(cc.x - CELL / 2, bottom, cc.z - CELL / 2);
          _box.max.set(cc.x + CELL / 2, bottom + thickness, cc.z + CELL / 2);
          const hit = _raycaster.ray.intersectBox(_box, _hitPt);
          if (!hit) continue;
          const t = _raycaster.ray.origin.distanceTo(_hitPt);
          if (t < bestT) {
            bestT = t;
            const face = faceFromLocal(_hitPt.x - cc.x, _hitPt.y - centreY, _hitPt.z - cc.z, CELL / 2, thickness / 2, CELL / 2);
            best = { layer: l, row: r, col: c, face: face };
          }
        }
      }
    }
    if (best) return best;
    return groundPick();
  }

  /** How far outside the current grid a single click may reach. Without a
   *  bound, one stray click on the distant horizon (the ground plane is
   *  enormous) would resolve to something like col +180 / layer -40 and grow
   *  the document to match. Depth gets a tighter bound than width on
   *  purpose: lateral position is unambiguous on screen, but depth is the
   *  axis a perspective view hides, so an overshoot there is far easier to
   *  make and far more expensive (a prepended layer reindexes every other). */
  const MAX_REACH = 12, MAX_LAYER_REACH = 2;
  const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const _skyPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const _pt = new THREE.Vector3();

  /** Nothing occupied was hit, so resolve the ray against the GROUND — and
   *  take BOTH axes of the ground position from it: x gives the column, z
   *  gives the LAYER. That is the whole point: the ground is a real 3D grid,
   *  so "where my cursor is pointing" is a genuine (col, layer) spot on it,
   *  and a click lands there.
   *
   *  This used to resolve against a single z-plane pinned to the ACTIVE
   *  layer instead, which meant depth never came from the cursor at all —
   *  every ground click landed in whichever layer the sidebar happened to
   *  have selected, and you could not put a block anywhere else on the
   *  ground no matter where you pointed. Row is the floor row here, because
   *  the ground IS the floor; stacking upward is what a FACE click is for
   *  (see adjacentCell), which is the other half of the same gesture set.
   *
   *  Looking above the horizon has no ground to hit; that falls back to the
   *  active layer's z-plane so mid-air placement still resolves to a row. */
  function groundPick() {
    const rows = Math.max(doc.rows, 1);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    if (_raycaster.ray.direction.y < -1e-4 && _raycaster.ray.intersectPlane(_groundPlane, _pt)) {
      // Inverses of cellCentre()'s x and layerZ()'s z — both MUST use the
      // same stable doc.centerCol/doc.centerLayer the forward direction
      // uses, or a click resolves to the wrong cell the moment the grid has
      // grown asymmetrically at all.
      const col = clamp(Math.floor(_pt.x / CELL + doc.centerCol), -MAX_REACH, doc.cols - 1 + MAX_REACH);
      const layer = clamp(Math.round(doc.centerLayer - (_pt.z + doc.dist) / CELL), -MAX_LAYER_REACH, doc.grid.length - 1 + MAX_LAYER_REACH);
      return { layer: layer, row: rows - 1, col: col, face: null, empty: true, ground: true };
    }
    // Above the horizon: no ground to land on, so fall back to the active
    // layer's own z-plane and read the row off the real per-cell heights.
    const fallbackLayer = Math.min(activeLayer, Math.max(0, doc.grid.length - 1));
    const planeZ = LV.layerZ(doc.dist, Math.max(1, doc.grid.length), fallbackLayer, doc.centerLayer);
    _skyPlane.set(new THREE.Vector3(0, 0, 1), -planeZ);
    if (Math.abs(_raycaster.ray.direction.z) < 1e-4 || !_raycaster.ray.intersectPlane(_skyPlane, _pt)) return null;
    const col = clamp(Math.floor(_pt.x / CELL + doc.centerCol), -MAX_REACH, doc.cols - 1 + MAX_REACH);
    let row = rows - 1;
    if (doc.grid.length && col >= 0 && col < doc.cols) {
      const bottoms = LV.rowBottoms(doc.grid[fallbackLayer], doc.rows, doc.cols);
      for (let r = 0; r < rows; r++) {
        if (bottoms[r][col] <= _pt.y) { row = r; break; }
      }
    } else {
      row = clamp(rows - 1 - Math.round((_pt.y - CELL / 2) / CELL), -MAX_REACH, rows - 1);
    }
    return { layer: fallbackLayer, row: row, col: col, face: null, empty: true };
  }
  /** Step one cell along the face a hit came in through — used by Erase/Place
   *  adjacency in a later revision; kept small and pure. */
  function adjacentCell(hit) {
    let l = hit.layer, r = hit.row, c = hit.col;
    if (hit.face === 'x+') c += 1; else if (hit.face === 'x-') c -= 1;
    else if (hit.face === 'y+') r -= 1; else if (hit.face === 'y-') r += 1;
    else if (hit.face === 'z+') l -= 1; else if (hit.face === 'z-') l += 1;
    return { layer: l, row: r, col: c };
  }

  /** A stamp's FILLED bounding box within its own w/h/d — cached on the
   *  stamp itself. Anchoring on the filled extent rather than the raw
   *  selection box is what makes attachment land flush: a copied selection
   *  usually carries blank rows/columns around the piece, and aligning THOSE
   *  to a surface would hang the piece a cell or two off it. Null for an
   *  entirely blank stamp (nothing to place). */
  function stampFill(stamp) {
    if (stamp._fill !== undefined) return stamp._fill;
    let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1, l0 = Infinity, l1 = -1;
    for (let dl = 0; dl < stamp.d; dl++)
      for (let dr = 0; dr < stamp.h; dr++)
        for (let dc = 0; dc < stamp.w; dc++) {
          if (stamp.cells[dl][dr][dc] === '.') continue;
          if (dr < r0) r0 = dr;
          if (dr > r1) r1 = dr;
          if (dc < c0) c0 = dc;
          if (dc > c1) c1 = dc;
          if (dl < l0) l0 = dl;
          if (dl > l1) l1 = dl;
        }
    stamp._fill = (r1 < 0) ? null : { r0: r0, r1: r1, c0: c0, c1: c1, l0: l0, l1: l1 };
    return stamp._fill;
  }

  /** Quarter-turns a stamp, returning a NEW stamp (never mutates the old one,
   *  so an assembly saved in the library keeps the orientation it was saved
   *  in). Ninety degrees exactly, no free angles — a level is a grid of cells,
   *  so any other angle simply has nowhere to be stored.
   *
   *  `axis` 'y' turns it in the horizontal (transverse) plane about a VERTICAL
   *  axis — a wall facing the ballista becomes a wall running away from it,
   *  swapping the column and layer axes and leaving heights alone. `axis` 'z'
   *  turns it in the plane of a layer, about the depth axis — a tall column
   *  tips over into a long horizontal run, swapping rows and columns and
   *  staying in the same layer (the useful vertical turn here: layers are
   *  scarce, columns are not). `dir` +1/-1 picks the direction.
   *
   *  Rotation happens in the stamp's own local space, and placementTarget()
   *  then re-derives the anchor from the rotated stamp's filled bbox and the
   *  clicked face — so the piece's facing edge stays on the cell you pointed
   *  at, which is exactly what makes it read as spinning about the root
   *  marker rather than wandering off it. */
  function rotateStamp(stamp, axis, dir) {
    const w = stamp.w, h = stamp.h, d = stamp.d;
    let W, H, D, map;
    if (axis === 'y') {
      W = d; H = h; D = w;
      map = dir > 0
        ? (dl, dr, dc) => ({ l: dc, r: dr, c: d - 1 - dl })
        : (dl, dr, dc) => ({ l: w - 1 - dc, r: dr, c: dl });
    } else {
      W = h; H = w; D = d;
      map = dir > 0
        ? (dl, dr, dc) => ({ l: dl, r: w - 1 - dc, c: dr })
        : (dl, dr, dc) => ({ l: dl, r: dc, c: h - 1 - dr });
    }
    const cells = [];
    for (let l = 0; l < D; l++) {
      const layer = [];
      for (let r = 0; r < H; r++) layer.push(new Array(W).fill('.'));
      cells.push(layer);
    }
    for (let dl = 0; dl < d; dl++)
      for (let dr = 0; dr < h; dr++)
        for (let dc = 0; dc < w; dc++) {
          const ch = stamp.cells[dl][dr][dc];
          if (ch === '.') continue;
          const m = map(dl, dr, dc);
          cells[m.l][m.r][m.c] = ch;
        }
    return { w: W, h: H, d: D, cells: cells };
  }

  /** Turns whatever is on the clipboard and refreshes the live preview in
   *  place, so the piece visibly spins under a stationary cursor instead of
   *  needing a mouse nudge to catch up. */
  function rotateClipboard(axis, dir) {
    if (!clipboard) return false;
    setClipboard(rotateStamp(clipboard, axis, dir), true);
    // Four quarter-turns per axis is a full circle and lands back on 0 — each
    // axis turns all the way round, in either direction, without limit.
    clipTurns[axis] = (((clipTurns[axis] + dir) % 4) + 4) % 4;
    refreshPaletteButtons();
    if (lastPointer) updateGhost(pickCell(lastPointer.x, lastPointer.y));
    return true;
  }

  /* ── Placement target ─────────────────────────────────────────────────────
   * The ONE place that decides where the active tool would write for a given
   * pick. Both the ghost preview and the click commit call it, which is what
   * makes the preview a promise rather than a guess — there is no second
   * code path that could disagree with it. Returns a uniform shape for both
   * tools (Place is just a 1x1x1 stamp), so everything downstream — preview,
   * cage, ground shadow, root marker, commit — handles one case instead of
   * two. `root` is the cell the piece attaches BY: the preview marks it, so
   * which part of a pasted piece is the attachment point is something you
   * can see rather than something you have to remember. */
  function placementTarget(hit) {
    if (!hit) return null;
    if (tool.kind === 'paste') {
      if (!clipboard) return null;
      const f = stampFill(clipboard);
      if (!f) return null;
      const base = hit.empty ? hit : adjacentCell(hit);
      const face = hit.empty ? null : hit.face;
      /* THE ATTACHMENT RULE. The cell you point at is where the piece's own
         facing EDGE lands, so the side of the piece that meets the surface
         is decided by the face you clicked — never a fixed corner:
           top (y+)    → the piece's BOTTOM row rests on it
           bottom (y-) → its TOP row hangs under it
           right (x+)  → its LEFT column butts against it
           left (x-)   → its RIGHT column butts against it
           front (z+)  → its BACK layer butts against it
           back (z-)   → its FRONT layer butts against it
         Open ground is the same rule with no normal: bottom row, left
         column, front layer — the piece stands on the cell you pointed at.
         Anchoring a fixed top-left-front corner instead (what this did
         before) meant clicking a left or top face drove the piece INTO the
         structure it was supposed to sit against. */
      const row = base.row - (face === 'y-' ? f.r0 : f.r1);
      const col = base.col - (face === 'x-' ? f.c1 : f.c0);
      const layer = base.layer - (face === 'z+' ? f.l1 : f.l0);
      return {
        layer: layer, row: row, col: col, stamp: clipboard, fill: f,
        key: 'paste|' + clipboardSeq, root: base
      };
    }
    if (tool.kind !== 'place') return null;
    const t = hit.empty ? hit : adjacentCell(hit);
    let row = t.row;
    /* Snap-drop only applies to the EMPTY-SPACE fallback (no specific face
       was clicked) — it's a convenience for "roughly here, let gravity find
       the resting spot." Clicking an actual FACE of an existing block
       (hit.empty === false) is an explicit, unambiguous placement gesture —
       attach flush against exactly that face, full stop. Applying snap-drop
       there too used to mean only the top/side faces (which happen to
       already BE a supported resting row) behaved as attaching; clicking the
       underside or a front/back (depth) face of a block sent the placement
       falling on past it to the floor of whatever layer/column it landed in,
       ignoring the very face that was clicked. */
    if (snap && hit.empty) row = snapDrop(t.layer, row, t.col);
    return {
      layer: t.layer, row: row, col: t.col, matId: tool.matId,
      stamp: { w: 1, h: 1, d: 1, cells: [[[tool.matId]]] }, key: 'place|' + tool.matId,
      fill: { r0: 0, r1: 0, c0: 0, c1: 0, l0: 0, l1: 0 },
      // A single block IS its own attachment point, so the root marker would
      // just double the cage — left off deliberately.
      root: null
    };
  }

  /* ── Ghost preview ────────────────────────────────────────────────────────
   * Translucent copies of exactly what's about to be written, moved on
   * pointermove — never triggers a rebuild. Shown for Paste as well as
   * Place: a saved piece is the one thing you most need to see before
   * committing, and it used to appear only after the click.
   *
   * The wireframe cage marks which CELLS get written, which the ghost alone
   * can't say — a B fills 15% of its cell and w/s/i fill 50%. */
  function hideGhost() {
    ghostGroup.visible = false;
    cellCage.visible = false;
    ghostShadow.visible = false;
    rootMarker.visible = false;
  }
  function buildGhostCells(stamp, key) {
    for (const g of ghostCells) ghostGroup.remove(g.mesh);
    ghostCells = [];
    for (let dl = 0; dl < stamp.d; dl++) {
      for (let dr = 0; dr < stamp.h; dr++) {
        for (let dc = 0; dc < stamp.w; dc++) {
          const ch = stamp.cells[dl][dr][dc];
          const mat = ch === '.' ? null : D.MAT[ch];
          if (!mat) continue;
          // The material's REAL proportions, same as parseLevel gives it, so
          // the preview reads as the thing itself, not a generic cube.
          const h = mat.plank ? CELL * LV.PLANK_FRAC : (mat.small ? CELL * 0.5 : CELL);
          const wd = mat.small ? CELL * 0.5 : CELL;
          const mesh = protoFor(ch, wd, h, wd).clone();
          mesh.traverse((o) => {
            if (!o.material) return;
            o.material = o.material.clone();
            o.material.transparent = true;
            o.material.opacity = 0.5;
            o.material.depthWrite = false;
          });
          ghostGroup.add(mesh);
          ghostCells.push({ dl: dl, dr: dr, dc: dc, h: h, mesh: mesh });
        }
      }
    }
    ghostKey = key;
  }
  function updateGhost(hit) {
    const target = placementTarget(hit);
    if (!target) { hideGhost(); return; }
    const stamp = target.stamp;
    if (target.key !== ghostKey) buildGhostCells(stamp, target.key);
    if (!ghostCells.length) { hideGhost(); return; }

    /* Mirror EXACTLY what growTo()/growLayersTo() would do on commit, so the
       preview shows the POST-growth position rather than a pre-growth guess:
       growing at a low edge reindexes existing content and bumps the stable
       centre by the same amount, and these offsets are those amounts. */
    // Bounds taken from the FILLED extent, exactly as blitStamp() grows for
    // it — a blank margin writes nothing, so previewing growth for it would
    // show the level lifted by a row that the commit never actually adds.
    const f = target.fill;
    const colOff = Math.max(0, -(target.col + f.c0));
    const rowOff = Math.max(0, -(target.row + f.r0));
    const layerOff = Math.max(0, -(target.layer + f.l0));
    const dims = {
      cols: Math.max(doc.cols + colOff, target.col + colOff + f.c1 + 1),
      rows: Math.max(doc.rows + rowOff, target.row + rowOff + f.r1 + 1),
      numLayers: Math.max(doc.grid.length + layerOff, target.layer + layerOff + f.l1 + 1),
      centerCol: doc.centerCol + colOff,
      centerLayer: doc.centerLayer + layerOff
    };

    /* Per-layer floor heights computed WITH the stamp written in, so the
       preview sits at the height it will really rest at — a board is thin,
       and anything the stamp stacks on its own cells rests flush on them. */
    const bottomsFor = [];
    for (let dl = 0; dl < stamp.d; dl++) {
      const l = target.layer + dl;
      const src = (l >= 0 && l < doc.grid.length) ? doc.grid[l] : null;
      const rowsArr = [];
      for (let r = 0; r < dims.rows; r++) rowsArr.push(new Array(dims.cols).fill('.'));
      if (src) {
        for (let r = 0; r < src.length; r++)
          for (let c = 0; c < src[r].length; c++) rowsArr[r + rowOff][c + colOff] = src[r][c];
      }
      for (let dr = 0; dr < stamp.h; dr++)
        for (let dc = 0; dc < stamp.w; dc++) {
          const ch = stamp.cells[dl][dr][dc];
          if (ch === '.') continue;
          rowsArr[target.row + rowOff + dr][target.col + colOff + dc] = ch;
        }
      bottomsFor.push(LV.rowBottoms(rowsArr, dims.rows, dims.cols));
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const g of ghostCells) {
      const l = target.layer + layerOff + g.dl;
      const r = target.row + rowOff + g.dr;
      const c = target.col + colOff + g.dc;
      const bottoms = bottomsFor[g.dl];
      const cc = LV.cellCentre(doc.dist, dims, l, r, c, bottoms);
      const bottom = bottoms[r][c];
      g.mesh.position.set(cc.x, bottom + g.h / 2, cc.z);
      minX = Math.min(minX, cc.x - CELL / 2); maxX = Math.max(maxX, cc.x + CELL / 2);
      minZ = Math.min(minZ, cc.z - CELL / 2); maxZ = Math.max(maxZ, cc.z + CELL / 2);
      minY = Math.min(minY, bottom); maxY = Math.max(maxY, bottom + CELL);
    }
    ghostGroup.visible = true;

    cellCage.scale.set(maxX - minX, maxY - minY, maxZ - minZ);
    cellCage.position.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    cellCage.visible = true;

    // Straight down onto the ground, at the footprint's real size.
    ghostShadow.scale.set(maxX - minX, maxZ - minZ, 1);
    ghostShadow.position.set((minX + maxX) / 2, 0.02, (minZ + maxZ) / 2);
    ghostShadow.visible = true;

    /* The root cell — the one the piece attaches BY (see placementTarget's
       attachment rule). Marked only when the piece is bigger than one cell;
       for a single block the cage already says it. */
    const multiCell = stamp.w > 1 || stamp.h > 1 || stamp.d > 1;
    if (target.root && multiCell) {
      const rl = target.root.layer + layerOff;
      const rr = target.root.row + rowOff;
      const rc = target.root.col + colOff;
      const dl = target.root.layer - target.layer;
      const bottoms = bottomsFor[dl >= 0 && dl < bottomsFor.length ? dl : 0];
      const rcc = LV.cellCentre(doc.dist, dims, rl, rr, rc, bottoms);
      const rBottom = (bottoms[rr] && bottoms[rr][rc] !== undefined) ? bottoms[rr][rc] : rcc.y - CELL / 2;
      rootMarker.scale.set(1, 1, 1);
      rootMarker.position.set(rcc.x, rBottom + CELL / 2, rcc.z);
      rootMarker.visible = true;
    } else {
      rootMarker.visible = false;
    }
  }
  function rebuildCage() {
    // Keep the cage visible over the active layer even without a live hover,
    // so switching layers gives an immediate sense of where "here" is.
  }

  /* ── Mutations ────────────────────────────────────────────────────────────
   * All visual-only — see the prototype-cache comment above for why a full
   * rebuild() per mutation is the honest, affordable answer here. */
  function placeAt(l, r, c, matId) {
    pushUndo();
    setCell(l, r, c, matId);
    rebuild();
  }
  function eraseAt(l, r, c) {
    if (cellAt(l, r, c) === '.') return;
    pushUndo();
    doc.grid[l][r][c] = '.';
    rebuild();
  }

  /* ── Selection / copy / paste ─────────────────────────────────────────────
   * Marquee-in-3D is guesswork; instead click corner A, click corner B. Layer
   * range defaults to A's layer..B's layer (click layer 0 then layer 2 and
   * that's a 3-deep box — exactly how you'd copy a tower). */
  let sel = null; // {col0,col1,row0,row1,layer0,layer1} normalised (0 <= min <= max)
  let selCorner = null;
  const selBoxHelper = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()), 0xffd400);
  selBoxHelper.visible = false;
  scene.add(selBoxHelper);
  function normSel(a, b) {
    return {
      col0: Math.min(a.col, b.col), col1: Math.max(a.col, b.col),
      row0: Math.min(a.row, b.row), row1: Math.max(a.row, b.row),
      layer0: Math.min(a.layer, b.layer), layer1: Math.max(a.layer, b.layer)
    };
  }
  function selectClick(hit) {
    if (!selCorner) { selCorner = hit; return; }
    sel = normSel(selCorner, hit);
    selCorner = null;
    updateSelectionUI();
  }
  function updateSelectionUI() {
    if (!sel) { selBoxHelper.visible = false; els.selectionInfo.textContent = 'No selection'; return; }
    const w = sel.col1 - sel.col0 + 1, h = sel.row1 - sel.row0 + 1, d = sel.layer1 - sel.layer0 + 1;
    let blocks = 0;
    for (let l = sel.layer0; l <= sel.layer1; l++)
      for (let r = sel.row0; r <= sel.row1; r++)
        for (let c = sel.col0; c <= sel.col1; c++)
          if (cellAt(l, r, c) !== '.') blocks++;
    els.selectionInfo.textContent = w + ' x ' + h + ' x ' + d + ' cells (' + blocks + ' filled)';
    const dims = { cols: Math.max(doc.cols, sel.col1 + 1), rows: Math.max(doc.rows, sel.row1 + 1), numLayers: Math.max(doc.grid.length, sel.layer1 + 1), centerCol: doc.centerCol, centerLayer: doc.centerLayer };
    const cMin = LV.cellCentre(doc.dist, dims, sel.layer1, sel.row1, sel.col0, LV.rowBottoms(doc.grid[sel.layer1], dims.rows, dims.cols));
    const cMax = LV.cellCentre(doc.dist, dims, sel.layer0, sel.row0, sel.col1, LV.rowBottoms(doc.grid[sel.layer0], dims.rows, dims.cols));
    selBoxHelper.box.min.set(Math.min(cMin.x, cMax.x) - CELL / 2, cMin.y - CELL / 2, Math.min(cMin.z, cMax.z) - CELL / 2);
    selBoxHelper.box.max.set(Math.max(cMin.x, cMax.x) + CELL / 2, cMax.y + CELL / 2, Math.max(cMin.z, cMax.z) + CELL / 2);
    selBoxHelper.visible = true;
  }

  let clipboard = null; // {w,h,d,cells[dl][dr][dc]}
  // Bumped on every clipboard write so the ghost preview knows its cached
  // meshes are stale — the stamp's SHAPE decides what meshes to build, and
  // object identity alone wouldn't catch a same-sized replacement.
  let clipboardSeq = 0;
  /* Net quarter-turns applied on each axis since the piece was copied, purely
   * so the readout can distinguish orientations a shape's own dimensions
   * cannot: a left-right symmetric piece looks IDENTICAL at 0° and 180°, so
   * without this there is no way to tell how far round you actually are. */
  let clipTurns = { y: 0, z: 0 };
  function setClipboard(stamp, keepTurns) {
    clipboard = stamp;
    clipboardSeq++;
    if (!keepTurns) clipTurns = { y: 0, z: 0 };
    refreshPaletteButtons();
  }
  /** Pure: reads the current selection into a {w,h,d,cells} stamp without
   *  touching the ad hoc clipboard. copySelection() (Ctrl+C, quick same-
   *  session duplication) and saveAssembly() (the persisted, named library,
   *  for reuse across levels or much later in this one) both build a stamp
   *  from this — but only copySelection() assigns it to `clipboard`. Before
   *  this split, saving an assembly called copySelection() itself, so
   *  hitting "Save" silently clobbered whatever you had ready to paste. */
  function extractCells(s) {
    const w = s.col1 - s.col0 + 1, h = s.row1 - s.row0 + 1, d = s.layer1 - s.layer0 + 1;
    const cells = [];
    for (let dl = 0; dl < d; dl++) {
      const layer = [];
      for (let dr = 0; dr < h; dr++) {
        const row = [];
        for (let dc = 0; dc < w; dc++) row.push(cellAt(s.layer0 + dl, s.row0 + dr, s.col0 + dc));
        layer.push(row);
      }
      cells.push(layer);
    }
    return { w: w, h: h, d: d, cells: cells };
  }
  function copySelection() {
    if (!sel) return;
    setClipboard(extractCells(sel));
  }
  /** Stamps a clipboard/assembly at (l,r,c) as its layer0/row0/col0 corner.
   *  '.' cells are transparent by default (a tower stamp is mostly empty; an
   *  opaque paste would gouge holes in whatever it lands on).
   *
   *  Grows the grid ONCE for the stamp's whole footprint, up front — going
   *  cell-by-cell through setCell() (each of which calls growTo() itself)
   *  would have the first cell's growth (if it needed room on the left/top)
   *  shift every existing column/row index out from under the *rest* of the
   *  loop, which is still writing in pre-growth coordinates. A stamp placed
   *  near the grid's low edge would scatter into the wrong cells partway
   *  through its own paste — exactly the kind of "can't place it anywhere"
   *  corruption a saved sub-assembly must never suffer. */
  function blitStamp(stamp, l, r, c, opaque) {
    /* Grow only for what actually gets WRITTEN. A transparent paste skips
       '.' cells, so growing for a selection's blank margin buys nothing and
       costs real damage: a blank bottom row would push the document's floor
       down a row, and since row heights count up from whatever the last row
       is, that lifts the entire rest of the level to make room for nothing.
       An opaque paste does write '.', so it grows for the full footprint. */
    const f = opaque
      ? { r0: 0, r1: stamp.h - 1, c0: 0, c1: stamp.w - 1, l0: 0, l1: stamp.d - 1 }
      : stampFill(stamp);
    if (!f) return;   // entirely blank stamp — nothing to place
    pushUndo();
    const off = growTo(c + f.c0, c + f.c1, r + f.r0, r + f.r1);
    r += off.addTop; c += off.addLeft;
    // Same one-shot growth for the DEPTH axis, and via growLayersTo() so a
    // stamp reaching in FRONT of layer 0 prepends (with its centre
    // compensation) instead of being silently dropped.
    l += growLayersTo(l + f.l0);
    growLayersTo(l + f.l1);
    for (let dl = 0; dl < stamp.d; dl++) {
      for (let dr = 0; dr < stamp.h; dr++) {
        for (let dc = 0; dc < stamp.w; dc++) {
          const ch = stamp.cells[dl][dr][dc];
          if (ch === '.' && !opaque) continue;
          doc.grid[l + dl][r + dr][c + dc] = ch;
        }
      }
    }
    rebuild();
  }
  function deleteSelection() {
    if (!sel) return;
    pushUndo();
    for (let l = sel.layer0; l <= sel.layer1; l++)
      for (let r = sel.row0; r <= sel.row1; r++)
        for (let c = sel.col0; c <= sel.col1; c++)
          if (l < doc.grid.length) doc.grid[l][r][c] = '.';
    rebuild();
  }

  /* ── Assembly library ─────────────────────────────────────────────────────
   * Persisted via RT.util's prefixed save/load (rt-ballista-assemblies), the
   * same convention every game's own save uses — not a bare localStorage key.
   * Plus export/import text so the library survives a cleared browser and can
   * be copied between machines. */
  const LIB_KEY = 'ballista-assemblies';
  function loadLib() { return U.load(LIB_KEY, { version: 1, items: [] }); }
  function saveLib(lib) { U.save(LIB_KEY, lib); }
  function renderAssemblyList() {
    const lib = loadLib();
    if (!lib.items.length) { els.assemblyList.innerHTML = 'None saved yet.'; return; }
    els.assemblyList.innerHTML = lib.items.map((a, i) =>
      '<div class="aRow"><span>' + escapeHtml(a.name) + ' (' + a.w + '&times;' + a.h + '&times;' + a.d + ')</span>' +
      '<span><button class="alt" data-place="' + i + '">Place</button> ' +
      '<button class="alt" data-del="' + i + '">Delete</button></span></div>'
    ).join('');
    els.assemblyList.querySelectorAll('[data-place]').forEach((b) => b.addEventListener('click', () => {
      const item = loadLib().items[+b.dataset.place];
      setClipboard({ w: item.w, h: item.h, d: item.d, cells: item.cells });
      setTool('paste');
    }));
    els.assemblyList.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      const lib2 = loadLib();
      lib2.items.splice(+b.dataset.del, 1);
      saveLib(lib2);
      renderAssemblyList();
    }));
  }
  document.getElementById('btnSaveAssembly').addEventListener('click', () => {
    if (!sel) { alert('Select a box first (click one corner, then the opposite corner).'); return; }
    const name = els.assemblyName.value.trim() || ('Assembly ' + (loadLib().items.length + 1));
    const stamp = extractCells(sel);
    const lib = loadLib();
    lib.items.push({ name: name, w: stamp.w, h: stamp.h, d: stamp.d, cells: stamp.cells });
    saveLib(lib);
    els.assemblyName.value = '';
    renderAssemblyList();
  });
  document.getElementById('btnExportLib').addEventListener('click', () => {
    els.assemblyText.value = JSON.stringify(loadLib(), null, 1);
  });
  document.getElementById('btnImportLib').addEventListener('click', () => {
    let parsed;
    try { parsed = JSON.parse(els.assemblyText.value); } catch (e) { alert('Not valid JSON: ' + e.message); return; }
    if (!parsed || !Array.isArray(parsed.items)) { alert('Expected {version, items:[...]}'); return; }
    for (const item of parsed.items) {
      if (typeof item.name !== 'string' || !Array.isArray(item.cells)) { alert('Malformed assembly "' + item.name + '"'); return; }
    }
    saveLib({ version: 1, items: parsed.items });
    renderAssemblyList();
  });

  /* ── Pointer input ────────────────────────────────────────────────────────
   * pointerdown records position; once movement exceeds 4px it's a drag
   * (orbit on left/right, pan on middle or Shift+left); under 4px on pointerup
   * it's a click (left = apply tool, right = erase). This is the resolution to
   * the old file's single mousedown-anywhere-drags behaviour, which left no
   * room for a click to mean "place a block". */
  const dom = renderer.domElement;
  dom.style.touchAction = 'none';
  dom.addEventListener('contextmenu', (e) => e.preventDefault());
  let down = null;
  dom.addEventListener('pointerdown', (e) => {
    dom.setPointerCapture(e.pointerId);
    down = { x: e.clientX, y: e.clientY, moved: 0, button: e.button, shift: e.shiftKey };
  });
  dom.addEventListener('pointermove', (e) => {
    if (down) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      down.moved = Math.max(down.moved, Math.abs(dx) + Math.abs(dy));
      if (down.moved > 4) {
        if (down.button === 1 || (down.button === 0 && down.shift)) {
          // Pan: move the orbit target in the camera's local right/up plane.
          const right = new THREE.Vector3(Math.cos(orbit.az), 0, -Math.sin(orbit.az));
          const up = new THREE.Vector3(0, 1, 0);
          orbit.target.addScaledVector(right, -dx * 0.02).addScaledVector(up, dy * 0.02);
        } else {
          orbit.az -= dx * 0.007;
          orbit.el = Math.max(0.08, Math.min(1.4, orbit.el + dy * 0.007));
        }
        applyOrbit();
        down.x = e.clientX; down.y = e.clientY;
      }
    }
    lastPointer = { x: e.clientX, y: e.clientY };
    const hit = pickCell(e.clientX, e.clientY);
    updateGhost(hit);
  });
  dom.addEventListener('pointerup', (e) => {
    const wasClick = down && down.moved <= 4;
    down = null;
    if (!wasClick) return;
    const hit = pickCell(e.clientX, e.clientY);
    if (!hit) return;
    if (e.button === 2) {
      // Right-click always erases the occupied cell that was actually hit,
      // regardless of the active tool. A miss (hit.empty) has nothing to erase.
      if (!hit.empty) eraseAt(hit.layer, hit.row, hit.col);
      return;
    }
    if (tool.kind === 'select') { selectClick(hit); return; }
    if (tool.kind === 'erase') { eraseAt(hit.layer, hit.row, hit.col); return; }
    // Place and Paste both commit exactly what the ghost was showing, because
    // both read the same placementTarget() the ghost read.
    const target = placementTarget(hit);
    if (!target) return;
    if (tool.kind === 'paste') blitStamp(target.stamp, target.layer, target.row, target.col, false);
    else placeAt(target.layer, target.row, target.col, target.matId);
    // Follow the cursor's depth: a negative target got layers prepended, so
    // what was layer -n is now layer 0. Keeps the layer readout honest about
    // where you are actually building.
    activeLayer = Math.min(Math.max(0, target.layer), Math.max(0, doc.grid.length - 1));
    updateLayerLabel();
    updateGhost(pickCell(e.clientX, e.clientY));
  });
  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    orbit.dist = Math.max(3, Math.min(60, orbit.dist + e.deltaY * 0.02));
    applyOrbit();
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (document.activeElement && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName)) return;
    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
    else if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redo(); }
    else if (e.ctrlKey && e.key === 'c') { e.preventDefault(); copySelection(); }
    else if (e.ctrlKey && e.key === 'v') { e.preventDefault(); if (clipboard) setTool('paste'); }
    else if (e.key === 'Delete') { deleteSelection(); }
    else if (e.key === 'Escape') { selCorner = null; sel = null; updateSelectionUI(); setTool('place'); }
    else if (e.key === '[') { activeLayer = Math.max(0, activeLayer - 1); updateLayerLabel(); }
    else if (e.key === ']') { activeLayer = Math.min(Math.max(0, doc.grid.length - 1), activeLayer + 1); updateLayerLabel(); }
    /* Quarter-turns for the piece on the clipboard. R is the horizontal
       (transverse-plane, vertical-axis) turn — the one you reach for most, so
       it gets the obvious key; T tips it over within its layer. Shift
       reverses either. Guarded against Ctrl/Alt/Meta so Ctrl+R still reloads
       the page. */
    else if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'r' || e.key === 'R')) {
      if (rotateClipboard('y', e.key === 'R' ? -1 : 1)) e.preventDefault();
    }
    else if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 't' || e.key === 'T')) {
      if (rotateClipboard('z', e.key === 'T' ? -1 : 1)) e.preventDefault();
    }
  });

  /* ── Stability test ───────────────────────────────────────────────────────
   * Idempotent by construction: build bodies, settle via RT.settle (the exact
   * damage model js/game.js's auditLevels() uses — extracted into js/settle.js
   * for exactly this reuse), report, destroy the bodies, then rebuild() from
   * the grid regardless of outcome. A second click always starts from the
   * same state, unlike the old check which left bodies wherever 4s of
   * simulation put them and compared the NEXT run against that.
   *
   * Using RT.settle rather than a bare P.step loop closes the real gap the
   * old check had: applyCrush() can kill a crown IN PLACE (crushed by a
   * falling block resting on it), which may never drift the 0.05 units a
   * pure-settling check watches for. This test now catches that the same way
   * the game's own boot audit does — see the crown-count condition below.
   *
   * Mass uses the same w*h*d-for-dynamic/0-for-static rule game.js:337 uses;
   * a different rule here would make this test lie about whether the real
   * game would agree with it. Each test rec gets a REAL Mesh with a matching
   * BoxGeometry (not a bare Object3D) because RT.settle's crush detection
   * calls Box3.setFromObject() on it — a geometry-less object silently
   * produces an empty box and crush damage would never fire. Nothing here is
   * ever added to the scene; it exists purely for physics bookkeeping and is
   * disposed the moment the test ends. */
  function runStabilityTest() {
    if (!live.recs.length) { els.checkResult.textContent = 'Nothing to test — nothing is placed.'; els.checkResult.className = ''; return; }
    const testRecs = live.recs.map((rec) => {
      const b = rec.spec;
      const mat = D.MAT[b.matId];
      const mass = mat.static ? 0 : b.w * b.h * b.d;
      const body = P.addBlock(b.x, b.y, b.z, b.w, b.h, b.d, mass);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d));
      mesh.position.set(b.x, b.y, b.z);
      return {
        body: body, mesh: mesh, mat: mat, spec: b, alive: true, hp: mat.hp,
        _peakSpeed: 0, _peakResolved: false, _lastHitSpeed: 0,
        start: new THREE.Vector3(b.x, b.y, b.z)
      };
    });
    const crownRecs = testRecs.filter((r) => r.mat.crown);
    const destroyedCrowns = [];
    RT.settle.settle(testRecs, RT.settle.DEFAULT_SECONDS, {
      onDestroy: (rec) => {
        rec.alive = false;
        P.destroyBlock(rec.body);
        if (rec.mat.crown) destroyedCrowns.push(rec);
      }
    });
    let worst = 0, worstRec = null;
    for (const r of crownRecs) {
      if (!r.alive) continue; // reported via destroyedCrowns instead
      const moved = r.mesh.position.distanceTo(r.start);
      if (moved > worst) { worst = moved; worstRec = r; }
    }
    const awake = testRecs.some((r) => r.alive && !r.mat.static && P.isAwake(r.body));
    const pass = destroyedCrowns.length === 0 && worst <= 0.05 && !awake;
    for (const r of testRecs) {
      if (r.alive) P.destroyBlock(r.body);
      r.mesh.geometry.dispose();
    }
    // rebuild() itself resets #checkResult (every other mutation path wants a
    // clean slate there) — so it has to run BEFORE the verdict is written, not
    // after, or the message this whole function exists to show gets wiped the
    // instant it's set. Idempotent either way: the doc/scene end up identical
    // regardless of the order, but the user actually gets to read the result.
    rebuild();
    els.checkResult.className = pass ? 'pass' : 'fail';
    if (pass) {
      els.checkResult.textContent = 'Stands on its own. Worst crown drift: ' + worst.toFixed(4) + ' units. All bodies asleep.';
    } else if (destroyedCrowns.length) {
      const where = destroyedCrowns.map((r) => '(layer ' + (r.spec.layer + 1) + ', row ' + (r.spec.row + 1) + ', col ' + (r.spec.col + 1) + ')').join(', ');
      els.checkResult.textContent = 'Does not stand on its own: ' + destroyedCrowns.length + ' crown(s) destroyed just settling ' + where + ' — likely crushed by a falling block, or an outright fall. Not merely drifted; actually destroyed.';
    } else {
      const where = worstRec ? (' (layer ' + (worstRec.spec.layer + 1) + ', row ' + (worstRec.spec.row + 1) + ', col ' + (worstRec.spec.col + 1) + ')') : '';
      els.checkResult.textContent = 'Does not stand on its own.\nWorst crown drift: ' + worst.toFixed(4) + ' units' + where + ' (fail if > 0.05).\nStill awake: ' + awake + '.';
    }
  }
  document.getElementById('btnCheck').addEventListener('click', runStabilityTest);

  /** Strips padBuildVolume()'s empty build margin back off before export —
   *  UP TO doc.padBack fully-blank layers off the back, UP TO doc.padLeft/
   *  padRight fully-blank columns off the left/right, UP TO doc.padTop
   *  fully-blank rows off the top, stopping early the moment one isn't
   *  blank (the user drew into part of the margin — that part is real now).
   *  Deliberately capped at the tracked amounts rather than just "trim
   *  every blank edge": a real level can have its OWN intentional blank
   *  border (a symmetric frame, spacing around a tower) that looks
   *  identical to unused margin — trimming by blankness alone would just as
   *  happily eat a designer's real framing, which is exactly what a naive
   *  first version of this did to a shipped level's frame. Never trims the
   *  front (padBuildVolume() never pads there) or the bottom row (the
   *  floor; rows are floor-anchored, never padded there either), and never
   *  an INTERIOR gap (a bridge's open shaft isn't a blank row/column/layer —
   *  the row still has the bridge itself in other columns). */
  function trimLevelLayers(layers) {
    const isBlankCh = (ch) => ch === undefined || ch === '.' || ch === ' ';
    const isBlankRow = (row) => !row || !/[^. ]/.test(row);
    const isBlankLayer = (layer) => layer.every(isBlankRow);

    let ls = layers.map((layer) => layer.slice());
    let backTrim = 0;
    while (backTrim < doc.padBack && ls.length > 1 && isBlankLayer(ls[ls.length - 1])) { ls.pop(); backTrim++; }

    let cols = 0, rows = 0;
    for (const layer of ls) { rows = Math.max(rows, layer.length); for (const row of layer) cols = Math.max(cols, row.length); }
    const colBlank = (c) => ls.every((layer) => layer.every((row) => isBlankCh(row[c])));
    let left = 0, right = cols - 1;
    let leftTrim = 0;
    while (leftTrim < doc.padLeft && left < right && colBlank(left)) { left++; leftTrim++; }
    let rightTrim = 0;
    while (rightTrim < doc.padRight && right > left && colBlank(right)) { right--; rightTrim++; }

    const rowBlankAt = (r) => ls.every((layer) => isBlankRow(layer[r]));
    let top = 0, topTrim = 0;
    while (topTrim < doc.padTop && top < rows - 1 && rowBlankAt(top)) { top++; topTrim++; }

    return ls.map((layer) => layer.slice(top).map((row) => row.slice(left, right + 1)));
  }

  /* ── Export ───────────────────────────────────────────────────────────────
   * Single-quote style to match levels.js, not JSON.stringify's doubles; only
   * emits `ammo:` when set; never emits _cols/_depth (levels.js computes those
   * at load, :506-510). */
  function exportText() {
    const level = docAsLevel();
    level.layers = trimLevelLayers(level.layers);
    const lines = [];
    let head = '{ name: ' + quote(level.name) + ', par: ' + level.par + ', bolts: ' + level.bolts + ', dist: ' + level.dist;
    if (level.ammo) head += ', ammo: [' + level.ammo.map(quote).join(', ') + ']';
    head += ', layers: [';
    lines.push(head);
    level.layers.forEach((rows, li) => {
      lines.push('  [');
      rows.forEach((r, ri) => lines.push('    ' + quote(r) + (ri < rows.length - 1 ? ',' : '')));
      lines.push(li < level.layers.length - 1 ? '  ],' : '  ]');
    });
    lines.push('] },');
    els.exportBox.value = lines.join('\n');
  }
  function quote(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }

  /* ── Textarea (two-way) / form wiring ─────────────────────────────────────
   * The textarea is a VIEW, not the source of truth: mouse edits regenerate
   * it (regenerateText()); typing in it and pressing Apply parses it back
   * into the grid (with the same top-padding rule gridFromLayers() uses). */
  function textToLayers(text) {
    return text.replace(/\r/g, '').split(/\n[ \t]*\n/)
      .map((block) => block.split('\n'))
      .map((rows) => {
        while (rows.length && rows[0].trim() === '') rows.shift();
        while (rows.length && rows[rows.length - 1].trim() === '') rows.pop();
        return rows;
      })
      .filter((rows) => rows.length > 0);
  }
  function applyText() {
    pushUndo();
    doc.name = els.name.value || 'Untitled';
    doc.dist = parseFloat(els.dist.value); if (!Number.isFinite(doc.dist)) doc.dist = 20;
    doc.par = parseInt(els.par.value, 10); if (!Number.isFinite(doc.par)) doc.par = 1;
    doc.bolts = parseInt(els.bolts.value, 10); if (!Number.isFinite(doc.bolts)) doc.bolts = 6;
    const g = gridFromLayers(textToLayers(els.layers.value));
    doc.grid = g.grid; doc.cols = g.cols; doc.rows = g.rows;
    // Same reasoning as loadLevelIntoDoc(): re-applying the text is a fresh
    // ground truth, not an incremental edit, so the centre resets naturally.
    doc.centerCol = doc.cols / 2;
    doc.centerLayer = (doc.grid.length - 1) / 2;
    padBuildVolume();
    if (activeLayer >= doc.grid.length) activeLayer = Math.max(0, doc.grid.length - 1);
    frameDoc();
    rebuild();
    if (g.notes.length) els.validation.innerHTML += g.notes.map((n) => '<div class="warn">⚠ ' + escapeHtml(n) + '</div>').join('');
  }
  document.getElementById('btnApplyText').addEventListener('click', applyText);

  function loadIntoForm(level, ix) {
    loadLevelIntoDoc(level);
    syncFormFromDoc();
    updateLayerLabel();
    frameDoc();
    // Keep the dropdown's displayed value in sync even when a level is loaded
    // some way other than the user picking it (e.g. RT.editor.__test.loadLevel) —
    // otherwise the label silently lies about which level is actually live.
    if (ix !== undefined) els.picker.value = ix;
    rebuild();
  }

  LV.LEVELS.forEach((l, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = (i + 1) + '. ' + l.name;
    els.picker.appendChild(o);
  });
  els.picker.addEventListener('change', () => loadIntoForm(LV.LEVELS[+els.picker.value], +els.picker.value));
  document.getElementById('btnExport').addEventListener('click', exportText);
  els.theme.value = document.body.dataset.theme || 'ben';
  els.theme.addEventListener('change', () => applyTheme(els.theme.value));
  els.toolButtons.querySelectorAll('button[data-tool]').forEach((b) =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  buildPalette();
  buildAmmoList();
  renderAssemblyList();

  /** Paints a readable failure instead of leaving a black viewport — the
   *  pattern js/main.js:136-146 uses for the game. Worth having here for the
   *  same reason it's worth having there: this tool's one historical failure
   *  was a silent throw during boot, and a black rectangle gives no clue
   *  whether the page is broken, still loading, or just aimed at empty sky. */
  let running = true;
  function fatal(err, where) {
    running = false;
    console.error('Ballista editor — ' + where + ':', err);
    const box = document.getElementById('fatal');
    const msg = document.getElementById('fatalMsg');
    if (!box || !msg) return;
    msg.innerHTML = '<b>😵 The editor stopped</b>'
      + 'Something threw while ' + where + '. The details are below and in the console.'
      + '<code></code>';
    msg.querySelector('code').textContent = String(err && err.stack ? err.stack : err);
    box.classList.add('on');
  }

  P.init().then(() => {
    loadIntoForm(LV.LEVELS[0], 0);
    requestAnimationFrame(loop);
  }).catch((err) => fatal(err, 'starting up'));

  let last = 0;
  function loop(now) {
    if (!running) return;
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    try {
      // Clouds drift and the sun's shadow frustum follows the castle — both
      // were dead here for no reason other than `dt` being computed and
      // dropped on the floor in the tool's original version.
      W.update(world, dt);
      renderer.render(scene, camera);
    } catch (err) {
      fatal(err, 'drawing a frame');
    }
  }

  /* ── Test hook — same idiom as js/game.js:1314's RT.game.__test ─────────── */
  return {
    __test: {
      loadLevel(ix) { loadIntoForm(LV.LEVELS[ix], ix); },
      gridSnapshot() { return snapshotDoc(); },
      setCell(l, r, c, ch) { pushUndo(); setCell(l, r, c, ch); rebuild(); },
      cellAt(l, r, c) { return cellAt(l, r, c); },
      place(l, r, c) { let rr = r; if (snap) rr = snapDrop(l, r, c); placeAt(l, rr, c, tool.matId); },
      erase(l, r, c) { eraseAt(l, r, c); },
      pickAt(x, y) { return pickCell(x, y); },
      camera() { return camera; },
      hoverAt(x, y) { const hit = pickCell(x, y); lastPointer = { x: x, y: y }; updateGhost(hit); return hit; },
      rotate(axis, dir) { return rotateClipboard(axis, dir); },
      turns() { return { y: clipTurns.y, z: clipTurns.z }; },
      target(x, y) { return placementTarget(pickCell(x, y)); },
      ghost() {
        return {
          visible: ghostGroup.visible,
          cells: ghostCells.map((g) => ({ x: g.mesh.position.x, y: g.mesh.position.y, z: g.mesh.position.z })),
          shadow: { visible: ghostShadow.visible, x: ghostShadow.position.x, z: ghostShadow.position.z, w: ghostShadow.scale.x, d: ghostShadow.scale.y },
          cage: { visible: cellCage.visible, x: cellCage.position.x, y: cellCage.position.y, z: cellCage.position.z },
          root: { visible: rootMarker.visible, x: rootMarker.position.x, y: rootMarker.position.y, z: rootMarker.position.z }
        };
      },
      liveBlocks() { return live.recs.map((r) => ({ matId: r.spec.matId, x: r.spec.x, y: r.spec.y, z: r.spec.z, w: r.spec.w, h: r.spec.h, d: r.spec.d, layer: r.spec.layer, row: r.spec.row, col: r.spec.col })); },
      blockCount() { return live.recs.length; },
      protoCacheSize() { return Object.keys(protoCache).length; },
      validate() { return validate(); },
      runStability() { runStabilityTest(); return els.checkResult.textContent; },
      exportText() { exportText(); return els.exportBox.value; },
      setTool(kind, matId) { setTool(kind, matId); },
      getTool() { return tool; },
      setSnap(on) { snap = !!on; document.getElementById('btnSnap').textContent = 'Snap: ' + (snap ? 'ON' : 'OFF'); },
      getSnap() { return snap; },
      setActiveLayer(i) { activeLayer = i; updateLayerLabel(); },
      getActiveLayer() { return activeLayer; },
      select(a, b) { sel = normSel(a, b); updateSelectionUI(); },
      getSelection() { return sel; },
      copy() { copySelection(); },
      paste(l, r, c, opaque) { if (clipboard) blitStamp(clipboard, l, r, c, !!opaque); },
      getClipboard() { return clipboard; },
      saveAssembly(name) { if (!sel) return false; const stamp = extractCells(sel); const lib = loadLib(); lib.items.push({ name: name, w: stamp.w, h: stamp.h, d: stamp.d, cells: stamp.cells }); saveLib(lib); renderAssemblyList(); return true; },
      lib() { return loadLib(); },
      undo() { undo(); },
      redo() { redo(); },
      docLevel() { return docAsLevel(); },
      applyTheme(name) { applyTheme(name); els.theme.value = name; },
      setAmmo(ids) { pushUndo(); doc.ammo = ids && ids.length ? ids.slice() : null; syncAmmoCheckboxes(); rebuild(); },
      getAmmo() { return doc.ammo; },
      ammoReach() { const level = docAsLevel(); const allowed = doc.ammo || D.AMMO.map((a) => a.id); return D.ammoReachReport(level, D.AMMO.filter((a) => allowed.indexOf(a.id) !== -1)); }
    }
  };
})();
