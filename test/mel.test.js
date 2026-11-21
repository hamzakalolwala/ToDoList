const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Mel = require('../site/mel.js');

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'mel_fixture.json'), 'utf8'));
for (const [name, c] of Object.entries(fx)) {
  test(`log-mel matches faster-whisper (${name})`, () => {
    const { data, frames } = Mel.logMel(Float32Array.from(c.audio));
    assert.deepStrictEqual([80, frames], c.shape);
    let maxErr = 0;
    for (let i = 0; i < data.length; i++) maxErr = Math.max(maxErr, Math.abs(data[i] - c.mel[i]));
    assert.ok(maxErr < 2e-3, 'max abs error ' + maxErr);
  });
}
test('model input: 0.4 s lead each side, even frame count, capped at 3000', () => {
  const r = Mel.modelInput(new Float32Array(16000 * 2));
  assert.strictEqual(r.frames % 2, 0);
  assert.strictEqual(r.frames, 280);
  const long = Mel.modelInput(new Float32Array(16000 * 35));
  assert.strictEqual(long.frames, 3000);
});
test('log-mel speed: 10 s of audio in under 1.5 s', () => {
  const t = Date.now(); Mel.logMel(new Float32Array(16000 * 10).map(() => Math.random() - 0.5));
  assert.ok(Date.now() - t < 1500, 'took ' + (Date.now() - t) + ' ms');
});
