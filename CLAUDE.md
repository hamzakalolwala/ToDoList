# e-Muhaffiz — notes for Claude Code

A phone web app that listens to Hamza's Quran tasmi (hifz recitation), stops him on mistakes and says the right word,
and notes tajweed slips. Live at https://hamzakalolwala.github.io/ToDoList/ (the `gh-pages` branch of this repo; the
`main` branch is an unrelated ToDoList project — don't touch it).

## How it works
- `site/audio.js` — mic at 16 kHz (AudioWorklet) + `Vad`: splits audio into breaths at pauses ≥ 0.65 s.
- `site/hear-worker.js` — Web Worker: `mel.js` (Whisper 80-bin log-mel, matches faster-whisper) → onnxruntime-web →
  HisnLabs Tajweed v2 (`onnx/model-int8.onnx`, fetched from Hugging Face on first use, cached in Cache Storage) →
  CTC best path → phonetic script (Quran phonetic alphabet, `site/vocab.json`).
- `site/engine.js` — pure logic, runs in node too:
  - `buildRef` joins precomputed word pieces (`site/data/N.json`: forms m/s/e/x per word = middle / breath start /
    breath end / alone) into the expected script + tajweed units of any breath.
  - `locate` finds which words a breath covered (may start up to an ayah back, never ahead).
  - `listen` judges per word: skipped-word hypothesis test first, then madd/ghunnah/ikhfa/iqlab/idgham/qalqalah/shadda
    units, then clear mistakes (letter/vowel/dropped/added) from Levenshtein opcodes. Clear mistakes need model
    confidence ≥ 0.7. Logic follows HisnLabs' imam.py (Apache-2.0), rewritten — their repo code is not run here.
- `site/app.js` — UI/session: per breath → locate → listen → stop on first jali (or khafi if "also stop for tajweed")
  → speak the word (speechSynthesis, ar-SA) with the mic paused → resume automatically. `?test=1` exposes `window.__app`
  and lets tests script what the model hears via `window.__hear`.
- `scripts/precompute.py` — regenerates `site/data` with `quran-transcript` (pip). Checks joined pieces against the
  phonetizer on random breaths (0 mismatches in 20k).

## Tests (56, all passing at handover)
`npm install` then `node --test test/*.test.js`. Browser tests use Playwright with `/usr/bin/google-chrome`
(adjust `executablePath` in `test/*.test.js` for your machine). Suites: engine (rules, parity with phonetizer fixtures),
mel (vs faster-whisper), vad, stress (random mistakes across all 114 surahs; noisy-model false stops), browser
(worker + ORT parity with a stand-in ONNX; fake-mic end to end), app (scenarios incl. mistake mid-ayah, restart ayah,
skipped word, tajweed slip, isti'adha ignored, summary).

## Not yet verified
The real model has never been run in a test (Hugging Face was unreachable from the build sandbox). First real-device
check: open the live site in Chrome on Android, recite, and use "What the model heard → Copy log" to debug.
Known limits: no tafkhim/tarqiq (sifat heads aren't in the ONNX export); ~4–9% of correct words may get a remark
(model card figure).

## Deploy
Copy `site/` to the root of the `gh-pages` branch and push; GitHub Pages rebuilds in ~1 min.
