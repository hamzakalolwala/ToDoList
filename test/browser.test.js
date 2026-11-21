// Browser tests (headless Chrome via Playwright): node --test test/browser.test.js
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

test('worker pipeline (JS log-mel + onnxruntime-web + CTC) matches Python onnxruntime on the stand-in model', async () => {
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto(base + '/test/pipeline.html');
  const r = await page.evaluate(() => window.result);
  await page.close();
  assert.ok(!r.error, r.error + ' ' + errs.join(' '));
  assert.strictEqual(r.T, r.wantT);
  assert.strictEqual(r.text, r.want);
  assert.strictEqual(r.times, r.probs + 1);
  console.log('    inference + decode of 3 s clip:', r.ms, 'ms');
});

test('real microphone path: fake mic audio → worklet → breath detection → worker → judged (stand-in model)', async () => {
  const b2 = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--use-file-for-fake-audio-capture=' + require('path').join(__dirname, 'assets/breaths.wav') + '%noloop', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b2.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto(base + '/site/index.html?test=1&model=/test/assets/dummy.onnx');
  await page.waitForFunction(() => !document.getElementById('mainBtn').disabled && document.getElementById('modelBox').style.display === 'none', null, { timeout: 30000 });
  await page.click('#mainBtn');
  await page.waitForFunction(() => (window.__log || []).length >= 3, null, { timeout: 30000 }).catch(() => {});
  const log = await page.evaluate(() => window.__log || []);
  const status = await page.evaluate(() => document.getElementById('status').textContent);
  await b2.close();
  assert.deepStrictEqual(errs, []);
  assert.ok(log.length >= 3, 'breaths judged: ' + JSON.stringify(log));
  assert.ok(log.every(e => typeof e.heard === 'string' && e.ms >= 0 && !e.error), JSON.stringify(log));
  const secs = log.slice(0, 3).map(e => e.sec);
  [2.5, 3.0, 2.0].forEach((want, i) => assert.ok(Math.abs(secs[i] - want) < 0.9, `breath ${i}: ${secs[i]} s`));
  console.log('    breaths:', secs.join(' s, '), 's; status:', status);
});
