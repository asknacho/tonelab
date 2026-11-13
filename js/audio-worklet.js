import './dsp.js';

const { SR, Source, EffectChain } = globalThis.TL;
const BLOCK_SIZE = 256;
// Live input uses much shorter blocks: 32 samples at 24 kHz is about 1.3 ms.
// The scope still receives 256-sample views, gathered from several blocks.
const LIVE_BLOCK = 32;
const LIVE_PRIME = LIVE_BLOCK + 8;
const LIVE_MAX = LIVE_BLOCK * 8;
const BANKS = ['A', 'B'];
// Match volume may lift a quiet chain by at most about +12 dB, so it can't blast the ear.
const MATCH_MAX = 4;
// Peaks above 0.8 bend smoothly toward full scale instead of being hard-clipped,
// which sounds much less brittle on fuzz and distortion.
function softLimit(x) {
  const a = Math.abs(x);
  if (a <= 0.8) return x;
  const over = Math.tanh((a - 0.8) / 0.2) * 0.2;
  return (x < 0 ? -1 : 1) * (0.8 + over);
}

// Second-order low-pass (RBJ), used to remove content above 12 kHz before the
// microphone signal is resampled to the engine's 24 kHz.
function lowpass(cutoff, rate) {
  const w = 2 * Math.PI * Math.min(cutoff, rate * 0.45) / rate, alpha = Math.sin(w) / Math.SQRT2, cos = Math.cos(w), a0 = 1 + alpha;
  return { b0: (1 - cos) / 2 / a0, b1: (1 - cos) / a0, b2: (1 - cos) / 2 / a0, a1: -2 * cos / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}
function filter(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
  return y;
}

class TonelabAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.source = new Source('guitar');
    this.live = false;
    this.inputPeak = 0;
    this.underruns = 0;
    this.configure(BLOCK_SIZE);
    this.fraction = 0;
    this.current = 0;
    this.next = 0;
    this.gain = 0;
    this.matchGains = { A: 1, B: 1 };
    this.targetMatches = { A: 1, B: 1 };
    this.bankMix = 0;
    this.matchedSamples = { A: 0, B: 0 };
    this.previousTaps = { A: '', B: '' };
    this.port.onmessage = ({ data }) => {
      if (data.type === 'recording') {
        this.source.setRecording(data.samples);
        this.configure(this.blockSize);
        for (const bank of BANKS) this.matchGains[bank] = this.targetMatches[bank] = 1;
        return;
      }
      if (data.type !== 'settings') return;
      const live = data.kind === 'live';
      if (live !== this.live) {
        this.live = live;
        this.configure(live ? LIVE_BLOCK : BLOCK_SIZE);
      }
      if (data.kind !== this.source.kind) {
        this.source.setKind(data.kind);
        this.position = this.blockSize;
        this.fraction = this.current = this.next = 0;
      }
      this.source.noiseDb = data.noiseDb;
      if (typeof data.tempo === 'number') this.source.tempo = data.tempo;
      this.settings = data;
    };
  }

  // Fresh chains and buffers for a block size: 256 for the synthesized guitar
  // and recordings, LIVE_BLOCK for a microphone or interface.
  configure(size) {
    this.blockSize = size;
    this.chains = { A: new EffectChain(size), B: new EffectChain(size) };
    this.powers = { A: { input: 0, output: 0 }, B: { input: 0, output: 0 } };
    this.dry = new Float32Array(size);
    this.position = size;
    this.fraction = this.current = this.next = 0;
    this.liveFifo = new Float32Array(LIVE_MAX * 2);
    this.liveCount = LIVE_PRIME;
    this.liveTime = 0;
    this.livePrevious = 0;
    this.antiAlias = [lowpass(10500, sampleRate), lowpass(10500, sampleRate)];
    this.scope = { samples: new Float32Array(BLOCK_SIZE), views: null, filled: 0 };
  }

  // Resample one render quantum of input to 24 kHz and queue it for the chain.
  queueLiveInput(channel) {
    const gain = 10 ** ((this.settings.inputGain || 0) / 20), ratio = sampleRate / SR;
    let peak = this.inputPeak * 0.995;
    for (let i = 0; i < channel.length; i++) {
      const raw = channel[i] * gain;
      peak = Math.max(peak, Math.abs(raw));
      const x = ratio > 1 ? filter(this.antiAlias[1], filter(this.antiAlias[0], raw)) : raw;
      // Output samples fall at liveTime (in input samples) between i - 1 and i.
      while (this.liveTime <= i) {
        const t = this.liveTime - (i - 1);
        if (this.liveCount < this.liveFifo.length) this.liveFifo[this.liveCount++] = this.livePrevious + (x - this.livePrevious) * t;
        this.liveTime += ratio;
      }
      this.livePrevious = x;
    }
    this.liveTime -= channel.length;
    this.inputPeak = peak;
    // A stalled tab can pile up input. Drop the oldest so latency stays low.
    if (this.liveCount > LIVE_MAX) {
      this.liveFifo.copyWithin(0, this.liveCount - LIVE_PRIME, this.liveCount);
      this.liveCount = LIVE_PRIME;
    }
  }

  takeLiveBlock() {
    const size = this.blockSize;
    if (this.liveCount < size) {
      // Underrun: play silence for this block and rebuild the small safety margin.
      this.underruns++;
      this.dry.fill(0);
      this.liveFifo.fill(0, this.liveCount, LIVE_PRIME);
      this.liveCount = LIVE_PRIME;
      return;
    }
    this.dry.set(this.liveFifo.subarray(0, size));
    this.liveFifo.copyWithin(0, size, this.liveCount);
    this.liveCount -= size;
  }

  renderBlock() {
    const settings = this.settings;
    const size = this.blockSize;
    if (this.live) this.takeLiveBlock();
    else this.source.generate(this.dry, 0, size);
    const active = settings.activeBank || 'A';
    const banks = settings.banks || { A: settings.state.chain, B: settings.state.chain };
    const views = {};
    let activeInput;
    let activeOutput;
    for (const bank of BANKS) {
      const pedals = banks[bank];
      const tap = settings.inspectByBank?.[bank] ?? settings.inspectId ?? '';
      if (tap !== this.previousTaps[bank]) {
        this.powers[bank] = { input: 0, output: 0 };
        this.previousTaps[bank] = tap;
      }
      const output = this.chains[bank].process(this.dry, pedals, false);
      const pedal = pedals.find(p => p.id === tap);
      const entry = pedal && this.chains[bank].instances.get(pedal.id);
      const tapInput = entry ? entry.input : this.dry;
      const tapOutput = entry ? (pedal.enabled ? entry.out : entry.input) : output;
      views[bank] = { inspectId: tap, input: tapInput.slice(), output: tapOutput.slice() };
      let inputPower = 0;
      let outputPower = 0;
      for (let i = 0; i < size; i++) {
        inputPower += tapInput[i] ** 2;
        outputPower += tapOutput[i] ** 2;
      }
      // Both configurations hear the same source continuously. A two-second
      // RMS window estimates their levels even while one bank is inaudible.
      const alpha = 1 - Math.exp(-size / (SR * 2));
      const powers = this.powers[bank];
      powers.input += alpha * (inputPower / size - powers.input);
      powers.output += alpha * (outputPower / size - powers.output);
      this.targetMatches[bank] = settings.matchVolume && powers.output > 1e-9
        ? Math.max(0.05, Math.min(MATCH_MAX, Math.sqrt(powers.input / powers.output))) : 1;
      if (bank === active) {
        activeInput = tapInput;
        activeOutput = tapOutput;
      }
    }
    this.bankViews = views;
    this.tapInput = activeInput;
    this.tapOutput = activeOutput;
    this.postScope(views);
    this.position = 0;
  }

  // Send the scope 256-sample views, however small the processing blocks are.
  postScope(views) {
    const size = this.blockSize;
    if (size === BLOCK_SIZE) {
      this.port.postMessage({ samples: this.dry.slice(), views });
      return;
    }
    const scope = this.scope;
    if (!scope.views || BANKS.some(bank => scope.views[bank].inspectId !== views[bank].inspectId)) {
      scope.views = Object.fromEntries(BANKS.map(bank => [bank, { inspectId: views[bank].inspectId, input: new Float32Array(BLOCK_SIZE), output: new Float32Array(BLOCK_SIZE) }]));
      scope.filled = 0;
    }
    scope.samples.set(this.dry, scope.filled);
    for (const bank of BANKS) {
      scope.views[bank].input.set(views[bank].input, scope.filled);
      scope.views[bank].output.set(views[bank].output, scope.filled);
    }
    scope.filled += size;
    if (scope.filled < BLOCK_SIZE) return;
    this.port.postMessage({ samples: scope.samples.slice(), views: scope.views, inputPeak: this.inputPeak, underruns: this.underruns });
    scope.views = null;
    scope.filled = 0;
  }

  tick() {
    if (this.position >= this.blockSize) this.renderBlock();
    const index = this.position++;
    const wet = this.settings.monitor !== 'dry';
    const samples = this.matchedSamples;
    for (const bank of BANKS) {
      const target = wet ? this.targetMatches[bank] : 1;
      this.matchGains[bank] += (target - this.matchGains[bank]) * (1 - Math.exp(-1 / (SR * 0.05)));
      const view = this.bankViews[bank];
      samples[bank] = (wet ? view.output[index] : view.input[index]) * this.matchGains[bank];
    }
    // A short crossfade avoids an audible step while both chains keep running.
    const targetMix = this.settings.activeBank === 'B' ? 1 : 0;
    const step = 1 / (SR * 0.02);
    this.bankMix += Math.max(-step, Math.min(step, targetMix - this.bankMix));
    return samples.A + (samples.B - samples.A) * this.bankMix;
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!this.settings?.state.playing) {
      out.fill(0);
      return true;
    }
    if (this.live) this.queueLiveInput(inputs[0]?.[0] || new Float32Array(out.length));
    const fixedSpeed = this.settings.kind === 'recording' || this.live;
    const step = SR / sampleRate * (fixedSpeed ? 1 : this.settings.state.speed);
    for (let i = 0; i < out.length; i++) {
      this.fraction += step;
      while (this.fraction >= 1) {
        this.current = this.next;
        this.next = this.tick();
        this.fraction--;
      }
      this.gain += (this.settings.volume - this.gain) * 0.003;
      const sample = this.current + (this.next - this.current) * this.fraction;
      out[i] = softLimit(sample * this.gain);
    }
    return true;
  }
}
registerProcessor('tonelab-audio', TonelabAudio);
