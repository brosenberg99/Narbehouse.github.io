/** Ben's Burger Bar - settings in localStorage (bb-settings), through js/core/savefmt.js.
 *
 *  Auto Scan, Scan Speed, the voice and Text to Speech belong to the Hub's shared managers
 *  and follow the player into every game, so they are not kept here. Storage can be
 *  missing or full (private windows); every call copes. The shift in progress and the
 *  diner's progress are saved from M2 (DESIGN.md "Saves").
 */
(function () {
  'use strict';
  const F = BB.savefmt, pack = BBPacks.diner;

  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, value) { try { localStorage.setItem(key, value); return true; } catch (e) { return false; } }

  const KEY = F.key('settings', pack);
  const got = F.read('settings', read(KEY), pack);
  // A save from a newer version of the game is read as defaults and never written over.
  const locked = !got.ok && got.keep;
  let settings = got.ok ? got.data : Object.assign({}, F.DEFAULT_SETTINGS);
  const listeners = [];

  function store() {
    if (locked || !F.canWrite('settings', read(KEY))) return;
    write(KEY, JSON.stringify(F.wrap('settings', pack, settings)));
  }

  BB.save = {
    get: k => (settings[k] === undefined ? F.DEFAULT_SETTINGS[k] : settings[k]),
    set(k, v) {
      settings[k] = v; store();
      listeners.forEach(fn => { try { fn(k, v); } catch (e) { console.error(e); } });
    },
    all: () => Object.assign({}, settings),
    onChange(fn) { listeners.push(fn); },
    /** Back to the defaults (the tests use this; Reset Progress arrives with progress, M5). */
    reset() {
      settings = Object.assign({}, F.DEFAULT_SETTINGS); store();
      listeners.forEach(fn => { try { fn('*'); } catch (e) { console.error(e); } });
    },
  };
})();
