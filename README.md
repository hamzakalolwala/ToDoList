# e-Muhaffiz (source + tests)

The live app is the `gh-pages` branch (https://hamzakalolwala.github.io/ToDoList/). This branch holds the source,
the data-generation scripts and the test suite.

- `site/` — the app (deployed as-is to gh-pages)
- `scripts/precompute.py` — builds `site/data/*.json` (phonetic script + tajweed units per word) with quran-transcript
- `test/` — `npm install && node --test test/*.test.js` (browser tests need Chrome + Playwright)

See `site/NOTICE.md` for credits.
