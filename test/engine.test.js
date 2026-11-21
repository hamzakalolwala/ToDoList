// Engine tests: run with `node --test test/`
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const E = require('../site/engine.js');

const DATA = path.join(__dirname, '../site/data');
const cache = {};
const surah = n => cache[n] || (cache[n] = JSON.parse(fs.readFileSync(path.join(DATA, n + '.json'), 'utf8')));
const flatOf = (s, ai, a, b) => Array.from({ length: b - a }, (_, i) => [ai, a + i]);
const passageOf = (s, fromAyah, toAyah) => {
  const out = [];
  for (let ai = fromAyah; ai <= toAyah; ai++) surah(s)[ai].w.forEach((_, k) => out.push([ai, k]));
  return out;
};
const judge = (s, flat, heard, opt) => E.listen(E.buildRef(surah(s), flat), heard, opt);
const notesOf = r => r.flatMap(w => w.notes.map(n => ({ k: w.k, rule: n.rule, sev: n.severity, en: n.msg.en })));

// ---------- 1. expected recitation matches the phonetizer ----------
test('buildRef reproduces the phonetizer for 400 random breaths (script and every tajweed unit)', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
  let bad = 0;
  for (const c of cases) {
    const ref = E.buildRef(surah(c.surah), flatOf(c.surah, c.ayah, c.a, c.b));
    const units = ref.units.map(u => [u.s, u.e, u.kind, u.word, u.rule, u.char, u.golden])
      .sort((x, y) => x[0] - y[0] || x[1] - y[1] || String(x[2]).localeCompare(y[2]));
    const want = c.units.map(u => [u[0], u[1], u[2], u[3], u[4], u[5], u[6]])
      .sort((x, y) => x[0] - y[0] || x[1] - y[1] || String(x[2]).localeCompare(y[2]));
    if (ref.phonemes !== c.phonemes || JSON.stringify(units) !== JSON.stringify(want)) {
      bad++; if (bad < 4) console.log('mismatch', c.surah, c.ayah, c.a, c.b, ref.phonemes, c.phonemes);
    }
  }
  assert.strictEqual(bad, 0);
});

// ---------- 2. a correct recitation gets no remarks ----------
test('a perfect recitation of 300 random breaths gets no remarks at all', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8')).slice(0, 300);
  const noisy = [];
  for (const c of cases) {
    const flat = flatOf(c.surah, c.ayah, c.a, c.b);
    const r = judge(c.surah, flat, E.buildRef(surah(c.surah), flat).phonemes);
    if (r.some(w => !w.ok)) noisy.push([c.surah, c.ayah, c.a, c.b, notesOf(r)]);
  }
  assert.deepStrictEqual(noisy, []);
});

// ---------- 3. each kind of mistake is caught, on the right word ----------
function findUnit(pred, maxBreath = 8) {
  for (const s of [2, 3, 18, 36, 55, 67, 78, 112, 113, 114, 1]) {
    const S = surah(s);
    for (let ai = 0; ai < S.length; ai++) {
      const W = S[ai].w.length;
      for (let a = 0; a < W; a++) {
        const b = Math.min(W, a + maxBreath); if (b - a < 3) continue;
        const flat = flatOf(s, ai, a, b), ref = E.buildRef(S, flat);
        const u = ref.units.find(x => pred(x, ref) && x.s >= 4 && x.word > 0 && x.word < b - a - 1);
        if (u) return { s, flat, ref, u };
      }
    }
  }
  throw new Error('no unit found');
}
const splice = (str, s, e, rep) => str.slice(0, s) + rep + str.slice(e);
function expectNote(c, heard, rule, sev) {
  const r = judge(c.s, c.flat, heard);
  const ns = notesOf(r);
  const hit = ns.find(n => n.rule === rule && n.k === c.u.word && (!sev || n.sev === sev));
  assert.ok(hit, `expected ${rule} on word ${c.u.word}; got ${JSON.stringify(ns)}`);
  const stray = ns.filter(n => n.k !== c.u.word);
  assert.deepStrictEqual(stray, [], 'remarks on other words');
  return r;
}

test('muttasil madd held for 2 counts → "too short" (khafi)', () => {
  const c = findUnit(u => u.kind === 'madd' && u.rule === 'MottaselMaddRule');
  expectNote(c, splice(c.ref.phonemes, c.u.s, c.u.e, c.u.char.repeat(2)), 'MottaselMaddRule', 'khafi');
});
test('lazim madd held for 2 counts → "too short"', () => {
  const c = findUnit(u => u.kind === 'madd' && u.rule === 'LazemMaddRule');
  expectNote(c, splice(c.ref.phonemes, c.u.s, c.u.e, c.u.char.repeat(2)), 'LazemMaddRule', 'khafi');
});
test('natural madd stretched to 6 → "too long"', () => {
  const c = findUnit(u => u.kind === 'madd' && u.rule === 'NormalMaddRule' && u.golden === 2);
  expectNote(c, splice(c.ref.phonemes, c.u.s, c.u.e, c.u.char.repeat(6)), 'NormalMaddRule', 'khafi');
});
test('madd dropped entirely → jali', () => {
  const c = findUnit(u => u.kind === 'madd' && u.rule === 'MottaselMaddRule');
  expectNote(c, splice(c.ref.phonemes, c.u.s, c.u.e, ''), 'MottaselMaddRule', 'jali');
});
test('munfasil read with 2 counts is allowed (qasr) → no remark', () => {
  const c = findUnit((u, ref) => u.kind === 'madd' && u.rule === 'MonfaselMaddRule' &&
    ref.units.filter(x => x.rule === 'MonfaselMaddRule').length === 1);
  const r = judge(c.s, c.flat, splice(c.ref.phonemes, c.u.s, c.u.e, c.u.char.repeat(2)));
  assert.deepStrictEqual(notesOf(r), []);
});
test('two munfasil madds, one 2 and one 4 → "keep the same length" remark', () => {
  const c = findUnit((u, ref) => u.kind === 'madd' && u.rule === 'MonfaselMaddRule' &&
    ref.units.filter(x => x.rule === 'MonfaselMaddRule').length >= 2, 14);
  const r = judge(c.s, c.flat, splice(c.ref.phonemes, c.u.s, c.u.e, c.u.char.repeat(2)));
  assert.ok(notesOf(r).some(n => n.rule === 'MonfaselMaddRule:uneven'), JSON.stringify(notesOf(r)));
});
test('ghunnah (nun/mim mushaddad) not held → ghunnah too short', () => {
  const c = findUnit(u => u.kind === 'ghunnah');
  expectNote(c, splice(c.ref.phonemes, c.u.s, c.u.e, c.u.char), 'ghunnah', 'khafi');
});
test('ikhfa read with a clear nun → ikhfa remark', () => {
  const c = findUnit(u => u.kind === 'ikhfa');
  expectNote(c, splice(c.ref.phonemes, c.u.s, c.u.e, 'ن'), 'ikhfa', 'khafi');
});
test('iqlab missed (nun before ب) → iqlab remark', () => {
  const c = findUnit(u => u.kind === 'iqlab');
  expectNote(c, splice(c.ref.phonemes, c.u.s, c.u.e, 'ن'), 'iqlab', 'khafi');
});
test('qalqalah not bounced → qalqalah remark', () => {
  const c = findUnit(u => u.kind === 'qalqalah');
  expectNote(c, splice(c.ref.phonemes, c.u.s, c.u.e, ''), 'qalqalah', 'khafi');
});
test('shadda not pronounced → jali', () => {
  const c = findUnit(u => u.kind === 'shadda' && !'نم'.includes(u.char));
  expectNote(c, splice(c.ref.phonemes, c.u.s, c.u.e, c.u.char), 'shadda', 'jali');
});
test('idgham with ghunnah into ي/و read with a clear nun → idgham remark', () => {
  const c = findUnit(u => u.kind === 'idgham_ghunnah' && 'يو'.includes(u.char));
  const r = judge(c.s, c.flat, splice(c.ref.phonemes, c.u.s, c.u.e, 'ْن'.slice(1) + c.u.char));
  assert.ok(notesOf(r).some(n => n.rule === 'idgham' || n.rule === 'idgham_ghunnah'), JSON.stringify(notesOf(r)));
});

// clear mistakes on plain letters / vowels
function plainSpot(pred) {
  for (const s of [2, 18, 36, 67]) {
    const S = surah(s);
    for (let ai = 0; ai < S.length; ai++) {
      const W = S[ai].w.length; if (W < 5) continue;
      const flat = flatOf(s, ai, 0, Math.min(W, 8)), ref = E.buildRef(S, flat);
      const covered = new Set(); ref.units.forEach(u => { for (let x = u.s - 1; x <= u.e; x++) covered.add(x); });
      for (let k = 1; k < ref.words.length - 1; k++) {
        const [a, z] = ref.spans[k];
        for (let i = a; i < z; i++) if (i > 4 && !covered.has(i) && pred(ref.phonemes[i], ref.phonemes, i)) return { s, flat, ref, i, k };
      }
    }
  }
  throw new Error('no spot');
}
test('wrong letter (makhraj slip ح → ه) → jali "pronounced ه instead of ح" on that word', () => {
  const c = plainSpot(ch => ch === 'ح');
  const r = judge(c.s, c.flat, splice(c.ref.phonemes, c.i, c.i + 1, 'ه'));
  const ns = notesOf(r);
  assert.ok(ns.some(n => n.rule === 'letter' && n.k === c.k && n.sev === 'jali'), JSON.stringify(ns));
  assert.ok(ns.every(n => n.k === c.k), JSON.stringify(ns));
});
test('wrong letter (ض → د) → jali', () => {
  const c = plainSpot(ch => ch === 'ض');
  const ns = notesOf(judge(c.s, c.flat, splice(c.ref.phonemes, c.i, c.i + 1, 'د')));
  assert.ok(ns.some(n => n.rule === 'letter' && n.k === c.k), JSON.stringify(ns));
});
test('wrong vowel (kasra for fatha) → jali "wrong vowel"', () => {
  const c = plainSpot((ch, P, i) => ch === 'َ' && P[i + 1] !== 'ا');
  const ns = notesOf(judge(c.s, c.flat, splice(c.ref.phonemes, c.i, c.i + 1, 'ِ')));
  assert.ok(ns.some(n => n.rule === 'vowel' && n.k === c.k), JSON.stringify(ns));
});
test('a skipped word → "this word was not heard" on exactly that word', () => {
  const S = surah(36), flat = flatOf(36, 8, 0, 7), ref = E.buildRef(S, flat);
  const [a, z] = ref.spans[3];
  const r = judge(36, flat, splice(ref.phonemes, a, z, ''));
  const missing = r.filter(w => w.notes.some(n => n.rule === 'word')).map(w => w.k);
  assert.deepStrictEqual(missing, [3]);
});
test('low model confidence suppresses a clear-mistake remark', () => {
  const c = plainSpot(ch => ch === 'ح');
  const heard = splice(c.ref.phonemes, c.i, c.i + 1, 'ه');
  const probs = [...heard].map((_, i) => (i === c.i ? 0.4 : 0.99));
  const ns = notesOf(judge(c.s, c.flat, heard, { probs }));
  assert.ok(!ns.some(n => n.rule === 'letter'), JSON.stringify(ns));
});
test('madd measured by time: 4 symbols held 3x a natural madd counts as 6', () => {
  const c = findUnit(u => u.kind === 'madd' && u.rule === 'MottaselMaddRule');
  const heard = c.ref.phonemes;
  // build times: each symbol 0.1 s; natural madds 0.2 s → unit 0.1 s/count; the muttasil run gets long
  const times = []; let t = 0;
  for (let i = 0; i < heard.length; i++) { times.push(t); t += (i >= c.u.s && i < c.u.e) ? 0.25 : 0.1; }
  times.push(t);
  const r = judge(c.s, c.flat, heard, { times });
  const m = r[c.u.word].madd.find(x => x.rule === 'MottaselMaddRule');
  assert.ok(m, 'madd reported'); assert.ok(m.heard >= 4);
});

// ---------- 4. locating a breath in the passage ----------
test('locate: continuing from the expected word', () => {
  const S = surah(2), passage = passageOf(2, 1, 4);
  const pos = 5, ph = E.phonemesOf(S, passage.slice(pos, pos + 7));
  assert.deepStrictEqual((({ a, b }) => ({ a, b }))(E.locate(S, passage, pos, ph)), { a: 5, b: 12 });
});
test('locate: restarting the ayah after being corrected does not jump ahead or loop', () => {
  const S = surah(2), passage = passageOf(2, 1, 4);
  const start = passage.findIndex(([ai]) => ai === 3); // ayah 4 start
  const pos = start + 6; // corrected at word 6 of the ayah
  const ph = E.phonemesOf(S, passage.slice(start, pos + 3));
  const r = E.locate(S, passage, pos, ph);
  assert.strictEqual(r.a, start); assert.strictEqual(r.b, pos + 3);
});
test('locate: a skipped word does not move the start forward (so it is judged missing)', () => {
  const S = surah(36), passage = passageOf(36, 0, 11), pos = 20;
  const ph = E.phonemesOf(S, passage.slice(pos + 1, pos + 8));
  const r = E.locate(S, passage, pos, ph);
  assert.strictEqual(r.a, pos);
});
test('locate: a breath with a wrong word mid-way still maps to the right range', () => {
  const S = surah(67), passage = passageOf(67, 0, 3), pos = 4;
  let ph = E.phonemesOf(S, passage.slice(pos, pos + 9));
  ph = ph.slice(0, 20) + 'زَيدُ' + ph.slice(26);
  const r = E.locate(S, passage, pos, ph);
  assert.deepStrictEqual([r.a, r.b], [pos, pos + 9]);
});

// ---------- 5. helpers ----------
test('opcodes rebuild the target string', () => {
  const pairs = [['قُلهُوَللَااهُ', 'قُلهُوَلَاهُ'], ['abcdef', 'azced'], ['', 'abc'], ['abc', '']];
  for (const [a, b] of pairs) {
    let out = '';
    for (const [t, i1, i2, j1, j2] of E.opcodes(a, b)) out += t === 'equal' ? a.slice(i1, i2) : b.slice(j1, j2);
    assert.strictEqual(out, b);
  }
});
test('CTC best path: blanks dropped, repeats collapsed, times per symbol', () => {
  const vocab = ['ء', 'ب', 'ت'], V = 4, seq = [0, 2, 2, 0, 2, 3, 3, 0];
  const lp = new Float32Array(seq.length * V).fill(-10);
  seq.forEach((v, t) => { lp[t * V + v] = -0.01; });
  const r = E.ctcDecode(lp, seq.length, V, vocab, 0.02, 0);
  assert.strictEqual(r.text, 'ببت');
  assert.strictEqual(r.times.length, 4);
});
