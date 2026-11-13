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

// ---- Full control sets (pedal models): each new control does what it says
const { diatonicShift } = context.TL;
const impulse = (seconds, at = 0) => { const b = new Float32Array(Math.round(SR * seconds)); b[at] = 1; return b; };
const firstPeak = (b, from = 1) => { let best = from; for (let i = from; i < b.length; i++) if (Math.abs(b[i]) > Math.abs(b[best])) best = i; return best; };
const mixOf = (...parts) => Float32Array.from(parts[0], (_, i) => parts.reduce((s, p) => s + p[i], 0));

test('gate: multiband mode only gates the highs; reduce mode never cuts more than 20 dB', () => {
  const quiet = mixOf(tone(100, 1, 0.003), noise(1, 0.003));
  const base = { threshold: -30, attack: 1, hold: 10, release: 50, range: -80, tone: 1500 };
  const mute = run('gate', { ...base, mode: 0 }, quiet), multi = run('gate', { ...base, mode: 2 }, quiet), reduce = run('gate', { ...base, mode: 1 }, quiet);
  assert(energyAt(multi, 100) > 100 * energyAt(mute, 100), 'lows pass in multiband');
  assert(energyAt(multi, 4000) < 0.01 * energyAt(quiet, 4000), 'highs are gated in multiband');
  assert(rmsOf(reduce, SR / 2) / rmsOf(quiet, SR / 2) > 0.09, 'reduce mode stays within 20 dB');
});

test('compressor: blend brings back the dry signal, input trims, tone tilts the treble', () => {
  const input = tone(440, 1, 0.5), p = { threshold: -30, ratio: 8, attack: 1, release: 50, knee: 0, makeup: 0 };
  const dry = run('comp', { ...p, blend: 0 }, input);
  assert(Math.abs(rmsOf(dry, SR / 2) - rmsOf(input, SR / 2)) < 1e-6);
  const hot = run('comp', { ...p, blend: 0, input: 6 }, input);
  assert(Math.abs(rmsOf(hot, SR / 2) / rmsOf(input, SR / 2) - 10 ** (6 / 20)) < 1e-3);
  const n = noise(1);
  assert(energyAt(run('comp', { ...p, tone: 1 }, n), 6000) > 4 * energyAt(run('comp', { ...p, tone: 0 }, n), 6000));
});

test('EQ: graphic sliders, narrow bands and presence match the drawn response', () => {
  const p = { bass: 6, bassFreq: 200, bassQ: 3, mid: 0, midFreq: 800, treble: 0, level: 0, presence: 6, g800: 9, g3200: -9 };
  for (const f of [200, 800, 3200, 7000]) {
    const input = tone(f, 1, 0.1), out = run('eq', p, input);
    const measured = 20 * Math.log10(rmsOf(out, SR / 2) / rmsOf(input, SR / 2));
    assert(Math.abs(measured - eqResponse(p, f)) < 0.5, f + ' Hz');
  }
  assert(eqResponse(p, 800) > 8 && eqResponse(p, 3200) < -6);
  assert(eqResponse(p, 200) - eqResponse(p, 60) > 3, 'a narrow bass band is a peak, not a shelf');
});

test('boost: voicing and tone controls shape it, level sets the output', () => {
  const n = noise(1);
  const clean = run('boost', { boost: 6, voicing: 0 }, n), fat = run('boost', { boost: 6, voicing: 1 }, n), mid = run('boost', { boost: 6, voicing: 2 }, n);
  assert(energyAt(fat, 150) > 2 * energyAt(clean, 150) && energyAt(mid, 800) > 2 * energyAt(clean, 800));
  assert(Math.abs(rmsOf(run('boost', { boost: 6, level: -6 }, tone(440, 1, 0.1))) / rmsOf(tone(440, 1, 0.1)) - 1) < 1e-3);
});

test('overdrive: asymmetric clipping adds even harmonics; the mid hump cuts lows before clipping', () => {
  const input = tone(220, 1, 0.3), p = { drive: 18, mix: 1 };
  const sym = run('drive', { ...p, clipping: 0 }, input), asym = run('drive', { ...p, clipping: 1 }, input);
  assert(energyAt(asym, 440) > 100 * energyAt(sym, 440));
  const n = noise(1, 0.2);
  assert(energyAt(run('drive', { ...p, voicing: 1 }, n), 100) < 0.5 * energyAt(run('drive', { ...p, voicing: 0 }, n), 100));
});

test('distortion: tight and weight cut the lows; mid EQ works after the clipper', () => {
  const n = noise(1, 0.2), p = { gain: 30, tone: 0.6, level: -6 };
  assert(energyAt(run('dist', { ...p, tight: 1 }, n), 90) < 0.5 * energyAt(run('dist', { ...p, tight: 0 }, n), 90));
  assert(energyAt(run('dist', { ...p, mid: -12, midFreq: 800 }, n), 800) < 0.25 * energyAt(run('dist', p, n), 800));
});

test('fuzz: the gate starves quiet notes and low stability squeals', () => {
  const quiet = tone(220, 1, 0.005), p = { fuzz: 30, tone: 0.6, level: -8 };
  assert(rmsOf(run('fuzz', { ...p, gate: 0.8 }, quiet), SR / 2) < 0.3 * rmsOf(run('fuzz', p, quiet), SR / 2));
  const loud = tone(220, 1, 0.2);
  assert(energyAt(run('fuzz', { ...p, stability: 0.2, tone: 1 }, loud), 1400) > 10 * energyAt(run('fuzz', { ...p, tone: 1 }, loud), 1400));
});

test('wah: low-pass and high-pass filter types, and the envelope can sweep down', () => {
  const n = noise(1), p = { mode: 0, position: 0.5, sensitivity: 12, speed: 1, resonance: 4 };
  assert(energyAt(run('wah', { ...p, filter: 1 }, n), 150) > 4 * energyAt(run('wah', { ...p, filter: 2 }, n), 150));
  assert(energyAt(run('wah', { ...p, filter: 2 }, n), 6000) > 4 * energyAt(run('wah', { ...p, filter: 1 }, n), 6000));
  const loud = noise(1, 0.5), up = run('wah', { ...p, mode: 1, sensitivity: 20 }, loud), down = run('wah', { ...p, mode: 1, sensitivity: 20, direction: 1 }, loud);
  assert(energyAt(up, 2000) > 2 * energyAt(down, 2000));
});

test('octave: a second octave down and a Whammy-style shifted voice', () => {
  const input = tone(220);
  const sub2 = run('octave', { dry: 0, sub: 0, up: 0, sub2: 1 }, input);
  assert(energyAt(sub2, 55) > 10 * energyAt(sub2, 220));
  const whammy = run('octave', { dry: 0, sub: 0, up: 0, shift: 1, interval: 12, treadle: 1 }, input);
  assert(energyAt(whammy, 440) > 10 * energyAt(whammy, 220));
  const half = run('octave', { dry: 0, sub: 0, up: 0, shift: 1, interval: 12, treadle: 0.5 }, input);
  assert(energyAt(half, 220 * 2 ** 0.5) > 10 * energyAt(half, 220), 'half treadle = half the interval');
});

test('harmonizer: scale modes pick the interval that fits the key', () => {
  assert.equal(diatonicShift(62, 2, [0, 2, 4, 5, 7, 9, 11], 2), 4); // D in D major: a 3rd up is F#
  assert.equal(diatonicShift(64, 2, [0, 2, 4, 5, 7, 9, 11], 2), 3); // E in D major: a 3rd up is G
  assert.equal(diatonicShift(57, 9, [0, 2, 3, 5, 7, 8, 10], 2), 3); // A in A minor: a 3rd up is C
  const out = run('harm', { voice1: 4, voice2: 0, mix: 1, window: 50, mode: 1, key: 0, steps1: 2, steps2: 0 }, tone(220)); // A in C major -> C
  assert(energyAt(out, 261.6) > 10 * energyAt(out, 277.2), 'a minor third (C), not a major third (C#)');
});

test('chorus: vibrato voice drops the dry signal; a short manual delay flanges', () => {
  const input = tone(440, 1, 0.3);
  const vib = run('chorus', { rate: 3, depth: 1, mix: 0.6, voice: 2 }, input);
  let diff = 0; for (let i = SR / 2; i < SR; i++) diff = Math.max(diff, Math.abs(vib[i] - input[i - 288]));
  assert(diff > 0.05, 'pitch wobbles');
  const n = noise(1), flange = run('chorus', { rate: 0.1, depth: 0, mix: 1, manual: 1, feedback: 0.7 }, n);
  assert(energyAt(flange, 500) > 4 * energyAt(flange, 1000) || energyAt(flange, 1000) > 4 * energyAt(flange, 500), 'comb filter peaks and notches');
});

test('phaser: 8 stages and Uni-Vibe modes sound different from the 4-stage phaser', () => {
  const n = noise(1), p = { rate: 0.5, depth: 0.7, feedback: 0.4 };
  const four = run('phaser', p, n);
  for (const extra of [{ stages: 8 }, { mode: 1 }, { mode: 2 }]) {
    const other = run('phaser', { ...p, ...extra }, n);
    let d = 0; for (let i = 0; i < n.length; i++) d += (other[i] - four[i]) ** 2;
    assert(Math.sqrt(d / n.length) > 0.02, JSON.stringify(extra));
  }
});

test('tremolo: harmonic mode pulses lows and highs in turn; square wave chops', () => {
  const input = mixOf(tone(100, 1, 0.3), tone(3000, 1, 0.3));
  const out = run('trem', { rate: 4, depth: 1, shape: 0, mode: 1 }, input);
  const slice = (f, k) => energyAt(Float32Array.from(out.slice(k * SR / 16, (k + 1) * SR / 16)), f);
  const lows = [0, 1, 2, 3].map(k => slice(100, k + 8)), highs = [0, 1, 2, 3].map(k => slice(3000, k + 8));
  const loudestLow = lows.indexOf(Math.max(...lows)), loudestHigh = highs.indexOf(Math.max(...highs));
  assert.notEqual(loudestLow, loudestHigh);
  const sq = run('trem', { rate: 4, depth: 1, shape: 0, wave: 1 }, tone(440, 1, 0.5));
  let silent = 0; for (let i = 0; i < SR; i += 100) if (Math.abs(sq[i]) < 0.01) silent++;
  assert(silent > 0.3 * (SR / 100));
});

test('swell: the linear curve rises faster at first than the smooth one', () => {
  const input = new Float32Array(SR); for (let i = SR / 4; i < SR; i++) input[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / SR);
  const at = b => rmsOf(b, SR / 4 + SR / 10, SR / 4 + SR / 8);
  assert(at(run('swell', { rise: 400, sensitivity: -40, curve: 1 }, input)) > 1.5 * at(run('swell', { rise: 400, sensitivity: -40, curve: 0 }, input)));
});

test('delay: subdivision, range, reverse and tape', () => {
  const p = { time: 400, feedback: 0, mix: 1 };
  assert(Math.abs(firstPeak(run('delay', { ...p, subdivision: 2 }, impulse(1))) - 0.3 * SR) < 2, 'dotted eighth = ¾ of the time');
  assert(Math.abs(firstPeak(run('delay', { ...p, range: 200 }, impulse(1))) - 0.2 * SR) < 2, 'range caps the time');
  const ramp = Float32Array.from({ length: SR }, (_, i) => (i < 0.3 * SR ? i / (0.3 * SR) : 0));
  const rev = run('delay', { ...p, time: 300, type: 3 }, ramp);
  const early = rmsOf(rev, Math.round(0.33 * SR), Math.round(0.4 * SR)), late = rmsOf(rev, Math.round(0.5 * SR), Math.round(0.57 * SR));
  assert(early > late, 'the loud end of the ramp comes back first');
  const tape = run('delay', { ...p, time: 200, type: 2 }, tone(1000, 1, 0.3)), digital = run('delay', { ...p, time: 200 }, tone(1000, 1, 0.3));
  let d = 0; for (let i = SR / 2; i < SR; i++) d = Math.max(d, Math.abs(tape[i] - digital[i]));
  assert(d > 0.05, 'tape wobbles');
});

test('reverb: pre-delay, low cut, and spring and shimmer modes', () => {
  const p = { decay: 0.7, tone: 0.6, mix: 1 };
  const onset = b => { for (let i = 1; i < b.length; i++) if (Math.abs(b[i]) > 1e-3) return i; return -1; };
  const click = impulse(1.5);
  assert(onset(run('reverb', { ...p, predelay: 100 }, click)) - onset(run('reverb', p, click)) > 0.09 * SR);
  const n = noise(0.3, 0.3), long = new Float32Array(SR * 2); long.set(n);
  const tail = b => Float32Array.from(b.slice(Math.round(0.4 * SR), Math.round(1.2 * SR)));
  assert(energyAt(tail(run('reverb', { ...p, lowCut: 400 }, long)), 100) < 0.3 * energyAt(tail(run('reverb', p, long)), 100));
  const t = new Float32Array(SR * 2); t.set(tone(330, 0.3, 0.4));
  const shimmer = tail(run('reverb', { ...p, mode: 4 }, t)), room = tail(run('reverb', p, t));
  assert(energyAt(shimmer, 660) / energyAt(shimmer, 330) > 2 * energyAt(room, 660) / energyAt(room, 330), 'shimmer adds the octave above');
  const spring = run('reverb', { ...p, mode: 3 }, long);
  assert(spring.every(Number.isFinite) && rmsOf(spring) > 0);
  const plate = run('reverb', { ...p, mode: 2 }, long);
  assert(rmsOf(spring) < 2 * rmsOf(plate), 'spring dispersion adds no large gain');
});

// ---- Playing patterns: strums, picking, single sustained notes, tweakable speed
const { Source, PATTERNS } = context.TL;
const playPattern = (kind, tempo, seconds) => { const s = new Source(kind); s.noiseDb = -90; s.tempo = tempo; const b = new Float32Array(Math.round(SR * seconds)); s.generate(b, 0, b.length); return b; };
// Strum onsets: a strum is several strings a few ms apart, so group them with a refractory time.
const strumOnsets = (b) => {
  const w = Math.round(SR * 0.01); const out = []; let prev = 0, last = -9;
  for (let i = 0; i + w <= b.length; i += w) { const e = rmsOf(b, i, i + w); if (e > 0.04 && e > 1.8 * prev && i / SR - last > 0.2) { out.push(i / SR); last = i / SR; } prev = e; }
  return out;
};

test('every playing pattern is well formed and renders clean, sensible audio', () => {
  for (const [id, p] of Object.entries(PATTERNS)) {
    assert(typeof p.label === 'string' && p.group, id + ' has a label and a group');
    if (!p.tempo) continue;
    if (p.grid) {
      const tokens = p.steps.split(' ');
      assert.equal(tokens.length, p.grid, id + ': one token per step');
      assert(tokens.every(t => /^[DUduxbchL0-5.]$/.test(t)), id + ': valid tokens');
      assert(p.chords.length > 0 && p.chords.every(c => c.length >= 3 && c.every(f => f > 60 && f < 500)), id + ': chords');
    }
    const audio = playPattern(id, p.tempo, 6);
    let peak = 0; for (const v of audio) { assert(Number.isFinite(v)); peak = Math.max(peak, Math.abs(v)); }
    assert(peak > 0.05 && peak < 1.0, id + ' peak ' + peak);
    assert(rmsOf(audio, SR) > 0.01, id + ' is audible');
  }
});

test('speed scales the rhythm: doubling the tempo doubles the strums', () => {
  const count = bpm => strumOnsets(playPattern('strum-down', bpm, 12)).length;
  const slow = count(60), fast = count(120);
  assert(Math.abs(slow - 12) <= 1, 'quarter notes at 60 BPM: ' + slow);
  assert(Math.abs(fast - 2 * slow) <= 2, 'at 120 BPM: ' + fast);
});

test('a strum plays the chord, a bass pick plays one string', () => {
  const slice = b => Float32Array.from(b.slice(Math.round(0.15 * SR), Math.round(0.9 * SR)));
  const strum = slice(playPattern('strum-down', 60, 2)), bass = slice(playPattern('boomchick', 60, 2));
  // D chord: its top string (F♯4, 370 Hz) sounds, and a note it doesn't contain (185 Hz) doesn't.
  assert(energyAt(strum, 370) > 3 * energyAt(strum, 185), 'the chord’s notes are there');
  // The bass pick is the G string alone: 98 Hz, with none of the chord's B (123.5 Hz).
  assert(energyAt(bass, 98) > 50 * energyAt(bass, 123.5), 'one string only');
});

test('the sustain pattern rings for seconds, and its speed follows the tempo', () => {
  const held = playPattern('sustain', 60, 7);
  const at = t => rmsOf(held, Math.round(t * SR), Math.round((t + 0.05) * SR));
  assert(at(3.1) > 0.1 * at(0.15), 'still above -20 dB three seconds after the pick');
  assert(at(5.1) > 0.02 * at(0.15), 'and still audible five seconds after');
  const quick = playPattern('sustain', 120, 4); // notes 3 s apart instead of 6
  const jump = rmsOf(quick, Math.round(3.15 * SR), Math.round(3.25 * SR)) / rmsOf(quick, Math.round(2.9 * SR), Math.round(3.0 * SR));
  assert(jump > 2, 'a new note lands at 3.1 s at 120 BPM (jump ' + jump.toFixed(1) + '×)');
});

test('a shuffle uses a triplet grid and chugs are palm-muted (short)', () => {
  assert.equal(PATTERNS.shuffle.grid, 12);
  const chug = playPattern('chug', 120, 3), power = playPattern('power', 120, 3);
  // Compare just before the next hit: the muted chug has died, the open chord still rings.
  const decay = b => rmsOf(b, Math.round(0.28 * SR), Math.round(0.33 * SR)) / rmsOf(b, Math.round(0.12 * SR), Math.round(0.17 * SR));
  assert(decay(chug) < 0.05 && decay(power) > 0.2, 'chug ' + decay(chug).toFixed(3) + ', open chord ' + decay(power).toFixed(3));
});

test('local recording source loops exact samples without synthesized noise', () => {
  const source = new context.TL.Source('guitar');
  const clip = Float32Array.from([0, 0.25, -0.5, 0.75, -0.125]);
  source.noiseDb = -20;
  source.setRecording(clip);
  source.setKind('recording');
  const first = new Float32Array(7), second = new Float32Array(8);
  source.generate(first, 0, first.length);
  source.generate(second, 0, second.length);
  const streamed = [...first, ...second];
  assert.deepEqual(streamed, Array.from({ length: 15 }, (_, i) => clip[i % clip.length]));
  source.setRecording(Float32Array.from([0.1, -0.1]));
  const replaced = new Float32Array(3);
  source.generate(replaced, 0, 3);
  assert.deepEqual([...replaced], [...Float32Array.from([0.1, -0.1, 0.1])]);
  source.setKind('guitar');
  source.setKind('recording');
  assert.equal(source.recordingPosition, 0);
});

test('recorded audio feeds both worklet banks and pauses without advancing', () => {
  let Processor;
  const messages = [];
  const ctx = vm.createContext({ Float32Array, Math, sampleRate: 24000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: msg => messages.push(msg) }; } },
    registerProcessor: (_, value) => { Processor = value; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/dsp.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/audio-worklet.js'), 'utf8').replace("import './dsp.js';", ''), ctx);
  const processor = new Processor();
  const clip = Float32Array.from({ length: 300 }, (_, i) => 0.2 * Math.sin(i * 0.11));
  processor.port.onmessage({ data: { type: 'recording', samples: clip } });
  const fuzz = { id: 'f', type: 'fuzz', enabled: true, params: { fuzz: 24, tone: 0.5, level: -8 } };
  const settings = { type: 'settings', kind: 'recording', noiseDb: -20, monitor: 'wet', volume: 0.5, matchVolume: false,
    activeBank: 'A', banks: { A: [], B: [fuzz] }, state: { chain: [], playing: true, speed: 2 } };
  processor.port.onmessage({ data: settings });
  const out = new Float32Array(128);
  for (let i = 0; i < 5; i++) processor.process([], [[out]]);
  assert.equal(messages.length, 3, 'recordings ignore synthetic tempo multiplier');
  assert(out.some(v => v !== 0));
  assert.deepEqual([...messages[0].views.A.input], [...messages[0].views.B.input]);
  assert(messages[0].views.B.output.some((v, i) => Math.abs(v - messages[0].views.A.output[i]) > 0.01));
  settings.state.playing = false;
  const position = processor.source.recordingPosition;
  processor.process([], [[out]]);
  assert(out.every(v => v === 0));
  assert.equal(processor.source.recordingPosition, position);
  settings.state.playing = true;
  processor.process([], [[out]]);
  assert(out.some(v => v !== 0));
  processor.port.onmessage({ data: { type: 'recording', samples: new Float32Array(8).fill(0.15) } });
  processor.process([], [[out]]);
  assert(messages.at(-1).samples.every(v => Math.abs(v - 0.15) < 1e-6));
  processor.port.onmessage({ data: { ...settings, kind: 'guitar' } });
  assert.equal(processor.source.kind, 'guitar');
});

test('a recorded riff starts on its first note and loops without clicks', () => {
  const { trimRiff } = context.TL;
  // 0.5 s of quiet hiss, a 1 s note, then 0.5 s of digital silence.
  const riff = new Float32Array(Math.round(2 * SR));
  let seed = 1;
  for (let i = 0; i < riff.length; i++) {
    seed = (seed * 16807) % 2147483647;
    const hiss = 0.0005 * (seed / 2147483647 - 0.5);
    riff[i] = i < 0.5 * SR ? hiss : i < 1.5 * SR ? 0.6 * Math.sin(i * 0.05) * Math.exp(-(i - 0.5 * SR) / SR) : 0;
  }
  const out = trimRiff(riff);
  const firstLoud = out.findIndex(v => Math.abs(v) > 0.1);
  assert(firstLoud >= 0 && firstLoud < 0.03 * SR, `the loop starts within 30 ms of the note (${(firstLoud / SR * 1000).toFixed(1)} ms)`);
  assert(out.length < 1.15 * SR && out.length > 0.95 * SR, `leading hiss and trailing silence are cut (${(out.length / SR).toFixed(2)} s)`);
  assert(Math.abs(out[0]) < 1e-3 && Math.abs(out.at(-1)) < 1e-3, 'both ends fade to zero');
  const silent = trimRiff(new Float32Array(100));
  assert.equal(silent.length, 100, 'silence is returned unchanged');
});
