#!/usr/bin/env node
/* Benny's Sphere Splash - the real game in headless Chrome, driven by real key events.
 * No npm dependencies (Baseball's art/check_browser.js pattern: spawn Chrome, talk CDP).
 *
 *   node tools/check-browser.cjs [path-to-chrome]
 *
 * What it proves (plan §9):
 *  - the page boots with no exceptions, and every card fits with no scrolling at
 *    1920x1008, 1368x840 and 1024x768;
 *  - at every decision the clock and every swimmer stay frozen, and every plate of the
 *    choice cluster is wholly on screen and overlaps no other plate;
 *  - Space/Enter menus fire on release; hold Space scans backwards; a tap in live play
 *    opens the Huddle; holding Enter shows the ring and then opens Pause, and its
 *    release is swallowed; Pause from a decision comes back to the same choice;
 *  - with Auto Scan on, Enter alone gets from the main menu through a match's decisions;
 *  - commentary is never spoken while a choice is on screen, and every line is captioned;
 *  - a match saved mid-play resumes at exactly the same moment after a reload;
 *  - a whole Quick Game plays to the results card, and every goal in it gets its
 *    moment (the banner, the scorer celebrating, the replay) and play goes on after it;
 *  - a real press during a goal replay skips it and opens no Huddle; so does one
 *    during the kickoff sweep.
 * Screenshots go to the system temp folder, never into this served folder.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '../../../..');          // bennyshub/
const out = path.join(os.tmpdir(), 'sphere-splash-review');
const GAME = '/apps/games/BENNYSSPHERESPLASH/index.html';
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-splash-chrome-'));
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
  const press = async (k, hold = 90, after = 320) => { await keyDown(k); await wait(hold); await keyUp(k); await wait(after); };
  const ui = () => evaluate('(() => { const d = SS.ui.__dbg(); return { ctx: d.ctx, screen: d.screen, index: d.index, row: d.rows[d.index] || "" }; })()');
  const load = async () => {
    await call('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + GAME });
    await until('!!(window.SS && SS.ui && SS.ui.screen === "title")', 60000);
    // Record every commentary line the system voice is asked to say, and what was on screen.
    await evaluate(`window.__said = JSON.parse(sessionStorage.getItem('__said') || '[]'); addEventListener('pagehide', () => sessionStorage.setItem('__said', JSON.stringify(__said))); (() => { const f = SS.util.speakAs; SS.util.speakAs = function (t, o) { __said.push({ t, ctx: SS.ui.context() }); return f.apply(this, arguments); }; })(); true`);
  };

  try {
    await call('Runtime.enable'); await call('Page.enable');
    // Silent while it runs: --mute-audio covers game sound, and the system voice speaks at volume 0
    // (same timing, so the speech checks still hold).
    await call('Page.addScriptToEvaluateOnNewDocument', { source: '(() => { const s = window.speechSynthesis; if (!s) return; const f = s.speak.bind(s); s.speak = u => { u.volume = 0; return f(u); }; })()' });
    await size(1368, 840);
    await load();
    await evaluate('localStorage.clear(); SS.save.resetAll(); true');
    await load();
    check('boots to the main menu', (await ui()).screen === 'title');
    check('main menu starts with nothing highlighted', (await ui()).index === -1);

    /* ── every card fits, at every size ───────────────────────────────── */
    const fitsAll = [];
    for (const [w, h] of [[1920, 1008], [1368, 840], [1024, 768]]) {
      await size(w, h); await wait(250);
      const bad = await evaluate(`(async () => {
        const bad = [], screens = ['title', 'quick', 'settings', 'howto', 'pickTeam'];
        const fit = n => { const r = document.getElementById('card').getBoundingClientRect(); if (r.top < -1 || r.bottom > innerHeight + 1 || r.left < -1 || r.right > innerWidth + 1) bad.push(n); };
        for (const s of screens) { SS.ui.setScreen(s, { page: 0, side: 0 }); await new Promise(r => setTimeout(r, 60)); fit(s); }
        for (const p of [1, 2]) { SS.ui.setScreen('howto', { page: p }); await new Promise(r => setTimeout(r, 60)); fit('howto' + p); }
        SS.game.startQuick(['beamers', 'harbor']);
        for (const s of ['kickoff', 'huddle', 'formation', 'pause', 'confirmRestart', 'confirmExit', 'halftime', 'results']) { SS.ui.setScreen(s, {}); await new Promise(r => setTimeout(r, 60)); fit(s); }
        SS.game.quitToMenu();
        return bad;
      })()`);
      fitsAll.push(w + 'x' + h + (bad.length ? ': ' + bad.join(',') : ': ok'));
    }
    check('every card fits on screen at 1920x1008, 1368x840, 1024x768', !fitsAll.some(s => !s.endsWith('ok')), fitsAll.join(' · '));
    await evaluate('SS.save.clearMatch(); SS.game.quitToMenu(); true');
    await size(1368, 840); await wait(200);


    /* ── two switches, real keys, from the menu into a match ───────────── */
    await press('Space'); let u = await ui();
    check('Space (released) highlights the first item', u.screen === 'title' && u.row.startsWith('Quick Game'), u.row);
    await press('Enter'); u = await ui();
    check('Enter (released) chooses it', u.screen === 'quick', u.screen);
    await keyDown('Space'); await wait(3400); await keyUp('Space'); await wait(300); u = await ui();
    check('holding Space scans backwards', u.index === 2 && u.row === 'Back', u.row);
    await press('Space'); await press('Space'); u = await ui();
    check('the list wraps through a blank step', u.row.startsWith('Start'), u.row);
    await press('Enter'); u = await ui();
    check('Start opens the kickoff card, Kick Off already lit', u.screen === 'kickoff' && u.index === 0, u.screen + '/' + u.index);
    await evaluate('SS.save.settings.set("speed", "fast"); true');
    await press('Enter'); u = await ui();
    check('Kick Off starts live play, with the kickoff sweep', u.ctx === 'live' && await evaluate('!!SS.game.intro && SS.director.mode === "intro"'), u.ctx);

    let decisions = 0, frozeOk = 0, auditBad = [], kinds = {};
    for (let n = 0; n < 8; n++) {
      await until('SS.ui.context() === "world" || SS.ui.screen === "halftime" || SS.ui.screen === "results"', 90000);
      if ((await ui()).ctx !== 'world') { await evaluate('SS.ui.screen === "halftime" && SS.game.startSecondHalf(); true'); continue; }
      decisions++;
      await wait(600);
      const a = await evaluate(`(() => { const m = SS.game.match.s; return { clock: m.clock, pos: SS.game.swimmers.map(s => s.group.position.toArray().map(v => +v.toFixed(3)).join(',')).join('|'), kind: m.pending.kind }; })()`);
      await wait(700);
      const b = await evaluate(`(() => { const m = SS.game.match.s; return { clock: m.clock, pos: SS.game.swimmers.map(s => s.group.position.toArray().map(v => +v.toFixed(3)).join(',')).join('|') }; })()`);
      if (a.clock === b.clock && a.pos === b.pos) frozeOk++;
      kinds[a.kind] = (kinds[a.kind] || 0) + 1;
      const bad = await evaluate(`(() => {
        const W = innerWidth, H = innerHeight, bad = [];
        const els = [...document.querySelectorAll('.cluster .plate, .cluster .head')].map(e => e.getBoundingClientRect());
        if (!els.length) bad.push('no plates');
        els.forEach(r => { if (r.left < 0 || r.top < 0 || r.right > W || r.bottom > H) bad.push('off screen'); });
        for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) { const p = els[i], q = els[j];
          if (p.left < q.right - 1 && q.left < p.right - 1 && p.top < q.bottom - 1 && q.top < p.bottom - 1) bad.push('overlap'); }
        return bad;
      })()`);
      if (bad.length) auditBad.push(a.kind + ':' + bad.join(','));
      if (n === 0) await shot('decision.png');
      await press('Space'); await press('Enter');
      if ((await ui()).ctx === 'world') { if (n === 1) await shot('second-stage.png'); await press('Space'); await press('Enter'); }
    }
    const stopsNow = await evaluate('SS.game.match.s.stops + "/" + SS.save.settings.get("stops")');
    check('decisions came up in play', decisions >= 4, decisions + ' ' + JSON.stringify(kinds) + ' stops ' + stopsNow);
    check('clock and every swimmer frozen at every decision', frozeOk === decisions, frozeOk + '/' + decisions);
    check('every plate on screen, none overlapping', auditBad.length === 0, auditBad.join(' '));

    /* ── Huddle and Pause (Coach: nothing else interrupts) ──────────────── */
    await evaluate('SS.save.settings.set("stops", "coach"); SS.game.startQuick(["reef", "gliders"]); SS.game.kickoff(); true');
    await wait(800);
    await press('Space'); u = await ui();
    const swept = await evaluate('JSON.stringify({ intro: !!SS.game.intro, cam: SS.director.mode })');
    check('a press during the kickoff sweep skips it, and opens nothing', u.ctx === 'live' && !u.screen && /"intro":false/.test(swept) && /broadcast/.test(swept), u.ctx + ' ' + swept);
    await press('Space'); u = await ui();
    check('a tap in live play opens the Huddle, Continue lit', u.screen === 'huddle' && u.row === 'Continue', u.screen + '/' + u.row);
    await press('Enter'); u = await ui();
    check('Continue goes back to live play', u.ctx === 'live', u.ctx);
    await wait(500);
    await keyDown('Enter'); await wait(3300);
    const ring = await evaluate('document.querySelector(".ring").classList.contains("on")');
    check('holding Enter shows the keep-holding ring', ring);
    await wait(2200); u = await ui();
    check('holding Enter long enough opens Pause', u.screen === 'pause', u.screen);
    const c1 = await evaluate('SS.game.match.s.clock'); await wait(600);
    check('the clock stops under Pause', c1 === await evaluate('SS.game.match.s.clock'));
    await keyUp('Enter'); await wait(300); u = await ui();
    check('the release that opened Pause is swallowed', u.screen === 'pause' && u.index === -1, u.screen + '/' + u.index);
    await press('Space'); await press('Enter'); u = await ui();
    check('Pause > Continue resumes play', u.ctx === 'live', u.ctx);
    await keyDown('Enter'); await wait(4000); await keyUp('Enter'); await wait(300); u = await ui();
    check('a slow 4 s press is an ordinary press (Huddle, not Pause)', u.screen === 'huddle', u.screen);
    await press('Enter');

    /* ── Pause from inside a decision comes back to the same choice ────── */
    await evaluate('SS.save.settings.set("stops", "ours"); SS.game.startQuick(["beamers", "reef"]); SS.game.kickoff(); true');
    await until('SS.ui.context() === "world"', 90000);
    await press('Space'); const before = await ui();
    await keyDown('Enter'); await wait(5400); await keyUp('Enter'); await wait(300);
    check('holding Enter during a decision opens Pause', (await ui()).screen === 'pause');
    await press('Space'); await press('Enter'); u = await ui();
    check('Continue returns to the same choice, same item lit', u.ctx === 'world' && u.row === before.row, before.row + ' -> ' + u.row);
    // ...with its plates drawn, not just its items in the list (Bryan: they vanished).
    const platesNow = () => evaluate('(() => { const r = document.querySelector(".cluster .row"); return r ? [...r.querySelectorAll(".plate")].filter(p => p.getBoundingClientRect().width > 0).length : 0; })()');
    const wantPlates = await evaluate('SS.ui.__dbg().rows.length') - 1;          // every item but Pause
    let got = await platesNow();
    check('after Pause > Continue every plate is back on screen', got > 0 && got === wantPlates, got + ' of ' + wantPlates);
    // Pause > Settings > change one > Back > Continue: the same.
    await keyDown('Enter'); await wait(5400); await keyUp('Enter'); await wait(300);
    const toRow = async (label) => { for (let i = 0; i < 20; i++) { if ((await ui()).row.startsWith(label)) return; await press('Space'); } throw Error('never reached ' + label); };
    await toRow('Settings'); await press('Enter');
    await toRow('Difficulty'); await press('Enter');
    await toRow('Back'); await press('Enter');
    await toRow('Continue'); await press('Enter');
    got = await platesNow();
    check('after Pause > Settings > Back > Continue every plate is back', (await ui()).ctx === 'world' && got === wantPlates, got + ' of ' + wantPlates);

    /* ── save mid-play, reload, Continue: exactly the same moment ─────── */
    await evaluate('SS.game.choose(SS.game.match.pending.options[0].id); true');
    await wait(1500);
    const snap = await evaluate('SS.game.saveNow(); JSON.stringify({ c: SS.game.match.s.clock, s: SS.game.match.s.score, o: SS.game.match.s.ball.owner, p: SS.game.match.s.players.map(p => p.hp.toFixed(3)).join(), pend: SS.game.match.pending && SS.game.match.pending.seq })');
    await load();
    u = await ui();
    check('Continue is offered after a reload', (await evaluate('SS.ui.__dbg().rows[0]')).startsWith('Continue'));
    await press('Space'); await press('Enter');
    const back = await evaluate('JSON.stringify({ c: SS.game.match.s.clock, s: SS.game.match.s.score, o: SS.game.match.s.ball.owner, p: SS.game.match.s.players.map(p => p.hp.toFixed(3)).join(), pend: SS.game.match.pending && SS.game.match.pending.seq })');
    check('the saved match resumes at exactly the same moment', snap === back);

    /* ── a goal replay: a real press skips it, and opens nothing ──────── */
    await evaluate("SS.save.clearMatch(); SS.save.settings.set('stops', 'ours'); SS.save.settings.set('difficulty', 'easy'); SS.game.startQuick(['reef', 'beamers']); SS.game.kickoff(); true");
    await until(`(() => {
      const p = SS.game.match.pending;
      if (p && SS.ui.context() === 'world') { const sh = p.options.find(o => o.kind === 'shoot' && !o.tech); SS.game.choose((sh || p.options[0]).id); }
      const g = SS.game.goalMoment;
      return !!(g && g.replay && g.replay.on && g.replay.rt - g.replay.from > 0.5);
    })()`, 300000);
    await shot('replay.png');
    await press('Space');
    await until('!SS.game.goalMoment', 3000).catch(() => {});
    const afterSkip = await evaluate('JSON.stringify({ gm: !!SS.game.goalMoment, screen: SS.ui.screen, ctx: SS.ui.context(), cam: SS.director.mode })');
    check('a press during a goal replay skips it, and opens nothing', /"gm":false/.test(afterSkip) && /"ctx":"live"/.test(afterSkip) && !/huddle/.test(afterSkip), afterSkip);
    await evaluate("SS.save.settings.set('difficulty', 'normal'); SS.save.settings.set('stops', 'both'); true");

    /* ── one switch: Auto Scan on, Enter only ───────────────────────── */
    await evaluate('(() => { const s = NarbeScanManager; if (!s.getSettings().autoScan) s.toggleAutoScan(); while (s.getScanInterval() !== 1000) s.cycleScanSpeed(); SS.save.clearMatch(); SS.game.quitToMenu(); })(); true');
    const litEnter = async (label) => { await until(`(SS.ui.__dbg().rows[SS.ui.__dbg().index] || "").startsWith(${JSON.stringify(label)})`, 20000); await press('Enter'); };
    await litEnter('Quick Game'); await litEnter('Start'); await press('Enter');
    let oneSwitch = 0;
    for (let n = 0; n < 4; n++) {
      await until('SS.ui.context() === "world" || SS.ui.screen === "halftime"', 90000);
      if ((await ui()).ctx !== 'world') { await litEnter('Start the second half'); continue; }
      await until('SS.ui.__dbg().index >= 0', 8000); await press('Enter');
      if ((await ui()).ctx === 'world') { await until('SS.ui.__dbg().index >= 0', 8000); await press('Enter'); }
      oneSwitch++;
    }
    check('with Auto Scan on, Enter alone plays through menus and decisions', oneSwitch === 4, oneSwitch + ' decisions');
    await evaluate('(() => { const s = NarbeScanManager; if (s.getSettings().autoScan) s.toggleAutoScan(); while (s.getScanInterval() !== 2000) s.cycleScanSpeed(); })(); true');

    /* ── a whole Quick Game to the results card, at 1024x768 ──────────── */
    await size(1024, 768);
    await evaluate('SS.game.startQuick(["summit", "mistwood"]); SS.game.kickoff(); true');
    await evaluate('window.__goals = { seen: 0, celebrated: 0, banner: 0, replayed: 0 }; true');
    await until(`(() => {
      // Every goal gets its moment: the banner, the scorer celebrating, and then the cut.
      const g = SS.game.goalMoment;
      if (g && !g.__seen) { g.__seen = 1; __goals.seen++; }
      if (g && g.started && !g.__cel) { g.__cel = 1; __goals.celebrated++; }
      if (g && !g.__ban && document.querySelector('#hud .goalbanner.on')) { g.__ban = 1; __goals.banner++; }
      if (g && g.replay && g.replay.on && !g.__rep) { g.__rep = 1; __goals.replayed++; }
      if (SS.ui.screen === 'halftime') SS.game.startSecondHalf();
      const p = SS.game.match && SS.game.match.pending;
      if (p && SS.ui.context() === 'world') SS.game.choose(p.options.slice().sort((a, b) => b.odds.p - a.odds.p)[0].id);
      return SS.ui.screen === 'results';
    })()`, 400000);
    await shot('results.png');
    check('a whole Quick Game plays to the results card', (await ui()).screen === 'results');
    const gl = await evaluate('JSON.stringify(Object.assign({ score: SS.game.matchInfo().score }, __goals))'), gv = JSON.parse(gl);
    const total = gv.score[0] + gv.score[1];
    check('every goal gets its moment: banner, celebration, replay, then play goes on', total > 0 && gv.seen === total && gv.celebrated === total && gv.banner === total && gv.replayed === total, gl);

    const said = await evaluate('JSON.stringify({ n: __said.length, bad: __said.filter(s => s.ctx !== "live").length, hist: SS.broadcast.history.length })');
    const sv = JSON.parse(said);
    check('commentary is never spoken while a choice or menu is up', sv.bad === 0, sv.n + ' lines spoken, ' + sv.bad + ' over a choice');
    check('every commentary line reached the caption', sv.hist >= sv.n, sv.hist + ' captioned');
    check('no exceptions', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));
  } catch (err) {
    console.error(err); fails++;
  } finally {
    console.log('\nScreenshots: ' + out);
    console.log(fails ? fails + ' check(s) failed' : 'All checks passed');
    try { ws.close(); } catch (e) { /* ignore */ }
    chrome.kill(); server.close();
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Chrome may still hold it */ } process.exit(fails ? 1 : 0); }, 600);
  }
})();
