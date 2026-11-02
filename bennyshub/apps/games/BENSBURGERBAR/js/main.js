/** Ben's Burger Bar - boot: the 3D kitchen, then the main menu. */
(function () {
  'use strict';
  async function boot() {
    BB.ui.init();
    try { await BB.world.init(); } catch (e) { console.error('The 3D kitchen could not start', e); }
    document.getElementById('loading').classList.add('gone');
    BB.ui.openCard('title');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
