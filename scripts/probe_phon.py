"""Probe: how fast is the quran-transcript phonetizer, and what does its output look like?"""
import time
from quran_transcript import Aya, quran_phonetizer, MoshafAttributes

moshaf = MoshafAttributes(rewaya='hafs', madd_monfasel_len=4, madd_mottasel_len=4,
                          madd_mottasel_waqf=4, madd_aared_len=4)
words = Aya(2, 255).get().uthmani.split(' ')
t = time.time()
out = quran_phonetizer(' '.join(words), moshaf, remove_spaces=True)
print('full ayah:', len(words), 'words in', round(time.time() - t, 3), 's')
t = time.time()
for k in range(len(words)):
    quran_phonetizer(' '.join(words[k:k + 2]), moshaf, remove_spaces=True)
print('per 2-word call:', round((time.time() - t) / len(words), 4), 's')
print(out.phonemes[:100])
m = out.mappings[0]
print(type(m).__name__, [a for a in dir(m) if not a.startswith('_')][:20])
