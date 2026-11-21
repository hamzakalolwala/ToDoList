const test = require('node:test');
const assert = require('node:assert');
const { Vad } = require('../site/audio.js');
const SR = 16000;

// synthetic "recitation": voiced bursts (a hummed vowel with vibrato) separated by pauses, over a little room noise
function audio(plan, noise = 0.002, seed = 1) {
  let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const parts = [];
  for (const [kind, sec] of plan) {
    const n = Math.round(sec * SR), x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      x[i] = noise * rnd() * 2 + (kind === 'v' ? 0.15 * Math.sin(2 * Math.PI * (140 + 8 * Math.sin(2 * Math.PI * 5 * t)) * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) : 0);
    }
    parts.push(x);
  }
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function run(x, opt) {
  const segs = []; const v = new Vad({ ...opt, onSegment: a => segs.push(a.length / SR) });
  for (let o = 0; o < x.length; o += 2048) v.push(x.subarray(o, o + 2048));
  v.end(); return segs;
}

test('three breaths separated by ~1 s pauses → three segments of about the right length', () => {
  const segs = run(audio([['s', 1], ['v', 3], ['s', 1.2], ['v', 4.5], ['s', 0.9], ['v', 2], ['s', 1]]));
  assert.strictEqual(segs.length, 3, JSON.stringify(segs));
  [3, 4.5, 2].forEach((want, i) => assert.ok(Math.abs(segs[i] - want) < 0.8, `segment ${i}: ${segs[i]} s vs ${want}`));
});
test('short gaps inside a breath (stops between words, < 0.4 s) do not split it', () => {
  const segs = run(audio([['s', 1], ['v', 1.2], ['s', 0.25], ['v', 1.5], ['s', 0.35], ['v', 1], ['s', 1.2]]));
  assert.strictEqual(segs.length, 1, JSON.stringify(segs));
});
test('a click or cough (< 0.3 s) is ignored', () => {
  const segs = run(audio([['s', 1], ['v', 0.15], ['s', 1.5], ['v', 2], ['s', 1]]));
  assert.strictEqual(segs.length, 1, JSON.stringify(segs));
});
test('louder room noise still splits correctly (adaptive noise floor)', () => {
  const segs = run(audio([['s', 2], ['v', 2.5], ['s', 1], ['v', 2.5], ['s', 1]], 0.01));
  assert.strictEqual(segs.length, 2, JSON.stringify(segs));
});
test('a 40 s breath without a pause is cut into pieces the model can take (≤ 27 s)', () => {
  const segs = run(audio([['s', 0.5], ['v', 40], ['s', 1]]));
  assert.ok(segs.length >= 2 && segs.every(s => s <= 27.5), JSON.stringify(segs));
});
test('drop() while the app speaks discards the half-heard breath', () => {
  const segs = []; const v = new Vad({ onSegment: a => segs.push(a.length) });
  const x = audio([['s', 0.5], ['v', 2]]); v.push(x); v.drop();
  v.push(audio([['s', 1]])); v.end();
  assert.strictEqual(segs.length, 0);
});
