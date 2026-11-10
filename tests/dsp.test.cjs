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

test('A/B volume matching equalizes different chains and pedal taps expose their actual buffers', () => {
  let Processor;
  const runtime = vm.createContext({ Float32Array, Math, sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
    registerProcessor: (_, value) => { Processor = value; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/dsp.js'), 'utf8'), runtime);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/audio-worklet.js'), 'utf8').replace("import './dsp.js';", ''), runtime);
  const banks = { A: [comp('a', -30)], B: [{ id: 'b', type: 'drive', enabled: true, params: { drive: 20, mix: 1 } }] };
  function render(activeBank) {
    const processor = new Processor();
    processor.port.onmessage({ data: { type: 'settings', kind: 'guitar', noiseDb: -48, monitor: 'wet', volume: 0.1, matchVolume: true, banks, activeBank, state: { playing: true, speed: 1 } } });
    let power = 0, count = 0;
    for (let block = 0; block < 3000; block++) {
      const output = new Float32Array(128);
      processor.process([], [[output]]);
      if (block > 1500) for (const value of output) { power += value * value; count++; }
    }
    return { processor, rms: Math.sqrt(power / count) };
  }
  const a = render('A'), b = render('B');
  assert(Math.abs(20 * Math.log10(a.rms / b.rms)) < 1.5);
  const settings = { ...a.processor.settings, inspectId: 'a' };
  a.processor.port.onmessage({ data: settings });
  a.processor.renderBlock();
  const entry = a.processor.chains.A.instances.get('a');
  assert.equal(a.processor.tapInput, entry.input);
  assert.equal(a.processor.tapOutput, entry.out);
});


test('inactive banks publish waveform history and retain their state when selected', () => {
  let Processor;
  const messages = [];
  const runtime = vm.createContext({ Float32Array, Math, sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => messages.push(data) }; } },
    registerProcessor: (_, value) => { Processor = value; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/dsp.js'), 'utf8'), runtime);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/audio-worklet.js'), 'utf8').replace("import './dsp.js';", ''), runtime);
  const processor = new Processor();
  const data = { type: 'settings', kind: 'guitar', noiseDb: -48, monitor: 'wet', volume: 0.1, matchVolume: true,
    banks: { A: [comp('a')], B: [comp('b', -30)] }, activeBank: 'A', inspectByBank: { A: '', B: '' }, state: { playing: true, speed: 1 } };
  processor.port.onmessage({ data });
  for (let i = 0; i < 100; i++) processor.renderBlock();
  assert(messages.every(message => message.views.A.output.length === 256 && message.views.B.output.length === 256));
  assert(messages.some(message => message.views.B.output.some(value => Math.abs(value) > 0.001)));
  const previousSourcePosition = processor.source.n;
  const previousProcessor = processor.chains.B.instances.get('b').processor;
  processor.port.onmessage({ data: { ...data, activeBank: 'B' } });
  processor.renderBlock();
  assert.equal(processor.source.n, previousSourcePosition + 256);
  assert.equal(processor.chains.B.instances.get('b').processor, previousProcessor);
  assert.equal(processor.tapOutput, processor.chains.B.instances.get('b').out);
});

const { SR } = context.TL;
const tone = (freq, seconds = 1, amp = 0.5) => Float32Array.from({ length: Math.round(SR * seconds) }, (_, i) => amp * Math.sin(2 * Math.PI * freq * i / SR));
// Energy at one frequency (Goertzel), measured over the second half to skip start-up.
function energyAt(buf, freq) {
  const start = buf.length >> 1, k = 2 * Math.cos(2 * Math.PI * freq / SR);
  let s1 = 0, s2 = 0;
  for (let i = start; i < buf.length; i++) { const s0 = buf[i] + k * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}
const pedal = (type, params) => ({ id: type + '1', type, enabled: true, params });

test('octave pedal adds a sub octave and an octave up', () => {
  const input = tone(220);
  const sub = new EffectChain(input.length).process(input, [pedal('octave', { dry: 0, sub: 1, up: 0 })]);
  assert(energyAt(sub, 110) > 20 * energyAt(sub, 220));
  const up = new EffectChain(input.length).process(input, [pedal('octave', { dry: 0, sub: 0, up: 1 })]);
  assert(energyAt(up, 440) > 20 * energyAt(up, 220));
});

test('harmonizer shifts pitch by the chosen interval', () => {
  const input = tone(220);
  const out = new EffectChain(input.length).process(input, [pedal('harm', { voice1: 12, voice2: 0, mix: 1, window: 50 })]);
  assert(energyAt(out, 440) > 10 * energyAt(out, 220));
  const fifth = new EffectChain(input.length).process(input, [pedal('harm', { voice1: 7, voice2: 0, mix: 1, window: 50 })]);
  assert(energyAt(fifth, 220 * 2 ** (7 / 12)) > 10 * energyAt(fifth, 220));
});

test('fuzz squares off the wave and stays bounded', () => {
  const input = tone(220, 1, 0.05);
  const out = new EffectChain(input.length).process(input, [pedal('fuzz', { fuzz: 36, tone: 1, level: 0 })]);
  let peak = 0, power = 0;
  for (let i = out.length >> 1; i < out.length; i++) { assert(Number.isFinite(out[i])); peak = Math.max(peak, Math.abs(out[i])); power += out[i] ** 2; }
  const rms = Math.sqrt(power / (out.length >> 1));
  assert(peak <= 1.5);
  assert(peak / rms < 1.3, 'crest factor of a square-ish wave is close to 1 (a sine is 1.41)');
});

test('new effects stream block by block exactly like one long buffer', () => {
  const input = tone(196, 0.5);
  const pedals = [pedal('fuzz', { fuzz: 24, tone: 0.5, level: -6 }), pedal('octave', { dry: 0.6, sub: 0.6, up: 0.3 }),
    pedal('harm', { voice1: 4, voice2: 7, mix: 0.5, window: 40 })];
  const continuous = new EffectChain(input.length).process(input, pedals).slice();
  const blocks = new EffectChain(128), streamed = new Float32Array(input.length);
  for (let offset = 0; offset + 128 <= input.length; offset += 128) streamed.set(blocks.process(input.slice(offset, offset + 128), pedals, false), offset);
  for (let i = 0; i + 128 <= input.length; i++) assert(Math.abs(continuous[i] - streamed[i]) < 1e-5, 'sample ' + i);
});

// ---- Boost, distortion, tremolo, swell, reverb, chorus, phaser, wah, EQ, delay character
const { eqResponse } = context.TL;
const noise = (seconds, amp = 0.3, seed = 7) => { let a = seed; return Float32Array.from({ length: Math.round(SR * seconds) }, () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return amp * (a / 0x3fffffff - 1); }); };
const rmsOf = (b, from = 0, to = b.length) => { let p = 0; for (let i = from; i < to; i++) p += b[i] ** 2; return Math.sqrt(p / (to - from)); };
const run = (type, params, input) => new EffectChain(input.length).process(input, [pedal(type, params)]).slice();

test('every new effect streams block by block exactly like one long buffer', () => {
  const input = Float32Array.from(tone(196, 0.6), (v, i) => v + 0.05 * noise(0.6)[i]);
  const pedals = [pedal('boost', { boost: 6 }), pedal('dist', { gain: 20, tone: 0.5, level: -6 }), pedal('eq', { bass: 4, mid: -6, midFreq: 800, treble: 3, level: 0 }),
    pedal('wah', { mode: 1, position: 0.5, sensitivity: 12, speed: 1.5, resonance: 5 }), pedal('chorus', { rate: 0.8, depth: 0.5, mix: 0.6 }),
    pedal('phaser', { rate: 0.5, depth: 0.7, feedback: 0.4 }), pedal('trem', { rate: 5, depth: 0.6, shape: 0.3 }), pedal('swell', { rise: 200, sensitivity: -40 }),
    pedal('delay', { time: 120, feedback: 0.4, mix: 0.4, character: 0.7 }), pedal('reverb', { decay: 0.6, tone: 0.5, mix: 0.4 })].map((p, i) => ({ ...p, id: p.type + i }));
  const continuous = new EffectChain(input.length).process(input, pedals).slice();
  const blocks = new EffectChain(128), streamed = new Float32Array(input.length);
  for (let offset = 0; offset + 128 <= input.length; offset += 128) streamed.set(blocks.process(input.slice(offset, offset + 128), pedals, false), offset);
  for (let i = 0; i + 128 <= input.length; i++) assert(Math.abs(continuous[i] - streamed[i]) < 1e-4, 'sample ' + i);
});

test('boost adds clean gain; distortion flattens the tops', () => {
  const input = tone(220, 0.5, 0.1);
  const boosted = run('boost', { boost: 12 }, input);
  assert(Math.abs(rmsOf(boosted) / rmsOf(input) - 10 ** (12 / 20)) < 1e-3);
  const dist = run('dist', { gain: 40, tone: 1, level: 0 }, input);
  let peak = 0; for (let i = dist.length >> 1; i < dist.length; i++) peak = Math.max(peak, Math.abs(dist[i]));
  assert(peak <= 1.05 && peak / rmsOf(dist, dist.length >> 1) < 1.25, 'hard-clipped wave is nearly square');
});

test('tremolo pulses the volume at its rate and depth', () => {
  const out = run('trem', { rate: 4, depth: 0.8, shape: 0 }, tone(440, 1, 0.5));
  const slices = []; for (let k = 0; k < 40; k++) slices.push(rmsOf(out, k * SR / 40, (k + 1) * SR / 40));
  assert(Math.min(...slices) < 0.35 * Math.max(...slices));
});

test('swell fades each new note in instead of starting with the pick', () => {
  const input = new Float32Array(SR); for (let i = SR / 4; i < SR; i++) input[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / SR);
  const out = run('swell', { rise: 400, sensitivity: -40 }, input);
  assert(rmsOf(out, SR / 4, SR / 4 + SR / 50) < 0.05 * rmsOf(input, SR / 4, SR / 4 + SR / 50), 'first 20 ms are nearly silent');
  assert(rmsOf(out, SR * 0.8, SR) > 0.9 * rmsOf(input, SR * 0.8, SR), 'fully up after the rise time');
});

test('reverb rings after the note stops, longer with more decay', () => {
  const input = new Float32Array(SR * 2); input.set(tone(330, 0.2, 0.5));
  const tail = decay => rmsOf(run('reverb', { decay, tone: 0.5, mix: 0.5 }, input), SR * 0.6, SR * 0.9);
  assert(tail(0.2) > 1e-4 && tail(0.9) > 3 * tail(0.2));
});

test('chorus and phaser change the sound over time but keep the level', () => {
  const input = noise(2);
  for (const [type, params] of [['chorus', { rate: 1, depth: 1, mix: 1 }], ['phaser', { rate: 1, depth: 1, feedback: 0.5 }]]) {
    const out = run(type, params, input);
    const ratio = rmsOf(out) / rmsOf(input);
    assert(ratio > 0.5 && ratio < 1.2, type + ' level ' + ratio);
    // energy near 800 Hz moves as the effect sweeps
    const band = (from) => { const s = out.slice(from, from + SR / 8); return energyAt(Float32Array.from([...s, ...s]), 800); };
    const values = [0, 1, 2, 3, 4, 5, 6].map(k => band(Math.round(k * SR / 7)));
    assert(Math.max(...values) > 2 * Math.min(...values), type + ' sweeps');
  }
});

test('wah: toe is brighter than heel; following the picking opens it on loud notes', () => {
  const input = noise(1);
  const heel = run('wah', { mode: 0, position: 0, sensitivity: 12, speed: 1, resonance: 5 }, input);
  const toe = run('wah', { mode: 0, position: 1, sensitivity: 12, speed: 1, resonance: 5 }, input);
  assert(energyAt(toe, 2000) > 10 * energyAt(heel, 2000));
  assert(energyAt(heel, 350) > 10 * energyAt(toe, 350));
});

test('EQ boosts and cuts where it says, and its drawn response matches', () => {
  const p = { bass: 12, mid: -12, midFreq: 800, treble: 0, level: 0 };
  for (const f of [80, 800, 5000]) {
    const input = tone(f, 1, 0.1), out = run('eq', p, input);
    const measured = 20 * Math.log10(rmsOf(out, SR / 2) / rmsOf(input, SR / 2));
    assert(Math.abs(measured - eqResponse(p, f)) < 0.5, f + ' Hz: ' + measured + ' vs ' + eqResponse(p, f));
  }
  assert(eqResponse(p, 80) > 9 && eqResponse(p, 800) < -11);
});

test('delay character makes each repeat darker', () => {
  const input = new Float32Array(SR * 2); input.set(noise(0.05, 0.5));
  const echoTreble = character => { const out = run('delay', { time: 300, feedback: 0.6, mix: 1, character }, input); const second = out.slice(Math.round(SR * 0.6), Math.round(SR * 0.66)); return energyAt(Float32Array.from([...second, ...second]), 4000); };
  assert(echoTreble(1) < 0.1 * echoTreble(0));
});
