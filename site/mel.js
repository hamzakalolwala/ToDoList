/* Whisper's 80-bin log-mel spectrogram, as computed by faster-whisper's FeatureExtractor (padding=0):
 * n_fft 400, hop 160, periodic Hann window, centred reflect padding, slaney mel filters, log10, max-8 clamp, (x+4)/4.
 * Returns {data: Float32Array [80 * frames] row-major (mel x frame), frames}. */
(function (root) {
  'use strict';
  const N = 400, HOP = 160, BINS = N / 2 + 1, MELS = 80, SR = 16000;

  function melFilters() {
    const fft = new Float64Array(BINS);
    for (let i = 0; i < BINS; i++) fft[i] = i * SR / N;
    const maxMel = 45.245640471924965, fsp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fsp, logstep = Math.log(6.4) / 27;
    const freqs = new Float64Array(MELS + 2);
    for (let i = 0; i < MELS + 2; i++) {
      const m = maxMel * i / (MELS + 1);
      freqs[i] = m >= minLogMel ? minLogHz * Math.exp(logstep * (m - minLogMel)) : fsp * m;
    }
    const W = new Float32Array(MELS * BINS);
    for (let m = 0; m < MELS; m++) {
      const enorm = 2 / (freqs[m + 2] - freqs[m]);
      const d0 = freqs[m + 1] - freqs[m], d1 = freqs[m + 2] - freqs[m + 1];
      for (let k = 0; k < BINS; k++) {
        const lower = -(freqs[m] - fft[k]) / d0, upper = (freqs[m + 2] - fft[k]) / d1;
        W[m * BINS + k] = Math.max(0, Math.min(lower, upper)) * enorm;
      }
    }
    return W;
  }

  // mixed-radix complex FFT for n = 400 (2^4 * 5^2), recursive decimation in time
  function makeFFT(n) {
    const cos = new Float64Array(n), sin = new Float64Array(n);
    for (let i = 0; i < n; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
    return function fft(re, im) {
      const outRe = new Float64Array(n), outIm = new Float64Array(n);
      recSafe(re, im, 0, 1, n, outRe, outIm, 0);
      return [outRe, outIm];
    };
    function recSafe(re, im, off, stride, len, outRe, outIm, o) {
      if (len === 1) { outRe[o] = re[off]; outIm[o] = im[off]; return; }
      const p = len % 2 === 0 ? 2 : len % 5 === 0 ? 5 : len, m = len / p;
      for (let q = 0; q < p; q++) recSafe(re, im, off + q * stride, stride * p, m, outRe, outIm, o + q * m);
      const step = n / len, bufR = new Float64Array(len), bufI = new Float64Array(len);
      for (let k = 0; k < m; k++) {
        for (let r = 0; r < p; r++) {
          let sr = 0, si = 0; const kk = k + r * m;
          for (let q = 0; q < p; q++) {
            const t = ((q * kk) % len) * step, c = cos[t], s = sin[t];
            const xr = outRe[o + q * m + k], xi = outIm[o + q * m + k];
            sr += xr * c - xi * s; si += xr * s + xi * c;
          }
          bufR[kk] = sr; bufI[kk] = si;
        }
      }
      for (let i = 0; i < len; i++) { outRe[o + i] = bufR[i]; outIm[o + i] = bufI[i]; }
    }
  }

  let FILT = null, FFT = null, WIN = null;
  function logMel(audio) {
    if (!FILT) {
      FILT = melFilters(); FFT = makeFFT(N); WIN = new Float64Array(N);
      for (let i = 0; i < N; i++) WIN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    }
    const L = audio.length, pad = N / 2;
    const at = i => { // reflect padding
      let j = i - pad;
      if (j < 0) j = -j; else if (j >= L) j = 2 * (L - 1) - j;
      return audio[j];
    };
    const frames = Math.floor(L / HOP); // stft gives 1 + L/HOP frames, the last one is dropped
    const out = new Float32Array(MELS * frames);
    const re = new Float64Array(N), im = new Float64Array(N), mag = new Float64Array(BINS);
    let max = -Infinity;
    for (let f = 0; f < frames; f++) {
      const s = f * HOP;
      for (let i = 0; i < N; i++) { re[i] = at(s + i) * WIN[i]; im[i] = 0; }
      const [R, I] = FFT(re, im);
      for (let k = 0; k < BINS; k++) mag[k] = R[k] * R[k] + I[k] * I[k];
      for (let m = 0; m < MELS; m++) {
        let acc = 0; const row = m * BINS;
        for (let k = 0; k < BINS; k++) acc += FILT[row + k] * mag[k];
        const v = Math.log10(Math.max(acc, 1e-10));
        out[m * frames + f] = v; if (v > max) max = v;
      }
    }
    const floor = max - 8;
    for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], floor) + 4) / 4;
    return { data: out, frames };
  }

  /** what the model is fed: 0.4 s of silence each side, mel cut to an even number of frames, at most 3000 */
  const LEAD = 6400;
  function modelInput(audio) {
    const x = new Float32Array(audio.length + 2 * LEAD); x.set(audio, LEAD);
    const { data, frames } = logMel(x);
    const F = Math.min(3000, Math.floor(frames / 2) * 2);
    const mel = new Float32Array(MELS * F);
    for (let m = 0; m < MELS; m++) mel.set(data.subarray(m * frames, m * frames + F), m * F);
    return { mel, frames: F, seconds: x.length / SR, lead: LEAD / SR };
  }

  const API = { logMel, modelInput, melFilters, MELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.Mel = API;
})(typeof self !== 'undefined' ? self : this);
