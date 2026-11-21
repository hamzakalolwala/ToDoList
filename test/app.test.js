// End-to-end app behaviour in headless Chrome. The model is replaced by a script of what it "hears" per breath,
// built from the real expected phonetic script with deliberate mistakes.
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { start } = require('./server');

let srv, browser, base;
test.before(async () => {
  srv = await start(0); base = `http://127.0.0.1:${srv.address().port}`;
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
});
test.after(async () => { await browser?.close(); srv?.close(); });

async function open(surah, from, to, opts = {}) {
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  page.errs = errs;
  await page.addInitScript(o => { try { localStorage.clear(); if (o.stopKh) localStorage.setItem('emuhaffiz.stopKh', 'true'); } catch (e) {} }, opts);
  await page.goto(base + '/site/index.html?test=1');
  await page.waitForFunction(() => window.__app && window.__app.passage.length > 0);
  await page.evaluate(async ([s, a, b]) => {
    document.getElementById('surah').value = s; document.getElementById('from').value = a; document.getElementById('to').value = b;
    document.getElementById('to').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 300));
    window.__spoken = []; window.__script = [];
    window.__hear = () => ({ text: window.__script.shift() || '', probs: null, times: null, ms: 1 });
    // helpers to write what the reciter says
    window.ph = (a, b) => Engine.phonemesOf(__app.S, __app.passage.slice(a, b));
    window.say = async text => { __script.push(text); __app.breath(new Float32Array(16000)); await __app.idle(); };
    window.wordIndex = (ayah, k) => __app.passage.findIndex(([ai, w]) => ai === ayah - 1 && w === k);
    __app.fakeListen();
  }, [surah, from, to]);
  return page;
}
const state = page => page.evaluate(() => ({ pos: __app.pos, st: __app.W.map(w => w.st), spoken: [...__spoken], stop: __app.stop && __app.stop.i, card: document.getElementById('stopCard').className }));

test('perfect recitation of al-Ikhlas in 4 breaths: all green, never stopped', async () => {
  const p = await open(112, 1, 4);
  await p.evaluate(async () => { for (const [a, b] of [[0, 4], [4, 6], [6, 10], [10, 15]]) await say(ph(a, b)); });
  const s = await state(p);
  assert.deepStrictEqual(p.errs, []);
  assert.strictEqual(s.pos, 15);
  assert.ok(s.st.every(x => x === 'ok'), JSON.stringify(s.st));
  assert.deepStrictEqual(s.spoken, []);
  await p.close();
});

test('THE BUG: a mistake in the middle of an ayah stops at that word — no jump back to the start of the ayah', async () => {
  const p = await open(2, 1, 5);
  const r = await p.evaluate(async () => {
    const s = wordIndex(2, 0), e = wordIndex(3, 0);            // ayah 2: ذَٰلِكَ ٱلْكِتَٰبُ لَا رَيْبَ ۛ فِيهِ ۛ هُدًى لِّلْمُتَّقِينَ
    let t = ph(s, e);
    const w3 = Engine.buildRef(__app.S, __app.passage.slice(s, e)).spans[3];   // رَيبَ
    t = t.slice(0, w3[0]) + 'شَكَّ' + t.slice(w3[1]);                           // said «شك» instead of «ريب»
    await say(ph(0, s));                                                          // ayah 1 (الٓمٓ) first
    await say(t);
    return { s, e, mistake: s + 3 };
  });
  const s1 = await state(p);
  assert.strictEqual(s1.stop, r.mistake, 'stopped on the wrong word');
  assert.strictEqual(s1.pos, r.mistake, 'continues from the wrong word, not the ayah start');
  assert.strictEqual(s1.st[r.mistake], 'jali');
  assert.ok(s1.st.slice(r.s, r.mistake).every(x => x === 'ok'), 'words before the mistake stay correct: ' + s1.st.slice(r.s, r.mistake));
  assert.strictEqual(s1.spoken.length, 1, 'said the right word once');
  assert.strictEqual(s1.spoken[0].replace(/[ً-ْ]/g, ''), 'ريب', s1.spoken[0]);
  // the reciter carries on from the corrected word to the end of the ayah
  await p.evaluate(async r => { await say(ph(r.mistake, r.e)); }, r);
  const s2 = await state(p);
  assert.strictEqual(s2.st[r.mistake], 'fixed');
  assert.strictEqual(s2.pos, r.e);
  assert.strictEqual(s2.spoken.length, 1, 'no second stop');
  assert.strictEqual(s2.card, '', 'correction card cleared');
  await p.close();
});

test('after a correction, starting the ayah again from its beginning is fine (no loop, no extra stop)', async () => {
  const p = await open(2, 1, 5);
  const r = await p.evaluate(async () => {
    const s = wordIndex(4, 0), e = wordIndex(5, 0);
    const ref = Engine.buildRef(__app.S, __app.passage.slice(s, e));
    let t = ref.phonemes; const sp = ref.spans[5];
    t = t.slice(0, sp[0]) + t.slice(sp[1]);       // skipped the 6th word of ayah 4
    for (const [x, y] of [[0, wordIndex(2, 0)], [wordIndex(2, 0), wordIndex(3, 0)], [wordIndex(3, 0), s]]) await say(ph(x, y));
    await say(t);
    const afterStop = __app.pos;
    await say(ph(s, e));                          // restarts ayah 4 from the beginning, all correct
    return { s, e, missing: s + 5, afterStop };
  });
  const st = await state(p);
  assert.strictEqual(r.afterStop, r.missing, 'stopped at the skipped word');
  assert.strictEqual(st.pos, r.e, 'moved on to the next ayah');
  assert.strictEqual(st.st[r.missing], 'fixed');
  assert.strictEqual(st.spoken.length, 1);
  await p.close();
});

test('skipped word → stops and says the skipped word', async () => {
  const p = await open(67, 1, 2);
  const r = await p.evaluate(async () => {
    const ref = Engine.buildRef(__app.S, __app.passage.slice(0, 8));
    const sp = ref.spans[2]; await say(ref.phonemes.slice(0, sp[0]) + ref.phonemes.slice(sp[1]));
    const [ai, k] = __app.passage[2]; return (__app.S[ai].d || __app.S[ai].w)[k];
  });
  const s = await state(p);
  assert.strictEqual(s.stop, 2);
  assert.ok(r.replace(/[ۖ-ۭ]/g, '').replace(/ٱ/g, 'ا').startsWith(s.spoken[0].slice(0, 2)));
  await p.close();
});

test('tajweed slip (ghunnah not held) → amber remark, no stop by default', async () => {
  const p = await open(2, 1, 7);
  const r = await p.evaluate(async () => {
    for (let s = 0; s < __app.passage.length; s++) {
      for (let e = s + 3; e <= Math.min(s + 8, __app.passage.length); e++) {
        const ref = Engine.buildRef(__app.S, __app.passage.slice(s, e));
        const u = ref.units.find(u => u.kind === 'ghunnah' && u.word > 0 && u.word < ref.words.length - 1 && u.s > 5);
        if (u) { return { s, e, w: s + u.word, t: ref.phonemes.slice(0, u.s) + u.char + ref.phonemes.slice(u.e) }; }
      }
    }
  });
  await p.evaluate(async r => {
    if (r.s > 0) await say(ph(0, r.s));
    await say(r.t);
  }, r);
  const s = await state(p);
  assert.strictEqual(s.st[r.w], 'kh', JSON.stringify(s.st.slice(r.s, r.e)));
  assert.strictEqual(s.spoken.length, 0);
  assert.strictEqual(s.pos, r.e);
  // tapping the word shows the remark
  const txt = await p.evaluate(w => { document.querySelector(`.w[data-i="${w}"]`).click(); return document.getElementById('wdBody').textContent; }, r.w);
  assert.match(txt, /ghunnah/i);
  await p.close();
});

test('with "also stop me for tajweed" on, a tajweed slip stops and is spoken', async () => {
  const p = await open(2, 1, 7, { stopKh: true });
  const r = await p.evaluate(async () => {
    for (let s = 0; s < __app.passage.length; s++) {
      const e = Math.min(s + 6, __app.passage.length);
      const ref = Engine.buildRef(__app.S, __app.passage.slice(s, e));
      const u = ref.units.find(u => u.kind === 'qalqalah' && u.word > 0 && u.word < ref.words.length - 1 && u.s > 5);
      if (u) { if (s > 0) await say(ph(0, s)); await say(ref.phonemes.slice(0, u.s) + ref.phonemes.slice(u.e)); return { w: s + u.word }; }
    }
  });
  const s = await state(p);
  assert.strictEqual(s.stop, r.w);
  assert.ok(s.card.includes('kh'));
  await p.close();
});

test("isti'adha / basmala / unrelated speech before starting is ignored", async () => {
  const p = await open(36, 1, 3);
  await p.evaluate(async () => {
    await say('ءَعُوذُبِللَااهِمِنَششَيطَاانِررَجِۦۦۦۦم');   // a'udhu billahi mina sh-shaytani r-rajim
    await say(ph(0, 1));
  });
  const s = await state(p);
  assert.strictEqual(s.pos, 1);
  assert.strictEqual(s.spoken.length, 0);
  await p.close();
});

test('repeating the same breath twice does not double-count or move backwards', async () => {
  const p = await open(1, 1, 7);
  await p.evaluate(async () => { await say(ph(0, 4)); await say(ph(4, 8)); await say(ph(4, 8)); await say(ph(8, 11)); });
  const s = await state(p);
  assert.strictEqual(s.pos, 11);
  assert.ok(s.st.slice(0, 11).every(x => x === 'ok'));
  await p.close();
});

test('"I said it right" clears the mistake and moves on', async () => {
  const p = await open(112, 1, 4);
  await p.evaluate(async () => {
    const ref = Engine.buildRef(__app.S, __app.passage.slice(0, 4));
    const sp = ref.spans[2]; await say(ref.phonemes.slice(0, sp[0] + 2) + 'زَ' + ref.phonemes.slice(sp[0] + 4));
    document.getElementById('scRight').click();
  });
  const s = await state(p);
  assert.strictEqual(s.st[2], 'ok');
  assert.strictEqual(s.pos, 4);
  await p.close();
});

test('finish shows a summary with mistakes and what to revise', async () => {
  const p = await open(112, 1, 4);
  const txt = await p.evaluate(async () => {
    const ref = Engine.buildRef(__app.S, __app.passage.slice(4, 6));
    await say(ph(0, 4));
    await say(ref.phonemes.slice(0, 4) + 'هِ' + ref.phonemes.slice(6));
    await say(ph(4, 6));
    document.getElementById('doneBtn').click();
    return document.getElementById('sumDlg').textContent;
  });
  assert.match(txt, /Mistakes/);
  assert.match(txt, /Revise/);
  assert.match(txt, /Ayah 2/);
  await p.close();
});
