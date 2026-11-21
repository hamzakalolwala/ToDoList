// Stress tests: random breaths across the Quran with one random clear mistake each. The remark must land on the
// word that was actually got wrong, and the muhaffiz must stop there (not earlier, not at the ayah start).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const E = require('../site/engine.js');

const cache = {};
const surah = n => cache[n] || (cache[n] = JSON.parse(fs.readFileSync(path.join(__dirname, '../site/data', n + '.json'), 'utf8')));
let seed = 12345;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = a => a[Math.floor(rnd() * a.length)];
const LETTERS = 'بتثجحخدذرزسشصضطظعغفقكلمنهوي'.split('');
const SIMILAR = { 'ح': 'ه', 'ه': 'ح', 'ع': 'ء', 'ء': 'ع', 'ض': 'د', 'ص': 'س', 'س': 'ص', 'ط': 'ت', 'ت': 'ط', 'ق': 'ك', 'ك': 'ق', 'ظ': 'ز', 'ذ': 'ز', 'ث': 'س' };

function randomBreath() {
  for (;;) {
    const s = 1 + Math.floor(rnd() * 114), S = surah(s), ai = Math.floor(rnd() * S.length), W = S[ai].w.length;
    if (W < 5) continue;
    const a = Math.floor(rnd() * (W - 4)), b = Math.min(W, a + 4 + Math.floor(rnd() * 8));
    const flat = Array.from({ length: b - a }, (_, i) => [ai, a + i]);
    return { s, S, flat, ref: E.buildRef(S, flat) };
  }
}
function firstJali(res) { return res.findIndex(r => r.jali); }

function run(kind, n) {
  let right = 0, wrongWord = [], earlier = 0;
  for (let t = 0; t < n; t++) {
    const c = randomBreath(), { ref } = c, L = ref.words.length;
    const k = 1 + Math.floor(rnd() * (L - 2));           // not the first/last word of the breath
    const [a, z] = ref.spans[k];
    if (z - a < 3) { t--; continue; }
    const P = ref.phonemes; let heard;
    const covered = new Set(); ref.units.forEach(u => { for (let x = u.s - 1; x <= u.e; x++) covered.add(x); });
    const plain = []; for (let i = Math.max(a, 4); i < z; i++) if (!covered.has(i) && LETTERS.includes(P[i])) plain.push(i);
    const vowels = []; for (let i = Math.max(a, 4); i < z; i++) if (!covered.has(i) && 'َُِ'.includes(P[i]) && !'اۥۦ'.includes(P[i + 1])) vowels.push(i);
    if (kind === 'skip') heard = P.slice(0, a) + P.slice(z);
    else if (kind === 'swap') {   // said a different word (taken from elsewhere in the Quran)
      const o = randomBreath().ref, ow = o.spans[Math.floor(rnd() * o.spans.length)], other = o.phonemes.slice(ow[0], ow[1]);
      if (other === P.slice(a, z) || other.length < 3) { t--; continue; }
      heard = P.slice(0, a) + other + P.slice(z);
    }
    else if (kind === 'letter') {
      if (!plain.length) { t--; continue; }
      const i = pick(plain); heard = P.slice(0, i) + (SIMILAR[P[i]] || pick(LETTERS.filter(x => x !== P[i]))) + P.slice(i + 1);
    } else if (kind === 'vowel') {
      if (!vowels.length) { t--; continue; }
      const i = pick(vowels); heard = P.slice(0, i) + pick('َُِ'.split('').filter(x => x !== P[i])) + P.slice(i + 1);
    }
    const res = E.listen(ref, heard), j = firstJali(res);
    if (j === k) right++;
    else { if (j >= 0 && j < k) earlier++; if (wrongWord.length < 5) wrongWord.push({ s: c.s, words: ref.words.join(' '), k, j, notes: res.filter(r => r.notes.length).map(r => [r.k, r.notes.map(x => x.msg.en)]) }); }
  }
  return { rate: right / n, earlier, examples: wrongWord };
}

for (const [kind, min] of [['skip', 0.97], ['letter', 0.95], ['vowel', 0.93], ['swap', 0.95]]) {
  test(`random ${kind} mistakes in 300 random breaths: stops on the right word ≥ ${min * 100}%`, () => {
    const r = run(kind, 300);
    console.log(`    ${kind}: ${(r.rate * 100).toFixed(1)}% on the right word, ${r.earlier} stopped too early`);
    if (r.rate < min) console.log(JSON.stringify(r.examples, null, 1));
    assert.ok(r.rate >= min);
  });
}

test('perfect recitation of 1000 random breaths from all 114 surahs: zero remarks', () => {
  let noisy = 0; const ex = [];
  for (let t = 0; t < 1000; t++) {
    const { ref, s } = randomBreath();
    const res = E.listen(ref, ref.phonemes);
    if (res.some(r => r.notes.length)) { noisy++; if (ex.length < 3) ex.push([s, ref.words.join(' '), res.filter(r => r.notes.length).map(r => r.notes.map(n => n.msg.en))]); }
  }
  assert.strictEqual(noisy, 0, JSON.stringify(ex));
});

test('locate: 300 random breaths from random positions in multi-ayah passages land exactly', () => {
  let bad = 0; const ex = [];
  for (let t = 0; t < 300; t++) {
    const s = 1 + Math.floor(rnd() * 114), S = surah(s);
    const a0 = Math.floor(rnd() * S.length), a1 = Math.min(S.length - 1, a0 + 3);
    const passage = []; for (let ai = a0; ai <= a1; ai++) S[ai].w.forEach((_, k) => passage.push([ai, k]));
    if (passage.length < 8) { t--; continue; }
    const pos = Math.floor(rnd() * (passage.length - 3));
    const back = rnd() < 0.3 ? Math.min(pos, Math.floor(rnd() * 5)) : 0;   // sometimes restarts a few words back
    const a = pos - back, b = Math.min(passage.length, a + 2 + Math.floor(rnd() * 10));
    if (b <= pos) { t--; continue; }
    const r = E.locate(S, passage, pos, E.phonemesOf(S, passage.slice(a, b)));
    // equal-sounding alternatives are fine (a repeated phrase): accept any range with the same script
    const same = E.phonemesOf(S, passage.slice(r.a, r.b)) === E.phonemesOf(S, passage.slice(a, b));
    if (!(r.a === a && r.b === b) && !same) { bad++; if (ex.length < 3) ex.push({ s, pos, a, b, got: [r.a, r.b] }); }
  }
  assert.strictEqual(bad, 0, JSON.stringify(ex));
});

test('a correct recitation heard through a noisy model (madd ±1 count, unsure symbols) is rarely stopped (< 3%)', () => {
  let stopped = 0; const N = 500, ex = [];
  const SYM = 'بتثجحخدذرزسشصضطظعغفقكلمنهوي'.split('');
  for (let t = 0; t < N; t++) {
    const { ref } = randomBreath(), P = ref.phonemes;
    let heard = '', probs = [];
    for (let i = 0; i < P.length; i++) {
      const c = P[i], r = rnd();
      if ('اۥۦ'.includes(c) && P[i - 1] === c && r < 0.15) continue;                 // a madd one count shorter
      if (r > 0.97 && i > 3) { heard += pick(SYM); probs.push(0.3 + 0.35 * rnd()); continue; }   // unsure wrong symbol
      heard += c; probs.push(0.9 + 0.1 * rnd());
      if ('اۥۦ'.includes(c) && P[i + 1] !== c && r > 0.9) { heard += c; probs.push(0.8); }   // a madd one count longer
    }
    const res = E.listen(ref, heard, { probs, minProb: 0.3, minProbJali: 0.7 });
    if (res.some(r => r.jali)) { stopped++; if (ex.length < 3) ex.push(res.filter(r => r.jali).map(r => r.notes.map(n => n.msg.en))); }
  }
  console.log(`    false stops: ${stopped}/${N}`);
  assert.ok(stopped / N < 0.03, JSON.stringify(ex));
});
