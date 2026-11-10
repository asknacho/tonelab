/*
 * Tonelab UI: builds the controls, runs the signal through the effect chain
 * every frame and draws the scope, the gain lanes and the transfer curves.
 */
(function (TL) {
  'use strict';

  const { SR, dbToLin, linToDb, Source, EffectChain, compCurve } = TL;

  const VIEW_SECONDS = 3;   // visible window
  const PRE_SECONDS = 1;    // processed but hidden, so effect state is settled at the left edge
  const VIEW = VIEW_SECONDS * SR;
  const PRE = PRE_SECONDS * SR;
  const N = VIEW + PRE;
  const LEVEL_WINDOW = Math.round(0.03 * SR); // window for the "current level" dot

  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const C = {
    ink: color('--ink'),
    ink2: color('--ink-2'),
    ink3: color('--ink-3'),
    ghost: color('--ghost'),
    grid: color('--grid'),
    rule: color('--rule'),
    paper: color('--paper'),
    gate: color('--gate'),
    gateSoft: color('--gate-soft'),
    comp: color('--comp'),
    compSoft: color('--comp-soft'),
    mono: color('--mono'),
  };

  const fmt = (v, d = 1) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d).replace('-', '−');
  const fmtMs = (v) => (v < 10 ? fmt(v, 1) : fmt(v, 0)) + ' ms';
  const fmtDb = (v) => (v <= -79.5 ? '−∞' : fmt(v, 0)) + ' dB';

  /* ------------------------------------------------------------- params */

  const GATE_PARAMS = [
    { key: 'threshold', label: 'Threshold', min: -70, max: 0, step: 1, value: -36, format: fmtDb,
      hint: 'Level the input has to reach to open the gate.' },
    { key: 'attack', label: 'Attack', min: 0.1, max: 50, value: 1, log: true, format: fmtMs,
      hint: 'How quickly it opens.' },
    { key: 'hold', label: 'Hold', min: 0, max: 500, step: 1, value: 40, format: fmtMs,
      hint: 'How long it stays open after the level drops.' },
    { key: 'release', label: 'Release', min: 5, max: 1500, value: 120, log: true, format: fmtMs,
      hint: 'How slowly it closes.' },
    { key: 'range', label: 'Range', min: -80, max: 0, step: 1, value: -80, format: fmtDb,
      hint: 'How much quieter the signal gets when closed.' },
  ];

  const COMP_PARAMS = [
    { key: 'threshold', label: 'Threshold', min: -60, max: 0, step: 1, value: -22, format: fmtDb,
      hint: 'Level above which it starts turning down.' },
    { key: 'ratio', label: 'Ratio', min: 1, max: 20, value: 4, log: true, format: (v) => fmt(v, 1) + ':1',
      hint: 'How hard it turns down above the threshold.' },
    { key: 'attack', label: 'Attack', min: 0.1, max: 200, value: 8, log: true, format: fmtMs,
      hint: 'How quickly it clamps down on a peak.' },
    { key: 'release', label: 'Release', min: 10, max: 1500, value: 180, log: true, format: fmtMs,
      hint: 'How quickly it lets go afterwards.' },
    { key: 'knee', label: 'Knee', min: 0, max: 24, step: 1, value: 6, format: (v) => fmt(v, 0) + ' dB',
      hint: 'Width of the soft transition around the threshold.' },
    { key: 'makeup', label: 'Makeup', min: 0, max: 24, step: 0.5, value: 0, format: (v) => '+' + fmt(v, 1) + ' dB',
      hint: 'Gain added after compression.' },
  ];

  const DRIVE_PARAMS = [
    { key: 'drive', label: 'Drive', min: 0, max: 30, step: 0.5, value: 8, format: fmtDb, hint: 'Gain pushed into soft clipping.' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0.4, format: v => Math.round(v * 100) + '%', hint: 'Blend the distorted sound with the incoming signal.' },
  ];
  const DELAY_PARAMS = [
    { key: 'time', label: 'Time', min: 60, max: 700, step: 1, value: 300, format: fmtMs, hint: 'Time between repeats.' },
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.75, step: 0.01, value: 0.35, format: v => Math.round(v * 100) + '%', hint: 'How much of each echo feeds the next.' },
    { key: 'mix', label: 'Mix', min: 0, max: 0.8, step: 0.01, value: 0.3, format: v => Math.round(v * 100) + '%', hint: 'Balance between the signal and its echoes.' },
  ];
  const pct = v => Math.round(v * 100) + '%';
  const FUZZ_PARAMS = [
    { key: 'fuzz', label: 'Fuzz', min: 0, max: 45, step: 0.5, value: 30, format: fmtDb, hint: 'Gain into the clipper. Turn it up and the wave becomes a square.' },
    { key: 'tone', label: 'Tone', min: 0, max: 1, step: 0.01, value: 0.5, format: pct, hint: 'Dark to bright: a filter that tames the fizz.' },
    { key: 'level', label: 'Level', min: -30, max: 0, step: 0.5, value: -8, format: fmtDb, hint: 'Output volume.' },
  ];
  const OCTAVE_PARAMS = [
    { key: 'dry', label: 'Dry', min: 0, max: 1, step: 0.01, value: 0.7, format: pct, hint: 'Your original note.' },
    { key: 'sub', label: 'Octave down', min: 0, max: 1, step: 0.01, value: 0.6, format: pct, hint: 'A switch flips once per cycle, making a square wave at half the frequency.' },
    { key: 'up', label: 'Octave up', min: 0, max: 1, step: 0.01, value: 0.3, format: pct, hint: 'Folding the bottom half of the wave up doubles its frequency.' },
  ];
  const INTERVALS = ['unison', 'minor 2nd', 'major 2nd', 'minor 3rd', 'major 3rd', '4th', 'tritone', '5th', 'minor 6th', 'major 6th', 'minor 7th', 'major 7th', 'octave'];
  const fmtInterval = v => v === 0 ? 'Unison' : (v > 0 ? '+' : '−') + Math.abs(v) + ' · ' + INTERVALS[Math.abs(v)] + (v > 0 ? ' up' : ' down');
  const HARM_PARAMS = [
    { key: 'voice1', label: 'Voice 1', min: -12, max: 12, step: 1, value: 4, format: fmtInterval, hint: 'Interval of the first harmony, in semitones.' },
    { key: 'voice2', label: 'Voice 2', min: -12, max: 12, step: 1, value: 7, format: v => v === 0 ? 'Off' : fmtInterval(v), hint: 'Add a second voice to make a chord. Set it to 0 to turn it off.' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0.5, format: pct, hint: 'Balance between your note and the harmony.' },
    { key: 'window', label: 'Window', min: 20, max: 120, step: 1, value: 50, format: fmtMs, hint: 'How much audio each voice replays. Short windows warble on low notes; long ones smear fast playing.' },
  ];
  // `model` names the classic pedal whose outline each card borrows.
  const types = {
    gate: { name: 'Noise gate', short: 'Gate', model: 'ISP Decimator', specs: GATE_PARAMS, explanation: 'Silences the quiet parts. Attack opens the gate; hold and release preserve the tails. Try a gate after delay to cut off the echoes.' },
    comp: { name: 'Compressor', short: 'Comp', model: 'MXR Dyna Comp', specs: COMP_PARAMS, explanation: 'Controls peaks above the threshold. Two compressors can share the work: use the first for gentle leveling and the second to catch the remaining peaks.' },
    drive: { name: 'Overdrive', short: 'Drive', model: 'Ibanez Tube Screamer', specs: DRIVE_PARAMS, explanation: 'Adds harmonics by rounding off peaks. Try compression before drive for a more even distortion, or after it to tame the result.' },
    fuzz: { name: 'Fuzz', short: 'Fuzz', model: 'Dallas Arbiter Fuzz Face', specs: FUZZ_PARAMS, explanation: 'Clips so hard the wave turns almost square, and the two halves clip unevenly for a sputtery edge. Compare it with overdrive, which only rounds the peaks.' },
    octave: { name: 'Octave', short: 'Octave', model: 'Electro-Harmonix POG', specs: OCTAVE_PARAMS, explanation: 'Adds notes an octave below and above. It tracks single notes best; chords confuse it, much like an analog octave pedal. Watch the octave down turn the wave into wide square steps.' },
    harm: { name: 'Harmonizer', short: 'Harmony', model: 'DigiTech Whammy', specs: HARM_PARAMS, explanation: 'Adds pitch-shifted copies of your playing to build harmonies. Each voice replays the last few milliseconds faster (higher) or slower (lower). Put it before drive for a thicker sound, or after for clearer voices.' },
    delay: { name: 'Delay', short: 'Delay', model: 'Boss DD-3', specs: DELAY_PARAMS, explanation: 'Time sets the spacing of echoes; feedback controls their decay. Stack two delays at different times for a more complex rhythm.' },
  };
  let nextId = 0;
  const counts = Object.fromEntries(Object.keys(types).map(type => [type, 0]));

  /* Pedal outlines, drawn in a 76 × 140 box. Knobs and faders point at the
   * pedal's real settings. `inset` and `jack` place the cable connections. */
  const ART_W = 76, ART_H = 140;
  function level(pedal, key) {
    const spec = types[pedal.type].specs.find(s => s.key === key);
    const v = pedal.params[key];
    const t = spec.log ? Math.log(v / spec.min) / Math.log(spec.max / spec.min) : (v - spec.min) / (spec.max - spec.min);
    return Math.max(0, Math.min(1, t));
  }
  function knob(cx, cy, r, t) {
    const a = (-135 + 270 * t) * Math.PI / 180;
    const x = (cx + Math.sin(a) * (r - 1.6)).toFixed(1), y = (cy - Math.cos(a) * (r - 1.6)).toFixed(1);
    return `<circle class="art-knob" cx="${cx}" cy="${cy}" r="${r}"/><line class="art-pointer" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/>`;
  }
  const stomp = (cx, cy, r = 6.5) => `<circle class="art-line" cx="${cx}" cy="${cy}" r="${r + 3.5}"/><circle class="art-switch" cx="${cx}" cy="${cy}" r="${r}"/>`;
  const ridges = (ys, x1, x2) => ys.map(y => `<line class="art-line" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/>`).join('');
  const led = (cx, cy) => `<circle class="art-led-glow" cx="${cx}" cy="${cy}" r="4.5"/><circle class="art-led" cx="${cx}" cy="${cy}" r="2.3"/>`;
  const ART = {
    gate: { inset: 9, jack: 66, led: [58, 36], draw: p => `<rect class="art-body" x="9" y="1" width="58" height="138" rx="5"/>${knob(38, 36, 9, level(p, 'threshold'))}${stomp(38, 98)}` },
    comp: { inset: 9, jack: 66, led: [38, 26], draw: p => `<rect class="art-body" x="9" y="1" width="58" height="138" rx="3"/>` +
      [[14, 6], [62, 6], [14, 134], [62, 134]].map(([x, y]) => `<circle class="art-line" cx="${x}" cy="${y}" r="1.4"/>`).join('') +
      knob(25, 36, 7, level(p, 'makeup')) + knob(51, 36, 7, level(p, 'ratio')) + stomp(38, 98) },
    drive: { inset: 3, jack: 66, led: [38, 19], draw: p => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="8"/>${knob(19, 36, 7, level(p, 'drive'))}${knob(38, 31, 4.5, 0.5)}${knob(57, 36, 7, level(p, 'mix'))}<rect class="art-switch" x="10" y="82" width="56" height="52" rx="3"/>` },
    fuzz: { inset: 1.5, jack: 70, led: [38, 47], draw: p => `<circle class="art-body" cx="38" cy="70" r="36.5"/>${knob(26, 46, 6, level(p, 'fuzz'))}${knob(50, 46, 6, level(p, 'level'))}${stomp(38, 95, 5)}` },
    octave: { inset: 3, jack: 66, led: [64, 36], draw: p => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="4"/>` +
      ['dry', 'sub', 'up'].map((key, i) => {
        const x = 22 + i * 16, y = 44 - level(p, key) * 16;
        return `<line class="art-line" x1="${x}" y1="25" x2="${x}" y2="46"/><rect class="art-knob" x="${x - 4.5}" y="${y - 2.5}" width="9" height="5" rx="1"/>`;
      }).join('') + stomp(38, 98) },
    harm: { inset: 1, jack: 66, led: [45, 33], draw: p => `<rect class="art-body" x="1" y="1" width="74" height="138" rx="10"/>${knob(22, 33, 8, level(p, 'voice1'))}<rect class="art-line" x="38" y="27" width="28" height="12" rx="2"/><rect class="art-switch" x="7" y="50" width="62" height="84" rx="7"/>${ridges([88, 94, 100, 106, 112], 15, 61)}` },
    delay: { inset: 3, jack: 66, led: [38, 19], draw: p => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="4"/>${knob(14, 36, 5.5, level(p, 'mix'))}${knob(30, 36, 5.5, level(p, 'feedback'))}${knob(46, 36, 5.5, level(p, 'time'))}${knob(62, 36, 5.5, 0.5)}<path class="art-switch" d="M10 80 H66 L70 86 V134 Q70 137 67 137 H9 Q6 137 6 134 V86 Z"/>${ridges([93, 98, 103, 108], 16, 60)}` },
  };
  function pedalArt(pedal) {
    const { inset, jack, draw } = ART[pedal.type];
    const jacks = `<rect class="art-jack" x="${inset - 3}" y="${jack - 3}" width="3" height="6"/><rect class="art-jack" x="${ART_W - inset}" y="${jack - 3}" width="3" height="6"/>`;
    return jacks + draw(pedal) + led(...ART[pedal.type].led);
  }
  const artSvg = (pedal, cls) => `<svg class="${cls}" viewBox="0 0 ${ART_W} ${ART_H}" aria-hidden="true" focusable="false">${pedalArt(pedal)}</svg>`;
  function createPedal(type, params) {
    return { id: 'pedal-' + (++nextId), type, number: ++counts[type], enabled: true,
      params: params ? { ...params } : Object.fromEntries(types[type].specs.map(p => [p.key, p.value])) };
  }
  const state = { playing: true, speed: 1, scale: 'db', chain: ['gate', 'comp', 'drive', 'delay'].map(type => createPedal(type)), dirty: true };
  const clone = value => JSON.parse(JSON.stringify(value));
  const storageKey = 'tonelab-board-v1';
  let activeBank = 'A';
  let banks = { A: clone(state.chain), B: clone(state.chain) };
  let restoredNoise = -48;
  let inspectId = '';
  const inspectByBank = { A: '', B: '' };
  let rebuildOrder = false;
  let metersOpen = false;
  let matchVolume = true;
  let saveTimer;
  let storageAvailable = true;

  function validateChain(chain) {
    if (!Array.isArray(chain)) throw new Error('Invalid chain');
    const ids = new Set();
    return chain.map(pedal => {
      if (!pedal || !Object.hasOwn(types, pedal.type) || typeof pedal.id !== 'string' || !/^pedal-[1-9][0-9]*$/.test(pedal.id) || ids.has(pedal.id) || !Number.isSafeInteger(Number(pedal.id.slice(6)))) throw new Error('Invalid pedal');
      ids.add(pedal.id);
      const params = {};
      for (const spec of types[pedal.type].specs) {
        const value = pedal.params?.[spec.key];
        params[spec.key] = typeof value === 'number' && Number.isFinite(value) ? Math.max(spec.min, Math.min(spec.max, value)) : spec.value;
      }
      return { id: pedal.id, type: pedal.type, number: Number.isSafeInteger(pedal.number) && pedal.number > 0 ? pedal.number : 1, enabled: pedal.enabled !== false, params };
    });
  }
  function restoreBoard(data) {
    if (data?.version !== 1 || !['A', 'B'].includes(data.active)) throw new Error('Unknown board format');
    const restored = { A: validateChain(data.banks?.A), B: validateChain(data.banks?.B) };
    banks = restored;
    activeBank = data.active;
    state.chain = clone(banks[activeBank]);
    restoredNoise = typeof data.noise === 'number' && Number.isFinite(data.noise) ? Math.max(-80, Math.min(-20, data.noise)) : -48;
    matchVolume = data.matchVolume !== false;
    for (const pedal of [...banks.A, ...banks.B]) {
      nextId = Math.max(nextId, Number(pedal.id.slice(6)));
      counts[pedal.type] = Math.max(counts[pedal.type], pedal.number);
    }
  }
  let restoreMessage = '';
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) restoreBoard(JSON.parse(saved));
  } catch { storageAvailable = false; }
  if (location.hash.startsWith('#board=')) {
    try {
      const encoded = location.hash.slice(7).replace(/-/g, '+').replace(/_/g, '/');
      restoreBoard(JSON.parse(atob(encoded)));
      restoreMessage = 'Shared pedalboard loaded';
      history.replaceState(null, '', location.pathname + location.search);
    } catch { restoreMessage = 'This shared link is invalid. Your saved board was kept.'; }
  }
  function snapshot() {
    banks[activeBank] = clone(state.chain);
    return { version: 1, active: activeBank, banks, noise: source.noiseDb, matchVolume };
  }
  function saveBoard() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(snapshot()));
        document.getElementById('save-status').textContent = 'Saved on this device';
      } catch {
        storageAvailable = false;
        document.getElementById('save-status').textContent = 'Local saving unavailable · use Share';
      }
    }, 250);
  }
  let selectedId = null;
  const pedalName = pedal => types[pedal.type].name + ' ' + pedal.number;
  function observed(type) { return state.chain.find(p => p.id === inspectId && p.type === type) || state.chain.find(p => p.id === selectedId && p.type === type) || state.chain.find(p => p.type === type); }

  function buildParams(container, specs, target, onChange) {
    for (const p of specs) {
      const value = target[p.key] ?? p.value;
      target[p.key] = value;
      const row = document.createElement('label');
      row.className = 'param';
      row.innerHTML =
        `<span class="param-top"><span class="param-name">${p.label}</span><output class="param-val"></output></span>` +
        `<input type="range" />` +
        `<span class="param-hint">${p.hint}</span>`;
      const input = row.querySelector('input');
      const out = row.querySelector('output');
      input.setAttribute('aria-label', p.label);
      if (p.log) {
        // Logarithmic slider: equal travel for each doubling of time or ratio.
        input.min = 0;
        input.max = 1000;
        input.step = 1;
        const span = Math.log(p.max / p.min);
        input.value = Math.round((Math.log(value / p.min) / span) * 1000);
        input.addEventListener('input', () => {
          target[p.key] = p.min * Math.exp((input.value / 1000) * span);
          update();
        });
      } else {
        Object.assign(input, { min: p.min, max: p.max, step: p.step, value });
        input.addEventListener('input', () => {
          target[p.key] = Number(input.value);
          update();
        });
      }
      const update = () => {
        out.textContent = p.format(target[p.key]);
        state.dirty = true;
        onChange?.();
        saveBoard();
      };
      out.textContent = p.format(value);
      container.appendChild(row);
    }
  }

  /* ------------------------------------------------------------- toolbar */

  const source = new Source('guitar');
  source.noiseDb = restoredNoise;

  function segmented(id, onChange) {
    const el = document.getElementById(id);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
      onChange(btn.dataset.value);
      state.dirty = true;
    });
  }

  const noise = document.getElementById('noise');
  const noiseOut = document.getElementById('noise-out');
  noise.value = restoredNoise;
  noiseOut.textContent = fmtDb(restoredNoise);
  noise.addEventListener('input', () => {
    source.noiseDb = Number(noise.value);
    state.dirty = true;
    noiseOut.textContent = fmtDb(source.noiseDb);
    saveBoard();
  });

  let orderList = document.getElementById('effect-order');
  const dropArea = document.querySelector('.drop-area');
  const settings = document.getElementById('effect-settings');
  const library = document.getElementById('effect-library');
  const removeConfirm = document.getElementById('remove-confirm');
  let pendingRemoval = null;
  const selected = () => state.chain.find(p => p.id === selectedId);
  function announce(text) { document.getElementById('order-status').textContent = text; }
  function changed() { state.dirty = true; renderOrder(); saveBoard(); }
  function moveEffect(id, to) {
    const from = state.chain.findIndex(p => p.id === id);
    to = Math.max(0, Math.min(state.chain.length - 1, to));
    if (from < 0 || from === to) return;
    const [pedal] = state.chain.splice(from, 1);
    state.chain.splice(to, 0, pedal);
    changed();
    if (settings.open) syncMoveButtons();
    announce(pedalName(pedal) + ' moved to position ' + (to + 1));
  }
  function syncMoveButtons() {
    const index = state.chain.findIndex(p => p.id === selectedId);
    document.getElementById('pedal-earlier').disabled = index <= 0;
    document.getElementById('pedal-later').disabled = index === state.chain.length - 1;
  }
  function openSettings(pedal) {
    selectedId = pedal.id;
    state.dirty = true;
    document.getElementById('settings-title').textContent = pedalName(pedal);
    document.getElementById('settings-state').textContent = pedal.enabled ? 'Enabled' : 'Bypassed';
    settings.dataset.type = pedal.type;
    document.getElementById('settings-model').textContent = 'Outline after the ' + types[pedal.type].model;
    const container = document.getElementById('pedal-params');
    container.replaceChildren();
    buildParams(container, types[pedal.type].specs, pedal.params, () => {
      const art = orderList.querySelector('[data-effect="' + pedal.id + '"] .pedal-art');
      if (art) art.innerHTML = pedalArt(pedal);
    });
    document.getElementById('pedal-curve-wrap').hidden = !['gate', 'comp'].includes(pedal.type);
    document.getElementById('effect-explanation').textContent = types[pedal.type].explanation;
    trails.gate.length = trails.comp.length = 0;
    syncMoveButtons();
    if (!settings.open) settings.showModal();
  }
  function addPedal(type, params) {
    const pedal = createPedal(type, params);
    state.chain.push(pedal);
    changed();
    announce(pedalName(pedal) + ' added at position ' + state.chain.length);
    return pedal;
  }
  function confirmRemoval(pedal) {
    pendingRemoval = pedal.id;
    document.getElementById('remove-message').textContent = 'Remove ' + pedalName(pedal) + ' from your signal chain?';
    removeConfirm.showModal();
  }
  function removePedal(id) {
    const pedal = state.chain.find(p => p.id === id);
    if (!pedal) return;
    state.chain = state.chain.filter(p => p.id !== id);
    selectedId = null;
    settings.close();
    removeConfirm.close();
    pendingRemoval = null;
    changed();
    document.getElementById('add-effect').focus();
    announce(pedalName(pedal) + ' removed');
  }
  document.getElementById('add-effect').onclick = () => library.showModal();
  for (const [type, info] of Object.entries(types)) {
    const button = document.createElement('button');
    button.dataset.type = type;
    const preview = { type, params: Object.fromEntries(info.specs.map(spec => [spec.key, spec.value])) };
    button.innerHTML = artSvg(preview, 'choice-art') + '<strong>' + info.name + '</strong><span class="choice-text">' + info.explanation.split('.')[0] + '.</span><span class="choice-model">Outline after the ' + info.model + '</span><span class="choice-add" aria-hidden="true">+</span>';
    button.onclick = () => {
      const pedal = addPedal(type);
      library.close();
      orderList.querySelector('[data-effect="' + pedal.id + '"] .pedal-toggle').focus();
    };
    document.getElementById('effect-choices').appendChild(button);
  }
  for (const dialog of [settings, library]) {
    dialog.querySelector('.sheet-close').onclick = () => dialog.close();
    dialog.addEventListener('click', e => { if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
    } });
  }
  document.getElementById('duplicate-pedal').onclick = () => {
    const pedal = selected();
    if (!pedal) return;
    const copy = addPedal(pedal.type, pedal.params);
    moveEffect(copy.id, state.chain.indexOf(pedal) + 1);
    openSettings(copy);
  };
  document.getElementById('remove-pedal').onclick = () => {
    const pedal = selected();
    if (!pedal) return;
    confirmRemoval(pedal);
  };
  document.getElementById('cancel-remove').onclick = () => { removeConfirm.close(); pendingRemoval = null; };
  document.getElementById('confirm-remove').onclick = () => removePedal(pendingRemoval);
  removeConfirm.addEventListener('close', () => {
    if (pendingRemoval && removeConfirm.returnValue !== 'remove') pendingRemoval = null;
    removeConfirm.returnValue = '';
  });
  document.getElementById('pedal-earlier').onclick = () => moveEffect(selectedId, state.chain.findIndex(p => p.id === selectedId) - 1);
  document.getElementById('pedal-later').onclick = () => moveEffect(selectedId, state.chain.findIndex(p => p.id === selectedId) + 1);

  const inspectSelect = document.getElementById('inspect-point');
  function refreshInspect() {
    if (inspectId && !state.chain.some(p => p.id === inspectId)) {
      inspectId = '';
      resetScopeHistory();
    }
    inspectSelect.replaceChildren(new Option('Full chain', ''));
    state.chain.forEach(pedal => inspectSelect.add(new Option(pedalName(pedal), pedal.id)));
    inspectSelect.value = inspectId;
    const pedal = state.chain.find(p => p.id === inspectId);
    document.querySelector('#monitor [data-value="dry"]').textContent = pedal ? 'Before pedal' : 'Dry input';
    document.querySelector('#monitor [data-value="wet"]').textContent = pedal ? 'After pedal' : 'With effects';
    document.getElementById('scope-caption').textContent = pedal ? pedalName(pedal) + ' · input → output' : 'Guitar input → full chain output';
    document.querySelector('.sw-in').parentElement.lastChild.textContent = pedal ? 'Pedal input' : 'Guitar input';
    document.querySelector('.sw-out').parentElement.lastChild.textContent = pedal ? 'Pedal output' : 'Chain output';
    state.dirty = true;
  }
  inspectSelect.onchange = () => {
    inspectId = inspectSelect.value;
    resetScopeHistory();
    refreshInspect();
  };
  document.getElementById('inspect-pedal').onclick = () => {
    inspectId = selectedId;
    resetScopeHistory();
    refreshInspect();
    settings.close();
    // The page scroll is restored when the dialog closes; scroll after that.
    requestAnimationFrame(() => scopeEl.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };
  document.getElementById('toggle-meters').onclick = e => {
    metersOpen = !metersOpen;
    e.target.setAttribute('aria-expanded', String(metersOpen));
    e.target.textContent = metersOpen ? 'Hide meters' : 'Show meters';
    state.dirty = true;
  };
  function syncBanks() {
    document.querySelectorAll('#compare-bank button').forEach(button => {
      button.classList.toggle('on', button.dataset.bank === activeBank);
      button.setAttribute('aria-pressed', String(button.dataset.bank === activeBank));
    });
    document.getElementById('copy-bank').textContent = activeBank === 'A' ? 'Copy A to B' : 'Copy B to A';
  }
  document.getElementById('compare-bank').onclick = e => {
    const bank = e.target.closest('[data-bank]')?.dataset.bank;
    if (!bank || bank === activeBank) return;
    banks[activeBank] = clone(state.chain);
    activeBank = bank;
    state.chain = clone(banks[activeBank]);
    rebuildOrder = true;
    selectedId = null;
    inspectId = inspectByBank[bank];
    selectScopeHistory();
    changed();
    syncBanks();
    announce('Configuration ' + activeBank + ' selected');
  };
  document.getElementById('copy-bank').onclick = () => {
    const other = activeBank === 'A' ? 'B' : 'A';
    banks[other] = clone(state.chain);
    state.dirty = true;
    saveBoard();
    announce('Configuration ' + activeBank + ' copied to ' + other);
  };
  document.getElementById('match-volume').checked = matchVolume;
  document.getElementById('match-volume').onchange = e => {
    matchVolume = e.target.checked;
    state.dirty = true;
    saveBoard();
  };
  document.getElementById('share-board').onclick = async () => {
    const encoded = btoa(JSON.stringify(snapshot())).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = new URL(location.href);
    url.hash = 'board=' + encoded;
    try {
      await navigator.clipboard.writeText(url.href);
      announce('Share link copied, including A and B');
    } catch {
      const field = document.getElementById('share-link');
      field.value = url.href;
      document.getElementById('share-dialog').showModal();
      field.select();
    }
  };
  document.querySelector('#share-dialog .sheet-close').onclick = () => document.getElementById('share-dialog').close();
  syncBanks();

  function reserveBoardHeight() {
    const card = orderList.firstElementChild;
    const cardWidth = card ? card.getBoundingClientRect().width : 62;
    const cardHeight = card ? card.getBoundingClientRect().height : 101;
    const gap = parseFloat(getComputedStyle(orderList).gap) || 6;
    const columns = Math.max(1, Math.floor((orderList.clientWidth + gap) / (cardWidth + gap)));
    const other = activeBank === 'A' ? 'B' : 'A';
    const rows = Math.ceil(Math.max(state.chain.length, banks[other].length) / columns);
    dropArea.style.minHeight = Math.max(126, rows * (cardHeight + gap) - gap + 28) + 'px';
  }
  window.addEventListener('resize', reserveBoardHeight);
  function renderOrder() {
    const previousList = rebuildOrder ? orderList : null;
    if (previousList) orderList = previousList.cloneNode(false);
    rebuildOrder = false;
    for (const item of [...orderList.children]) if (!state.chain.some(p => p.id === item.dataset.effect)) item.remove();
    state.chain.forEach((pedal, index) => {
      const id = pedal.id;
      let item = orderList.querySelector('[data-effect="' + id + '"]');
      if (!item) {
        item = document.createElement('li');
        item.dataset.effect = id;
        item.dataset.type = pedal.type;
        item.innerHTML = artSvg(pedal, 'pedal-art') + '<div class="pedal-top"><span class="pedal-position"></span><button class="pedal-edit" aria-label="Edit ' + pedalName(pedal) + '">Edit</button></div><button class="pedal-toggle"><span class="pedal-label"><span class="pedal-name"></span><span class="pedal-status"></span></span></button><button class="drag-handle" aria-label="Drag ' + pedalName(pedal) + ', or use arrow keys to reorder">⠿</button>';
        item.querySelector('.pedal-edit').onclick = () => openSettings(pedal);
        item.querySelector('.pedal-toggle').onclick = () => {
          pedal.enabled = !pedal.enabled;
          changed();
          announce(pedalName(pedal) + (pedal.enabled ? ' enabled' : ' bypassed'));
        };
        const handle = item.querySelector('.drag-handle');
        handle.onkeydown = e => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
          e.preventDefault();
          const earlier = ['ArrowLeft', 'ArrowUp'].includes(e.key);
          moveEffect(id, state.chain.indexOf(pedal) + (earlier ? -1 : 1));
          handle.focus();
        };
        handle.onpointerdown = e => {
          if (e.button !== 0) return;
          handle.setPointerCapture(e.pointerId);
          item.classList.add('dragging');
        };
        const clearDrag = () => {
          item.classList.remove('dragging');
          dropArea.classList.remove('drag-over');
          orderList.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        };
        handle.onpointermove = e => {
          if (!handle.hasPointerCapture(e.pointerId)) return;
          const hit = document.elementFromPoint(e.clientX, e.clientY);
          const target = hit?.closest('[data-effect]');
          dropArea.classList.toggle('drag-over', dropArea.contains(hit));
          orderList.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
          if (target && target !== item && orderList.contains(target)) target.classList.add('drop-target');
          // Allow long boards to scroll while holding a pedal near a screen edge.
          if (e.clientY > innerHeight - 65) window.scrollBy(0, 12);
          else if (e.clientY < 65) window.scrollBy(0, -12);
        };
        handle.onpointerup = e => {
          if (!handle.hasPointerCapture(e.pointerId)) return;
          const hit = document.elementFromPoint(e.clientX, e.clientY);
          const target = hit?.closest('[data-effect]');
          clearDrag();
          if (target && target !== item && orderList.contains(target)) moveEffect(id, state.chain.findIndex(p => p.id === target.dataset.effect));
          else if (!target && dropArea.contains(hit)) moveEffect(id, state.chain.length - 1);
          else if (!target && !dropArea.contains(hit)) confirmRemoval(pedal);
        };
        handle.onpointercancel = clearDrag;
      }
      item.classList.toggle('off', !pedal.enabled);
      item.querySelector('.pedal-art').innerHTML = pedalArt(pedal);
      item.querySelector('.pedal-position').textContent = index + 1;
      item.querySelector('.pedal-name').textContent = types[pedal.type].short + ' ' + pedal.number;
      const toggle = item.querySelector('.pedal-toggle');
      toggle.setAttribute('aria-label', pedalName(pedal));
      toggle.setAttribute('aria-pressed', String(pedal.enabled));
      item.querySelector('.pedal-status').textContent = pedal.enabled ? 'On' : 'Off';
      // Keep DOM nodes in place during playback and editing to preserve focus.
      if (orderList.children[index] !== item) orderList.insertBefore(item, orderList.children[index] || null);
    });
    if (previousList) previousList.replaceWith(orderList);
    document.getElementById('empty-chain').hidden = state.chain.length > 0;
    reserveBoardHeight();
    drawCables();
    refreshInspect();
  }

  /* Cable: Input → each pedal in processing order → Output. Runs straight
   * between neighbours and snakes through the gap when the board wraps. */
  const signalPath = document.querySelector('.signal-path');
  const cables = document.getElementById('cables');
  function roundedPath(points, radius = 6) {
    const pts = points.filter((pt, i) => i === 0 || Math.hypot(pt[0] - points[i - 1][0], pt[1] - points[i - 1][1]) > 0.5);
    let d = 'M' + pts[0].join(',');
    for (let i = 1; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const l1 = Math.hypot(x1 - x0, y1 - y0), l2 = Math.hypot(x2 - x1, y2 - y1);
      const r = Math.min(radius, l1 / 2, l2 / 2);
      const ax = x1 - (x1 - x0) / l1 * r, ay = y1 - (y1 - y0) / l1 * r;
      const bx = x1 + (x2 - x1) / l2 * r, by = y1 + (y2 - y1) / l2 * r;
      d += ` L${ax.toFixed(1)},${ay.toFixed(1)} Q${x1.toFixed(1)},${y1.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}`;
    }
    return d + ' L' + pts[pts.length - 1].map(v => v.toFixed(1)).join(',');
  }
  function drawCables() {
    const base = signalPath.getBoundingClientRect();
    if (!base.width) return;
    const box = el => {
      const r = el.getBoundingClientRect();
      return { left: r.left - base.left, right: r.right - base.left, top: r.top - base.top, bottom: r.bottom - base.top, width: r.width, height: r.height };
    };
    const inDot = box(document.querySelector('.endpoint-input i'));
    const outDot = box(document.querySelector('.endpoint-output i'));
    const nodes = [{ out: inDot.right, y: inDot.top + inDot.height / 2, left: inDot.left, right: inDot.right, top: inDot.top, bottom: inDot.bottom }];
    for (const item of orderList.children) {
      const b = box(item);
      const art = ART[item.dataset.type];
      const scale = b.width / ART_W;
      nodes.push({ in: b.left + art.inset * scale, out: b.right - art.inset * scale, y: b.top + art.jack * scale, ...b });
    }
    nodes.push({ in: outDot.left, y: outDot.top + outDot.height / 2, ...outDot });
    const gap = parseFloat(getComputedStyle(orderList).columnGap) || 8;
    let paths = '';
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i], b = nodes[i + 1];
      let pts;
      if (b.in > a.out + 1) {
        // Next pedal is to the right: straight, or one step if the heights differ.
        const mid = Math.abs(a.y - b.y) < 1 ? null : (a.right + b.left) / 2;
        pts = mid === null ? [[a.out, a.y], [b.in, b.y]] : [[a.out, a.y], [mid, a.y], [mid, b.y], [b.in, b.y]];
      } else {
        // Wrapped onto the next row: out, down through the row gap, back to the left, in.
        const x1 = a.right + gap / 2, x2 = b.left - gap / 2, ym = (a.bottom + b.top) / 2;
        pts = [[a.out, a.y], [x1, a.y], [x1, ym], [x2, ym], [x2, b.y], [b.in, b.y]];
      }
      paths += `<path d="${roundedPath(pts)}" marker-end="url(#cable-arrow)"/>`;
    }
    cables.innerHTML = '<defs><marker id="cable-arrow" viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0.5 L8,4 L0,7.5 z"/></marker></defs>' + paths;
  }
  new ResizeObserver(drawCables).observe(signalPath);
  document.fonts?.ready.then(drawCables);
  renderOrder();

  /* Freeze the page behind any open dialog (iOS ignores overflow: hidden on
   * its own, so pin the body in place and restore the scroll on close). */
  let lockedScroll = null;
  function syncScrollLock() {
    const open = !!document.querySelector('dialog[open]');
    if (open && lockedScroll === null) {
      lockedScroll = window.scrollY;
      Object.assign(document.body.style, { position: 'fixed', top: -lockedScroll + 'px', left: '0', right: '0' });
    } else if (!open && lockedScroll !== null) {
      const y = lockedScroll;
      lockedScroll = null;
      Object.assign(document.body.style, { position: '', top: '', left: '', right: '' });
      window.scrollTo(0, y);
    }
  }
  new MutationObserver(syncScrollLock).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });

  /* ------------------------------------------------------------ buffers */

  const input = new Float32Array(N);
  const scopeHistory = {
    A: { input: new Float32Array(N), output: new Float32Array(N) },
    B: { input: new Float32Array(N), output: new Float32Array(N) },
  };
  let scopeInput = scopeHistory[activeBank].input;
  let scopeOutput = scopeHistory[activeBank].output;
  function selectScopeHistory() {
    scopeInput = scopeHistory[activeBank].input;
    scopeOutput = scopeHistory[activeBank].output;
  }
  function resetScopeHistory() {
    inspectByBank[activeBank] = inspectId;
    scopeInput.fill(0);
    scopeOutput.fill(0);
  }

  const gateGain = new Float32Array(N);
  const compGR = new Float32Array(N);
  const visualChains = { A: new EffectChain(N), B: new EffectChain(N) };
  let visualChain = visualChains[activeBank];

  let total = 0; // samples generated since start

  // Fill the buffer so the first frame isn't empty.
  source.generate(input, 0, N);
  total = N;

  function advance(count) {
    count = Math.min(count, N);
    input.copyWithin(0, count);
    source.generate(input, N - count, count);
    total += count;
  }

  function processChain() {
    banks[activeBank] = state.chain;
    for (const bank of ['A', 'B']) {
      const output = visualChains[bank].process(input, banks[bank]);
      if (!listening) {
        const pedal = banks[bank].find(p => p.id === inspectByBank[bank]);
        const entry = pedal && visualChains[bank].instances.get(pedal.id);
        scopeHistory[bank].input.set(entry ? entry.input : input);
        scopeHistory[bank].output.set(entry && pedal.enabled ? entry.out : entry ? entry.input : output);
      }
    }
    visualChain = visualChains[activeBank];
    document.getElementById('lanes').hidden = !metersOpen;
    // The scope meters follow the inspected pedal of each type, or the first.
    for (const type of ['gate', 'comp']) {
      const pedal = observed(type);
      state[type + 'On'] = !!pedal?.enabled;
      state[type] = pedal?.params || {};
      const entry = pedal && visualChain.instances.get(pedal.id);
      const meter = type === 'gate' ? gateGain : compGR;
      if (entry) meter.set(entry.meter); else meter.fill(type === 'gate' ? 1 : 0);
      const legend = document.querySelector('.lg-' + type);
      legend.classList.toggle('hidden', !pedal?.enabled || (!!inspectId && inspectId !== pedal?.id));
      legend.lastChild.textContent = pedal ? pedalName(pedal) + ' threshold' : '';
    }
    if (audioNode) sendAudioState();
  }

  function peakDb(buf) {
    let m = 0;
    for (let i = N - LEVEL_WINDOW; i < N; i++) m = Math.max(m, Math.abs(buf[i]));
    return linToDb(m);
  }

  /* ------------------------------------------------------------ drawing */

  function fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: canvas.clientWidth, h: canvas.clientHeight, dpr };
  }

  const DB_FLOOR = 72; // bottom of the decibel view
  function amp(v) {
    if (state.scale === 'lin') return v;
    const s = Math.sign(v);
    return s * Math.max(0, 1 + linToDb(v) / DB_FLOOR);
  }

  function label(ctx, text, x, y, col, align = 'left', base = 'alphabetic', boxed = false) {
    ctx.font = '500 10.5px ' + C.mono;
    if (boxed) {
      const tw = ctx.measureText(text).width;
      const bx = align === 'right' ? x - tw : align === 'center' ? x - tw / 2 : x;
      ctx.fillStyle = C.paper;
      ctx.globalAlpha = 0.88;
      ctx.fillRect(bx - 4, y - 10, tw + 8, 14);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = col;
    ctx.textAlign = align;
    ctx.textBaseline = base;
    ctx.fillText(text, x, y);
  }

  // Shape of a buffer, one top/bottom pair per screen column. Linear view shows
  // the real min/max; the decibel view shows the peak level, mirrored, over a
  // short window so it reads as a level envelope instead of individual cycles.
  const ENV_HALF = Math.round(0.008 * SR);
  function columns(buf, cols) {
    const top = new Float32Array(cols);
    const bot = new Float32Array(cols);
    const env = state.scale === 'db';
    for (let c = 0; c < cols; c++) {
      let s0 = PRE + Math.floor((c * VIEW) / cols);
      let s1 = Math.max(s0 + 1, PRE + Math.floor(((c + 1) * VIEW) / cols));
      if (env) {
        s0 = Math.max(0, s0 - ENV_HALF);
        s1 = Math.min(N, s1 + ENV_HALF);
        let pk = 0;
        for (let i = s0; i < s1; i++) {
          const v = buf[i] < 0 ? -buf[i] : buf[i];
          if (v > pk) pk = v;
        }
        top[c] = pk;
        bot[c] = -pk;
        continue;
      }
      let lo = Infinity, hi = -Infinity;
      for (let i = s0; i < s1; i++) {
        const v = buf[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      top[c] = hi;
      bot[c] = lo;
    }
    return { top, bot };
  }

  function fillWave(ctx, env, cols, step, y, fill) {
    ctx.beginPath();
    for (let c = 0; c < cols; c++) ctx.lineTo(c * step, y(env.top[c]) - 0.5);
    for (let c = cols - 1; c >= 0; c--) ctx.lineTo(c * step, y(env.bot[c]) + 0.5);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  const scopeEl = document.getElementById('scope');
  const lanesEl = document.getElementById('lanes');

  function timeLines(ctx, w, h, withLabels) {
    const startSample = total - VIEW;
    const every = 0.5 * SR;
    let k = Math.ceil(startSample / every) * every;
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (; k < total; k += every) {
      const x = Math.round(((k - startSample) / VIEW) * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (withLabels) label(ctx, fmt(k / SR, 1) + 's', x + 4, h - 6, C.ink3);
    }
  }

  function drawScope() {
    const { ctx, w, h, dpr } = fit(scopeEl);
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    const half = (h / 2) * 0.88;
    const y = (v) => mid - amp(v) * half;

    timeLines(ctx, w, h, true);

    // Amplitude grid
    const marks =
      state.scale === 'lin'
        ? [0.25, 0.5, 0.75, 1].map((v) => [v, fmt(v, 2)])
        : [0, -12, -24, -36, -48, -60].map((d) => [dbToLin(d), fmt(d, 0) + ' dB']);
    ctx.strokeStyle = C.grid;
    for (const [v, text] of marks) {
      for (const s of [1, -1]) {
        const yy = Math.round(y(s * v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(w, yy);
        ctx.stroke();
      }
      label(ctx, text, 6, Math.round(y(v)) - 3, C.ink3);
    }
    ctx.strokeStyle = C.rule;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(w, Math.round(mid) + 0.5);
    ctx.stroke();

    // Waveforms
    const cols = Math.max(1, Math.floor(w * dpr));
    const step = w / cols;
    fillWave(ctx, columns(scopeInput, cols), cols, step, y, C.ghost);
    fillWave(ctx, columns(scopeOutput, cols), cols, step, y, C.ink);

    // Thresholds
    const thresholds = [];
    const showThresholds = !inspectId || ['gate', 'comp'].includes(state.chain.find(p => p.id === inspectId)?.type);
    if (showThresholds && state.gateOn && (!inspectId || observed('gate')?.id === inspectId)) thresholds.push([state.gate.threshold, C.gate, pedalName(observed('gate')), 'left']);
    if (showThresholds && state.compOn && (!inspectId || observed('comp')?.id === inspectId)) thresholds.push([state.comp.threshold, C.comp, pedalName(observed('comp')), 'right']);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    for (const [db, col] of thresholds) {
      ctx.strokeStyle = col;
      for (const s of [1, -1]) {
        const yy = y(s * dbToLin(db));
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(w, yy);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    for (const [db, col, name, side] of thresholds) {
      const text = name + ' ' + fmt(db, 0) + ' dB';
      const x = side === 'left' ? 80 : w - 8;
      label(ctx, text, x, y(dbToLin(db)) - 5, col, side, 'alphabetic', true);
    }
  }

  function drawLanes() {
    if (lanesEl.hidden) return;
    const { ctx, w, h, dpr } = fit(lanesEl);
    ctx.clearRect(0, 0, w, h);
    const rowH = h / 2;
    const cols = Math.max(1, Math.floor(w * dpr));
    const step = w / cols;

    timeLines(ctx, w, h, false);
    ctx.strokeStyle = C.rule;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(rowH) + 0.5);
    ctx.lineTo(w, Math.round(rowH) + 0.5);
    ctx.stroke();

    const lane = (top, on, buf, toY, col, soft, fromTop, name) => {
      const bottom = top + rowH;
      if (!on) {
        label(ctx, name + ' — BYPASSED', 8, top + 14, C.ink3, 'left', 'alphabetic', true);
        return;
      }
      ctx.beginPath();
      ctx.moveTo(0, fromTop ? top : bottom);
      for (let c = 0; c < cols; c++) {
        const s0 = PRE + Math.floor((c * VIEW) / cols);
        const s1 = Math.max(s0 + 1, PRE + Math.floor(((c + 1) * VIEW) / cols));
        let v = Infinity;
        for (let i = s0; i < s1; i++) if (buf[i] < v) v = buf[i];
        ctx.lineTo(c * step, toY(v));
      }
      ctx.lineTo(w, fromTop ? top : bottom);
      ctx.closePath();
      ctx.fillStyle = soft;
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.25;
      ctx.stroke();
      ctx.lineWidth = 1;
      label(ctx, name, 8, fromTop ? bottom - 6 : top + 14, col, 'left', 'alphabetic', true);
    };

    const pad = 6;
    lane(0, state.gateOn, gateGain, (g) => rowH - pad - g * (rowH - pad * 2 - 12), C.gate, C.gateSoft, false,
      (observed('gate') ? pedalName(observed('gate')) : 'Gate') + ' · gain');
    const GR_RANGE = 24;
    lane(rowH, state.compOn, compGR, (gr) => rowH + pad + Math.min(1, -gr / GR_RANGE) * (rowH - pad * 2), C.comp,
      C.compSoft, true, (observed('comp') ? pedalName(observed('comp')) : 'Compressor') + ' · reduction (dB)');
  }

  /* Transfer curves: input level on x, output level on y, both −60..0 dB. */
  const LO = -60;
  const trails = { gate: [], comp: [] };

  function drawCurve(canvas, curveFn, thr, on, col, dot, trail) {
    const { ctx, w, h } = fit(canvas);
    ctx.clearRect(0, 0, w, h);
    const padL = 30, padB = 22, padT = 10, padR = 10;
    const pw = w - padL - padR;
    const ph = h - padT - padB;
    const X = (db) => padL + ((db - LO) / -LO) * pw;
    const Y = (db) => padT + ph - ((Math.max(LO, db) - LO) / -LO) * ph;

    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (let d = LO; d <= 0; d += 12) {
      ctx.beginPath();
      ctx.moveTo(Math.round(X(d)) + 0.5, padT);
      ctx.lineTo(Math.round(X(d)) + 0.5, padT + ph);
      ctx.moveTo(padL, Math.round(Y(d)) + 0.5);
      ctx.lineTo(padL + pw, Math.round(Y(d)) + 0.5);
      ctx.stroke();
      label(ctx, fmt(d, 0), X(d), h - 8, C.ink3, 'center');
      label(ctx, fmt(d, 0), padL - 5, Y(d), C.ink3, 'right', 'middle');
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, pw, ph);
    ctx.clip();

    // Unity line: what "no effect" looks like
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = C.ghost;
    ctx.beginPath();
    ctx.moveTo(X(LO), Y(LO));
    ctx.lineTo(X(0), Y(0));
    ctx.stroke();

    if (on) {
      ctx.strokeStyle = col;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(X(thr), padT);
      ctx.lineTo(X(thr), padT + ph);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.strokeStyle = on ? col : C.ink3;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = LO; x <= 0.001; x += 0.25) ctx.lineTo(X(x), Y(on ? curveFn(x) : x));
    ctx.stroke();

    // Recent levels fade out behind the live dot
    trail.push(dot);
    if (trail.length > 36) trail.shift();
    trail.forEach(([dx, dy], i) => {
      if (dx <= LO) return;
      ctx.globalAlpha = ((i + 1) / trail.length) * 0.35;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(X(dx), Y(dy), 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    const [dx, dy] = dot;
    if (dx > LO) {
      ctx.fillStyle = C.ink;
      ctx.beginPath();
      ctx.arc(X(dx), Y(dy), 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = C.paper;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();

    label(ctx, 'in →', padL + pw, padT + ph - 5, C.ink3, 'right');
    label(ctx, '↑ out', padL + 4, padT + 11, C.ink3);
  }

  const curveEl = document.getElementById('pedal-curve');
  const badgeEl = document.getElementById('pedal-state');
  const readEl = document.getElementById('pedal-readout');
  function drawCurves() {
    const pedal = selected();
    if (!settings.open || !pedal || !['gate', 'comp'].includes(pedal.type)) return;
    const entry = visualChain.instances.get(pedal.id);
    if (!entry) return;
    const p = pedal.params;
    const level = peakDb(entry.input);
    const isGate = pedal.type === 'gate';
    const gr = isGate ? linToDb(entry.meter[N - 1]) : entry.meter[N - 1];
    const makeup = !isGate && pedal.enabled ? p.makeup : 0;
    drawCurve(curveEl, x => isGate ? (x >= p.threshold ? x : x + p.range) : compCurve(x, p) + p.makeup,
      p.threshold, pedal.enabled, isGate ? C.gate : C.comp, [level, level + gr + makeup], trails[pedal.type]);
    badgeEl.textContent = !pedal.enabled ? 'Bypassed' : isGate ? entry.processor.state() : gr < -0.5 ? 'Compressing' : 'Idle';
    readEl.textContent = (isGate ? 'gain ' : 'GR ') + fmtDb(gr);
  }

  // Audio runs off the main thread. Its source samples also drive the scope.
  let audioContext, audioNode, listening = false, monitor = 'wet';
  let audioStarting = false;
  const listen = document.getElementById('listen');
  const audioStatus = document.getElementById('audio-status');
  function sendAudioState() {
    banks[activeBank] = clone(state.chain);
    audioNode?.port.postMessage({ type: 'settings', state: { playing: state.playing, speed: state.speed, chain: state.chain }, kind: source.kind,
      noiseDb: source.noiseDb, banks, activeBank, inspectId, inspectByBank, matchVolume, monitor, volume: Number(document.getElementById('volume').value) });
  }
  segmented('monitor', v => { monitor = v; sendAudioState(); });
  document.getElementById('volume').oninput = sendAudioState;
  listen.onclick = async () => {
    if (audioStarting) return;
    audioStarting = true;
    listen.disabled = true;
    try {
      if (!audioContext) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContext();
        await audioContext.resume();
        await audioContext.audioWorklet.addModule('js/audio-worklet.js');
        audioNode = new AudioWorkletNode(audioContext, 'tonelab-audio', { outputChannelCount: [1] });
        audioNode.port.onmessage = ({ data }) => {
          if (!listening || !state.playing || !data.samples) return;
          const samples = data.samples;
          input.copyWithin(0, samples.length);
          input.set(samples, N - samples.length);
          for (const bank of ['A', 'B']) {
            const view = data.views?.[bank];
            if (!view || view.inspectId !== inspectByBank[bank]) continue;
            for (const [buffer, block] of [[scopeHistory[bank].input, view.input], [scopeHistory[bank].output, view.output]]) {
              buffer.copyWithin(0, block.length);
              buffer.set(block, N - block.length);
            }
          }
          total += samples.length;
          state.dirty = true;
        };
        audioNode.connect(audioContext.destination);
      }
      if (listening) {
        listening = false;
        await audioContext.suspend();
      } else {
        input.fill(0);
        for (const history of Object.values(scopeHistory)) { history.input.fill(0); history.output.fill(0); }
        listening = true;
        sendAudioState();
        await audioContext.resume();
      }
      listen.textContent = listening ? 'Stop listening' : 'Listen';
      listen.setAttribute('aria-pressed', String(listening));
      audioStatus.textContent = listening ? 'Listening · switch between dry input and effects' : 'Synthesized guitar';
    } catch (error) {
      listening = false;
      if (audioContext) await audioContext.close().catch(() => {});
      audioContext = audioNode = null;
      audioStatus.textContent = 'Audio could not start. Tap Listen to try again in Safari or Chrome.';
    } finally { audioStarting = false; listen.disabled = false; }
  };

  /* --------------------------------------------------------------- loop */

  let last = performance.now();
  let carry = 0;
  let lastDraw = 0;

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (state.playing && !listening) {
      carry += dt * SR * state.speed;
      const n = Math.floor(carry);
      carry -= n;
      if (n > 0) {
        advance(n);
        state.dirty = true;
      }
    }
    if (now - lastDraw < 50) { requestAnimationFrame(frame); return; }
    lastDraw = now;
    if (state.dirty) {
      processChain();
      state.dirty = false;
    }
    drawScope();
    drawLanes();
    drawCurves();
    requestAnimationFrame(frame);
  }

  document.getElementById('save-status').textContent = restoreMessage || (storageAvailable ? 'Autosave enabled' : 'Local saving unavailable · use Share');
  saveBoard();
  requestAnimationFrame(frame);
})(window.TL);
