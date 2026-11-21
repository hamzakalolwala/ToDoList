"""Probe: which tajweed rule classes the phonetizer tags, and how mappings line up with words."""
from collections import Counter
from quran_transcript import Aya, quran_phonetizer, MoshafAttributes

moshaf = MoshafAttributes(rewaya='hafs', madd_monfasel_len=4, madd_mottasel_len=4,
                          madd_mottasel_waqf=4, madd_aared_len=4)
names = Counter()
for s, a in [(1, 1), (1, 7), (2, 2), (2, 6), (2, 255), (112, 1), (113, 1), (114, 4), (20, 1)]:
    words = Aya(s, a).get().uthmani.split(' ')
    o = quran_phonetizer(' '.join(words), moshaf, remove_spaces=True)
    for m in o.mappings:
        for r in m.tajweed_rules or []:
            names[type(r).__name__] += 1
    if (s, a) in [(1, 1), (112, 1)]:
        print(s, a, words)
        print('  ph:', o.phonemes, '| text len', len(' '.join(words)), 'mappings', len(o.mappings))
        pos = 0
        for w in words:
            ps = [m.pos for m in o.mappings[pos:pos + len(w)]]
            print('  ', w, ps[:3], '...', ps[-2:], [m.deleted for m in o.mappings[pos:pos + len(w)]][-3:])
            pos += len(w) + 1
print(names)
print(Aya(2, 286).get().uthmani[:40], '| surah 2 has 286 ayat ok')
