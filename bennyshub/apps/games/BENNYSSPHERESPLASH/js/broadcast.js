/** Benny's Sphere Splash - the broadcast: an announcer, a play-by-play caller and an
 *  analyst, as captions from day one and live speech when the Commentary setting
 *  allows it. Recorded voices are a later, optional layer that slots in here with no
 *  game changes: a line whose id is listed in audio/vo/index.json plays that clip
 *  instead of the system voice.
 *
 *  say(family, slots, priority) picks a line from js/voice-lines.generated.js:
 *   - a no-repeat shuffle per family, so the same words never come twice running;
 *   - a cooldown per speaker, so the caller never drones (ACCESSIBILITY.md: keep
 *     speech short), and a low-priority line is simply dropped inside it;
 *   - the interface always wins. Commentary speaks only into silence, only during
 *     live play, and never within a moment of a menu or decision line. A decision
 *     opening cuts it off (the voice manager cancels on every interface line).
 *  Every line spoken is also captioned, with the speaker's name - never colour alone.
 */
SS.broadcast = (function () {
  'use strict';

  const U = SS.util;
  const COOLDOWN = { pa: 0, pbp: 2.4, color: 9 };   // seconds between lines, per speaker
  const PRI_OVERRIDE = 3;                           // this priority ignores the cooldown
  const CAPTION_MS = 3400;

  const bags = {}, lastAt = { pa: -99, pbp: -99, color: -99 };
  let voIndex = null, clip = null, captionTimer = null, history = [];

  function lines() { return (SS.VOICE_LINES && SS.VOICE_LINES.families) || {}; }
  function speakers() { return (SS.VOICE_LINES && SS.VOICE_LINES.speakers) || {}; }
  function mode() { return SS.save.settings.get('commentary') || 'full'; }

  function loadIndex() {
    if (voIndex !== null) return;
    voIndex = {};
    try {
      const req = new XMLHttpRequest();
      req.open('GET', 'audio/vo/index.json', true);
      req.onload = () => {
        if (req.status >= 200 && req.status < 300) {
          try { const d = JSON.parse(req.responseText); voIndex = (d && d.lines) || {}; } catch (e) { /* no manifest */ }
        }
      };
      req.send();
    } catch (e) { /* file:// with no server: captions and the system voice */ }
  }

  function pick(family) {
    const list = lines()[family];
    if (!list || !list.length) return null;
    let bag = bags[family];
    if (!bag || !bag.length) {
      bag = bags[family] = U.shuffle(list.map((_, i) => i));
      // never the line that just played, even across a reshuffle
      if (bag.length > 1 && bag[bag.length - 1] === bags[family + ':last']) bag.unshift(bag.pop());
    }
    const i = bag.pop();
    bags[family + ':last'] = i;
    return list[i];
  }
  function fill(text, slots) {
    return text.replace(/\{(\w+)\}/g, (m, k) => (slots && slots[k] != null ? slots[k] : ''))
      .replace(/\s+([.,!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  }

  /* Lines queue, so a goal call, the score and the analyst's reaction are all heard in
     turn: every system-voice line cancels the one before it, so firing them together
     would leave only the last. Chatter never waits in line - it is about a moment
     that will have passed. */
  const queue = [];
  let pumpTimer = null, busyUntil = 0;

  /** @param priority 1 chatter, 2 a real moment, 3 must be said (goals, periods) */
  function say(family, slots, priority) {
    const m = mode();
    if (m === 'off') return null;
    const pri = priority || 1, now = performance.now() / 1000;
    const peek = lines()[family];
    if (!peek || !peek.length) return null;
    if (pri < PRI_OVERRIDE && queue.length) return null;
    const line = pick(family);
    if (pri < PRI_OVERRIDE && now - lastAt[line.speaker] < COOLDOWN[line.speaker]) return null;
    lastAt[line.speaker] = now;
    const text = fill(line.text, slots);
    history.push({ id: line.id, speaker: line.speaker, family, text, at: now });
    if (history.length > 80) history.shift();
    queue.push({ line, text, pri, family });
    while (queue.length > 4) queue.splice(queue.findIndex(q => q.pri < PRI_OVERRIDE) >= 0 ? queue.findIndex(q => q.pri < PRI_OVERRIDE) : 0, 1);
    pump();
    return text;
  }
  function pump() {
    if (pumpTimer || !queue.length) return;
    const now = performance.now(), talking = U.speaking() || (clip && !clip.paused && !clip.ended);
    if (now < busyUntil || (talking && now < busyUntil + 4000)) { pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, 150); return; }
    const q = queue.shift(), m = mode();
    caption(q.line.speaker, q.text);
    const audible = m === 'full' || (m === 'calls' && (q.line.speaker === 'pa' || q.family === 'goal'));
    if (audible) voice(q.line, q.text, q.pri);
    busyUntil = now + 500 + q.text.length * 60;             // roughly how long it takes to say
    if (queue.length) pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, 200);
  }

  function voice(line, text, pri) {
    const ctx = SS.ui && SS.ui.context ? SS.ui.context() : 'live';
    if (ctx !== 'live') return;                                // a choice is on screen: the interface has the floor
    if (U.uiSpokeRecently(1500)) return;
    if (pri < PRI_OVERRIDE && (U.speaking() || (clip && !clip.paused))) return;
    loadIndex();
    const file = voIndex && voIndex[line.id];
    if (file) {
      try {
        if (clip) clip.pause();
        clip = new Audio('audio/vo/' + file);
        clip.play().catch(() => { clip = null; });
        return;
      } catch (e) { /* fall through to the system voice */ }
    }
    const sp = speakers()[line.speaker];
    U.speakAs(text, sp && sp.tts);
  }

  /** Stop talking: a decision or a menu has just come up. */
  function hush() { if (clip) { try { clip.pause(); } catch (e) { /* ignore */ } clip = null; } }

  function caption(speaker, text) {
    const el = U.$('caption');
    if (!el) return;
    const sp = speakers()[speaker] || { name: speaker, tag: '' };
    el.replaceChildren();
    const who = document.createElement('b'); who.className = 'who sp-' + speaker; who.textContent = sp.name;
    const what = document.createElement('span'); what.textContent = text;
    el.append(who, what);
    el.classList.add('on');
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => el.classList.remove('on'), CAPTION_MS + text.length * 25);
  }
  function clearCaption() { const el = U.$('caption'); if (el) el.classList.remove('on'); clearTimeout(captionTimer); }

  function reset() {
    Object.keys(bags).forEach(k => delete bags[k]); Object.keys(lastAt).forEach(k => { lastAt[k] = -99; });
    history = []; queue.length = 0; clearTimeout(pumpTimer); pumpTimer = null; busyUntil = 0; clearCaption(); hush();
  }

  loadIndex();
  /** A commentary line is being heard right now (system voice or a recorded clip): the music and crowd duck. */
  const talking = () => U.speaking() || !!(clip && !clip.paused && !clip.ended);
  return { say, hush, reset, clearCaption, talking, get history() { return history.slice(); } };
})();
