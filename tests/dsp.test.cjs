const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const context = vm.createContext({ Float32Array, Math });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/dsp.js'), 'utf8'), context);
const { EffectChain } = context.TL;
const comp = (id, threshold = -18) => ({ id, type: 'comp', enabled: true,
  params: { threshold, ratio: 4, attack: 1, release: 80, knee: 0, makeup: 0 } });
const signal = Float32Array.from({ length: 4096 }, (_, i) => 0.8 * Math.sin(i * 0.2));

test('two compressors have separate detectors, buffers, and settings', () => {
  const first = comp('first', -12), second = comp('second', -26);
  const chain = new EffectChain(signal.length);
  const single = chain.process(signal, [first]).slice();
  const serial = chain.process(signal, [first, second]).slice();
  const a = chain.instances.get(first.id), b = chain.instances.get(second.id);
  assert.notEqual(a.processor, b.processor);
  assert.notEqual(a.out, b.out);
  assert(serial.some((v, i) => Math.abs(v - single[i]) > 0.01));
  const firstMeter = a.meter.slice();
  second.params.threshold = -36;
  const adjusted = chain.process(signal, [first, second]);
  assert.deepEqual(a.meter, firstMeter);
  assert(adjusted.some((v, i) => Math.abs(v - serial[i]) > 0.01));
});

test('empty and fully bypassed chains preserve the dry signal; removing pedals frees their state', () => {
  const chain = new EffectChain(signal.length);
  const pedals = [comp('first'), comp('second')];
  chain.process(signal, pedals);
  const bypassed = chain.process(signal, pedals.map(p => ({ ...p, enabled: false })));
  assert.deepEqual(bypassed, signal);
  chain.process(signal, [pedals[1]]);
  assert.equal(chain.instances.has('first'), false);
  assert.deepEqual(chain.process(signal, []), signal);
  assert.equal(chain.instances.size, 0);
});

test('streamed block processing matches continuous processing through repeated effects', () => {
  const pedals = [comp('a'), comp('b', -28), { id: 'echo1', type: 'delay', enabled: true, params: { time: 60, feedback: 0.35, mix: 0.4 } }, { id: 'echo2', type: 'delay', enabled: true, params: { time: 90, feedback: 0.4, mix: 0.5 } }];
  const continuous = new EffectChain(signal.length).process(signal, pedals).slice();
  const blocks = new EffectChain(128), streamed = new Float32Array(signal.length);
  for (let offset = 0; offset < signal.length; offset += 128) streamed.set(blocks.process(signal.slice(offset, offset + 128), pedals, false), offset);
  for (let i = 0; i < signal.length; i++) assert(Math.abs(continuous[i] - streamed[i]) < 1e-6);
});

test('changing order changes the result with compression and overdrive', () => {
  const compressor = comp('comp');
  const drive = { id: 'drive', type: 'drive', enabled: true, params: { drive: 18, mix: 0.8 } };
  const chain = new EffectChain(signal.length);
  const a = chain.process(signal, [compressor, drive]).slice();
  const b = chain.process(signal, [drive, compressor]);
  assert(a.some((v, i) => Math.abs(v - b[i]) > 0.05));
});

test('audio worklet keeps rendering when duplicate pedals are added, reordered, and removed', () => {
  let AudioProcessor;
  const audioContext = vm.createContext({ Float32Array, Math, sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
    registerProcessor: (name, Processor) => { AudioProcessor = Processor; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/dsp.js'), 'utf8'), audioContext);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/audio-worklet.js'), 'utf8').replace("import './dsp.js';", ''), audioContext);
  const processor = new AudioProcessor();
  const stages = [[comp('a')], [comp('a'), comp('b', -30)], [comp('b', -30), comp('a')], []];
  let peak = 0;
  for (const chain of stages) {
    processor.port.onmessage({ data: { type: 'settings', kind: 'guitar', noiseDb: -48, monitor: 'wet', volume: 0.2, state: { chain, playing: true, speed: 1 } } });
    for (let block = 0; block < 100; block++) {
      const output = new Float32Array(128);
      processor.process([], [[output]]);
      for (const value of output) { assert(Number.isFinite(value)); assert(Math.abs(value) <= 1); peak = Math.max(peak, Math.abs(value)); }
    }
  }
  assert(peak > 0.001);
});
