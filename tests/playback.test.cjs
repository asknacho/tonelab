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
    segmented() {}, sendRecording() {}, updateAuditionButtons() {}, announce() {},
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
