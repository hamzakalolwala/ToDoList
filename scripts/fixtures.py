"""Reference fixtures for the JS tests, straight from the phonetizer (not from the precomputed pieces):
random breaths of random ayat with their expected phonetic script and tajweed units.

  python3 -I scripts/fixtures.py DATADIR OUT.json [N]
"""
import json, random, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from precompute import analyse  # noqa: E402

datadir, out = sys.argv[1], sys.argv[2]
n = int(sys.argv[3]) if len(sys.argv) > 3 else 400
rnd = random.Random(7)
cases = []
surahs = [1, 2, 3, 18, 36, 55, 67, 78, 112, 113, 114]
for _ in range(n):
    s = rnd.choice(surahs)
    ayat = json.load(open(f'{datadir}/{s}.json'))
    ai = rnd.randrange(len(ayat)); W = ayat[ai]['w']
    a = rnd.randrange(len(W)); b = rnd.randint(a + 1, min(len(W), a + 12))
    ph, starts, units = analyse(W[a:b])
    cases.append({'surah': s, 'ayah': ai, 'a': a, 'b': b, 'phonemes': ph,
                  'units': sorted([u[0], u[1], u[2], u[3], u[4], u[5], u[6]] for u in units)})
json.dump(cases, open(out, 'w'), ensure_ascii=False)
print('wrote', len(cases), 'cases')
