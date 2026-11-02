/** Ben's Burger Bar - seeded random numbers.
 *
 *  mulberry32, with the seed kept IN the state object (`s.rng`), so a saved shift
 *  (JSON.stringify) resumes with exactly the same customers and orders, and every Node
 *  test and bot run is repeatable. Nothing in js/core/ calls Math.random.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.BB = root.BB || {}).rng = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  /** A number in [0, 1); advances s.rng. */
  function next(s) {
    let t = (s.rng = (s.rng + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const int = (s, n) => Math.floor(next(s) * n);
  const pick = (s, list) => list[int(s, list.length)];
  const chance = (s, p) => next(s) < p;
  function shuffle(s, list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = int(s, i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }
  /** Pick from [[value, weight], ...]. */
  function weighted(s, pairs) {
    const total = pairs.reduce((k, p) => k + p[1], 0);
    let r = next(s) * total;
    for (const [v, w] of pairs) { if ((r -= w) < 0) return v; }
    return pairs[pairs.length - 1][0];
  }
  const seed = n => (n >>> 0) || 1;

  return { next, int, pick, chance, shuffle, weighted, seed };
});
