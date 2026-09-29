#!/usr/bin/env node
/* Benny's Sphere Splash - match simulation checks. No dependencies.
 *
 *   node tools/check-sim.cjs            full run (every pairing, both ends, many seeds)
 *   node tools/check-sim.cjs --quick    fewer seeds, for a fast loop while tuning
 *
 * Loads the game's own js/data.js, modes.js, ai.js and sim.js into a Node vm (the
 * same files the browser runs), plays AI-vs-AI and scripted-human matches, and
 * asserts the rules produce real games: sensible scores, stronger teams winning more,
 * no stalls, every decision resolved, determinism, and exact save/resume.
 */
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path');
const JS = path.join(__dirname, '..', 'js');
const QUICK = process.argv.includes('--quick');

function load() {
  const ctx = vm.createContext({ console });
  for (const f of ['data', 'modes', 'ai', 'sim']) vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' });
  return ctx.SS;
}
const SS = load();
const { TEAMS, RULES } = SS.DATA;

/** Play one match to the end. `chooser(dec, m)` answers human decisions. */
function play({ home, away, seed, half = RULES.HALF_STANDARD, overtime = false, human = null, stops = 'ours', chooser, onEvent, formations }) {
  const m = SS.sim.create({ teams: [home, away], seed, halfLength: half, overtime, human, stops, formations });
  let guard = 0, lastBallMove = 0, stall = 0;
  const events = [];
  while (!m.done) {
    if (m.pending) {
      const id = chooser(m.pending, m);
      events.push(...m.choose(id));
    } else events.push(...m.advance(1));
    if (++guard > 200000) throw new Error('match did not finish (seed ' + seed + ')');
    const b = m.s.ball.p, far = Math.hypot(b.x, b.y, b.z);
    if (far > RULES.R) throw new Error('ball left the sphere: ' + far.toFixed(2));
  }
  if (onEvent) events.forEach(onEvent);
  return { m, events };
}

const bestOdds = dec => dec.options.slice().sort((a, b) => b.odds.p - a.odds.p)[0].id;
/** A sensible human: weighs where each option leaves the ball, like the AI does, but without the dice. */
const sensible = (dec, m) => { const v = dec.options.map(o => dec.kind === 'stance' ? o.odds.p : SS.ai.valueOf(m.s, dec, o)); return dec.options[v.indexOf(Math.max(...v))].id; };
const results = [];
let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  - ' + detail : ''));
  if (!ok) fails++;
}

/* ── 1. every pairing, both ends ─────────────────────────────────────────── */
const SEEDS = QUICK ? 6 : 20;
const t0 = Date.now();
const table = {};
TEAMS.forEach(t => { table[t.id] = { w: 0, d: 0, l: 0, gf: 0, ga: 0 }; });
let totals = { goals: 0, matches: 0, shots: 0, onTarget: 0, passes: 0, completed: 0, encounters: 0, decisions: 0, possessions: 0, tackles: 0, kept: 0, techs: 0, zeroDecision: 0 };
for (let a = 0; a < TEAMS.length; a++) for (let b = 0; b < TEAMS.length; b++) {
  if (a === b) continue;
  for (let k = 0; k < SEEDS; k++) {
    const seed = 1000 + a * 97 + b * 13 + k * 7919;
    const { m } = play({ home: TEAMS[a], away: TEAMS[b], seed });
    const s = m.s, [ga, gb] = s.score;
    table[TEAMS[a].id].gf += ga; table[TEAMS[a].id].ga += gb; table[TEAMS[b].id].gf += gb; table[TEAMS[b].id].ga += ga;
    if (ga > gb) { table[TEAMS[a].id].w++; table[TEAMS[b].id].l++; } else if (gb > ga) { table[TEAMS[b].id].w++; table[TEAMS[a].id].l++; } else { table[TEAMS[a].id].d++; table[TEAMS[b].id].d++; }
    totals.matches++; totals.goals += ga + gb;
    s.players.forEach(p => { totals.shots += p.st.shots; totals.onTarget += p.st.onTarget; totals.passes += p.st.passes; totals.completed += p.st.completed; totals.tackles += p.st.tackles; totals.kept += p.st.kept; totals.techs += p.st.techs; });
    totals.encounters += s.log.encounters; totals.decisions += s.log.decisions[0] + s.log.decisions[1]; totals.possessions += s.log.possessions;
    if (s.log.decisions[0] + s.log.decisions[1] === 0) totals.zeroDecision++;
  }
}
const n = totals.matches;
console.log(`\n${n} AI-vs-AI matches in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
console.log('Team                   W   D   L    GF   GA   win%');
TEAMS.forEach(t => { const r = table[t.id], g = r.w + r.d + r.l; console.log(`${t.name.padEnd(20)} ${String(r.w).padStart(3)} ${String(r.d).padStart(3)} ${String(r.l).padStart(3)}  ${String(r.gf).padStart(4)} ${String(r.ga).padStart(4)}   ${(100 * r.w / g).toFixed(0)}%`); });
const per = k => (totals[k] / n).toFixed(1);
console.log(`\nper match: goals ${per('goals')}, shots ${per('shots')} (on target ${per('onTarget')}), passes ${per('passes')} (done ${(100 * totals.completed / Math.max(1, totals.passes)).toFixed(0)}%),`);
console.log(`           encounters ${per('encounters')}, decisions ${per('decisions')}, possessions ${per('possessions')}, tackles won ${per('tackles')}, dribbles kept ${per('kept')}, techniques ${per('techs')}`);
console.log('');
const goals = totals.goals / n;
check('goals per match between 2 and 7', goals >= 2 && goals <= 7, goals.toFixed(2));
check('every match has decisions', totals.zeroDecision === 0, totals.zeroDecision + ' without');
const wr = id => { const r = table[id]; return r.w / (r.w + r.d + r.l); };
check('champions (Harbor Stars) win more than underdogs (Bayside Beamers)', wr('harbor') > wr('beamers') + 0.15, `${(wr('harbor') * 100).toFixed(0)}% vs ${(wr('beamers') * 100).toFixed(0)}%`);
check('underdogs still win sometimes', table.beamers.w > 0, table.beamers.w + ' wins');
check('pass completion 55-90%', totals.completed / totals.passes >= 0.55 && totals.completed / totals.passes <= 0.9, (100 * totals.completed / totals.passes).toFixed(0) + '%');
check('encounters per match 10-60', totals.encounters / n >= 10 && totals.encounters / n <= 60, per('encounters'));
check('possession changes hands (>= 12 per match)', totals.possessions / n >= 12, per('possessions'));

/* ── 2. determinism and save/resume ───────────────────────────────────────── */
{
  const a = play({ home: TEAMS[0], away: TEAMS[1], seed: 4242 }).m.s.score.join('-');
  const b = play({ home: TEAMS[0], away: TEAMS[1], seed: 4242 }).m.s.score.join('-');
  check('same seed, same match', a === b, a + ' / ' + b);

  // Save at a human decision, restore, and the rest of the match plays identically.
  const run = (restoreAt) => {
    const m0 = SS.sim.create({ teams: [TEAMS[0], TEAMS[3]], seed: 99, human: 0, stops: 'ours' });
    let m = m0, count = 0, log = [];
    while (!m.done) {
      if (m.pending) {
        if (count === restoreAt) m = SS.sim.restore(JSON.parse(JSON.stringify(m.snapshot())));
        count++;
        log.push(...m.choose(bestOdds(m.pending)).map(e => e.type));
      } else log.push(...m.advance(1).map(e => e.type));
    }
    return m.s.score.join('-') + '|' + log.length + '|' + count;
  };
  const straight = run(-1), resumed = run(5);
  check('save at a decision and resume: identical match', straight === resumed, straight + ' vs ' + resumed);
}

/* ── 3. decision stops respect the setting ────────────────────────────────── */
{
  const seen = { ours: new Set(), both: new Set(), key: new Set(), coach: new Set() };
  const count = { ours: 0, both: 0, key: 0, coach: 0 };
  for (const stops of Object.keys(seen)) {
    for (let k = 0; k < 4; k++) {
      play({ home: TEAMS[0], away: TEAMS[2], seed: 500 + k, human: 0, stops, chooser: (dec, m) => {
        seen[stops].add(dec.kind + '/' + dec.team); count[stops]++;
        if (dec.team !== 0) throw new Error('decision for the wrong team');
        return sensible(dec, m);
      } });
    }
  }
  check('Coach: no decisions for the player', count.coach === 0, count.coach + '');
  check('Our ball only: no defense decisions', ![...seen.ours].some(k => k.startsWith('stance')), [...seen.ours].join(' '));
  check('Attack and defense: includes defense decisions', [...seen.both].some(k => k.startsWith('stance')), [...seen.both].join(' '));
  check('Key moments: clearly fewer stops than Our ball only (< 75%)', count.key < count.ours * 0.75, count.key + ' vs ' + count.ours);
  const perMatch = (count.ours / 4).toFixed(1);
  let safe = 0;
  for (let k = 0; k < 4; k++) play({ home: TEAMS[0], away: TEAMS[2], seed: 500 + k, human: 0, stops: 'ours', chooser: d => { safe++; return bestOdds(d); } });
  check('always taking the safest option cannot stall a match (< 120 stops)', safe / 4 < 120, (safe / 4).toFixed(1));
  check('Our ball only: a playable number of stops (8-60 per full match)', count.ours / 4 >= 8 && count.ours / 4 <= 60, perMatch);
}

/* ── 4. choosing well beats choosing badly ────────────────────────────────── */
{
  let good = 0, bad = 0;
  const worst = dec => dec.options.slice().sort((a, b) => a.odds.p - b.odds.p)[0].id;
  for (let k = 0; k < (QUICK ? 10 : 30); k++) {
    const g = play({ home: TEAMS[0], away: TEAMS[3], seed: 7000 + k, human: 0, chooser: bestOdds }).m.s.score;
    const b = play({ home: TEAMS[0], away: TEAMS[3], seed: 7000 + k, human: 0, chooser: worst }).m.s.score;
    good += g[0] - g[1]; bad += b[0] - b[1];
  }
  check('picking good odds beats picking bad odds', good > bad + 5, `goal difference ${good} vs ${bad}`);
}

/* ── 5. overtime always ends ──────────────────────────────────────────────── */
{
  let unresolved = 0, ot = 0;
  for (let k = 0; k < (QUICK ? 10 : 40); k++) {
    const { m } = play({ home: TEAMS[4], away: TEAMS[4], seed: 300 + k, overtime: true, half: 60 });
    if (m.s.period > 2) ot++;
    if (m.s.result.unresolved) unresolved++;
  }
  check('tournament overtime always produces a winner', unresolved === 0, `${ot} went to overtime, ${unresolved} unresolved`);
}

/* ── 6. Quick Game length ─────────────────────────────────────────────────── */
{
  const half = SS.modes.halfLength(SS.modes.rules({ preset: 'quick' }));
  const { m } = play({ home: TEAMS[0], away: TEAMS[1], seed: 5, half, human: 0, chooser: bestOdds });
  check('Quick Game uses short halves', half === RULES.HALF_SHORT && m.done, half + 's halves');
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
