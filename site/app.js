/* e-Muhaffiz app: listens breath by breath, judges with the tajweed model + engine, stops on mistakes and says the
 * right word, then keeps listening on its own. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const TEST = params.has('test');
  const MODEL_URL = params.get('model') || 'https://huggingface.co/Hisnlabs/tajweed-v2/resolve/main/onnx/model-int8.onnx';
  const CACHE = 'emuhaffiz-tajweed-v2';
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const disp = (ai, k) => (S[ai].d || S[ai].w)[k];   // the mushaf spelling shown (and spoken)
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- state ----------
  let SURAHS = [], S = null, sn = 1, passage = [], W = [], spans = [];
  let pos = 0, mode = 'mic', listening = false, selfPtr = 0;
  let worker = null, modelReady = false, vocab = null, mic = null, vad = null;
  let queue = [], busy = false, breathNo = 0, stop = null, tempo = [], hints = new Set();
  const log = [];

  // ---------- model ----------
  function initModel() {
    worker = new Worker('hear-worker.js');
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') {
        if (m.stage === 'download') {
          const pct = m.total ? Math.round(100 * m.got / m.total) : 0;
          $('modelTxt').textContent = `Downloading the tajweed model (once): ${(m.got / 1048576).toFixed(1)}${m.total ? ' / ' + (m.total / 1048576).toFixed(0) : ''} MB`;
          $('modelBar').style.width = pct + '%';
        } else if (m.stage === 'cached') $('modelTxt').textContent = 'Loading the tajweed model…';
        else if (m.stage === 'starting') { $('modelTxt').textContent = 'Starting the tajweed model…'; $('modelBar').style.width = '100%'; }
      } else if (m.type === 'ready') {
        modelReady = true; $('modelBox').style.display = 'none'; setMain(); status();
      } else if (m.type === 'error' && m.stage === 'init') {
        $('modelTxt').textContent = 'Could not load the tajweed model: ' + m.message + '. Check your internet and reload. Self-check still works.';
        $('modelBar').style.width = '0';
      } else if (m.type === 'heard' || m.type === 'error') {
        const cb = pending.get(m.id); pending.delete(m.id); if (cb) cb(m);
      }
    };
    worker.postMessage({ type: 'init', modelUrl: new URL(MODEL_URL, location.href).href, ortBase: new URL('ort/', location.href).href, vocab, cacheName: CACHE });
  }
  const pending = new Map(); let reqId = 0;
  function hear(audio) {
    if (TEST && window.__hear) return Promise.resolve(window.__hear(audio, breathNo));
    return new Promise(res => { const id = ++reqId; pending.set(id, res); worker.postMessage({ type: 'hear', id, audio, riwaya: 0 }, [audio.buffer]); });
  }

  // ---------- passage ----------
  async function loadSurah(n) {
    if (!loadSurah.cache) loadSurah.cache = {};
    if (!loadSurah.cache[n]) loadSurah.cache[n] = await (await fetch(`data/${n}.json`)).json();
    return loadSurah.cache[n];
  }
  async function build() {
    sn = +$('surah').value;
    const info = SURAHS[sn - 1];
    let a = Math.max(1, Math.min(info[3], +$('from').value || 1));
    let b = Math.max(a, Math.min(info[3], +$('to').value || info[3]));
    $('from').value = a; $('to').value = b;
    lsSet('emuhaffiz.last', { s: sn, a, b });
    S = await loadSurah(sn);
    passage = [];
    for (let ai = a - 1; ai < b; ai++) S[ai].w.forEach((_, k) => passage.push([ai, k]));
    const box = $('mushaf'); box.innerHTML = ''; spans = [];
    const frag = document.createDocumentFragment();
    passage.forEach(([ai, k], i) => {
      const sp = document.createElement('span'); sp.className = 'w p'; sp.textContent = disp(ai, k); sp.dataset.i = i;
      spans.push(sp); frag.appendChild(sp); frag.appendChild(document.createTextNode(' '));
      if (k === S[ai].w.length - 1) {
        const am = document.createElement('span'); am.className = 'am'; am.textContent = (ai + 1).toLocaleString('ar-EG');
        frag.appendChild(am); frag.appendChild(document.createTextNode(' '));
      }
    });
    box.appendChild(frag);
    reset();
  }
  function reset() {
    W = passage.map(() => ({ st: 'p', notes: [], madd: [], everJali: false, tries: 0 }));
    pos = 0; selfPtr = 0; queue = []; hints = new Set(); tempo = []; hideStop(); render();
  }

  // ---------- listening ----------
  async function startListening() {
    if (!modelReady && !TEST) { note('The tajweed model is still loading — one moment.'); return; }
    note('');
    if (!vad) vad = new Audio16.Vad({ onSegment: onBreath, onLevel: lvl => { $('lvl').style.transform = `scale(${1 + Math.min(1.6, lvl * 25)})`; } });
    if (!mic) mic = new Audio16.Mic(vad);
    try { await mic.start(); } catch (e) {
      note(e && e.name === 'NotAllowedError' ? 'Chrome blocked the microphone. Tap the lock icon next to the address, allow Microphone, then tap Start again.' : 'Could not open the microphone: ' + esc(e.message || e));
      return;
    }
    listening = true; setMain(); render();
  }
  async function stopListening() { listening = false; if (mic) { await mic.stop(); mic = null; } setMain(); render(); }

  function onBreath(audio) { if (!listening || mode !== 'mic') return; queue.push(audio); pump(); }
  async function pump() {
    if (busy || !queue.length) return;
    busy = true; status();
    const audio = queue.shift(); breathNo++;
    const seconds = audio.length / 16000;   // measured before the buffer is handed to the worker
    try { const h = await hear(audio); judge(h, seconds); }
    catch (e) { addLog({ n: breathNo, error: String(e) }); }
    busy = false; status(); pump();
  }

  /** one breath heard: where was it, what was right, does the muhaffiz stop? */
  function judge(h, seconds) {
    const entry = { n: breathNo, sec: +seconds.toFixed(1), ms: h.ms, heard: h.text };
    if (h.type === 'error') { entry.error = h.message; return addLog(entry); }
    if (!h.text || h.text.replace(/[َُِ]/g, '').length < 3) { entry.skip = 'no recitation heard'; return addLog(entry); }
    const loc = Engine.locate(S, passage, pos, h.text);
    if (!loc) return addLog(entry);
    const refPh = Engine.phonemesOf(S, passage.slice(loc.a, loc.b));
    const ratio = loc.cost / Math.max(refPh.length, h.text.length);
    Object.assign(entry, { a: loc.a, b: loc.b, cost: +loc.cost.toFixed(1), ratio: +ratio.toFixed(2), expected: refPh });
    if (ratio > 0.55) {
      entry.skip = 'not this passage (isti\'adha, basmala, or another ayah?)';
      addLog(entry);
      if (pos > 0) toastNote(`That didn't match the passage. Carry on from ${wordName(pos)}.`);
      return;
    }
    const ref = Engine.buildRef(S, passage.slice(loc.a, loc.b));
    const res = Engine.listen(ref, h.text, { probs: h.probs, times: h.times, tempo, minProb: 0.3, minProbJali: 0.7 });
    res.forEach((r, k) => {
      const i = loc.a + k, prev = W[i];
      const everJali = prev.everJali || r.jali;
      let st = r.jali ? 'jali' : r.notes.length ? 'kh' : 'ok';
      if (!r.jali && prev.everJali && st === 'ok') st = 'fixed';
      W[i] = { st, notes: r.notes, madd: r.madd, everJali, tries: prev.tries + 1, lastNotes: r.notes.length ? r.notes : prev.lastNotes };
    });
    entry.remarks = res.filter(r => r.notes.length).map(r => `${r.word}: ${r.notes.map(n => n.msg.en).join('; ')}`);
    addLog(entry);
    hideStop();
    const j = res.findIndex(r => r.jali);
    const kj = $('stopKh').checked ? res.findIndex(r => r.notes.length) : -1;
    const first = j >= 0 && (kj < 0 || j <= kj) ? j : kj;
    if (first >= 0) {
      pos = loc.a + first;
      showStop(pos, res[first], loc.b);
    } else {
      pos = loc.b;
      if (pos >= passage.length) toastNote('MashaAllah, you reached the end. Tap <b>Finish</b> for your result.');
    }
    render();
  }

  // ---------- the muhaffiz stops you ----------
  const speakable = t => t.replace(/[ۖ-ۭ]/g, '').replace(/ٱ/g, 'ا');
  function showStop(i, r, breathEnd) {
    const jali = r.notes.some(n => n.severity === 'jali');
    const missing = r.notes.some(n => n.rule === 'word');
    stop = { i, breathEnd };
    $('stopCard').className = 'show' + (jali ? '' : ' kh');
    document.body.classList.add('stopped');
    requestAnimationFrame(() => { const sp = spans[i]; if (sp) { const r = sp.getBoundingClientRect(); window.scrollBy({ top: r.top - 120, behavior: 'smooth' }); } });
    $('scTitle').textContent = (missing ? 'You skipped' : jali ? 'Mistake' : 'Tajweed') + ' · ayah ' + (passage[i][0] + 1);
    $('scWord').textContent = disp(passage[i][0], passage[i][1]);
    $('scWhy').innerHTML = r.notes.slice(0, 3).map(n => `<div>${esc(n.msg.en)}</div><div class="ar">${esc(n.msg.ar)}</div>`).join('');
    $('scRight').style.display = missing ? 'none' : '';
    sayWord(i, jali ? null : r.notes[0]);
  }
  function hideStop() { $('stopCard').className = ''; document.body.classList.remove('stopped'); stop = null; }
  function arabicVoice() { const v = speechSynthesis.getVoices(); return v.find(x => /^ar[-_]SA/i.test(x.lang)) || v.find(x => /^ar/i.test(x.lang)) || null; }
  function sayWord(i, remark) {
    const word = speakable(disp(passage[i][0], passage[i][1]));
    if (mic) mic.pause();
    const done = () => setTimeout(() => { if (mic && listening) mic.resume(); }, 350);
    if (!$('voiceOn').checked || !window.speechSynthesis) { setTimeout(done, 900); return; }
    if (TEST && window.__spoken) { window.__spoken.push(word); done(); return; }
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(word); u.lang = 'ar-SA'; const v = arabicVoice(); if (v) u.voice = v; u.rate = 0.8;
      let fired = false; const fin = () => { if (!fired) { fired = true; done(); } };
      u.onend = fin; u.onerror = fin; setTimeout(fin, 6000);
      speechSynthesis.speak(u);
      if (remark) { const r = new SpeechSynthesisUtterance(remark.msg.en); r.lang = 'en-US'; speechSynthesis.speak(r); }
    } catch (e) { done(); }
  }

  // ---------- rendering ----------
  function render() {
    let ok = 0, jali = 0, kh = 0, fixed = 0, cur = -1;
    const reach = mode === 'self' ? selfPtr : pos;
    for (let i = 0; i < W.length; i++) {
      let st = W[i].st;
      if (mode === 'self') st = W[i].st === 'jali' ? 'jali' : i < selfPtr ? 'ok' : 'p';
      if (st === 'ok') ok++; else if (st === 'jali') jali++; else if (st === 'kh') kh++; else if (st === 'fixed') fixed++;
      const c = 'w ' + st + (i === reach && (listening || mode === 'self') ? ' cur' : '') + (hints.has(i) && st === 'p' ? ' ok' : '');
      if (spans[i] && spans[i]._c !== c) { spans[i].className = c; spans[i]._c = c; }
      if (i === reach) cur = i;
    }
    if (cur >= 0 && spans[cur] && (listening || mode === 'self')) {
      const r = spans[cur].getBoundingClientRect();
      if (r.top > innerHeight - 280 || r.top < 60) spans[cur].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    const pct = W.length ? Math.round(100 * Math.min(reach, W.length) / W.length) : 0;
    $('stats').innerHTML = `<span>Progress <b>${pct}%</b></span><span>Correct <b>${ok}</b></span><span>Tajweed <b>${kh}</b></span><span>Mistakes <b>${jali}</b></span><span>Fixed <b>${fixed}</b></span>`;
    $('mushaf').classList.toggle('hide', $('hideT').checked);
  }
  function setMain() {
    const b = $('mainBtn');
    b.disabled = mode === 'mic' && !modelReady && !TEST;
    b.classList.toggle('live', listening);
    if (mode === 'self') { $('mainTxt').textContent = 'Reveal next ayah'; $('hintBtn').textContent = 'Next word'; b.disabled = false; }
    else { $('mainTxt').textContent = listening ? 'Stop listening' : (W.some(w => w.st !== 'p') ? 'Continue' : 'Start tasmi'); $('hintBtn').textContent = 'Hint'; }
  }
  function status() {
    $('status').textContent = mode === 'self' ? 'Self-check' : !modelReady && !TEST ? 'Loading model…' : busy ? 'Checking…' : listening ? 'Listening' : 'Ready';
  }
  function note(msg) { $('note').innerHTML = msg || ''; $('note').classList.toggle('show', !!msg); }
  let toastT = 0;
  function toastNote(msg) { note(msg); clearTimeout(toastT); toastT = setTimeout(() => note(''), 6000); }
  const wordName = i => passage[i] ? disp(passage[i][0], passage[i][1]) : '';
  function addLog(e) {
    log.push(e); if (log.length > 200) log.shift();
    if (TEST) window.__log = log;
    const line = [`#${e.n} ${e.sec ?? ''}s ${e.ms ?? ''}ms`, e.a != null ? `words ${e.a + 1}–${e.b} cost ${e.cost} (${e.ratio})` : '', e.skip || e.error || '',
      `heard:    ${e.heard ?? ''}`, e.expected ? `expected: ${e.expected}` : '', ...(e.remarks || [])].filter(Boolean).join('\n');
    const el = $('log'); el.textContent = line + '\n\n' + el.textContent.slice(0, 20000);
  }

  // ---------- word sheet & summary ----------
  function openWord(i) {
    const w = W[i]; if (!w || w.st === 'p') return;
    $('wdWord').textContent = wordName(i);
    const notes = w.notes.length ? w.notes : (w.lastNotes || []);
    const madd = (w.madd || []).map(m => `<li>${esc(m.name.en)}: held ${m.heard} counts</li>`).join('');
    $('wdBody').innerHTML = (notes.length ? '<ul>' + notes.map(n => `<li><b>${n.severity === 'jali' ? 'Mistake' : 'Tajweed'}:</b> ${esc(n.msg.en)}<div dir="rtl" style="color:var(--mute)">${esc(n.msg.ar)}</div></li>`).join('') + '</ul>' : '<p>No remarks on this word.</p>') +
      (w.st === 'fixed' ? '<p>You got this word wrong first, then fixed it.</p>' : '') + (madd ? '<p>Madd heard:</p><ul>' + madd + '</ul>' : '');
    $('wdOk').onclick = () => { W[i] = { ...w, st: 'ok', notes: [], everJali: false }; $('wordDlg').close(); render(); };
    $('wdOk').style.display = w.st === 'ok' ? 'none' : '';
    $('wordDlg').showModal();
  }
  function finish() {
    if (listening) stopListening();
    hideStop();
    const info = SURAHS[sn - 1];
    const c = { ok: 0, kh: 0, jali: 0, fixed: 0 };
    W.forEach(w => { if (w.st in c) c[w.st]++; });
    const mistakes = W.filter(w => w.everJali).length;
    $('sRange').textContent = `${info[2]} (${info[1]}) · ayah ${$('from').value}–${$('to').value}`;
    $('sBig').innerHTML = `<div><b>${c.ok}</b>Correct</div><div><b>${mistakes}</b>Mistakes</div><div><b>${c.fixed}</b>Fixed</div><div><b>${c.kh}</b>Tajweed</div>`;
    const byAyah = new Map();
    W.forEach((w, i) => {
      if (!(w.everJali || w.st === 'kh' || w.st === 'jali')) return;
      const a = passage[i][0] + 1; if (!byAyah.has(a)) byAyah.set(a, []);
      const n = (w.notes.length ? w.notes : w.lastNotes || []).map(x => x.msg.en).join('; ');
      byAyah.get(a).push(`<span class="qw">${esc(wordName(i))}</span> — ${esc(n || (w.st === 'fixed' ? 'fixed after correction' : 'mistake'))}`);
    });
    const unread = W.filter(w => w.st === 'p').length;
    $('sRev').innerHTML = (byAyah.size ? '<b>Revise:</b><ul>' + [...byAyah].map(([a, l]) => `<li>Ayah ${a}<ul>${l.map(x => `<li>${x}</li>`).join('')}</ul></li>`).join('') + '</ul>' : '<b>MashaAllah — no remarks.</b>') +
      (unread ? `<p class="sub" style="text-align:left">${unread} words not recited yet.</p>` : '');
    const hist = lsGet('emuhaffiz.hist', []);
    hist.unshift({ d: new Date().toISOString().slice(0, 16).replace('T', ' '), s: info[2], a: $('from').value, b: $('to').value, ...c, m: mistakes });
    lsSet('emuhaffiz.hist', hist.slice(0, 40)); showHist();
    $('sumDlg').showModal();
  }
  function showHist() {
    const h = lsGet('emuhaffiz.hist', []);
    $('histBox').style.display = h.length ? '' : 'none';
    $('hist').innerHTML = h.map(x => `<li>${esc(x.d)} — ${esc(x.s)} ${x.a}–${x.b}: ${x.ok} correct, ${x.m ?? x.jali} mistakes, ${x.kh} tajweed remarks</li>`).join('');
  }

  // ---------- controls ----------
  $('mainBtn').addEventListener('click', () => {
    if (mode === 'self') {
      if (selfPtr >= W.length) return;
      const a = passage[selfPtr][0]; while (selfPtr < W.length && passage[selfPtr][0] === a) selfPtr++;
      return render();
    }
    if (listening) stopListening(); else startListening();
  });
  $('hintBtn').addEventListener('click', () => {
    if (mode === 'self') { if (selfPtr < W.length) { selfPtr++; render(); } return; }
    let i = pos; while (hints.has(i) && i < W.length) i++;
    if (i < W.length) { hints.add(i); render(); }
  });
  $('doneBtn').addEventListener('click', finish);
  $('scGo').addEventListener('click', () => { hideStop(); if (mic && listening) mic.resume(); });
  $('scAgain').addEventListener('click', () => { if (stop) sayWord(stop.i, null); });
  $('scRight').addEventListener('click', () => {
    if (!stop) return;
    const w = W[stop.i]; W[stop.i] = { ...w, st: 'ok', notes: [], everJali: false };
    pos = stop.breathEnd; hideStop(); if (mic && listening) mic.resume(); render();
  });
  $('mushaf').addEventListener('click', e => {
    const sp = e.target.closest('.w'); if (!sp) return;
    const i = +sp.dataset.i;
    if (mode === 'self') { if (i < selfPtr) { W[i].st = W[i].st === 'jali' ? 'ok' : 'jali'; if (W[i].st === 'jali') W[i].everJali = true; render(); } return; }
    openWord(i);
  });
  $('wdClose').addEventListener('click', () => $('wordDlg').close());
  $('sClose').addEventListener('click', () => $('sumDlg').close());
  $('sAgain').addEventListener('click', () => { $('sumDlg').close(); reset(); setMain(); });
  $('modeSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (listening) stopListening();
    mode = b.dataset.m; [...$('modeSeg').children].forEach(x => x.classList.toggle('on', x === b));
    note(mode === 'self' ? 'Recite from memory, then tap <b>Reveal next ayah</b> to check yourself. Tap a word you got wrong to mark it red.' : '');
    reset(); setMain(); status();
  });
  ['hideT', 'voiceOn', 'stopKh'].forEach(id => {
    const saved = lsGet('emuhaffiz.' + id, null); if (saved !== null) $(id).checked = saved;
    $(id).addEventListener('change', () => { lsSet('emuhaffiz.' + id, $(id).checked); render(); });
  });
  $('surah').addEventListener('change', () => { $('from').value = 1; $('to').value = SURAHS[+$('surah').value - 1][3]; build(); });
  $('from').addEventListener('change', build);
  $('to').addEventListener('change', build);
  $('copyLog').addEventListener('click', () => {
    const txt = JSON.stringify({ surah: sn, from: $('from').value, to: $('to').value, ua: navigator.userAgent, log }, null, 1);
    navigator.clipboard.writeText(txt).then(() => toastNote('Log copied. Paste it to Claude.'), () => toastNote('Could not copy.'));
  });

  // ---------- start ----------
  (async () => {
    [SURAHS, vocab] = await Promise.all([fetch('surahs.json').then(r => r.json()), fetch('vocab.json').then(r => r.json()).then(v => v.phonemes)]);
    $('surah').innerHTML = SURAHS.map(s => `<option value="${s[0]}">${s[0]}. ${s[2]} · ${s[1]}</option>`).join('');
    const last = lsGet('emuhaffiz.last', null);
    if (last && SURAHS[last.s - 1]) { $('surah').value = last.s; $('from').value = last.a; $('to').value = last.b; }
    await build(); showHist(); setMain(); status();
    if (!TEST || params.get('model')) initModel();
    if (TEST) window.__app = { get pos() { return pos; }, get W() { return W; }, get passage() { return passage; }, get stop() { return stop; },
      get S() { return S; }, breath: a => onBreath(a), start: startListening, fakeListen: () => { listening = true; setMain(); }, idle: () => new Promise(r => { const t = () => (!busy && !queue.length) ? r() : setTimeout(t, 20); t(); }) };
  })();
})();
