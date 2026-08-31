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

  /** How much of a cell's vertical budget a `plank:true` material (js/data.js's
   *  `B`) claims, sitting flush on its own row's floor rather than filling the
   *  cell like every other material. Tunable — not a locked design constant. */
  const PLANK_FRAC = 0.15;

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
          h = mat.plank ? CELL * PLANK_FRAC : CELL;
          d = (endLayer - li + 1) * CELL;
          x = (run.col + run.len / 2 - cols / 2) * CELL;
          const bottom = (rows - run.row - 1) * CELL;   // this row's own floor
          y = bottom + h / 2;
          z = (layerZ(li) + layerZ(endLayer)) / 2;
        }
        blocks.push({ matId: run.matId, x: x, y: y, z: z, w: w, h: h, d: d });
      }
    }

    return { blocks: blocks, cols: cols, rows: rows, numLayers: numLayers, crownCount: crownCount };
  }

  /* ── Levels ───────────────────────────────────────────────────────────────
   * `dist` is the castle's centre distance downrange (see data.js's
   * castleBounds/rangeWindow) — retuned 2026-08-30 for real cinematic flight
   * time (measured by tracing real shots via traceShot(), not guessed):
   * at the short original 16-25 range, a flat/direct ammo's near-max-range
   * shot resolved in well under a second, too quick to watch the FLIGHT
   * camera actually chase it. Distances now sit as far out as each level's
   * available/needed ammo can safely reach — checked against
   * maxRange(speed) for every unlocked ammo at that level index, with the
   * rangeWindow's near/far pad and (for the four depth levels) each layer's
   * own half-depth folded in — so this is still exactly as reachable as the
   * original escalation, just slower to arrive. auditLevels()/auditReach()
   * (js/game.js) reverify this on every boot regardless.
   *
   * The first eight are single-layer castles, carried over from the 2D
   * game's LEVELS array (recovered from git history, commit bc731c9) since
   * their shapes are already known to stand on their own weight — depth
   * changes nothing about whether a layer stands, only what can see it. The
   * last four introduce depth, escalating from two layers to three.
   */
  const LEVELS = [
    { name: 'The Reed Tower', par: 1, bolts: 6, dist: 24, layers: [[
      '..K..',
      '.WWW.',
      '.W.W.',
      '.W.W.',
      '.W.W.'
    ]] },
    { name: 'The Clad Pillar', par: 2, bolts: 7, dist: 25, layers: [[
      '.K',
      '.W',
      'SW',
      'SW',
      'SW',
      'SW'
    ]] },
    { name: 'Scaffold Twins', par: 2, bolts: 7, dist: 26, layers: [[
      '.K.....K.',
      'WWWWWWWWW',
      'W.......W',
      'W.......W'
    ]] },
    { name: 'The Long Colonnade', par: 2, bolts: 7, dist: 27, layers: [[
      '....K....',
      '.WWWWWWW.',
      '.S.S.S.S.'
    ]] },
    { name: 'Glasshouse Keep', par: 2, bolts: 7, dist: 27, layers: [[
      '.K..K',
      '.W..W',
      '.W..W',
      'SW.IW',
      'IW.SW',
      'SW.SW'
    ]] },
    { name: 'Cliffside Fort', par: 2, bolts: 9, dist: 28, layers: [[
      '..K..K..K..',
      '..W..W..W..',
      '.WWWWTWWWW.',
      'XXXXXXXXXXX'
    ]] },
    { name: 'Powder Row', par: 3, bolts: 8, dist: 29, layers: [[
      '....K....',
      '.WWWWWWW.',
      'SW.....WS',
      'IT.....TI',
      'SW.....WS',
      'SW.....WS'
    ]] },
    { name: 'The Timberworks', par: 3, bolts: 9, dist: 27, layers: [[
      '.K.....K.',
      '.WWWWWWW.',
      '.W.....W.',
      '.T.....W.',
      '.W.....T.',
      '.W..s..W.'
    ]] },
    { name: 'Twin Halls', par: 3, bolts: 9, dist: 25, layers: [
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
    { name: 'The Palisade', par: 3, bolts: 9, dist: 26, layers: [
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
    { name: 'The Deep Keep', par: 4, bolts: 11, dist: 27, layers: [
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
    { name: "Benny's Bastion", par: 5, bolts: 13, dist: 27, layers: [
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
    ] },
    /* The first two levels built around `B` (js/data.js's timber board) — a
     * thin, mergeable piece that sits flush on its own row's floor instead of
     * filling the cell, so a run of it can bridge a gap between two supports
     * with nothing but open air underneath. Both keep the crown a full empty
     * row below the board (never directly touching it), per the authoring
     * rule in README.md. */
    { name: 'The Bridge', par: 2, bolts: 7, dist: 28, layers: [[
      '..BBBBB..',   // the span itself — rests only on the two pillars below
      '..W...W..',   // pillar tops; the three middle columns are open shaft
      '..W.K.W..'    // pillar bases, and the crown standing in the open gap
    ]] },
    /* Deliberately NOT independently reachable — the point of this one.
     * The roof rests on two single-block pillars, each in turn resting on a
     * static steel ledge (steel needs no support underneath it — see
     * Cliffside Fort/The Palisade above — so the ledge can float over an
     * open pit with nothing propping it up). Destroy either single-block
     * pillar (one hit; nothing stacked above it to catch the gap the way a
     * taller pillar would) and the roof, now held at only one end, swings
     * down into the pit onto whatever's below — a genuine multi-unit fall,
     * not a token one-row drop, so it actually crosses the damage threshold.
     * Verified in-browser (RT.game.__test): destroying a pillar really does
     * bring the roof down hard enough to kill a crown underneath, not
     * assumed from the fall-height arithmetic alone (see
     * [[ballista-3d-rework]] for why a short drop doesn't reliably cross the
     * threshold, and why "shoot the base" alone never used to be enough —
     * a destroyed support's neighbours don't wake on their own). */
    /* The crown sits on a cantilevered LEDGE (one wide merged run poking one
     * cell further than the wall above and below it — `W` at col0-1 doesn't
     * merge with the `K` beside it, different materials never do, but the
     * ledge row's own col0-2 run is one single rigid body). Destroy that one
     * row and the wall above simply settles 1 unit onto the wall below (an
     * ordinary, harmless resettle) — but col2 has nothing at ANY row below
     * the ledge, all the way to the ground, so the crown genuinely free-
     * falls the full six units with nothing to catch it partway, unlike a
     * continuously-touching stack (which only ever closes by the height of
     * whatever's removed — see [[ballista-3d-rework]] for how that was
     * confirmed, and why a supported crown never has to be independently
     * reachable to begin with). Verified in-browser, not assumed. */
    { name: 'The Cantilever', par: 3, bolts: 8, dist: 29, layers: [[
      'WWK......',   // the crown, resting on nothing but the ledge below it
      'WWW......',   // the ledge — one merged run, one hit clears it entirely
      'WW.......',
      'WW.......',
      'WW.......',
      'WW.......',
      'WW.......'    // wall base, unrelated to whatever col2 is doing above
    ]] }
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
