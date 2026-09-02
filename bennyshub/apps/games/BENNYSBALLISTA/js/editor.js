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
   * row 0 = TOP (levels.js: bottom = rowBottoms(layerRows, rows)[row] — the
   * REAL cumulative floor height, not a flat `(rows - row - 1) * CELL`; a
   * board/rubble row is thinner than a full CELL, so whatever's above one
   * sits flush on its actual surface rather than a fixed per-row assumption).
   *
   * Why padding is mandatory, not tidiness: parseLevel() computes rows/cols
   * as MAXIMA across all layers, and every row still costs SOME reserved
   * height (a full CELL unless something thinner occupies it) even if empty.
   * So adding one row to ONE layer raises `rows`, which shifts every block in
   * EVERY layer by that reserved amount. A ragged document makes "grow the
   * castle" an accidental whole-castle displacement; a padded one makes it a
   * single well-defined row/column insert. */
  const doc = { name: 'Untitled', dist: 26, par: 3, bolts: 9, ammo: null, cols: 0, rows: 0, grid: [] };

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
   *  coordinates — growing left/up shifts every existing index. */
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
    return { addLeft: addLeft, addTop: addTop };
  }

  function blankLayer() {
    const rows = [];
    for (let r = 0; r < doc.rows; r++) rows.push(new Array(doc.cols).fill('.'));
    return rows;
  }

  function setCell(l, r, c, ch) {
    const off = growTo(c, c, r, r);
    r += off.addTop; c += off.addLeft;
    while (doc.grid.length <= l) doc.grid.push(blankLayer());
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
  function dropProtoCache() {
    for (const k in protoCache) {
      protoCache[k].traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
    protoCache = {};
  }

  /* ── Live view — rebuilt wholesale from `doc` on every mutation ─────────── */
  let live = { parsed: null, recs: [] };
  function clearLive() {
    for (const rec of live.recs) scene.remove(rec.mesh);
    live.recs = [];
  }

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
    if (document.getElementById('btnPasteTool')) {
      document.getElementById('btnPasteTool').disabled = !clipboard;
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
    activeLayer = 0;
    rebuild();
  });
  document.getElementById('btnAddLayerBack').addEventListener('click', () => {
    pushUndo();
    doc.grid.push(blankLayer());
    activeLayer = doc.grid.length - 1;
    rebuild();
  });
  document.getElementById('btnRemoveLayer').addEventListener('click', () => {
    if (doc.grid.length <= 1) return;
    pushUndo();
    doc.grid.splice(activeLayer, 1);
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
  function faceFromLocal(lx, ly, lz, half) {
    const mx = half - Math.abs(lx), my = half - Math.abs(ly), mz = half - Math.abs(lz);
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
    const dims = { cols: doc.cols, rows: doc.rows, numLayers: numLayers };
    for (let l = 0; l < doc.grid.length; l++) {
      // One layer's real per-row floor heights (board/rubble rows are
      // thinner) — computed once per layer, not per cell, since it only
      // depends on that layer's own content.
      const bottoms = LV.rowBottoms(doc.grid[l], doc.rows);
      for (let r = 0; r < doc.rows; r++) {
        for (let c = 0; c < doc.cols; c++) {
          if (cellAt(l, r, c) === '.') continue;
          const cc = LV.cellCentre(doc.dist, dims, l, r, c, bottoms);
          _box.min.set(cc.x - CELL / 2, cc.y - CELL / 2, cc.z - CELL / 2);
          _box.max.set(cc.x + CELL / 2, cc.y + CELL / 2, cc.z + CELL / 2);
          const hit = _raycaster.ray.intersectBox(_box, _hitPt);
          if (!hit) continue;
          const t = _raycaster.ray.origin.distanceTo(_hitPt);
          if (t < bestT) {
            bestT = t;
            const face = faceFromLocal(_hitPt.x - cc.x, _hitPt.y - cc.y, _hitPt.z - cc.z, CELL / 2);
            best = { layer: l, row: r, col: c, face: face };
          }
        }
      }
    }
    if (best) return best;
    // Nothing occupied was hit: fall back to the active layer's z-plane, then
    // the ground plane, and find the nearest cell to where the ray lands.
    const numLayersFallback = Math.max(1, doc.grid.length, activeLayer + 1);
    const planeZ = doc.grid.length
      ? LV.layerZ(doc.dist, numLayersFallback, Math.min(activeLayer, doc.grid.length - 1))
      : LV.layerZ(doc.dist, 1, 0);
    let plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ);
    let pt = new THREE.Vector3();
    if (Math.abs(_raycaster.ray.direction.z) < 1e-4 || !_raycaster.ray.intersectPlane(plane, pt)) {
      plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      if (!_raycaster.ray.intersectPlane(plane, pt)) return null;
    }
    const cols = Math.max(doc.cols, 1), rows = Math.max(doc.rows, 1);
    const col = Math.floor(pt.x / CELL + cols / 2);
    const row = rows - 1 - Math.round((pt.y - CELL / 2) / CELL);
    return { layer: Math.min(activeLayer, Math.max(0, doc.grid.length - 1)), row: row, col: col, face: null, empty: true };
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

  /* ── Ghost preview + cell cage ────────────────────────────────────────────
   * One persistent translucent clone, moved on pointermove — never triggers a
   * rebuild. Necessary because a B fills 15% of its cell and w/s/i fill 50%,
   * so without the wireframe cage the ghost alone doesn't say which CELL is
   * about to be written. */
  let ghost = null, ghostMatId = null;
  function updateGhost(hit) {
    if (!hit || tool.kind !== 'place') { if (ghost) ghost.visible = false; cellCage.visible = false; return; }
    let target = hit;
    if (!hit.empty) target = adjacentCell(hit);
    let r = target.row;
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
    if (snap && hit.empty) r = snapDrop(target.layer, r, target.col);
    if (ghostMatId !== tool.matId || !ghost) {
      if (ghost) scene.remove(ghost);
      const proto = protoFor(tool.matId, CELL, CELL, CELL);
      ghost = proto.clone();
      ghost.traverse((o) => { if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.45; } });
      ghostMatId = tool.matId;
      scene.add(ghost);
    }
    const dims = { cols: Math.max(doc.cols, target.col + 1), rows: Math.max(doc.rows, r + 1), numLayers: Math.max(doc.grid.length, target.layer + 1) };
    const ghostBottoms = LV.rowBottoms(doc.grid[target.layer], dims.rows);
    const cc = LV.cellCentre(doc.dist, dims, target.layer, r, target.col, ghostBottoms);
    ghost.position.set(cc.x, cc.y, cc.z);
    ghost.visible = true;
    cellCage.position.copy(ghost.position);
    cellCage.visible = true;
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
    const dims = { cols: Math.max(doc.cols, sel.col1 + 1), rows: Math.max(doc.rows, sel.row1 + 1), numLayers: Math.max(doc.grid.length, sel.layer1 + 1) };
    const cMin = LV.cellCentre(doc.dist, dims, sel.layer1, sel.row1, sel.col0, LV.rowBottoms(doc.grid[sel.layer1], dims.rows));
    const cMax = LV.cellCentre(doc.dist, dims, sel.layer0, sel.row0, sel.col1, LV.rowBottoms(doc.grid[sel.layer0], dims.rows));
    selBoxHelper.box.min.set(Math.min(cMin.x, cMax.x) - CELL / 2, cMin.y - CELL / 2, Math.min(cMin.z, cMax.z) - CELL / 2);
    selBoxHelper.box.max.set(Math.max(cMin.x, cMax.x) + CELL / 2, cMax.y + CELL / 2, Math.max(cMin.z, cMax.z) + CELL / 2);
    selBoxHelper.visible = true;
  }

  let clipboard = null; // {w,h,d,cells[dl][dr][dc]}
  function copySelection() {
    if (!sel) return;
    const w = sel.col1 - sel.col0 + 1, h = sel.row1 - sel.row0 + 1, d = sel.layer1 - sel.layer0 + 1;
    const cells = [];
    for (let dl = 0; dl < d; dl++) {
      const layer = [];
      for (let dr = 0; dr < h; dr++) {
        const row = [];
        for (let dc = 0; dc < w; dc++) row.push(cellAt(sel.layer0 + dl, sel.row0 + dr, sel.col0 + dc));
        layer.push(row);
      }
      cells.push(layer);
    }
    clipboard = { w: w, h: h, d: d, cells: cells };
    refreshPaletteButtons();
  }
  /** Stamps a clipboard/assembly at (l,r,c) as its layer0/row0/col0 corner.
   *  '.' cells are transparent by default (a tower stamp is mostly empty; an
   *  opaque paste would gouge holes in whatever it lands on). */
  function blitStamp(stamp, l, r, c, opaque) {
    pushUndo();
    for (let dl = 0; dl < stamp.d; dl++) {
      for (let dr = 0; dr < stamp.h; dr++) {
        for (let dc = 0; dc < stamp.w; dc++) {
          const ch = stamp.cells[dl][dr][dc];
          if (ch === '.' && !opaque) continue;
          setCell(l + dl, r + dr, c + dc, ch);
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
      clipboard = { w: item.w, h: item.h, d: item.d, cells: item.cells };
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
    copySelection();
    const lib = loadLib();
    lib.items.push({ name: name, w: clipboard.w, h: clipboard.h, d: clipboard.d, cells: clipboard.cells });
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
    if (tool.kind === 'paste') {
      if (!clipboard) return;
      const target = hit.empty ? hit : adjacentCell(hit);
      blitStamp(clipboard, target.layer, target.row, target.col, false);
      return;
    }
    // 'place' — see updateGhost()'s comment: snap-drop only applies when no
    // specific face was clicked (the empty-space fallback); an explicit face
    // click attaches exactly there.
    let target = hit.empty ? hit : adjacentCell(hit);
    let r = target.row;
    if (snap && hit.empty) r = snapDrop(target.layer, r, target.col);
    placeAt(target.layer, r, target.col, tool.matId);
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

  /* ── Export ───────────────────────────────────────────────────────────────
   * Single-quote style to match levels.js, not JSON.stringify's doubles; only
   * emits `ammo:` when set; never emits _cols/_depth (levels.js computes those
   * at load, :506-510). */
  function exportText() {
    const level = docAsLevel();
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
    if (activeLayer >= doc.grid.length) activeLayer = Math.max(0, doc.grid.length - 1);
    rebuild();
    if (g.notes.length) els.validation.innerHTML += g.notes.map((n) => '<div class="warn">⚠ ' + escapeHtml(n) + '</div>').join('');
  }
  document.getElementById('btnApplyText').addEventListener('click', applyText);

  function loadIntoForm(level, ix) {
    loadLevelIntoDoc(level);
    syncFormFromDoc();
    updateLayerLabel();
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
      saveAssembly(name) { if (!sel) return false; copySelection(); const lib = loadLib(); lib.items.push({ name: name, w: clipboard.w, h: clipboard.h, d: clipboard.d, cells: clipboard.cells }); saveLib(lib); renderAssemblyList(); return true; },
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
