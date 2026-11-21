/* e-Muhaffiz engine: builds the expected recitation of a breath from precomputed word pieces and judges what the
 * model heard, word by word, the way a teacher would. Pure functions, no DOM: runs in the browser and in node tests.
 *
 * The judging logic follows the description of HisnLabs' rule engine (imam.py, Apache-2.0,
 * https://github.com/HisnLabs/tajweed), rewritten in JavaScript.
 */
(function (root) {
  'use strict';
  const LONG = new Set(['ا', 'ۥ', 'ۦ']);
  const HARAKAT = new Set(['َ', 'ُ', 'ِ']);
  const NASAL_MARKS = new Set(['ڇ', 'ں', '۾', 'ن', 'م']);
  const ONSET = 3;
  const TIME_SIX = 8.3, TIME_FIVE = 7.0;

  // rule -> [allowed counts, ar, en]
  const MADD = {
    NormalMaddRule: [[2], 'المد الطبيعي', 'natural madd'],
    MonfaselMaddRule: [[2, 4, 5], 'المد المنفصل', 'munfasil madd'],
    MottaselMaddRule: [[4, 5, 6], 'المد المتصل', 'muttasil madd'],
    MottaselMaddPauseRule: [[4, 5, 6], 'المد المتصل وقفا', 'muttasil madd at a stop'],
    LazemMaddRule: [[6], 'المد اللازم', 'lazim madd'],
    AaredMaddRule: [[2, 4, 6], 'المد العارض للسكون', "'arid madd (before a stop)"],
    LeenMaddRule: [[2, 4, 6], 'مد اللين', 'lin madd'],
  };
  const VOWEL = { 'َ': ['فتحة', 'fatha'], 'ُ': ['ضمة', 'damma'], 'ِ': ['كسرة', 'kasra'] };
  const AR_COUNTS = { 2: 'حركتان', 3: 'ثلاث حركات', 4: 'أربع حركات', 5: 'خمس حركات', 6: 'ست حركات' };
  const counts = (n, l) => l === 'ar' ? (n ? (AR_COUNTS[n] || n + ' حركات') : 'بلا مد') : n + ' counts';

  const MSG = {
    madd_short: { ar: '{name}: {heard} بدل {want}', en: '{name} too short: {heard} instead of {want}' },
    madd_long: { ar: '{name}: {heard} بدل {want}', en: '{name} too long: {heard} instead of {want}' },
    madd_missing: { ar: '{name}: المد محذوف', en: '{name} dropped: the vowel must be lengthened' },
    madd_added: { ar: 'مد زائد في غير موضعه', en: 'a vowel lengthened where there is no madd' },
    madd_uneven: { ar: '{name}: سوِّ بين المدود ({lens})', en: '{name}: keep the same length every time ({lens})' },
    ghunnah_short: { ar: 'الغنة ناقصة: أطِل الغنة حركتين', en: 'ghunnah too short: hold the nasal sound for 2 counts' },
    ikhfa_izhar: { ar: 'إخفاء: أظهرتَ النون، والصواب إخفاؤها مع الغنة', en: "ikhfa': the nun was pronounced clearly; hide it with ghunnah" },
    ikhfa_short: { ar: 'إخفاء: الغنة قصيرة', en: "ikhfa': the ghunnah is too short" },
    iqlab_missed: { ar: 'إقلاب: تُقلب النون ميمًا مخفاة مع الغنة', en: 'iqlab: the nun becomes a hidden mim with ghunnah before ب' },
    idgham_missed: { ar: 'إدغام: أظهرتَ النون، والصواب إدغامها في {letter}', en: 'idgham: the nun was pronounced; merge it into {letter}' },
    idgham_ghunnah_short: { ar: 'إدغام بغنة: الغنة ناقصة', en: 'idgham with ghunnah: the ghunnah is missing' },
    shadda_missing: { ar: 'الشدة على {letter} غير ظاهرة', en: 'the shadda on {letter} was not pronounced' },
    qalqalah_missing: { ar: 'القلقلة غير ظاهرة على {letter}', en: 'qalqalah missing on {letter}: let it bounce' },
    letter: { ar: 'نطقتَ {heard} بدل {want}', en: 'pronounced {heard} instead of {want}' },
    vowel: { ar: 'الحركة: {heard} بدل {want}', en: 'wrong vowel: {heard} instead of {want}' },
    dropped: { ar: 'سقط حرف: {want}', en: 'a sound was dropped: {want}' },
    added: { ar: 'زيادة: {heard}', en: 'an extra sound: {heard}' },
    word_missing: { ar: 'لم تُقرأ هذه الكلمة', en: 'this word was not heard' },
  };
  const fmt = (kind, k) => {
    const out = {};
    for (const l of ['ar', 'en']) out[l] = MSG[kind][l].replace(/\{(\w+)\}/g, (_, x) => {
      const v = k[x]; return v && typeof v === 'object' ? v[l] : (v == null ? '' : String(v));
    });
    return out;
  };

  // ---------- Levenshtein with opcodes ----------
  function levTable(a, b) {
    const n = a.length, m = b.length, W = m + 1, D = new Int32Array((n + 1) * W);
    for (let j = 0; j <= m; j++) D[j] = j;
    for (let i = 1; i <= n; i++) {
      D[i * W] = i; const ai = a.charCodeAt(i - 1);
      for (let j = 1; j <= m; j++) {
        const c = D[(i - 1) * W + j - 1] + (ai === b.charCodeAt(j - 1) ? 0 : 1);
        const d = D[(i - 1) * W + j] + 1, ins = D[i * W + j - 1] + 1;
        D[i * W + j] = c < d ? (c < ins ? c : ins) : (d < ins ? d : ins);
      }
    }
    return D;
  }
  function distance(a, b) {
    if (a === b) return 0;
    const n = a.length, m = b.length; if (!n) return m; if (!m) return n;
    let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
      cur[0] = i; const ai = a.charCodeAt(i - 1);
      for (let j = 1; j <= m; j++) {
        const c = prev[j - 1] + (ai === b.charCodeAt(j - 1) ? 0 : 1), d = prev[j] + 1, ins = cur[j - 1] + 1;
        cur[j] = c < d ? (c < ins ? c : ins) : (d < ins ? d : ins);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[m];
  }
  /** [tag, i1, i2, j1, j2] blocks covering both strings, tags: equal / replace / delete / insert */
  function opcodes(a, b) {
    const n = a.length, m = b.length, W = m + 1, D = levTable(a, b);
    const ops = []; let i = n, j = m;
    while (i > 0 || j > 0) {
      const v = D[i * W + j];
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && v === D[(i - 1) * W + j - 1]) { ops.push('equal'); i--; j--; }
      else if (i > 0 && j > 0 && v === D[(i - 1) * W + j - 1] + 1) { ops.push('replace'); i--; j--; }
      else if (i > 0 && v === D[(i - 1) * W + j] + 1) { ops.push('delete'); i--; }
      else { ops.push('insert'); j--; }
    }
    ops.reverse();
    const blocks = []; i = 0; j = 0;
    for (const t of ops) {
      const di = t === 'insert' ? 0 : 1, dj = t === 'delete' ? 0 : 1;
      const last = blocks[blocks.length - 1];
      if (last && last[0] === t) { last[2] += di; last[4] += dj; }
      else blocks.push([t, i, i + di, j, j + dj]);
      i += di; j += dj;
    }
    return blocks;
  }

  // ---------- the expected recitation of a breath ----------
  /** surah: [{w:[words], f:[{m:[seg,units], s?, e?, x?}]}]; flat: [[ayahIndex, wordIndex], ...] for the breath */
  function buildRef(surah, flat) {
    let ph = ''; const spans = [], units = [], words = [];
    const L = flat.length;
    flat.forEach(([ai, k], p) => {
      const f = surah[ai].f[k];
      const key = L === 1 ? 'x' : p === 0 ? 's' : p === L - 1 ? 'e' : 'm';
      const [seg, us] = f[key] || f.m;
      const o = ph.length;
      for (const u of us) units.push({ s: u[0] + o, e: u[1] + o, kind: u[2], rule: u[3], char: u[4], golden: u[5], word: p });
      spans.push([o, o + seg.length]);
      words.push(surah[ai].w[k]);
      ph += seg;
    });
    units.sort((x, y) => x.s - y.s);
    return { words, phonemes: ph, spans, units, flat };
  }
  function phonemesOf(surah, flat) {
    let ph = ''; const L = flat.length;
    flat.forEach(([ai, k], p) => { const f = surah[ai].f[k]; const key = L === 1 ? 'x' : p === 0 ? 's' : p === L - 1 ? 'e' : 'm'; ph += (f[key] || f.m)[0]; });
    return ph;
  }

  // ---------- judging ----------
  function boundaries(ref, heard) {
    const b = new Array(ref.length + 1).fill(0);
    for (const [, i1, i2, j1, j2] of opcodes(ref, heard))
      for (let k = i1; k <= i2; k++) b[k] = j1 + (i2 > i1 ? Math.round((k - i1) * (j2 - j1) / (i2 - i1)) : 0);
    b[ref.length] = heard.length;
    return b;
  }
  function run(heard, a, b, c) {
    let k = -1;
    for (let x = a; x < b; x++) if (heard[x] === c) { k = x; break; }
    if (k < 0) return [0, a, a];
    let s = k, e = k;
    while (s > 0 && heard[s - 1] === c) s--;
    while (e < heard.length && heard[e] === c) e++;
    return [e - s, s, e];
  }
  function dur(heard, times, s, e) {
    const a = s && HARAKAT.has(heard[s - 1]) ? times[s - 1] : times[s];
    return Math.max(0, times[Math.min(e, times.length - 1)] - a);
  }
  function tempoOf(ref, heard, b, times, tempo) {
    if (!times || times.length !== heard.length + 1) return null;
    const last = ref.words.length - 1, nat = [];
    for (const u of ref.units) {
      if (u.kind === 'madd' && u.rule === 'NormalMaddRule' && u.word !== last) {
        const [n, s, e] = run(heard, Math.max(0, b[u.s] - 1), Math.min(heard.length, b[u.e] + 1), u.char);
        if (n >= 1 && n <= 3) { const d = dur(heard, times, s, e); if (d > 0.08 && d < 2) nat.push(d); }
      }
    }
    if (tempo) { tempo.push(...nat); tempo.splice(0, Math.max(0, tempo.length - 40)); }
    const src = nat.length >= 2 ? nat : (tempo && tempo.length >= 3 ? tempo : []);
    if (!src.length) return null;
    const srt = [...src].sort((x, y) => x - y);
    return srt[Math.floor(srt.length / 2)] / 2;
  }
  function stripLen(s) {
    let out = '';
    for (const c of s) if (!out.length || out[out.length - 1] !== c) out += c;
    return [...out].filter(c => !LONG.has(c) && c !== 'ں' && c !== 'ڇ' && c !== '۾').join('');
  }
  const subset = (s, set) => [...s].every(c => set.has(c));

  /** heard: phonetic script; probs: per symbol; times: per symbol + end (seconds). Returns one entry per word.
   *  First asks, like a teacher, "was a whole word left out?": a word whose removal explains what was heard much
   *  better is judged as skipped, and the rest is judged without it (so the gap is not blamed on its neighbours). */
  function listen(ref, heard, opt = {}) {
    heard = heard.replace(/ /g, '');
    const gone = new Set();
    for (let round = 0; round < 4; round++) {
      const base = distance(phonemesWithout(ref, gone), heard);
      let best = null;
      ref.spans.forEach(([a, z], k) => {
        if (gone.has(k) || z - a < 2 || gone.size + 1 >= ref.words.length) return;
        const g = new Set(gone); g.add(k);
        const gain = base - distance(phonemesWithout(ref, g), heard);
        if (gain >= Math.max(2, 0.6 * (z - a)) && (!best || gain > best.gain)) best = { k, gain };
      });
      if (!best) break;
      gone.add(best.k);
    }
    if (!gone.size) return listenCore(ref, heard, opt);
    const red = withoutWords(ref, gone);
    const inner = listenCore(red.ref, heard, opt);
    const near = p => p != null && red.junctions.some(j => p >= j - 4 && p < j + 3);
    return ref.words.map((word, k) => {
      if (gone.has(k)) return { word, k, flat: ref.flat ? ref.flat[k] : null, jali: true, ok: false, madd: [],
        notes: [{ rule: 'word', severity: 'jali', pos: ref.spans[k][0], msg: fmt('word_missing', {}) }] };
      const r = inner[red.newIndex[k]];
      const notes = r.notes.filter(n => !near(n.pos));   // the sounds where the skipped word joined its neighbours
      return { ...r, k, flat: ref.flat ? ref.flat[k] : null, notes, jali: notes.some(n => n.severity === 'jali'), ok: notes.length === 0 };
    });
  }
  function phonemesWithout(ref, gone) {
    if (!gone.size) return ref.phonemes;
    return ref.spans.map(([a, z], k) => gone.has(k) ? '' : ref.phonemes.slice(a, z)).join('');
  }
  function withoutWords(ref, gone) {
    const P = ref.phonemes, newPos = new Int32Array(P.length + 1).fill(-1), newIndex = [], junctions = [];
    let ph = ''; const spans = [], words = [], flat = [];
    ref.spans.forEach(([a, z], k) => {
      if (gone.has(k)) { junctions.push(ph.length); newIndex.push(-1); return; }
      for (let i = a; i < z; i++) newPos[i] = ph.length + (i - a);
      newIndex.push(words.length);
      spans.push([ph.length, ph.length + (z - a)]); words.push(ref.words[k]); flat.push(ref.flat ? ref.flat[k] : null);
      ph += P.slice(a, z);
    });
    const units = [];
    for (const u of ref.units) {
      if (gone.has(u.word)) continue;
      let ok = true; for (let i = u.s; i < u.e; i++) if (newPos[i] < 0) { ok = false; break; }
      if (ok) units.push({ ...u, s: newPos[u.s], e: newPos[u.e - 1] + 1, word: newIndex[u.word] });
    }
    return { ref: { words, phonemes: ph, spans, units, flat }, newIndex, junctions };
  }

  function listenCore(ref, heard, opt = {}) {
    const probs = opt.probs, times = opt.times, tempo = opt.tempo;
    const minProb = opt.minProb ?? 0.3, jaliThr = opt.minProbJali ?? 0.7;
    heard = heard.replace(/ /g, '');
    const P = ref.phonemes, b = boundaries(P, heard);
    const notes = ref.words.map(() => []), covered = new Array(P.length).fill(false);
    let span = [0, 0], pos = null;
    const unsure = (hs, he, thr) => {
      if (!probs || !probs.length) return false;
      const seg = probs.slice(Math.max(0, hs - 1), Math.min(probs.length, he + 1));
      return seg.length > 0 && Math.min(...seg) < (thr ?? minProb);
    };
    const add = (w, rule, sev, kind, k = {}, extra = {}) => {
      if (unsure(span[0], span[1], sev === 'jali' ? jaliThr : minProb)) return;   // a clear mistake needs a sure model
      notes[w].push({ rule, severity: sev, pos, msg: fmt(kind, k), ...extra });
    };
    const moreNun = (u, hs, he) => (heard.slice(Math.max(0, hs - 2), he).split('ن').length) > (P.slice(Math.max(0, u.s - 2), u.e).split('ن').length);
    const maddSeen = {}, maddHeard = ref.words.map(() => []);
    const unit = tempoOf(ref, heard, b, times, tempo);

    for (const u of ref.units) {
      for (let x = u.s; x < u.e; x++) covered[x] = true;
      const hs = b[u.s], he = b[u.e];
      pos = u.s; span = [hs, he];
      if (u.kind === 'madd') {
        let [n, rs, re] = run(heard, Math.max(0, hs - 1), Math.min(heard.length, he + 1), u.char);
        if (u.rule.startsWith('Leen') && n > 0) n += 1;
        const sym = n; let shown = n ? (n <= 3 ? 2 : n <= 5 ? 4 : 6) : 0;
        if (unit && (n === 4 || n === 5) && times) {
          const tc = dur(heard, times, rs, re) / unit;
          n = tc >= TIME_SIX ? 6 : tc >= TIME_FIVE ? 5 : 4; shown = tc >= TIME_SIX ? 6 : 4;
        }
        const def = MADD[u.rule] || MADD.NormalMaddRule, allowed = def[0];
        const near = allowed.reduce((p, a) => Math.abs(a - n) < Math.abs(p - n) ? a : p, allowed[0]);
        (maddSeen[u.rule] = maddSeen[u.rule] || []).push([u.word, sym]);
        const name = { ar: def[1], en: def[2] };
        if (shown && u.rule !== 'NormalMaddRule') maddHeard[u.word].push({ rule: u.rule, heard: shown, name });
        if (n === 0 && !u.rule.startsWith('Leen')) add(u.word, u.rule, 'jali', 'madd_missing', { name });
        else if (Math.abs(n - near) > 1 && !unsure(hs, he)) {
          const want = allowed.includes(u.golden) ? u.golden : near;
          notes[u.word].push({ rule: u.rule, severity: 'khafi', pos: u.s,
            msg: fmt(n > near ? 'madd_long' : 'madd_short', { name, heard: { ar: counts(n, 'ar'), en: counts(n, 'en') }, want: { ar: counts(want, 'ar'), en: counts(want, 'en') } }) });
        }
      } else if (u.kind === 'qalqalah') {
        if (!heard.slice(Math.max(0, hs - 1), he + 1).includes('ڇ')) add(u.word, 'qalqalah', 'khafi', 'qalqalah_missing', { letter: u.s ? P[u.s - 1] : '' });
      } else if (u.kind === 'ikhfa') {
        const [n] = run(heard, hs, Math.max(he, hs + 1), 'ں');
        if (n === 0 && heard.slice(hs, he + 1).includes('ن')) add(u.word, 'ikhfa', 'khafi', 'ikhfa_izhar');
        else if (n && n < u.golden - 1) add(u.word, 'ikhfa', 'khafi', 'ikhfa_short');
      } else if (u.kind === 'iqlab') {
        if (!heard.slice(Math.max(0, hs - 1), he + 1).includes('۾')) add(u.word, 'iqlab', 'khafi', 'iqlab_missed');
      } else if (u.kind === 'ghunnah' || u.kind === 'idgham_ghunnah') {
        const [n] = run(heard, Math.max(0, hs - 1), Math.min(heard.length, he + 1), u.char);
        if (u.kind === 'idgham_ghunnah' && u.char !== 'ن' && moreNun(u, hs, he)) add(u.word, 'idgham', 'khafi', 'idgham_missed', { letter: u.char });
        else if (n < u.golden) add(u.word, u.kind, 'khafi', u.kind === 'ghunnah' ? 'ghunnah_short' : 'idgham_ghunnah_short');
      } else if (u.kind === 'shadda' || u.kind === 'idgham') {
        const [n] = run(heard, Math.max(0, hs - 1), Math.min(heard.length, he + 1), u.char);
        if (u.kind === 'idgham' && moreNun(u, hs, he)) add(u.word, 'idgham', 'khafi', 'idgham_missed', { letter: u.char });
        else if (n === 1) add(u.word, 'shadda', 'jali', 'shadda_missing', { letter: u.char });
      }
    }

    const okExtra = new Set([...LONG, ...NASAL_MARKS]);
    const wordAt = i => { for (let k = 0; k < ref.spans.length; k++) if (ref.spans[k][0] <= i && i < ref.spans[k][1]) return k; return ref.words.length - 1; };
    // words not recited at all; a gap the alignment slid a sound or two into a neighbour still belongs to them
    const missing = ref.spans.map(([a, z]) => z > a && b[z] - b[a] <= Math.max(0, Math.floor((z - a) / 4)));
    const inMissing = (i1, i2) => ref.spans.some(([a, z], k) => missing[k] && i1 < z && Math.max(i2, i1 + 1) > a);
    const ops = opcodes(P, heard);
    // which word a difference belongs to: where most of it is; an insertion at the very end of a word that is
    // followed by more differences in the next word belongs to the next word (the alignment slid it back)
    const ownerOf = (n) => {
      const [tag, i1, i2] = ops[n];
      if (i2 > i1) {
        const cnt = new Map(); for (let i = i1; i < i2; i++) { const w = wordAt(i); cnt.set(w, (cnt.get(w) || 0) + 1); }
        return [...cnt].sort((x, y) => y[1] - x[1] || y[0] - x[0])[0][0];
      }
      const w = wordAt(Math.max(0, i1 - 1)), end = ref.spans[w][1];
      if (end - i1 <= 2) for (let m = n + 1; m < ops.length && ops[m][1] <= end + 3; m++) if (ops[m][0] !== 'equal' && wordAt(ops[m][1]) > w) return w + 1;
      return wordAt(i1);
    };
    for (let n = 0; n < ops.length; n++) {
      const [tag, i1, i2, j1, j2] = ops[n];
      if (tag === 'equal') continue;
      if ((tag === 'delete' || tag === 'replace') && inMissing(i1, i2)) continue;
      const exp = P.slice(i1, i2), got = heard.slice(j1, j2);
      if (i2 > i1 && covered.slice(i1, i2).every(Boolean)) {
        const allow = new Set([...exp, ...okExtra]);
        if (!got || subset(got, allow)) continue;
      }
      if (tag === 'insert' && ref.units.some(u => u.kind === 'madd' && u.s <= i1 && i1 <= u.e && subset(got, new Set([u.char])))) continue;
      const w = ownerOf(n);
      pos = i1; span = [j1, j2];
      if (i1 < ONSET) continue;
      const ec = stripLen(exp), gc = stripLen(got);
      if (ec === gc) continue;
      if (unsure(j1, j2, jaliThr)) continue;
      if (tag === 'replace' && ec.length === 1 && gc.length === 1 && HARAKAT.has(ec) && HARAKAT.has(gc)) {
        notes[w].push({ rule: 'vowel', severity: 'jali', pos: i1, expected: exp, heard: got,
          msg: fmt('vowel', { want: { ar: VOWEL[ec][0], en: VOWEL[ec][1] }, heard: { ar: VOWEL[gc][0], en: VOWEL[gc][1] } }) });
      } else if (tag === 'replace') add(w, 'letter', 'jali', 'letter', { want: exp, heard: got }, { expected: exp, heard: got });
      else if (tag === 'delete') {
        if (exp.length === 1 && (LONG.has(exp) || HARAKAT.has(exp))) continue;
        add(w, 'dropped', 'jali', 'dropped', { want: exp }, { expected: exp });
      } else if (tag === 'insert') {
        if (i1 === 0 || i1 === P.length) continue;
        if (subset(got, LONG)) { if (got.length >= 2) add(w, 'madd_added', 'khafi', 'madd_added', {}, { heard: got }); continue; }
        if (got.length === 1 && HARAKAT.has(got)) continue;
        add(w, 'added', 'jali', 'added', { heard: got }, { heard: got });
      }
    }

    missing.forEach((m, k) => { if (m) notes[k] = [{ rule: 'word', severity: 'jali', pos: ref.spans[k][0], msg: fmt('word_missing', {}) }]; });
    // unit remarks (madd, ghunnah...) whose sounds sit in a missing word are part of that word too
    notes.forEach((ns, k) => { if (!missing[k]) notes[k] = ns.filter(n => n.pos == null || !inMissing(n.pos, n.pos + 1)); });

    for (const [rule, seen] of Object.entries(maddSeen)) {
      if (!['MonfaselMaddRule', 'MottaselMaddRule', 'AaredMaddRule'].includes(rule) || seen.length < 2) continue;
      // a madd of this kind already corrected for its length: that remark says it, don't blame the right one too
      if (notes.some(ns => ns.some(n => n.rule === rule))) continue;
      const lens = seen.map(x => x[1]).filter(Boolean);
      if (lens.length && Math.max(...lens) - Math.min(...lens) >= 2) {
        const avg = Math.round(lens.reduce((p, c) => p + c, 0) / lens.length);
        const w = seen.reduce((p, c) => Math.abs(c[1] - avg) > Math.abs(p[1] - avg) ? c : p)[0];
        notes[w].push({ rule: rule + ':uneven', severity: 'khafi', pos: null,
          msg: fmt('madd_uneven', { name: { ar: MADD[rule][1], en: MADD[rule][2] }, lens: lens.join(' / ') }) });
      }
    }

    return ref.words.map((word, k) => ({
      word, k, flat: ref.flat ? ref.flat[k] : null,
      jali: notes[k].some(n => n.severity === 'jali'),
      ok: notes[k].length === 0, notes: notes[k], madd: maddHeard[k],
    }));
  }

  // ---------- where in the passage was this breath? ----------
  /** passage: [[ai, k], ...] (the user's selected range, in order); pos: index in passage the reciter should be at.
   *  Returns {a, b, cost}: the breath covers passage[a:b]. A breath may start a few words back (a repeat, or starting
   *  the ayah again after a correction), never ahead: skipped words must be judged as missing. */
  function locate(surah, passage, pos, heard, opt = {}) {
    heard = heard.replace(/ /g, '');
    const maxWords = opt.maxWords ?? 40;
    pos = Math.max(0, Math.min(pos, passage.length - 1));
    // how far back: at least 6 words, and back to the start of the current ayah (up to 25 words)
    let back = 6;
    const ai = passage[pos][0];
    let s = pos; while (s > 0 && passage[s - 1][0] === ai && pos - s < 25) s--;
    back = Math.max(back, pos - s);
    // a breath ending one ayah back may also be re-recited: allow the previous ayah start
    let best = null;
    for (let a = pos; a >= Math.max(0, pos - back); a--) {
      for (let b = a + 1; b <= Math.min(passage.length, a + maxWords); b++) {
        const ph = phonemesOf(surah, passage.slice(a, b));
        if (ph.length > heard.length * 1.6 + 20) break;
        const c = distance(ph, heard) + 0.15 * (pos - a);   // tiny preference for continuing where we were
        if (!best || c < best.cost) best = { a, b, cost: c };
      }
    }
    return best;
  }

  /** CTC best path over logprobs [T, V] (Float32Array, row-major). blank = 0. Returns {text, probs, times}. */
  function ctcDecode(lp, T, V, vocab, secondsPerFrame, lead) {
    const out = [], probs = [], times = []; let prev = 0, lastNonBlank = -1;
    for (let t = 0; t < T; t++) {
      let bi = 0, bv = -Infinity;
      for (let v = 0; v < V; v++) { const x = lp[t * V + v]; if (x > bv) { bv = x; bi = v; } }
      if (bi !== prev && bi !== 0) { out.push(vocab[bi - 1]); probs.push(Math.exp(bv)); times.push((t + 0.5) * secondsPerFrame - lead); }
      if (bi !== 0) lastNonBlank = t;
      prev = bi;
    }
    times.push(lastNonBlank >= 0 ? (lastNonBlank + 1) * secondsPerFrame - lead : 0);
    return { text: out.join(''), probs, times };
  }

  const API = { buildRef, phonemesOf, listen, locate, opcodes, distance, ctcDecode, stripLen, MADD };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.Engine = API;
})(typeof self !== 'undefined' ? self : this);
