"""Reference log-mel from faster-whisper for the JS parity test."""
import json, numpy as np, sys
from faster_whisper.feature_extractor import FeatureExtractor
rng = np.random.default_rng(3)
sr = 16000
cases = {}
t = np.arange(int(sr * 2.3)) / sr
cases['chirp'] = (0.3 * np.sin(2 * np.pi * (200 + 900 * t) * t)).astype(np.float32)
cases['noise'] = (0.05 * rng.standard_normal(int(sr * 1.7))).astype(np.float32)
v = np.zeros(int(sr * 3.1), np.float32); v[8000:30000] = 0.2 * np.sin(2 * np.pi * 180 * t[:22000]) * np.sin(2 * np.pi * 3 * t[:22000])
cases['burst'] = v
fe = FeatureExtractor(feature_size=80)
out = {}
for k, a in cases.items():
    mel = fe(a, padding=0)
    out[k] = {'audio': a.tolist(), 'shape': list(mel.shape), 'mel': mel.astype(np.float32).ravel().tolist()}
json.dump(out, open(sys.argv[1], 'w'))
print({k: v['shape'] for k, v in out.items()})
