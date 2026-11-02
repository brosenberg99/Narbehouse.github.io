#!/usr/bin/env node
/* Ben's Burger Bar - the real game in headless Chrome, driven by real key events.
 * No npm dependencies (Sphere Splash's tools/check-browser.cjs pattern: spawn Chrome, talk CDP).
 *
 *   node bennyshub/apps/games/BENSBURGERBAR/tools/check-browser.cjs [path-to-chrome] [--quick]
 *
 * What it proves (DESIGN.md M1 "Done when"):
 *  - the page boots with no exceptions and opens the main menu on the blank -1;
 *  - every card fits with no scrolling at 1920x1008, 1368x840 and 1024x768;
 *  - Space and Enter act on release; Enter on the blank does nothing; holding Space
 *    scans backwards; a row loops through its Back stop, and Back lands on the row;
 *  - two switches: a whole first order is made and served with real key presses, and the
 *    number of selects matches what the planner bot counts for the same order;
 *  - holding Enter for 5 seconds at a station opens Pause, and Continue comes back;
 *  - one switch (Auto Scan on, 1 s): Enter alone makes and serves an order;
 *  - Exit Game asks first, with Cancel first.
 * --quick skips the one-switch order (it takes a few minutes at 1 s a step).
 * Screenshots go to the system temp folder, never into this served folder.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '../../../..');          // bennyshub/
const out = path.join(os.tmpdir(), 'burger-bar-review');
const GAME = '/apps/games/BENSBURGERBAR/index.html';
const QUICK = process.argv.includes('--quick');
const wait = ms => new Promise(r => setTimeout(r, ms));
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
});

let fails = 0;
const check = (name, ok, detail) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  - ' + detail : '')); if (!ok) fails++; };

function findChrome() {
  const arg = process.argv.slice(2).find(a => !a.startsWith('--'));
  const list = [arg, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return list.find(p => p && fs.existsSync(p));
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'burger-bar-chrome-'));
  const exe = findChrome();
  if (!exe) { console.error('No Chrome or Edge found. Pass the path: node tools/check-browser.cjs <chrome.exe>'); process.exit(2); }
  const chrome = spawn(exe, ['--headless=new', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1368,840', '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) await wait(100);
  const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(), exceptions = [];
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails.exception ? msg.params.exceptionDetails.exception.description : msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') exceptions.push(msg.params.args.map(a => a.value || a.description).join(' '));
    if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
  };
  const call = (method, params = {}) => new Promise((res, rej) => { pending.set(++id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expr => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(expr.slice(0, 80) + ': ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    return r.result.value;
  };
  const until = async (expr, timeout = 30000) => {
    for (let t = 0; t < timeout; t += 100) { if (await evaluate(expr)) return true; await wait(100); }
    throw Error('Timed out waiting for: ' + expr);
  };
  const shot = async name => { const s = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name), Buffer.from(s.data, 'base64')); };
  const size = (w, h) => call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const KEYS = { Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 },
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 } };
  const keyDown = k => call('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, KEYS[k]));
  const keyUp = k => call('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, KEYS[k]));
  // The hub's input guard drops presses closer together than Input Sensitivity (100 ms by default).
  const press = async (k, hold = 80, after = 220) => { await keyDown(k); await wait(hold); await keyUp(k); await wait(after); };
  const ui = () => evaluate('BB.ui.__dbg()');
  const load = async () => {
    await call('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + GAME });
    await until('!!(window.BB && BB.ui && BB.ui.context === "card")', 60000);
    await wait(300);
  };

  /** The next action the planner bot would take, as the ids leading to its leaf. */
  const nextPath = () => evaluate(`(() => { const k = BB.game.kitchen(); const a = BB.planner.next(k);
    if (!a || a.wait) return null; const L = BB.menus.find(BB.game.tree(), a); return L ? L.ids : 'noroute:' + JSON.stringify(a); })()`);
  /** Two switches: Space until the id is lit, then Enter. Leaves rows by their Back stop. */
  let selects = 0, moves = 0;
  async function goSelect(want, auto) {
    // One switch waits for the scan to come round: up to a full lap of the longest root at 1 s.
    for (let n = 0; n < (auto ? 300 : 60); n++) {
      if ((await ui()).id === want) break;
      if (auto) await wait(100); else { await press('Space'); moves++; }
    }
    const u = await ui();
    if (u.id !== want) throw Error('Could not reach ' + want + ' (at ' + u.id + ' in ' + u.items.join(',') + ')');
    await press('Enter'); selects++;
  }
  const shots = {};
  /** Two switches: Space until the id is lit (no select). */
  async function goTo(want) { for (let n = 0; n < 60 && (await ui()).id !== want; n++) { await press('Space'); moves++; } }
  async function playAction(auto) {
    const ids = await nextPath();
    if (ids === null) return false;
    if (typeof ids === 'string') throw Error(ids);
    // Leave any open rows that are not on the way.
    for (let g = 0; g < 6; g++) {
      const u = await ui();
      const ok = u.rows.every((r, i) => ids[i] === r);
      if (ok) break;
      await goSelect('narbe:row-back', auto);
    }
    const u = await ui();
    const tail = ids.slice(u.rows.length);
    for (let i = 0; i < tail.length; i++) {
      // Pictures of the grill and the board, the first time each is in use.
      if (i === tail.length - 1 && !auto && /^verb:(flip|send:counter)$/.test(tail[i]) && !shots[tail[i]]) { shots[tail[i]] = 1; await goTo(tail[i]); await shot(tail[i] === 'verb:flip' ? 'grill.png' : 'board.png'); }
      await goSelect(tail[i], auto);
    }
    if (process.env.BB_TRACE) console.log('       ' + ids.join('>') + ' ' + (selects - (playAction.last || 0)));
    playAction.last = selects;
    await wait(150);
    return true;
  }
  /** Play the current order through to its serve. */
  async function playOrder(auto) {
    for (let n = 0; n < 80; n++) {
      if ((await ui()).ctx !== 'station') return true;
      if (!(await playAction(auto))) return false;
    }
    return false;
  }

  try {
    await call('Runtime.enable'); await call('Page.enable');
    // Silent while it runs; the system voice keeps its timing.
    await call('Page.addScriptToEvaluateOnNewDocument', { source: '(() => { const s = window.speechSynthesis; if (!s) return; const f = s.speak.bind(s); s.speak = u => { u.volume = 0; return f(u); }; })()' });
    await size(1368, 840);
    await load();
    await evaluate('localStorage.clear(); true');
    await load();
    let u = await ui();
    check('boots to the main menu', u.ctx === 'card' && u.card === 'title', u.card);
    check('the main menu opens on the blank -1', u.index === -1, String(u.index));
    await shot('title.png');

    /* ── every card fits ───────────────────────────────────────────── */
    const fits = [];
    for (const [w, h] of [[1920, 1008], [1368, 840], [1024, 768]]) {
      await size(w, h); await wait(200);
      const bad = await evaluate(`(async () => {
        const bad = [];
        const fit = n => { const c = document.querySelector('.card'); if (!c) { bad.push(n + '?'); return; } const r = c.getBoundingClientRect();
          if (r.top < -1 || r.bottom > innerHeight + 1 || c.scrollHeight > c.clientHeight + 2) bad.push(n); };
        for (const [n, o] of [['title', {}], ['settings', {}], ['confirm', { title: 'Exit the game?', warn: 'You will go back to the hub.', yes: 'Exit Game' }],
          ['served', { name: 'Marge', stars: 3, tip: 9, line: 'Now that is a burger.' }], ['results', { orders: 5, coins: 40, stars: [3, 2, 3, 1, 3] }]]) {
          BB.ui.openCard(n, o); await new Promise(r => setTimeout(r, 60)); fit(n);
        }
        BB.ui.openCard('title');
        return bad;
      })()`);
      fits.push(w + 'x' + h + (bad.length ? ': ' + bad.join(',') : ': ok'));
    }
    check('every card fits at 1920x1008, 1368x840, 1024x768', fits.every(f => f.endsWith('ok')), fits.join(' · '));
    await size(1368, 840); await wait(300);

    /* ── the scan contract on the main menu ───────────────────────── */
    await press('Enter'); u = await ui();
    check('Enter on the blank does nothing', u.card === 'title' && u.index === -1);
    await keyDown('Space'); await wait(400); u = await ui();
    check('Space does nothing until it is released', u.index === -1);
    await keyUp('Space'); await wait(250); u = await ui();
    check('Space (released) lights the first item', u.id === 'start', u.id);
    await press('Space'); await press('Space'); await press('Space'); u = await ui();
    check('the root loops through the blank -1', u.index === -1, String(u.index));
    await keyDown('Space'); await wait(3300); await keyUp('Space'); await wait(250); u = await ui();
    check('holding Space scans backwards (blank -> last item)', u.id === 'exit', u.id);
    await press('Enter'); u = await ui();
    check('Exit Game asks first, with nothing lit', u.card === 'confirm' && u.index === -1);
    await press('Space'); u = await ui();
    check('the safe choice (Cancel) comes first', u.id === 'cancel', u.id);
    await press('Enter'); u = await ui();
    check('Cancel goes back with Exit Game lit', u.card === 'title' && u.id === 'exit', u.card + '/' + u.id);

    /* ── two switches: a whole order ──────────────────────────────── */
    await evaluate('BB.game.seed(7); true');
    await goSelect('start');
    u = await ui();
    check('Start Shift opens the counter on the blank -1', u.ctx === 'station' && u.index === -1 && u.rows.length === 0, u.ctx + '/' + u.index);
    await shot('counter.png');
    // What the planner bot counts for this same order, from this same kitchen.
    const expected = await evaluate(`(() => { const k = JSON.parse(JSON.stringify(BB.game.kitchen())); const r = BB.planner.run(BB.planner.kitchenDriver(k), { until: s => !s.tickets.length });
      return { choices: r.choices, steps: r.steps, noRoute: !!r.noRoute }; })()`);
    const order = await evaluate('BB.words.ticket(BBPacks.diner, BB.game.ticket())');

    // A row: enter the Go To row, loop through it to its Back stop, and Back lands on Go To.
    await goSelect('go');
    u = await ui();
    check('a row opens on its first item', u.depth === 1 && u.index === 0, u.id);
    const rowLen = u.items.length;              // its items; the Back stop comes after them
    for (let i = 0; i < rowLen; i++) await press('Space');
    u = await ui();
    check('a row ends with its Back stop (no Back plate of its own)', u.id === 'narbe:row-back' && !(await evaluate('[...document.querySelectorAll(".plate")].some(p => p.offsetParent && /^Back$/.test(p.textContent.trim()))')), u.id);
    await press('Space'); u = await ui();
    check('the row loops past its Back stop to its first item', u.depth === 1 && u.index === 0, u.id);
    for (let i = 0; i < rowLen; i++) await press('Space');
    await press('Enter'); u = await ui();
    check('Back returns to the row it opened, with Go To lit', u.depth === 0 && u.id === 'go', u.id + ' depth ' + u.depth);
    // Start the count from the blank, as the bot does.
    for (let g = 0; g < 20 && (await ui()).index !== -1; g++) await press('Space');
    selects = 0; moves = 0; playAction.last = 0;
    const done = await playOrder(false);
    u = await ui();
    check('two switches: the first order is made and served with real keys', done && u.card === 'served', order + ' -> ' + u.card);
    check('real selects match the planner bot\'s count', selects === expected.choices, selects + ' pressed, bot ' + expected.choices + (expected.noRoute ? ' (bot had no route)' : ''));
    console.log('       order: ' + order + ' · ' + selects + ' selects, ' + moves + ' Space moves');
    await shot('served.png');
    const stars = await evaluate('BB.game.shift().served[0].stars');
    check('the planner\'s burger earns 3 stars', stars === 3, String(stars));

    /* ── hold Enter at a station opens Pause ──────────────────────── */
    await goSelect('next');
    u = await ui();
    check('Next Customer opens the counter on the blank', u.ctx === 'station' && u.index === -1);
    await keyDown('Enter'); await wait(2600);
    const ring = await evaluate('document.getElementById("holdRing").classList.contains("on")');
    await wait(2700); u = await ui();
    check('holding Enter shows the ring, then opens Pause', ring && u.card === 'pause', 'ring ' + ring + ', ' + u.card);
    await keyUp('Enter'); await wait(250); u = await ui();
    check('the hold\'s release chooses nothing on Pause', u.card === 'pause' && u.index === -1, u.card + '/' + u.index);
    await goSelect('continue');
    u = await ui();
    check('Continue returns to the station', u.ctx === 'station', u.ctx);

    /* ── one switch: Enter alone ──────────────────────────────────── */
    if (!QUICK) {
      await evaluate('NarbeScanManager.setScanSpeedIndex(0); NarbeScanManager.setAutoScan(true); true');
      await wait(300);
      const before = await evaluate('BB.game.shift().served.length');
      const order1 = await evaluate('BB.words.ticket(BBPacks.diner, BB.game.ticket())');
      const t0 = Date.now(); selects = 0;
      const ok = await playOrder(true);
      console.log('       one switch at 1 s: ' + order1 + ' · ' + selects + ' selects in ' + Math.round((Date.now() - t0) / 1000) + ' s');
      u = await ui();
      const after = await evaluate('(BB.game.shift() || { served: [] }).served.length');
      check('one switch: Auto Scan + Enter alone serves an order', ok && after === before + 1 && u.card === 'served', before + ' -> ' + after);
      await evaluate('NarbeScanManager.setAutoScan(false); true');
    }

    check('no exceptions or console errors', !exceptions.length, exceptions.slice(0, 3).join(' | '));
  } catch (e) {
    console.error(e); fails++;
    try { await shot('failure.png'); } catch (x) { /* ignore */ }
  } finally {
    console.log(fails ? fails + ' FAILED' : 'all passed', '- screenshots in', out);
    ws.close(); chrome.kill(); server.close();
    process.exit(fails ? 1 : 0);
  }
})();
