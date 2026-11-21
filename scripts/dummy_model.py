"""A stand-in for the tajweed model with the same inputs/outputs (mel [1,80,F] float32, riwaya [1] int64 ->
logprobs [1,F/2,43]), so the browser pipeline can be tested without the real weights. Also writes the reference
decode of a test clip, computed in Python with onnxruntime + faster-whisper's log-mel.

  python3 -I scripts/dummy_model.py OUT.onnx REF.json
"""
import json, sys
import numpy as np, onnx, onnxruntime as ort
from onnx import helper, TensorProto, numpy_helper
from faster_whisper.feature_extractor import FeatureExtractor

out_model, out_ref = sys.argv[1], sys.argv[2]
rng = np.random.default_rng(11)
W = numpy_helper.from_array((rng.standard_normal((80, 43)) * 0.8).astype(np.float32), 'W')
B = numpy_helper.from_array((rng.standard_normal(43) * 0.3).astype(np.float32), 'B')
zero = numpy_helper.from_array(np.array([0.0], np.float32), 'zero')
nodes = [
    helper.make_node('AveragePool', ['mel'], ['pooled'], kernel_shape=[2], strides=[2]),
    helper.make_node('Transpose', ['pooled'], ['tr'], perm=[0, 2, 1]),
    helper.make_node('MatMul', ['tr', 'W'], ['mm']),
    helper.make_node('Cast', ['riwaya'], ['rf'], to=TensorProto.FLOAT),
    helper.make_node('Mul', ['rf', 'zero'], ['r0']),
    helper.make_node('Add', ['B', 'r0'], ['b2']),
    helper.make_node('Add', ['mm', 'b2'], ['logits']),
    helper.make_node('LogSoftmax', ['logits'], ['logprobs'], axis=-1),
]
g = helper.make_graph(nodes, 'dummy_tajweed',
                      [helper.make_tensor_value_info('mel', TensorProto.FLOAT, [1, 80, 'F']),
                       helper.make_tensor_value_info('riwaya', TensorProto.INT64, [1])],
                      [helper.make_tensor_value_info('logprobs', TensorProto.FLOAT, [1, 'T', 43])],
                      [W, B, zero])
m = helper.make_model(g, opset_imports=[helper.make_opsetid('', 17)])
m.ir_version = 8
onnx.checker.check_model(m)
onnx.save(m, out_model)

# reference: the same steps as the model makers' inference (lead silence, log-mel, even frames, CTC best path)
vocab = json.load(open('/home/claude/work/ref/config.json'))['phonemes']
sr, LEAD = 16000, 6400
t = np.arange(int(sr * 3.0)) / sr
audio = (0.25 * np.sin(2 * np.pi * (150 + 300 * t) * t) * (1 + np.sin(2 * np.pi * 2 * t))).astype(np.float32)
x = np.concatenate([np.zeros(LEAD, np.float32), audio, np.zeros(LEAD, np.float32)])
mel = FeatureExtractor(feature_size=80)(x, padding=0)
mel = mel[:, : min(3000, mel.shape[1] // 2 * 2)]
sess = ort.InferenceSession(out_model, providers=['CPUExecutionProvider'])
lp = sess.run(None, {'mel': mel[None].astype(np.float32), 'riwaya': np.array([0], np.int64)})[0][0]
ids = lp.argmax(-1); text, prev = [], 0
for i in ids:
    if i != prev and i != 0: text.append(vocab[i - 1])
    prev = i
json.dump({'audio': audio.tolist(), 'text': ''.join(text), 'T': int(lp.shape[0])}, open(out_ref, 'w'), ensure_ascii=False)
print('dummy model ok; reference decode:', ''.join(text)[:60], '... T =', lp.shape[0])
