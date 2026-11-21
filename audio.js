/* Microphone capture at 16 kHz and breath detection (the reciter's pauses split the audio into breaths). */
(function (root) {
  'use strict';
  const SR = 16000, FRAME = 320; // 20 ms

  /** Voice activity detector: feed Float32 chunks, get one segment per breath via onSegment(Float32Array). */
  class Vad {
    constructor(opt = {}) {
      this.minSilence = opt.minSilence ?? 0.65;   // a pause this long ends a breath
      this.preRoll = opt.preRoll ?? 0.3;
      this.minSpeech = opt.minSpeech ?? 0.35;     // shorter blips are noise
      this.maxLen = opt.maxLen ?? 27;             // the model takes at most 30 s
      this.onSegment = opt.onSegment || (() => {});
      this.onLevel = opt.onLevel || (() => {});
      this.reset();
    }
    reset() {
      this.buf = new Float32Array(0); this.pre = []; this.seg = null;
      this.noise = this.noise || 0.004; this.silentFrames = 0; this.speechFrames = 0; this.level = 0;
    }
    push(chunk) {
      const x = new Float32Array(this.buf.length + chunk.length); x.set(this.buf); x.set(chunk, this.buf.length);
      let o = 0;
      for (; o + FRAME <= x.length; o += FRAME) this.frame(x.subarray(o, o + FRAME));
      this.buf = x.slice(o);
    }
    frame(f) {
      let e = 0; for (let i = 0; i < f.length; i++) e += f[i] * f[i];
      const rms = Math.sqrt(e / f.length);
      // noise floor: drops fast to quiet frames, rises slowly
      this.noise = rms < this.noise ? 0.9 * this.noise + 0.1 * rms : this.noise * 1.0015 + 1e-6;
      const thr = Math.max(this.noise * 3.2, 0.008);
      const voiced = rms > thr;
      this.level = rms; this.onLevel(rms, thr);
      const copy = Float32Array.from(f);
      if (!this.seg) {
        this.pre.push(copy);
        if (this.pre.length > this.preRoll * SR / FRAME) this.pre.shift();
        if (voiced) { this.speechFrames++; if (this.speechFrames >= 3) { this.seg = [...this.pre]; this.pre = []; this.silentFrames = 0; this.voicedTotal = this.speechFrames; } }
        else this.speechFrames = 0;
        return;
      }
      this.seg.push(copy);
      if (voiced) { this.silentFrames = 0; this.voicedTotal++; } else this.silentFrames++;
      const len = this.seg.length * FRAME / SR;
      if (this.silentFrames * FRAME / SR >= this.minSilence) this.flush(this.silentFrames - Math.round(0.25 * SR / FRAME));
      else if (len >= this.maxLen) this.cut();
    }
    flush(dropTail = 0) {
      const frames = this.seg.slice(0, Math.max(1, this.seg.length - Math.max(0, dropTail)));
      const voiced = this.voicedTotal * FRAME / SR;
      this.seg = null; this.speechFrames = 0; this.silentFrames = 0; this.pre = [];
      if (voiced < this.minSpeech) return;
      const out = new Float32Array(frames.length * FRAME);
      frames.forEach((fr, i) => out.set(fr, i * FRAME));
      this.onSegment(out);
    }
    /** too long without a pause: cut at the quietest 200 ms of the last 8 s and keep going */
    cut() {
      const n = this.seg.length, from = Math.max(0, n - Math.round(8 * SR / FRAME));
      let best = n - 1, bestE = Infinity;
      for (let i = from; i < n - 10; i++) {
        let e = 0; for (let k = i; k < i + 10; k++) for (const v of this.seg[k]) e += v * v;
        if (e < bestE) { bestE = e; best = i + 5; }
      }
      const rest = this.seg.slice(best);
      this.seg = this.seg.slice(0, best); this.voicedTotal = this.seg.length; this.flush(0);
      this.seg = rest; this.voicedTotal = rest.length; this.silentFrames = 0;
    }
    /** stop listening for a moment (while the muhaffiz speaks): forget what is in progress */
    drop() { this.seg = null; this.pre = []; this.speechFrames = 0; this.silentFrames = 0; this.buf = new Float32Array(0); }
    end() { if (this.seg) this.flush(0); }
  }

  const WORKLET = `class Tap extends AudioWorkletProcessor {
    constructor(){ super(); this.b = new Float32Array(2048); this.n = 0; }
    process(inputs){ const ch = inputs[0] && inputs[0][0]; if (ch) { for (let i=0;i<ch.length;i++){ this.b[this.n++] = ch[i]; if (this.n === this.b.length){ this.port.postMessage(this.b.slice(0)); this.n = 0; } } } return true; }
  } registerProcessor('tap', Tap);`;

  /** Microphone → 16 kHz Float32 chunks → Vad. paused: audio is thrown away (the app's own voice is speaking). */
  class Mic {
    constructor(vad) { this.vad = vad; this.paused = false; this.ctx = null; this.stream = null; }
    async start() {
      if (this.ctx) { this.paused = false; return; }
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true } });
      let ctx;
      try { ctx = new AudioContext({ sampleRate: SR }); } catch (e) { ctx = new AudioContext(); }
      this.ctx = ctx;
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      const src = ctx.createMediaStreamSource(this.stream);
      const node = new AudioWorkletNode(ctx, 'tap');
      const ratio = ctx.sampleRate / SR;
      node.port.onmessage = e => {
        if (this.paused) return;
        this.vad.push(ratio === 1 ? e.data : downsample(e.data, ratio));
      };
      src.connect(node);
      const mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute).connect(ctx.destination);
      if (ctx.state === 'suspended') await ctx.resume();
    }
    pause() { this.paused = true; this.vad.drop(); }
    resume() { this.vad.drop(); this.paused = false; }
    async stop() {
      this.vad.end();
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      if (this.ctx) await this.ctx.close().catch(() => {});
      this.ctx = null; this.stream = null;
    }
  }
  function downsample(x, ratio) {
    const n = Math.floor(x.length / ratio), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio), b = Math.min(x.length, Math.floor((i + 1) * ratio));
      let s = 0; for (let k = a; k < b; k++) s += x[k]; out[i] = s / Math.max(1, b - a);
    }
    return out;
  }

  const API = { Vad, Mic, SR };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.Audio16 = API;
})(typeof self !== 'undefined' ? self : this);
