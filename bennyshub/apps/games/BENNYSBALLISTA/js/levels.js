/**
 * Benny's Ballista — level data and the ASCII-layer parser.
 *
 * A castle is a stack of 2D ASCII pictures, front layer first (nearest the
 * ballista) — same letters and merge rule as the old 2D game's single-picture
 * `LEVELS`, extended with depth. Two merges happen, both only for
 * `mergeable` materials (never small rubble, never a one-off piece like `T`
 * or `K`):
 *
 *   - ROW merge (x). A run of the same letter side by side in one row welds
 *     into one wide rigid body, exactly as the 2D version did.
 *   - LAYER merge (z). The *same* run (same row, same columns, same letter)
 *     repeated in the next layer back welds into one deep body too, so a
 *     wall drawn identically on several layers is one slab, not N thin
 *     plates standing shoulder to shoulder.
 *
 * Because layers sit in their own z-slice with no vertical overlap between
 * them, **each layer has to stand on its own** — a block only rests on
 * whatever is directly below it in the *same* layer. That is what makes a
 * front wall a genuine sightline obstruction rather than a support for
 * anything behind it: knock it down and the layers behind are unaffected
 * structurally, only newly visible/reachable.
 *
 * Authoring tricks that carry over unchanged from the 2D game, now doubled
 * by having a Z axis as well as an X one:
 *   - CLADDING. Put `S` in front of a `W` (same row, same column, earlier
 *     layer) and the wood is armoured — a shot has to get through the stone
 *     first.
 *   - WINDOWS. Put `I` in front of anything and the same shot shatters the
 *     glass and carries on into whatever it was hiding.
 *   - DEPTH. A solid front layer can hide a back layer's crown from a flat
 *     shot entirely — reaching it needs a lob that clears the front layer's
 *     height, or knocking the front layer down first.
 */
RT.levels = (function () {
  'use strict';

  const D = RT.data;
  const MAT = D.MAT;

  /** One block is one world unit, matching data.js's coordinate note and
   *  physics.js's happy range for Bullet. */
  const CELL = 1.0;

  /** Same-letter runs within one row of one layer, exactly as the 2D
   *  version's buildLevel() found them. */
  function rowRuns(rows) {
    const runs = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      let c = 0;
      while (c < row.length) {
        const ch = row[c];
        if (ch === '.' || ch === ' ') { c++; continue; }
        const mat = MAT[ch];
        if (!mat) { c++; continue; }
        let len = 1;
        if (mat.mergeable) { while (c + len < row.length && row[c + len] === ch) len++; }
        runs.push({ row: r, col: c, len: len, matId: ch, small: !!mat.small });
        c += len;
      }
    }
    return runs;
  }

  /**
   * Parses one level's stacked layers into plain block specs in world units
   * — {matId, x, y, z, w, h, d} — ready to hand to js/physics.js and
   * js/art.js. Pure; spawns nothing itself, so both js/game.js and
   * editor.html can call it.
   */
  function parseLevel(level) {
    const layers = level.layers;
    const numLayers = layers.length;
    let cols = 0, rows = 0;
    for (const layer of layers) {
      rows = Math.max(rows, layer.length);
      for (const row of layer) cols = Math.max(cols, row.length);
    }

    const layerRuns = layers.map(rowRuns);
    const used = layerRuns.map((runs) => runs.map(() => false));
    const blocks = [];
    let crownCount = 0;

    // Layer 0 is nearest the ballista (least negative Z); layers stack away
    // from it in even CELL-wide steps, centred on level.dist.
    const layerZ = (i) => -level.dist + ((numLayers - 1) / 2 - i) * CELL;

    for (let li = 0; li < numLayers; li++) {
      const runs = layerRuns[li];
      for (let ri = 0; ri < runs.length; ri++) {
        if (used[li][ri]) continue;
        const run = runs[ri];
        used[li][ri] = true;
        const mat = MAT[run.matId];
        if (run.matId === 'K') crownCount++;

        let endLayer = li;
        if (mat.mergeable && !run.small) {
          for (let nl = li + 1; nl < numLayers; nl++) {
            const idx = layerRuns[nl].findIndex((r2, i2) => !used[nl][i2] &&
              r2.row === run.row && r2.col === run.col &&
              r2.len === run.len && r2.matId === run.matId);
            if (idx === -1) break;
            used[nl][idx] = true;
            endLayer = nl;
          }
        }

        let x, y, z, w, h, d;
        if (run.small) {
          w = h = d = CELL * 0.5;
          x = (run.col + 0.5 - cols / 2) * CELL;
          y = (rows - run.row - 1) * CELL + h / 2;   // resting on its cell's floor
          z = layerZ(li);
        } else {
          w = run.len * CELL;
          h = CELL;
          d = (endLayer - li + 1) * CELL;
          x = (run.col + run.len / 2 - cols / 2) * CELL;
          y = (rows - run.row - 1 + 0.5) * CELL;
          z = (layerZ(li) + layerZ(endLayer)) / 2;
        }
        blocks.push({ matId: run.matId, x: x, y: y, z: z, w: w, h: h, d: d });
      }
    }

    return { blocks: blocks, cols: cols, rows: rows, numLayers: numLayers, crownCount: crownCount };
  }

  /* ── Levels ───────────────────────────────────────────────────────────────
   * `dist` is the castle's centre distance downrange (see data.js's
   * castleBounds/rangeWindow) — a placeholder pass for now, escalating
   * gently; the plan's step 7 retunes these once real flight time can be
   * judged by eye rather than guessed at.
   *
   * The first eight are single-layer castles, carried over from the 2D
   * game's LEVELS array (recovered from git history, commit bc731c9) since
   * their shapes are already known to stand on their own weight — depth
   * changes nothing about whether a layer stands, only what can see it. The
   * last four introduce depth, escalating from two layers to three.
   */
  const LEVELS = [
    { name: 'The Reed Tower', par: 1, bolts: 6, dist: 16, layers: [[
      '..K..',
      '.WWW.',
      '.W.W.',
      '.W.W.',
      '.W.W.'
    ]] },
    { name: 'The Clad Pillar', par: 2, bolts: 7, dist: 17, layers: [[
      '.K',
      '.W',
      'SW',
      'SW',
      'SW',
      'SW'
    ]] },
    { name: 'Scaffold Twins', par: 2, bolts: 7, dist: 18, layers: [[
      '.K.....K.',
      'WWWWWWWWW',
      'W.......W',
      'W.......W'
    ]] },
    { name: 'The Long Colonnade', par: 2, bolts: 7, dist: 19, layers: [[
      '....K....',
      '.WWWWWWW.',
      '.S.S.S.S.'
    ]] },
    { name: 'Glasshouse Keep', par: 2, bolts: 7, dist: 19, layers: [[
      '.K..K',
      '.W..W',
      '.W..W',
      'SW.IW',
      'IW.SW',
      'SW.SW'
    ]] },
    { name: 'Cliffside Fort', par: 2, bolts: 9, dist: 20, layers: [[
      '..K..K..K..',
      '..W..W..W..',
      '.WWWWTWWWW.',
      'XXXXXXXXXXX'
    ]] },
    { name: 'Powder Row', par: 3, bolts: 8, dist: 21, layers: [[
      '....K....',
      '.WWWWWWW.',
      'SW.....WS',
      'IT.....TI',
      'SW.....WS',
      'SW.....WS'
    ]] },
    { name: 'The Timberworks', par: 3, bolts: 9, dist: 22, layers: [[
      '.K.....K.',
      '.WWWWWWW.',
      '.W.....W.',
      '.T.....W.',
      '.W.....T.',
      '.W..s..W.'
    ]] },
    { name: 'Twin Halls', par: 3, bolts: 9, dist: 20, layers: [
      [                             // front — a blind stone wall, no crown
        '.....',
        '.....',
        'SSSSS',
        'SSSSS'
      ], [                          // back — the real target, behind it
        '..K..',
        '.WWW.',
        '.W.W.',
        '.W.W.'
      ]
    ] },
    { name: 'The Palisade', par: 3, bolts: 9, dist: 21, layers: [
      [                             // front
        '.....',
        'X...X',
        'X.T.X',
        'XXXXX'
      ], [                          // back — corner posts and the floor weld
        '..K..',                    // to the front layer's (layer merge)
        'X.W.X',
        'X.W.X',
        'XXXXX'
      ]
    ] },
    { name: 'The Deep Keep', par: 4, bolts: 11, dist: 23, layers: [
      [                             // front screen — thin, meant to fall first
        '.....',
        '.W.W.',
        '.W.W.',
        '.W.W.'
      ], [                          // middle wall — a gap down its centre
        '.....',
        'SSSSS',
        'S...S',
        'SSSSS'
      ], [                          // back — the crown, behind both
        '..K..',
        '.WWW.',
        '.W.W.',
        '.W.W.'
      ]
    ] },
    { name: "Benny's Bastion", par: 5, bolts: 13, dist: 25, layers: [
      [                             // front — twin outer crowns, spindly towers
        'K.......K',
        'W.......W',
        'W.......W',
        'W.......W'
      ], [                          // courtyard — a lone keg, nothing to protect it
        '.........',
        '.........',
        '....T....',
        'XXXXXXXXX'
      ], [                          // inner sanctum — the true crown, walled in
        '....K....',
        '.WWWWWWW.',
        '.W.....W.',
        '.WWWWWWW.'
      ]
    ] }
  ];

  // Compute and cache each level's footprint once, at load — data.js's
  // castleBounds()/rangeWindow()/yawLimit() read these directly, the same
  // way they already read TEST_LEVEL's hand-set _cols/_depth.
  for (const level of LEVELS) {
    const parsed = parseLevel(level);
    level._cols = parsed.cols;
    level._depth = parsed.numLayers;
  }

  return { CELL: CELL, LEVELS: LEVELS, parseLevel: parseLevel };
})();
