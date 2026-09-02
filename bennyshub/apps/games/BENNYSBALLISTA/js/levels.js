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

  /** World Z of layer `i` in a castle `numLayers` deep, centred on `dist`.
   *  Layer 0 is nearest the ballista (least negative Z). Promoted out of
   *  parseLevel()'s closure (where it started life as a one-off arrow
   *  function) so a caller that needs to place a single cell — the level
   *  editor mapping a mouse ray back to a cell, not a full re-parse — has the
   *  exact inverse of parseLevel()'s own placement maths to call instead of
   *  re-deriving it and risking the two drifting apart. */
  function layerZ(dist, numLayers, i) {
    return -dist + ((numLayers - 1) / 2 - i) * CELL;
  }

  /** World-space centre of one grid CELL — not of a merged block, which can
   *  span several cells and isn't what a mouse click ever targets. Always a
   *  full CELL cube regardless of what (if anything) occupies it, so a thin
   *  `B` plank or a half-size `w/s/i` chunk is exactly as easy to pick as a
   *  full block. `dims` is `{cols, rows, numLayers}`, i.e. parseLevel()'s own
   *  return shape (or the `_cols`/`_depth` pair cached onto a level, plus its
   *  layer count) — same convention data.js's castleBounds() reads. */
  function cellCentre(dist, dims, layer, row, col) {
    return {
      x: (col + 0.5 - dims.cols / 2) * CELL,
      y: (dims.rows - row - 1) * CELL + CELL / 2,
      z: layerZ(dist, dims.numLayers, layer),
      size: CELL
    };
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
    // from it in even CELL-wide steps, centred on level.dist. `lz` rather than
    // shadowing the module-level layerZ() above — same maths, this closure
    // just bakes in level.dist/numLayers so every call site below doesn't
    // have to repeat them.
    const lz = (i) => layerZ(level.dist, numLayers, i);

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
          z = lz(li);
        } else {
          w = run.len * CELL;
          h = mat.plank ? CELL * PLANK_FRAC : CELL;
          d = (endLayer - li + 1) * CELL;
          x = (run.col + run.len / 2 - cols / 2) * CELL;
          const bottom = (rows - run.row - 1) * CELL;   // this row's own floor
          y = bottom + h / 2;
          z = (lz(li) + lz(endLayer)) / 2;
        }
        // layer/endLayer/row/col/len/small are pure provenance — nothing here
        // reads them back, but a caller that wants to report a failure in cell
        // coordinates ("crown at layer 5, row 6, col 7") rather than raw world
        // x/y/z needs them, and every value already exists in this scope.
        blocks.push({ matId: run.matId, x: x, y: y, z: z, w: w, h: h, d: d,
                      layer: li, endLayer: endLayer, row: run.row, col: run.col,
                      len: run.len, small: !!run.small });
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
   * original escalation, just slower to arrive. `js/game.js`'s auditLevels()
   * reverifies every castle still stands on every boot regardless, and
   * auditAmmoOffers() (backed by `js/data.js`'s ammoReachReport()) checks
   * the ammo-range arithmetic this paragraph describes — deterministically,
   * not by sampling.
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
      'QWWWWTWWWWH',            // two guards flanking the ground floor, easy first look at one
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
        '..H..',                    // a guard standing on the rampart, in full view
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
    ]] },
    /* The conservative end of the level chart — three axes, but every layer
     * still does exactly one job, and every gate is a plain copy of the same
     * cols-5-7/rows-6-7 opening, so the one proven direct sightline never
     * has to be re-verified from scratch. 13 cols wide, a 9-row twin-pillar
     * tower, and now 5 real layers of depth (deepened per Bryan's ask —
     * two new layers inserted, an indestructible steel inner gate and a
     * flanking glass screen, both keeping the SAME open gate footprint as
     * the outer wall rather than a new one, on purpose: a shot only stops
     * at the first block its trace hits (js/game.js's traceShot() has no
     * pass-through logic for any material, "shatters and carries on" from
     * this file's own header comment notwithstanding — that reveals itself
     * over separate shots, not within one), so a material with no gate at
     * all in the sightline's column would turn this into a shoot-twice
     * puzzle: break the obstruction, then hit the now-exposed crown. That is
     * a perfectly legitimate solution — a level is free to need a sequence
     * of shots (see js/game.js's header on why the reachability audit that
     * used to require single-shot solvability was removed) — but keeping
     * every new layer's gate aligned was still the simpler, more comfortable
     * *play* here, so it stayed.
     * The `B` timber board reappears as a mid-tower balcony — a second,
     * different use from The Bridge's span-over-a-pit: here it's pure
     * obstruction/flavour, bracing the two pillars with open shaft on both
     * sides of it (rows 0-2 above, rows 4-8 below), never carrying anything
     * else's weight, so it can't foul the crown-standing-flush requirement
     * the way something resting ON a board would (a board only fills
     * PLANK_FRAC of its own row's cell — flush FOR whatever sits below it,
     * since a row's floor always meets the row below's ceiling exactly, but
     * a ~0.85-cell air gap for anything placed in the row ABOVE it, which a
     * crown there would fall through and fail auditLevels' <0.05
     * settle-movement check). The crown itself sits on an ordinary flush
     * stone plinth in the BACK layer, screened by every wall's gate (cols
     * 5-7) and the tower's open shaft (cols 4-8) — all centred on the same
     * row (6) as the crown, for a clean flat sightline straight through,
     * exactly the "depth as obstruction, not a maze" rule the other
     * multi-layer levels already use. */
    { name: 'The Siege Tower', par: 3, bolts: 8, dist: 28, layers: [
      [                             // front — the wide outer wall (breadth)
        '.............',
        '.............',
        '.............',
        '.............',
        '.............',
        '.............',
        'SSSSS...SSSSS',           // gate, cols 5-7
        'SSSSS...SSSSS',
        'SSSSSSSSSSSSS'            // solid base — the gate is a window, not a door
      ], [                          // NEW — an inner steel gate, indestructible
        '.............',
        '.............',
        '.............',
        '.............',
        '.............',
        '.............',
        'XXXXX...XXXXX',           // same gate footprint as the outer wall
        'XXXXX...XXXXX',
        'XXXXXXXXXXXXX'
      ], [                          // middle — the twin-pillar tower (height)
        '...W.....W...',
        '...W.....W...',
        '...W.....W...',
        '...BBBBBBB...',           // balcony brace, open shaft both above and below
        '...W.....W...',
        '...W.....W...',
        '...W.....W...',           // row 6 — level with every gate
        '...W.....W...',
        '...W.....W...'
      ], [                          // NEW — a flanking glass screen
        '.............',
        '.............',
        '.............',
        '.............',
        '.............',
        '.............',
        'IIIII...IIIII',           // glass either side, same gate left open
        'IIIII...IIIII',
        'SSSSSSSSSSSSS'            // stone footing
      ], [                          // back — the keep, the true target (depth)
        '.............',
        '.............',
        '.............',
        '.............',
        '.............',
        '.............',
        '......K......',
        '......S......',
        '......S......'
      ]
    ] },
    /* The elaborate end of the chart — every material in MAT gets a job, two
     * crowns at two difficulty tiers, two spans, and the widest/tallest
     * footprint yet (15 cols, a 10-row tower, 4 layers). Everything below is
     * still built ONLY from patterns already proven elsewhere in this file,
     * on purpose: an early draft gave the mid-tower steel brace a gap at the
     * centre column so a shot could thread it, which meant the brace was
     * only supported at ONE end for most of its span — a real cantilever,
     * unlike The Cantilever's own (which is a solid single merged run, never
     * an asymmetric overhang) — and risks Bullet resolving it as an
     * unstable torque rather than a clean rest. Moved the two spans to rows
     * the main sightline never uses (1 and 5) instead, so both are full,
     * symmetric, both-ends-supported runs exactly like The Bridge/Siege
     * Tower's boards, and row 6 stays a plain open pillar row the whole way
     * through — the same "keep every gate on the same row/column" discipline
     * The Siege Tower's deepening above just used, not a new risk.
     *
     * Layer 0 (wall): two gates — left (cols 2-6, widened from an original
     * 2-wide cols-3-4 draft) and right (cols 10-11) — stone, with a glass
     * arrow-slit over the right gate and a plain merlon top; the glass never
     * sits in front of the centre column, so it's flavour, not a shoot-twice
     * trap. The left gate's first draft was only 2 cols wide with the crown
     * behind it sitting at the gate's own EDGE — a genuinely uncomfortable
     * shot at sweep speed (AGENTS.md's hold-to-sweep rule wants targets
     * forgiving enough to hit), which is reason enough on its own to widen
     * it. It also happened to expose a real bug worth remembering: the
     * now-removed reachability audit's coarse direct-hit grid missed that
     * narrow a window outright and fell through to a real-physics
     * simulation tier whose result depended on simulation order — passing
     * on a warm test session but failing on a genuine fresh boot. Widened to
     * 5 cols with the crown re-centred in it — better to aim at either way,
     * and (at the time) verified clean across multiple fresh boots too.
     * Layer 1 (courtyard): an EASY crown directly behind the left gate, one
     * layer to clear, no deeper obstruction — a second, shallower difficulty
     * tier the way Powder Row/Bastion escalate within one level. A powder
     * keg sits loose behind the right gate purely as a hazard/flavour (nothing
     * depends on destroying it), plus one small wood-rubble chunk on bare
     * ground — both isolated on open floor, the only placement `w`/`s`/`i`
     * chunks are safe in (see The Timberworks' lone `s` for the precedent;
     * a small chunk under a full-size block would be a narrow, likely
     * unstable support, so this file never does that).
     * Layer 2 (tower): twin pillars, TALLER than The Siege Tower's (10 rows
     * vs 9), with a timber board near the top and a steel brace lower down
     * — different material, different row, so neither merges with the
     * other or with anything in an adjacent layer.
     * Layer 3 (keep): the HARD crown, three layers deep, on a wider stone
     * altar than The Siege Tower's single-block plinth. */
    { name: 'The Grand Citadel', par: 5, bolts: 12, dist: 24, layers: [
      [                             // wall — breadth, two gates, glass slits
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
        'S.......S.IIS.S',           // merlons + an arrow-slit over the right gate
        'SS.....SSS..SSS',           // gates — cols 2-6 (widened) and 10-11
        'SS.....SSS..SSS',
        'SSSSSSSSSSSSSSS'            // solid base
      ], [                          // courtyard — the easy crown, keg, rubble
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
        '....K..........',          // easy crown, centred in the widened left gate
        '....S..........',          // its pedestal
        '....S..w..T....'            // pedestal base + loose rubble + a keg
      ], [                          // tower — height, two symmetric spans
        '..W.........W..',
        '..BBBBBBBBBBB..',           // upper board, full span (both ends supported)
        '..W.........W..',
        '..W.........W..',
        '..W.........W..',
        '..XXXXXXXXXXX..',           // steel brace, full span — same discipline
        '..W.........W..',           // row 6 — level with every gate, left clear
        '..W.........W..',
        '..W.........W..',
        '..W.........W..'
      ], [                          // keep — depth, the hard crown, a wider altar
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
        '.....H.K.Q.....',           // hard crown, flanked by two guards on the altar
        '.....SSSSS.....',           // altar
        '.....SSSSS.....',
        'SSSSSSSSSSSSSSS'            // keep floor
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

  return {
    CELL: CELL, PLANK_FRAC: PLANK_FRAC, LEVELS: LEVELS,
    parseLevel: parseLevel, layerZ: layerZ, cellCentre: cellCentre
  };
})();
