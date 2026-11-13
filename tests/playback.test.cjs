const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '../js', file), 'utf8');

test('Play sends a running preset to the worklet immediately, including after pause', async () => {
  let Processor;
  const worklet = vm.createContext({ Float32Array, Math, sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
    registerProcessor: (_, value) => { Processor = value; } });
  vm.runInContext(read('dsp.js'), worklet);
  vm.runInContext(read('audio-worklet.js').replace("import './dsp.js';", ''), worklet);
  const processor = new Processor();
  const messages = [];
  const button = { disabled: false, setAttribute() {}, classList: { toggle() {} } };
  class AudioContext {
    constructor() { this.audioWorklet = { addModule: async () => {} }; }
    async resume() { this.status = 'running'; }
    async suspend() { this.status = 'suspended'; }
    async close() {}
  }
  const ui = vm.createContext({
    window: { AudioContext },
    tr: value => value,
    AudioWorkletNode: class {
      constructor() { this.port = { postMessage(message) {
        const data = structuredClone(message); // A real MessagePort copies the state.
        messages.push(data);
        processor.port.onmessage({ data });
      } }; }
      connect() {}
    },
    document: { getElementById: id => id === 'listen' ? button : id === 'volume' ? { value: '0.2' } : {} },
    audioContext: null, audioNode: null, listening: false, monitor: 'wet', audition: null,
    state: { playing: false, speed: 1, chain: [] },
    source: { kind: 'lead', tempo: 100, noiseDb: -60 },
    banks: { A: [], B: [] }, activeBank: 'A', inspectId: '', inspectByBank: { A: '', B: '' }, matchVolume: true,
    clone: structuredClone, input: new Float32Array(256), N: 256, total: 0,
    scopeHistory: { A: { input: new Float32Array(256), output: new Float32Array(256) }, B: { input: new Float32Array(256), output: new Float32Array(256) } },
    segmented() {}, sendRecording() {}, connectLiveInput() {}, syncPattern() {}, updateAuditionButtons() {}, announce() {},
  });
  // Exercise the actual page's transport and message sender with the real DSP.
  const app = read('app.js');
  const start = app.indexOf('  let audioStarting = false;');
  const end = app.indexOf('  /* --------------------------------------------------------------- loop */', start);
  assert(start >= 0 && end > start);
  vm.runInContext(app.slice(start, end), ui);
  const peak = () => {
    let result = 0;
    for (let i = 0; i < 100; i++) {
      const output = new Float32Array(128);
      processor.process([], [[output]]);
      for (const value of output) result = Math.max(result, Math.abs(value));
    }
    return result;
  };

  await button.onclick();
  assert.equal(messages[0].kind, 'lead');
  assert.equal(messages[0].state.playing, true, 'first Play must start the worklet without another control change');
  assert(peak() > 0.001, 'the selected preset must produce audio on first Play');
  await button.onclick();
  assert.equal(ui.audioContext.status, 'suspended');
  assert.equal(ui.state.playing, false);
  assert.equal(messages.at(-1).state.playing, false);
  assert.equal(peak(), 0);
  await button.onclick();
  assert.equal(messages.at(-1).state.playing, true);
  assert(peak() > 0.001, 'resuming must also produce audio without changing rhythm');
});

function liveProcessor(rate) {
  let Processor;
  const posted = [];
  const worklet = vm.createContext({ Float32Array, Math, sampleRate: rate,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage(message) { posted.push(message); } }; } },
    registerProcessor: (_, value) => { Processor = value; } });
  vm.runInContext(read('dsp.js'), worklet);
  vm.runInContext(read('audio-worklet.js').replace("import './dsp.js';", ''), worklet);
  const processor = new Processor();
  const settings = (chain, inputGain = 0) => processor.port.onmessage({ data: { type: 'settings', kind: 'live', tempo: 100, noiseDb: -60,
    state: { playing: true, speed: 1.7, chain }, banks: { A: chain, B: chain }, activeBank: 'A', inspectByBank: { A: '', B: '' },
    matchVolume: false, monitor: 'wet', volume: 0.5, inputGain } });
  // Feed render quanta of input and collect the output.
  const run = (inputAt, quanta) => {
    const out = [];
    for (let q = 0; q < quanta; q++) {
      const input = Float32Array.from({ length: 128 }, (_, i) => inputAt(q * 128 + i));
      const output = new Float32Array(128);
      processor.process([[input]], [[output]]);
      out.push(...output);
    }
    return out;
  };
  return { processor, posted, settings, run };
}

for (const rate of [48000, 44100]) {
  test(`live input at ${rate} Hz passes through the chain with only a few milliseconds of added latency`, () => {
    const { processor, posted, settings, run } = liveProcessor(rate);
    settings([]);
    // Warm up with silence so the volume ramp settles, then send a click.
    run(() => 0, Math.ceil(rate / 128));
    const clickAt = 64;
    const out = run(n => (n >= clickAt && n < clickAt + 4 ? 0.5 : 0), 40);
    const peakAt = out.reduce((best, v, i) => (Math.abs(v) > Math.abs(out[best]) ? i : best), 0);
    const latencyMs = (peakAt - clickAt) / rate * 1000;
    assert(Math.abs(out[peakAt]) > 0.05, 'the click reaches the output');
    assert(latencyMs >= 0 && latencyMs < 4, `added processing latency ${latencyMs.toFixed(2)} ms`);
    assert.equal(processor.underruns, 0, 'a steady input stream never underruns');
    // A steady tone: the scope still gets 256-sample views, plus an input peak.
    run(n => 0.25 * Math.sin(n * 2 * Math.PI * 220 / rate), Math.ceil(rate / 128));
    const last = posted.at(-1);
    assert.equal(last.samples.length, 256);
    assert.equal(last.views.A.output.length, 256);
    assert(Math.abs(last.inputPeak - 0.25) < 0.03, `input peak ${last.inputPeak}`);
    assert.equal(processor.underruns, 0);
  });
}

test('live input gain and pedals act on the microphone signal', () => {
  const { settings, run } = liveProcessor(48000);
  const tone = n => 0.05 * Math.sin(n * 2 * Math.PI * 330 / 48000);
  const level = (chain, gain) => {
    settings(chain, gain);
    run(tone, 400);
    const out = run(tone, 100);
    return Math.sqrt(out.reduce((sum, v) => sum + v * v, 0) / out.length);
  };
  const plain = level([], 0);
  const louder = level([], 12);
  assert(louder / plain > 3.5 && louder / plain < 4.5, `+12 dB input gain ≈ ×4 (${(louder / plain).toFixed(2)})`);
  const boosted = level([{ id: 'b', type: 'boost', enabled: true, params: { boost: 12, level: 0, bass: 0, treble: 0, voicing: 0 } }], 0);
  assert(boosted / plain > 3, 'a boost pedal processes the live signal');
});
