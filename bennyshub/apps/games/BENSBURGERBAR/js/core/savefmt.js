/** Ben's Burger Bar - save format, settings defaults and migrations.
 *
 *  Keys (DESIGN.md "Saves"): bb-settings, bb-progress:<pack>, bb-shift:<pack>. Each holds
 *  { v, kind, pack, packVersion, data }. Older saves are upgraded one version at a time.
 *  A save from a newer version is never overwritten. If the pack changed since the save,
 *  only the shift in progress is dropped; coins and unlocks are kept.
 *
 *  Pure: this builds and reads the records. js/save.js (M1) does the localStorage calls.
 *  Auto Scan, Scan Speed, Parking and the voice belong to the Hub's shared managers and
 *  follow the player into every game, so they are not saved here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.BB = root.BB || {}).savefmt = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  const VERSIONS = { settings: 1, progress: 1, shift: 1 };
  const key = (kind, pack) => (kind === 'settings' ? 'bb-settings' : 'bb-' + kind + ':' + pack.id);

  /** Settings, in the canonical order of DESIGN.md "Settings" (Hub-owned ones left out). */
  const DEFAULT_SETTINGS = {
    tts: true,
    cooking: 'pick',             // pick | timed
    speed: 'verySlow',           // verySlow | slow | normal (Time It Yourself only)
    burning: false,              // Time It Yourself only
    pouring: 'auto',             // auto | hold
    customersAtOnce: 1,          // 1 | 2 | 3
    shiftLength: 5,              // 5 | 3 | 8
    orders: 'usual',             // usual | simple | fancy
    mitch: 'hintsJokes',         // hintsJokes | hints | off
    mistakeWarnings: false,      // say when food does not match its order (opt-in)
    star: false,                 // Next-Step Star
    characterVoices: 'voices',   // voices | captions | off
    theme: 'standard',           // standard | contrast
    motion: 'full',              // full | reduced
    textSize: 'normal',          // normal | large | xlarge
    graphics: 'hub',             // hub | high | standard | low
    sfx: true,
    music: true,
  };
  /** The kitchen's rules from the settings. Burning needs Time It Yourself. */
  const rulesFrom = st => ({
    cooking: st.cooking === 'timed' ? 'timed' : 'pick', speed: st.speed || 'verySlow',
    burning: st.cooking === 'timed' && !!st.burning, pouring: st.pouring === 'hold' ? 'hold' : 'auto',
  });

  /** v -> v + 1 steps, per kind. None yet: version 1 is the first. */
  const MIGRATIONS = { settings: {}, progress: {}, shift: {} };

  function wrap(kind, pack, data) {
    return { v: VERSIONS[kind], kind, pack: pack.id, packVersion: pack.version, data };
  }

  /** Read a stored record. -> { ok, data } or { ok: false, reason, keep }.
   *  keep: true means leave the stored record alone (it is from a newer game). */
  function read(kind, raw, pack) {
    let rec = raw;
    if (typeof raw === 'string') { try { rec = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'corrupt', keep: false }; } }
    if (!rec || typeof rec !== 'object' || rec.data === undefined) return { ok: false, reason: 'missing', keep: false };
    if (rec.kind && rec.kind !== kind) return { ok: false, reason: 'kind', keep: true };
    if (rec.v > VERSIONS[kind]) return { ok: false, reason: 'newer', keep: true };
    let data = JSON.parse(JSON.stringify(rec.data));
    for (let v = rec.v || 1; v < VERSIONS[kind]; v++) data = MIGRATIONS[kind][v](data);
    if (kind === 'settings') return { ok: true, data: Object.assign({}, DEFAULT_SETTINGS, data) };
    if (rec.pack !== pack.id) return { ok: false, reason: 'pack', keep: true };
    if (rec.packVersion !== pack.version) {
      if (kind === 'shift') return { ok: false, reason: 'packVersion', keep: false };
      // Progress survives a pack change: keep coins and whatever still exists.
      const known = new Set([...Object.keys(pack.recipes), ...Object.keys(pack.extras || {}), ...Object.keys(pack.upgrades || {})]);
      data.unlocked = data.unlocked.filter(id => known.has(id));
      data.order = data.order.filter(id => known.has(id));
      return { ok: true, data, upgraded: true };
    }
    return { ok: true, data };
  }

  /** May this record be written over what is stored? Never over a newer save. */
  function canWrite(kind, stored) {
    let rec = stored;
    if (typeof stored === 'string') { try { rec = JSON.parse(stored); } catch (e) { return true; } }
    return !rec || !(rec.v > VERSIONS[kind]);
  }

  return { VERSIONS, key, DEFAULT_SETTINGS, rulesFrom, MIGRATIONS, wrap, read, canWrite };
});
