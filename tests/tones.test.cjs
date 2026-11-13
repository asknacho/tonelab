const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '../js', file), 'utf8');
const context = vm.createContext({});
for (const file of ['dsp.js', 'pedals.js', 'locales/es.js']) vm.runInContext(read(file), context);
const app = read('app.js');
const start = app.indexOf('  const TONES = [');
const end = app.indexOf('  I18n?.catalog(TONES);', start);
assert(start >= 0 && end > start);
vm.runInContext(app.slice(start, end) + '\nglobalThis.tones = TONES;', context);
const { tones, TL } = context;
const addedIds = [
  'dimebag-walk', 'iommi-iron-man', 'morello-killing', 'van-halen-eruption',
  'santana-black-magic', 'knopfler-sultans', 'acdc-back-in-black', 'slash-sweet-child',
  'bb-king-thrill', 'zakk-no-more-tears', 'rhoads-crazy-train', 'gibbons-la-grange',
  'jones-schism', 'white-seven-nation',
];
const added = addedIds.map(id => tones.find(tone => tone.id === id));

function build(spec) {
  return spec.map(([descriptor, settings], i) => {
    const [type, named] = descriptor.split(':');
    const info = TL.Pedals.types[type];
    assert.ok(info, descriptor);
    const model = named || info.models[0].id;
    assert.ok(info, descriptor);
    assert.ok(info.models.some(item => item.id === model), descriptor);
    for (const [key, value] of Object.entries(settings)) {
      const control = info.specs.find(control => control.key === key);
      assert.ok(control, `${descriptor}.${key} exists`);
      assert.ok(Number.isFinite(value) && value >= control.min && value <= control.max, `${descriptor}.${key} is in range`);
      if (control.options) assert.ok(control.options.some(([option]) => option === value), `${descriptor}.${key} is a valid option`);
    }
    return { id: 'test-' + i, type, model, enabled: true, params: { ...TL.Pedals.modelDefaults(type, model), ...settings } };
  });
}

function render(tone, spec) {
  const size = 256;
  const input = new Float32Array(size);
  const source = new TL.Source(tone.source.kind);
  source.tempo = tone.source.tempo;
  source.noiseDb = tone.source.noise;
  const engine = new TL.EffectChain(size);
  const pedals = build(spec);
  const samples = [];
  for (let block = 0; block < 200; block++) {
    source.generate(input, 0, size);
    const output = engine.process(input, pedals, false);
    for (const value of output) {
      assert.ok(Number.isFinite(value), `${tone.id} produces finite audio`);
      samples.push(value);
    }
  }
  assert.ok(samples.some(value => Math.abs(value) > .001), `${tone.id} produces audible output`);
  return samples;
}

test('requested missing tones are unique, complete and use supported settings', () => {
  assert.equal(new Set(tones.map(tone => tone.id)).size, tones.length);
  assert.ok(added.every(Boolean));
  for (const id of ['queen-layers', 'gilmour-lead', 'srv-texas', 'hendrix-octave', 'edge-streets', 'beck-wah', 'audioslave-stone']) {
    assert.equal(tones.filter(tone => tone.id === id).length, 1, `preserve ${id}`);
  }
  for (const tone of added) {
    assert.ok(TL.PATTERNS[tone.source.kind]);
    assert.ok(tone.source.tempo >= 40 && tone.source.tempo <= 220);
    assert.ok(tone.summary && tone.play && tone.tip && tone.whatIfs.length);
    build(tone.chain);
    for (const variant of tone.whatIfs) build(variant.chain);
  }
});

test('every tone and its A/B comparisons render finite, audible, different audio', () => {
  for (const tone of tones) {
    const baseline = render(tone, tone.chain);
    for (const variant of tone.whatIfs) {
      const comparison = render(tone, variant.chain);
      const meanDifference = baseline.reduce((sum, sample, i) => sum + Math.abs(sample - comparison[i]), 0) / baseline.length;
      assert.ok(meanDifference > .0001, `${tone.id}: ${variant.id} changes the sound`);
    }
  }
});

test('every new learning explanation has Spanish copy', () => {
  for (const tone of added) {
    const copy = [tone.summary, tone.play, tone.tip, ...tone.chain.map(entry => entry[2]),
      ...tone.whatIfs.flatMap(variant => [variant.label, variant.note])];
    for (const english of copy) {
      assert.ok(Object.hasOwn(TL.es, english), `${tone.id}: ${english}`);
      assert.notEqual(TL.es[english], english);
    }
  }
});

test('every built-in tone uses supported pedals and settings, with Spanish copy', () => {
  for (const tone of tones) {
    assert.ok(TL.PATTERNS[tone.source.kind], tone.id);
    build(tone.chain);
    for (const variant of tone.whatIfs) build(variant.chain);
    const copy = [tone.summary, tone.play, tone.tip, ...tone.chain.map(entry => entry[2]),
      ...tone.whatIfs.flatMap(variant => [variant.label, variant.note])];
    for (const english of copy) assert.ok(Object.hasOwn(TL.es, english), `${tone.id}: ${english}`);
  }
});

test('corrected tones follow the documented rigs', () => {
  const tone = id => tones.find(item => item.id === id);
  const plain = value => JSON.parse(JSON.stringify(value));
  const pedals = id => plain(tone(id).chain.map(([descriptor]) => descriptor));
  const settings = (id, descriptor) => plain(tone(id).chain.filter(([d]) => d === descriptor).map(([, s]) => s));
  // Tom Morello: Whammy two octaves up and a Boss delay; no chorus or reverb.
  assert.deepEqual(pedals('audioslave-stone'), ['octave:whammy', 'drive:ocd', 'delay:dd3']);
  assert.equal(settings('audioslave-stone', 'octave:whammy')[0].interval, 24);
  // Stevie Ray Vaughan: Tube Screamer with Drive low and Level high; no compressor.
  assert.ok(!pedals('srv-texas').some(d => d.startsWith('comp')));
  assert.ok(settings('srv-texas', 'drive:ts9')[0].drive <= 5 && settings('srv-texas', 'drive:ts9')[0].level >= 5);
  // Brian May: one-repeat echoes at 800 and 1600 ms (two 800 ms delays in series).
  assert.deepEqual(settings('queen-layers', 'delay:dd3').map(s => [s.time, s.feedback]), [[800, 0], [800, 0]]);
  // Randy Rhoads: distortion first, then a graphic EQ boosting the mids.
  assert.deepEqual(pedals('rhoads-crazy-train').slice(0, 2), ['dist:rat', 'eq:ge7']);
  // Santana: a parked wah and no compressor.
  assert.equal(pedals('santana-black-magic')[0], 'wah:crybaby');
  assert.ok(!pedals('santana-black-magic').some(d => d.startsWith('comp')));
  // Zakk Wylde: the CH-1 chorus sat before the amps' distortion.
  assert.ok(pedals('zakk-no-more-tears').indexOf('chorus:ce2w') < pedals('zakk-no-more-tears').indexOf('dist:heavy'));
  // Johnny Marr: Boss chorus and the Twin's spring reverb. Andy Summers: Electric Mistress and a tape echo.
  assert.deepEqual(pedals('marr-jangle').slice(1), ['chorus:ce2w', 'reverb:fender']);
  assert.ok(pedals('summers-chorus').includes('chorus:flanger'));
  assert.equal(settings('summers-chorus', 'delay:multi')[0].type, 2);
  // Eddie Van Halen used an Echoplex tape echo; Gilmour's solo delay is about 480 ms.
  assert.equal(settings('van-halen-eruption', 'delay:multi')[0].type, 2);
  assert.equal(settings('gilmour-lead', 'delay')[0].time, 480);
});
