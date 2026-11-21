"""Precompute, for every word of the Quran, its phonetic script (the model's alphabet) in four contexts, plus the
tajweed units a teacher listens for in it. The browser builds the expected recitation of any breath by joining these
pieces, without running the phonetizer:

  x  the word alone (a breath of one word: start + waqf)
  s  first word of a breath (ibtida: hamzat wasl voiced; assimilates into the next word)
  e  last word of a breath (waqf form; the previous word assimilates into it)
  m  in the middle (from the whole ayah; the ayah's last word keeps its waqf form, its first word its ibtida form)

A breath [a, b) is: x if one word, else s(a) + m(a+1 .. b-2) + e(b-1).

The unit logic follows the description of HisnLabs' rule engine (imam.py, Apache-2.0): madd and qalqalah from the
phonetizer's tags; ikhfa, iqlab, ghunnah, idgham and shadda read from runs in the script.

  python3 -I scripts/precompute.py OUTDIR [--check N]
"""
import json, os, random, sys
from multiprocessing import Pool
from quran_transcript import Aya, quran_phonetizer, MoshafAttributes

LONG = set('اۥۦ')
HARAKAT = set('َُِ')
MADD_RULES = {'NormalMaddRule', 'MonfaselMaddRule', 'MottaselMaddRule', 'MottaselMaddPauseRule', 'LazemMaddRule',
              'AaredMaddRule', 'LeenMaddRule'}
MOSHAF = MoshafAttributes(rewaya='hafs', madd_monfasel_len=4, madd_mottasel_len=4, madd_mottasel_waqf=4,
                          madd_aared_len=4)
TANWEEN = set('ًࣰٌࣱٍࣲ')


def phon(words):
    o = quran_phonetizer(' '.join(words), MOSHAF, remove_spaces=True)
    return o.phonemes, o.mappings


def analyse(words):
    """phonemes, per-word segment starts, units [(s, e, kind, word, rule, char, golden)]"""
    ph, mp = phon(words)
    # letter spans (as the rule engine does) and tiling starts
    spans, pos, offs = [], 0, []
    for w in words:
        offs.append(pos)
        ps = [m.pos for m in mp[pos:pos + len(w)] if m.pos[1] > m.pos[0]]
        spans.append((min(p[0] for p in ps), max(p[1] for p in ps)) if ps else ((spans[-1][1],) * 2 if spans else (0, 0)))
        pos += len(w) + 1
    starts, last = [], 0
    for a, _ in spans:
        last = max(last, a); starts.append(last)
    starts[0] = 0

    def word_at(i):
        for k, (a, b) in enumerate(spans):
            if a <= i < b: return k
        return len(spans) - 1

    vanishing = [any(m.deleted for m in mp[p0:p0 + len(w)][-3:]) and
                 (w.rstrip('ْۡ').endswith('ن') or any(c in w for c in TANWEEN)) for w, p0 in zip(words, offs)]
    units, ruled = [], set()
    for m in mp:
        for r in m.tajweed_rules or []:
            a, b = m.pos
            name = type(r).__name__
            if name in MADD_RULES:
                seg = ph[a:b]
                c = next((ch for ch in seg if ch in LONG), None) or (seg[0] if name == 'LeenMaddRule' and seg else None)
                if c is None: continue
                j = seg.index(c); k = j
                while k < len(seg) and seg[k] == c: k += 1
                units.append((a + j, a + k, 'madd', word_at(a), name, c, k - j + (name == 'LeenMaddRule')))
                ruled.update(range(a + j, a + k))
            elif name == 'Qalqalah':
                q = ph.find('ڇ', a, b)
                if q >= 0:
                    units.append((q, q + 1, 'qalqalah', word_at(q), '', 'ڇ', 0)); ruled.add(q)
    i = 0
    while i < len(ph):
        j = i
        while j < len(ph) and ph[j] == ph[i]: j += 1
        c, n, w = ph[i], j - i, word_at(i)
        if i not in ruled:
            if c == 'ں': units.append((i, j, 'ikhfa', w, '', c, n))
            elif c == '۾': units.append((i, j, 'iqlab', w, '', c, n))
            elif c in 'نم' and n >= 3:
                pw = word_at(i - 1) if i else w
                if pw != w and vanishing[pw]: units.append((i, j, 'idgham_ghunnah', pw, '', c, n))
                else: units.append((i, j, 'ghunnah', w, '', c, n))
            elif c in 'يو' and n >= 3:
                units.append((i, j, 'idgham_ghunnah', w, '', c, n))
            elif c not in LONG and c not in HARAKAT and n == 2:
                pw = word_at(i - 1) if i else w
                if i == spans[w][0] and pw != w and vanishing[pw]: units.append((i, j, 'idgham', pw, '', c, 2))
                else: units.append((i, j, 'shadda', w, '', c, 2))
        i = j
    return ph, starts, units


def piece(ph, starts, units, k):
    """the segment and units of word k, positions relative to its segment start"""
    a = starts[k]; b = starts[k + 1] if k + 1 < len(starts) else len(ph)
    us = [[u[0] - a, u[1] - a, u[2], u[4], u[5], u[6]] for u in sorted(units) if u[3] == k]
    return ph[a:b], us


def surah(n):
    out, a = [], 1
    while True:
        try:
            words = Aya(n, a).get().uthmani.split(' ')
        except Exception:
            break
        full = analyse(words)
        forms = []
        for k in range(len(words)):
            x = piece(*analyse([words[k]]), 0)
            m = piece(*full, k)
            s = piece(*analyse(words[k:k + 2]), 0) if k + 1 < len(words) else x
            e = piece(*analyse(words[k - 1:k + 1]), 1) if k > 0 else x
            f = {'m': m}
            for key, v in (('s', s), ('e', e), ('x', x)):
                if v != m: f[key] = v
            forms.append(f)
        out.append({'w': words, 'f': forms})
        a += 1
    return n, out


def compose(ayat, ai, a, b):
    """phonemes + units of the breath words[a:b] of one ayah, from the pieces (mirrors the browser code)"""
    ph, units = '', []
    for k in range(a, b):
        f = ayat[ai]['f'][k]
        key = 'x' if b - a == 1 else 's' if k == a else 'e' if k == b - 1 else 'm'
        seg, us = f.get(key, f['m'])
        o = len(ph)
        units += [(u[0] + o, u[1] + o, u[2], u[3]) for u in us]
        ph += seg
    return ph, sorted(units)


def check(data, n_checks, seed=1):
    """compare joined pieces with the phonetizer run directly on the breath"""
    rnd = random.Random(seed)
    keys = list(data)
    bad_ph = bad_units = 0
    examples = []
    for _ in range(n_checks):
        s = rnd.choice(keys); ayat = data[s]; ai = rnd.randrange(len(ayat))
        W = ayat[ai]['w']; a = rnd.randrange(len(W)); b = rnd.randint(a + 1, len(W))
        ph, units = compose(ayat, ai, a, b)
        dph, _, dunits = analyse(W[a:b])
        du = sorted((u[0], u[1], u[2], u[4]) for u in dunits)
        if ph != dph:
            bad_ph += 1
            if len(examples) < 5: examples.append(('ph', s, ai + 1, a, b, ph, dph))
        elif units != du:
            bad_units += 1
            if len(examples) < 8: examples.append(('units', s, ai + 1, a, b, [u for u in units if u not in du], [u for u in du if u not in units]))
    return bad_ph, bad_units, examples


if __name__ == '__main__':
    outdir = sys.argv[1]
    os.makedirs(outdir, exist_ok=True)
    only = [int(x) for x in os.environ.get('SURAHS', '').split(',') if x] or list(range(1, 115))
    with Pool(os.cpu_count()) as pool:
        data = dict(pool.map(surah, only))
    total = 0
    for n, ayat in data.items():
        with open(os.path.join(outdir, f'{n}.json'), 'w') as f:
            json.dump(ayat, f, ensure_ascii=False, separators=(',', ':'))
        total += sum(len(a['w']) for a in ayat)
    print('surahs', len(data), 'ayat', sum(len(a) for a in data.values()), 'words', total)
    if '--check' in sys.argv:
        n = int(sys.argv[sys.argv.index('--check') + 1])
        bp, bu, ex = check(data, n)
        print(f'checked {n} random breaths: phoneme mismatches {bp}, unit mismatches {bu}')
        for e in ex: print('  ', e)
