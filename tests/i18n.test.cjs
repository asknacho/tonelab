const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(languages = ['en-US'], saved, blocked = false) {
  const storage = new Map(saved ? [['tonelab-language', saved]] : []);
  const context = vm.createContext({
    navigator: { languages },
    document: { documentElement: {} },
    localStorage: {
      getItem: key => { if (blocked) throw new Error('Storage blocked'); return storage.get(key) || null; },
      setItem: (key, value) => { if (blocked) throw new Error('Storage blocked'); storage.set(key, value); },
    },
  });
  for (const file of ['dsp.js', 'locales/es.js', 'i18n.js', 'pedals.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), context);
  }
  return { context, i18n: context.TL.I18n, pedals: context.TL.Pedals, storage };
}

test('language follows browser preferences, supports regional Spanish, and respects explicit choices', () => {
  assert.equal(load(['es-MX', 'en-US']).i18n.language, 'es');
  assert.equal(load(['en-GB', 'es']).i18n.language, 'en');
  assert.equal(load(['fr-FR', 'es-ES']).i18n.language, 'es');
  assert.equal(load(['fr-FR']).i18n.language, 'en');
  assert.equal(load(['es-ES'], 'en').i18n.language, 'en');
  assert.equal(load(['en-US'], 'es').i18n.language, 'es');
  assert.equal(load(['es-ES'], 'invalid').i18n.language, 'es');
});

test('switching translates catalogs and formats in both directions without changing effect state or model names', () => {
  const { context, i18n, pedals, storage } = load();
  const originalModels = Object.fromEntries(Object.entries(pedals.types).map(([type, info]) => [type, info.models.map(model => [model.id, model.name])]));
  const originalControls = Object.fromEntries(Object.entries(pedals.types).map(([type, info]) => [type, info.models.map(model => pedals.controlsFor({ type, model: model.id }, true).map(c => [c.label, c.options]))]));
  const originalDefaults = JSON.stringify(Object.fromEntries(Object.entries(pedals.types).map(([type, info]) => [type, pedals.modelDefaults(type, info.models[0].id)])));
  const sound = { id: 'octave', group: 'Techniques', title: 'Ambient swells', chain: [['octave', { interval: 12 }, 'Your original note.']] };
  i18n.catalog(sound);
  let changes = 0;
  i18n.onChange(() => changes++);
  i18n.setLanguage('es');
  assert.equal(context.document.documentElement.lang, 'es');
  assert.equal(storage.get('tonelab-language'), 'es');
  assert.equal(pedals.types.gate.name, 'Noise gate');
  assert.match(pedals.types.gate.explanation, /Silencia/);
  assert.equal(pedals.types.gate.name, 'Noise gate');
  assert.equal(pedals.types.drive.short, 'Drive');
  assert.equal(pedals.types.octave.name, 'Octave');
  assert.equal(pedals.types.comp.specs[0].label, 'Threshold');
  assert.equal(pedals.types.comp.specs[0].hint, 'Nivel a partir del cual empieza a reducir el volumen.');
  assert.match(pedals.fmtInterval(7), /5th up/);
  assert.equal(context.TL.PATTERNS.guitar.group, 'Libre');
  assert.equal(sound.title, 'Swells ambientales');
  assert.equal(sound.chain[0][0], 'octave');
  assert.equal(sound.chain[0][2], 'Tu nota original.');
  for (const [type, info] of Object.entries(pedals.types)) {
    assert.deepEqual(info.models.map(model => [model.id, model.name]), originalModels[type]);
    assert.deepEqual(info.models.map(model => pedals.controlsFor({ type, model: model.id }, true).map(c => [c.label, c.options])), originalControls[type]);
    assert.equal(JSON.stringify(pedals.modelDefaults(type, info.models[0].id)), JSON.stringify(JSON.parse(originalDefaults)[type]));
    for (const model of info.models) assert.ok(pedals.controlsFor({ type, model: model.id }).every(control => typeof control.spec.key === 'string'));
  }
  i18n.setLanguage('en');
  assert.equal(pedals.types.gate.name, 'Noise gate');
  assert.equal(pedals.types.comp.specs[0].label, 'Threshold');
  assert.equal(sound.title, 'Ambient swells');
  assert.equal(context.TL.PATTERNS.guitar.group, 'Free');
  assert.equal(changes, 2);
  assert.equal(i18n.t('My custom sound 🎸'), 'My custom sound 🎸');
});

test('blocked storage still allows browser selection and live language switching', () => {
  const { i18n } = load(['es-AR'], undefined, true);
  assert.equal(i18n.language, 'es');
  assert.equal(i18n.t('Play'), 'Reproducir');
  assert.doesNotThrow(() => i18n.setLanguage('en'));
  assert.equal(i18n.t('Play'), 'Play');
  assert.doesNotThrow(() => i18n.setLanguage('es'));
  assert.equal(i18n.t('Unknown copy'), 'Unknown copy');
});
