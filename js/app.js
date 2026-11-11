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

  /* ------------------------------------------------------------- pedals */
  // Every effect's controls, its classic pedal models and their outlines
  // live in pedals.js.
  const P = TL.Pedals;
  const { types, modelOf, kindName, shortName, controlsFor, pedalArt, artSvg, ART_W } = P;
  let nextId = 0;
  const counts = Object.fromEntries(Object.keys(types).map(type => [type, 0]));
  function createPedal(type, params, model) {
    model = types[type].models.some(m => m.id === model) ? model : types[type].models[0].id;
    return { id: 'pedal-' + (++nextId), type, model, advanced: false, number: ++counts[type], enabled: true,
      params: params ? { ...params } : P.modelDefaults(type, model) };
  }
  // A control's current value, as the pedal shows it.
  function controlValue(pedal, c) {
    const v = pedal.params[c.key];
    if (c.options) return c.options.reduce((a, b) => (Math.abs(b[0] - v) < Math.abs(a[0] - v) ? b : a))[1];
    if (c.invert && c.spec.min === 0 && c.spec.max === 1) return P.pct(1 - v);
    return c.spec.format(v);
  }

  let savedView = 'level';
  try { savedView = localStorage.getItem('tonelab-view') === 'tone' ? 'tone' : 'level'; } catch {}
  const state = { view: savedView, playing: true, speed: 1, scale: 'db', chain: ['gate', 'comp', 'drive', 'delay'].map(type => createPedal(type)), dirty: true };
  const clone = value => JSON.parse(JSON.stringify(value));
  const PATTERNS = Object.keys(TL.PATTERNS);
  const storageKey = 'tonelab-board-v1';
  let activeBank = 'A';
  let banks = { A: clone(state.chain), B: clone(state.chain) };
  let restoredNoise = -48;
  let restoredSource = { kind: 'guitar', tempo: 126 };
  let restoredSlots = null;
  let inspectId = '';
  const inspectByBank = { A: '', B: '' };
  let rebuildOrder = false;
  let metersOpen = false;
  // Audio state, declared early: the chain strip and inspector read it.
  let audioContext, audioNode, listening = false, monitor = 'wet';
  let audition = null;
  let matchVolume = true;
  let saveTimer;
  let storageAvailable = true;
  let localRecording = null;

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
      const model = types[pedal.type].models.some(m => m.id === pedal.model) ? pedal.model : P.legacyModel(pedal.type, params);
      return { id: pedal.id, type: pedal.type, model, advanced: pedal.advanced === true, number: Number.isSafeInteger(pedal.number) && pedal.number > 0 ? pedal.number : 1, enabled: pedal.enabled !== false, params };
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
    const kind = data.source?.kind, tempo = data.source?.tempo;
    restoredSource = { kind: PATTERNS.includes(kind) ? kind : 'guitar', tempo: typeof tempo === 'number' && tempo >= 40 && tempo <= 240 ? tempo : 126 };
    restoredSlots = data.slots && typeof data.slots === 'object' ? data.slots : null;
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
    return { version: 1, active: activeBank, banks, noise: source.noiseDb, matchVolume, source: { kind: source.kind === 'recording' ? 'guitar' : source.kind, tempo: source.tempo }, slots };
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
  const pedalName = pedal => kindName(pedal) + ' ' + pedal.number;
  function observed(type) { return state.chain.find(p => p.id === inspectId && p.type === type) || state.chain.find(p => p.id === selectedId && p.type === type) || state.chain.find(p => p.type === type); }

  // The controls for one pedal: its model's (or all of them with "Show all
  // controls"), as sliders, or as switches for controls with named positions.
  function buildControls(container, pedal, onChange) {
    const target = pedal.params;
    const update = () => { state.dirty = true; onChange?.(); saveBoard(); };
    let moreHeading = false;
    for (const c of controlsFor(pedal, pedal.advanced)) {
      const spec = c.spec;
      if (!c.onPedal && !moreHeading) {
        moreHeading = true;
        const h = document.createElement('p');
        h.className = 'params-more';
        h.textContent = 'More controls (not on this pedal)';
        container.appendChild(h);
      }
      if (typeof target[c.key] !== 'number') target[c.key] = spec.value;
      if (c.options) {
        const row = document.createElement('div');
        row.className = 'param param-switch';
        row.innerHTML = '<span class="param-top"><span class="param-name"></span></span><div class="segmented switch-options" role="group"></div><span class="param-hint"></span>';
        row.querySelector('.param-name').textContent = c.label;
        row.querySelector('.param-hint').textContent = spec.hint || '';
        const group = row.querySelector('.switch-options');
        group.setAttribute('aria-label', c.label);
        const sync = () => {
          const current = c.options.reduce((a, b) => (Math.abs(b[0] - target[c.key]) < Math.abs(a[0] - target[c.key]) ? b : a))[0];
          group.querySelectorAll('button').forEach(b => {
            const on = Number(b.dataset.value) === current;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', String(on));
          });
        };
        for (const [value, label] of c.options) {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.value = value;
          b.textContent = label;
          b.onclick = () => { target[c.key] = value; sync(); update(); };
          group.appendChild(b);
        }
        sync();
        container.appendChild(row);
        continue;
      }
      const row = document.createElement('label');
      row.className = 'param';
      row.innerHTML = '<span class="param-top"><span class="param-name"></span><output class="param-val"></output></span><input type="range" /><span class="param-hint"></span>';
      row.querySelector('.param-name').textContent = c.label;
      row.querySelector('.param-hint').textContent = spec.hint || '';
      const input = row.querySelector('input');
      const out = row.querySelector('output');
      input.setAttribute('aria-label', c.label);
      if (spec.log) {
        // Logarithmic slider: equal travel for each doubling of time or ratio.
        const span = Math.log(spec.max / spec.min);
        Object.assign(input, { min: 0, max: 1000, step: 1 });
        const t = Math.log(target[c.key] / spec.min) / span;
        input.value = Math.round((c.invert ? 1 - t : t) * 1000);
        input.addEventListener('input', () => {
          const t = input.value / 1000;
          target[c.key] = spec.min * Math.exp((c.invert ? 1 - t : t) * span);
          out.textContent = controlValue(pedal, c);
          update();
        });
      } else {
        // Inverted controls run the other way (a RAT's Filter, a Dyna Comp's Sensitivity).
        const flip = v => (c.invert ? spec.min + spec.max - v : v);
        Object.assign(input, { min: spec.min, max: spec.max, step: spec.step, value: flip(target[c.key]) });
        input.addEventListener('input', () => {
          target[c.key] = flip(Number(input.value));
          out.textContent = controlValue(pedal, c);
          update();
        });
      }
      out.textContent = controlValue(pedal, c);
      container.appendChild(row);
    }
  }

  /* ------------------------------------------------------------- toolbar */

  const source = new Source('guitar');
  source.noiseDb = restoredNoise;
  source.setKind(restoredSource.kind);
  source.tempo = restoredSource.tempo;

  // What the synthesized guitar plays: free picking or steady eighth notes.
  const patternSelect = document.getElementById('pattern');
  const speed = document.getElementById('speed');
  const speedOut = document.getElementById('speed-out');
  patternSelect.replaceChildren(...['Free', 'Single notes', 'Strums', 'Picking', 'Rhythm'].map(name => {
    const group = document.createElement('optgroup');
    group.label = name;
    for (const [id, pattern] of Object.entries(TL.PATTERNS)) if (pattern.group === name) group.appendChild(new Option(pattern.label, id));
    return group;
  }));
  const recordingGroup = document.createElement('optgroup');
  recordingGroup.label = 'Your sound';
  const bringYourOwn = document.getElementById('bring-your-own');
  const recordingFile = document.getElementById('recording-file');
  let recordingLoad = 0;
  const sendRecording = () => {
    if (!audioNode || !localRecording) return;
    const samples = localRecording.samples.slice();
    audioNode.port.postMessage({ type: 'recording', samples }, [samples.buffer]);
  };
  bringYourOwn.onclick = () => recordingFile.click();
  recordingFile.addEventListener('cancel', syncPattern);
  recordingFile.onchange = async () => {
    const file = recordingFile.files[0];
    if (!file) { syncPattern(); return; }
    const load = ++recordingLoad;
    bringYourOwn.disabled = true;
    bringYourOwn.setAttribute('aria-busy', 'true');
    bringYourOwn.title = 'Opening recording…';
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('Choose a recording smaller than 50 MB.');
      const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const decoder = new OfflineContext(1, 1, SR);
      const decoded = await decoder.decodeAudioData(await file.arrayBuffer());
      if (load !== recordingLoad) return;
      if (!decoded.length || decoded.duration > 600) throw new Error('Choose a recording between a moment and 10 minutes long.');
      // The pedal engine is mono. Decode/resample locally, then mix channels.
      const samples = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const data = decoded.getChannelData(channel);
        for (let i = 0; i < samples.length; i++) samples[i] += data[i] / decoded.numberOfChannels;
      }
      localRecording = { samples, name: file.name };
      source.setRecording(samples);
      source.setKind('recording');
      let option = recordingGroup.querySelector('[value="recording"]');
      if (!option) { option = new Option('', 'recording'); recordingGroup.prepend(option); }
      option.textContent = 'Your recording · ' + file.name;
      if (!recordingGroup.isConnected) patternSelect.append(recordingGroup);
      input.fill(0);
      source.generate(input, 0, N);
      source.recordingPosition = 0;
      resetScopeHistory();
      sendRecording();
      syncPattern();
      state.dirty = true;
      onBoardChange();
      saveBoard();
      sendAudioState();
      announce('Recording ready · stays on this device · loops during playback');
    } catch (error) {
      if (load !== recordingLoad) return;
      syncPattern();
      window.alert(error.message?.startsWith('Choose a recording') ? error.message : 'This audio file could not be opened. Try a WAV, MP3, or M4A recording.');
    } finally {
      if (load === recordingLoad) {
        bringYourOwn.disabled = false;
        bringYourOwn.removeAttribute('aria-busy');
        bringYourOwn.title = 'Bring your own recording';
        recordingFile.value = '';
      }
    }
  };
  // Free picking has no tempo; every other pattern follows the Speed slider.
  function syncPattern() {
    patternSelect.value = source.kind;
    const tempo = Math.round(source.tempo);
    const free = !TL.PATTERNS[source.kind]?.tempo;
    speed.value = tempo;
    speed.disabled = free;
    speedOut.textContent = free ? 'not used' : tempo + ' BPM';
    document.getElementById('dock-playing-text').textContent = free ? '--' : tempo + ' BPM';
    const tempoButton = document.getElementById('dock-playing');
    tempoButton.disabled = free;
    tempoButton.title = free ? (source.kind === 'recording' ? 'Recording plays at its original speed' : 'No tempo for free picking') : 'Adjust tempo';
    tempoButton.setAttribute('aria-label', free ? tempoButton.title : 'Adjust tempo: ' + tempo + ' BPM');
    patternSelect.title = source.kind === 'recording' ? localRecording.name + ' · local recording · loops during playback' : '';
    document.getElementById('noise').disabled = source.kind === 'recording';
    document.querySelector('.noise-hint').textContent = source.kind === 'recording'
      ? 'Your recording keeps its own background noise.'
      : 'Add background hiss to try the noise gate.';
  }
  // Temporary controls stay within the player bar and share the same behavior.
  let activePlayerControl = null;
  function inlinePlayerControl(buttonId, fieldId, sliderId) {
    const button = document.getElementById(buttonId);
    const field = document.getElementById(fieldId);
    const slider = document.getElementById(sliderId);
    let timer, dragging = false;
    const close = () => {
      clearTimeout(timer);
      field.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (activePlayerControl?.close === close) {
        activePlayerControl = null;
        button.closest('.player-dock').classList.remove('adjusting-player');
      }
      if (document.activeElement === slider) button.focus({ preventScroll: true });
    };
    const finish = () => {
      clearTimeout(timer);
      if (!dragging) timer = setTimeout(close, 1500);
    };
    button.onclick = () => {
      if (!field.hidden) { close(); return; }
      activePlayerControl?.close();
      activePlayerControl = { button, field, close };
      field.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      button.closest('.player-dock').classList.add('adjusting-player');
      slider.focus({ preventScroll: true });
    };
    slider.addEventListener('pointerdown', () => { dragging = true; clearTimeout(timer); });
    slider.addEventListener('input', finish);
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      slider.addEventListener(event, () => { dragging = false; finish(); });
    }
    slider.addEventListener('keydown', () => clearTimeout(timer));
    slider.addEventListener('keyup', finish);
  }
  inlinePlayerControl('dock-volume', 'inline-volume', 'volume');
  inlinePlayerControl('dock-playing', 'inline-tempo', 'speed');
  document.addEventListener('click', e => {
    const control = activePlayerControl;
    if (control && !control.field.contains(e.target) && !control.button.contains(e.target)) control.close();
  });
  document.addEventListener('focusin', e => {
    const control = activePlayerControl;
    if (control && !control.field.contains(e.target) && !control.button.contains(e.target)) control.close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') activePlayerControl?.close(); });
  patternSelect.onchange = () => {
    recordingLoad++;
    bringYourOwn.disabled = false;
    bringYourOwn.removeAttribute('aria-busy');
    bringYourOwn.title = 'Bring your own recording';
    source.setKind(patternSelect.value);
    if (source.kind === 'recording') {
      input.fill(0);
      source.generate(input, 0, N);
      source.recordingPosition = 0;
      resetScopeHistory();
    }
    // Start at the pattern's own tempo; Speed changes it from there.
    if (TL.PATTERNS[source.kind]?.tempo) source.tempo = TL.PATTERNS[source.kind].tempo;
    syncPattern();
    state.dirty = true;
    onBoardChange();
    saveBoard();
  };
  speed.addEventListener('input', () => {
    source.tempo = Number(speed.value);
    syncPattern();
    state.dirty = true;
    onBoardChange();
    saveBoard();
  });
  syncPattern();

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
  const selected = () => state.chain.find(p => p.id === selectedId);
  function announce(text) { document.getElementById('order-status').textContent = text; }
  let onBoardChange = () => {};
  function changed() { state.dirty = true; renderOrder(); onBoardChange(); saveBoard(); }
  // A change you made by hand: the slot's sound is now "(edited)".
  function edited() { markEdited(); changed(); }
  function moveEffect(id, to) {
    const from = state.chain.findIndex(p => p.id === id);
    to = Math.max(0, Math.min(state.chain.length - 1, to));
    if (from < 0 || from === to) return;
    const [pedal] = state.chain.splice(from, 1);
    state.chain.splice(to, 0, pedal);
    edited();
    if (!settings.hidden) syncMoveButtons();
    announce(pedalName(pedal) + ' moved to position ' + (to + 1));
  }
  function syncMoveButtons() {
    const index = state.chain.findIndex(p => p.id === selectedId);
    document.getElementById('pedal-earlier').disabled = index <= 0;
    document.getElementById('pedal-later').disabled = index === state.chain.length - 1;
  }
  // Editing happens inline, under the chain and the scope, so the live
  // waveform stays in view while you turn the knobs.
  function closeSettings() {
    settings.hidden = matchMedia('(max-width: 700px), (max-width: 1023px) and (max-height: 500px)').matches;
    const empty = state.chain.length === 0;
    document.getElementById('inspector-empty').hidden = !empty;
    document.getElementById('inspector-controls').hidden = true;
    document.getElementById('inspector-guide').hidden = true;
    settings.querySelector('.sheet-head').hidden = empty;
    settings.querySelector('.inspector-tabs').hidden = empty;
    settings.querySelector('.model-row').hidden = empty;
    document.getElementById('settings-title').textContent = '';
    document.getElementById('settings-state').textContent = '';
    selectedId = null;
    orderList.querySelectorAll('.selected-pedal').forEach(item => { item.classList.remove('selected-pedal'); item.querySelector('.pedal-toggle').setAttribute('aria-pressed', 'false'); });
    document.body.classList.remove('editing');
    renderStrip();
    if (!undoToast.hidden) placeUndo();
  }
  function showPedalNotes(pedal) {
    document.getElementById('settings-state').textContent = pedal.enabled ? 'Enabled' : 'Bypassed';
    document.getElementById('pedal-note').textContent = noteFor(pedal, state.chain);
    const other = otherBank(activeBank);
    const diff = differences(state.chain, banks[other], other).byPedal.get(pedal.id);
    const diffEl = document.getElementById('pedal-diff');
    diffEl.textContent = diff ? 'A/B difference · ' + diff : '';
    diffEl.hidden = !diff;
    updateGuide(pedal);
  }
  let savedTimer;
  function flashSaved() {
    const el = document.getElementById('pedal-saved');
    el.textContent = '✓ Saved';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { el.textContent = ''; }, 1600);
  }
  function openSettings(pedal) {
    const wasOpen = !settings.hidden && selectedId === pedal.id;
    if (!wasOpen) settings.scrollTop = 0;
    selectedId = pedal.id;
    state.dirty = true;
    // Editing a pedal leaves the explicitly chosen listening point unchanged.
    document.getElementById('settings-title').textContent = pedalName(pedal);
    document.getElementById('settings-state').textContent = pedal.enabled ? 'Enabled' : 'Bypassed';
    settings.dataset.type = pedal.type;
    // Which classic pedal this is: its outline, its controls and their names.
    const modelSelect = document.getElementById('pedal-model');
    modelSelect.replaceChildren(...types[pedal.type].models.map(m => new Option(m.name + (m.kind ? ' · ' + m.kind : ''), m.id)));
    modelSelect.value = modelOf(pedal).id;
    modelSelect.onchange = () => {
      pedal.model = modelSelect.value;
      Object.assign(pedal.params, modelOf(pedal).defaults || {});
      edited();
      openSettings(pedal);
      announce(pedalName(pedal) + ' is now a ' + modelOf(pedal).name);
    };
    const showAll = document.getElementById('show-all');
    const hidden = types[pedal.type].specs.length - modelOf(pedal).controls.length;
    showAll.checked = !!pedal.advanced;
    document.getElementById('show-all-label').textContent = 'Show all controls (' + hidden + ' more)';
    showAll.parentElement.hidden = hidden <= 0;
    const container = document.getElementById('pedal-params');
    const renderControls = () => {
      container.replaceChildren();
      buildControls(container, pedal, () => {
        const art = orderList.querySelector('[data-effect="' + pedal.id + '"] .pedal-art');
        if (art) art.innerHTML = pedalArt(pedal);
        markEdited();
        showPedalNotes(pedal);
        flashSaved();
      });
    };
    showAll.onchange = () => { pedal.advanced = showAll.checked; saveBoard(); renderControls(); };
    renderControls();
    document.getElementById('pedal-curve-wrap').hidden = !['gate', 'comp'].includes(pedal.type);
    document.getElementById('effect-explanation').textContent = types[pedal.type].explanation;
    trails.gate.length = trails.comp.length = 0;
    showPedalNotes(pedal);
    syncMoveButtons();
    settings.hidden = false;
    document.getElementById('inspector-empty').hidden = true;
    settings.querySelector('.sheet-head').hidden = false;
    settings.querySelector('.inspector-tabs').hidden = false;
    settings.querySelector('.model-row').hidden = false;
    document.getElementById('inspector-controls').hidden = false;
    document.getElementById('inspector-guide').hidden = true;
    document.getElementById('tab-controls').setAttribute('aria-pressed', 'true');
    document.getElementById('tab-guide').setAttribute('aria-pressed', 'false');
    document.body.classList.add('editing');
    renderStrip();
    orderList.querySelectorAll('[data-effect]').forEach(item => {
      const isSelected = item.dataset.effect === pedal.id;
      item.classList.toggle('selected-pedal', isSelected);
      item.querySelector('.pedal-toggle').setAttribute('aria-pressed', String(isSelected));
    });
    if (!undoToast.hidden) placeUndo();
    updateAuditionButtons();
  }
  function addPedal(type, params, model) {
    const pedal = createPedal(type, params, model);
    state.chain.push(pedal);
    edited();
    announce(pedalName(pedal) + ' added at position ' + state.chain.length);
    return pedal;
  }
  function removePedal(id) {
    const index = state.chain.findIndex(p => p.id === id);
    if (index < 0) return;
    const [pedal] = state.chain.splice(index, 1);
    edited();
    if (state.chain.length) {
      const nextPedal = state.chain[Math.min(index, state.chain.length - 1)];
      openSettings(nextPedal);
      orderList.querySelector('[data-effect="' + nextPedal.id + '"] .pedal-toggle')?.focus({ preventScroll: true });
    } else {
      closeSettings();
      orderList.querySelector('.board-add-tile')?.focus({ preventScroll: true });
    }
    announce(pedalName(pedal) + ' removed');
    const bank = activeBank;
    offerUndo(pedalName(pedal) + ' removed', () => {
      // Put it back on the board it came from, even if A/B was switched since.
      if (activeBank !== bank) document.querySelector('#compare-bank [data-bank="' + bank + '"]').click();
      state.chain.splice(Math.min(index, state.chain.length), 0, pedal);
      edited();
      openSettings(pedal);
      announce(pedalName(pedal) + ' restored at position ' + (state.chain.indexOf(pedal) + 1));
      orderList.querySelector('[data-effect="' + pedal.id + '"] .pedal-toggle')?.focus({ preventScroll: true });
    });
  }

  /* Undo bar: removing a pedal or loading a recipe has no confirmation, so
   * the last such change can be reversed for a few seconds. */
  const undoToast = document.getElementById('undo-toast');
  let undoAction = null, undoTimer;
  function hideUndo() {
    clearTimeout(undoTimer);
    undoToast.hidden = true;
    undoAction = null;
  }
  // Normally at the top of the screen; while a pedal is open for editing it
  // sits inline in the editor, so it never covers the pinned chain or scope.
  const undoHome = undoToast.parentElement;
  // Its home is the status line under the header; when that is scrolled out
  // of view it floats at the top of the screen instead.
  function placeUndo() {
    if (undoToast.parentElement !== undoHome) undoHome.appendChild(undoToast);
    undoToast.classList.add('inline', 'home');
  }
  addEventListener('scroll', () => { if (!undoToast.hidden) placeUndo(); }, { passive: true });
  function offerUndo(text, restore) {
    placeUndo();
    undoAction = restore;
    document.getElementById('undo-text').textContent = text;
    undoToast.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, 8000);
  }
  function undo() {
    const action = undoAction;
    hideUndo();
    action?.();
  }
  document.getElementById('undo-button').onclick = undo;
  document.addEventListener('keydown', e => {
    if (!undoAction || e.key.toLowerCase() !== 'z' || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    e.preventDefault();
    undo();
  });
  document.querySelector('.board-add-tile')?.addEventListener('click', () => library.showModal());
  document.getElementById('strip-add').onclick = () => library.showModal();
  for (const [type, info] of Object.entries(types)) {
    const button = document.createElement('button');
    button.dataset.type = type;
    const preview = { type, model: info.models[0].id, params: P.modelDefaults(type, info.models[0].id) };
    button.innerHTML = artSvg(preview, 'choice-art') + '<strong>' + info.name + '</strong><span class="choice-text">' + info.explanation.split('.')[0] + '.</span><span class="choice-model">' + info.models.map(m => m.name).join(' · ') + '</span><span class="choice-add" aria-hidden="true">+</span>';
    button.onclick = () => {
      const pedal = addPedal(type);
      library.close();
      openSettings(pedal);
    };
    document.getElementById('effect-choices').appendChild(button);
  }
  settings.querySelector('.sheet-close').onclick = () => {
    if (matchMedia('(max-width: 700px), (max-width: 1023px) and (max-height: 500px)').matches) { dismissSettings(); return; }
    const id = selectedId;
    if (state.chain.length > 1 && id) {
      const index = state.chain.findIndex(p => p.id === id);
      openSettings(state.chain[index >= 0 ? index : 0]);
    } else if (state.chain.length) openSettings(state.chain[0]);
    else closeSettings();
  };
  function dismissSettings(restoreFocus = true) {
    settings.hidden = true;
    document.body.classList.remove('editing');
    if (restoreFocus) orderList.querySelector('[data-effect="' + selectedId + '"] .pedal-toggle')?.focus({ preventScroll: true });
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !settings.hidden && matchMedia('(max-width: 700px), (max-width: 1023px) and (max-height: 500px)').matches && !document.querySelector('dialog[open]')) dismissSettings();
  });
  matchMedia('(max-width: 700px), (max-width: 1023px) and (max-height: 500px)').addEventListener('change', e => {
    if (!e.matches) {
      const pedal = selected() || state.chain[0];
      if (pedal) openSettings(pedal); else closeSettings();
    } else if (!state.chain.length) closeSettings();
  });
  const player = document.querySelector('.player-dock');
  const sizePlayer = () => document.documentElement.style.setProperty('--player-height', player.getBoundingClientRect().height + 'px');
  new ResizeObserver(sizePlayer).observe(player);
  sizePlayer();
  for (const dialog of [library]) {
    dialog.querySelector('.sheet-close').onclick = () => dialog.close();
    dialog.addEventListener('click', e => { if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
    } });
  }
  document.getElementById('duplicate-pedal').onclick = () => {
    const pedal = selected();
    if (!pedal) return;
    const copy = addPedal(pedal.type, pedal.params, pedal.model);
    copy.advanced = pedal.advanced;
    moveEffect(copy.id, state.chain.indexOf(pedal) + 1);
    openSettings(copy);
  };
  document.getElementById('remove-pedal').onclick = () => {
    const pedal = selected();
    if (!pedal) return;
    removePedal(pedal.id);
  };
  document.getElementById('pedal-earlier').onclick = () => moveEffect(selectedId, state.chain.findIndex(p => p.id === selectedId) - 1);
  document.getElementById('pedal-later').onclick = () => moveEffect(selectedId, state.chain.findIndex(p => p.id === selectedId) + 1);

  function refreshInspect() {
    if (inspectId && !state.chain.some(p => p.id === inspectId)) {
      inspectId = '';
      monitor = 'wet';
      audition = null;
      resetScopeHistory();
    }
    const pedal = state.chain.find(p => p.id === inspectId);
    document.querySelector('#monitor [data-value="dry"]').textContent = pedal ? 'Before' : 'Dry guitar';
    document.querySelector('#monitor [data-value="wet"]').textContent = pedal ? 'After' : 'With pedals';
    const name = pedal && kindName(pedal).toLowerCase();
    document.getElementById('scope-caption').textContent = !pedal
      ? (monitor === 'dry' || !state.chain.length ? 'Your guitar' : 'Full chain output')
      : (monitor === 'dry' ? 'Before the ' : 'After the ') + name;
    renderStrip();
    document.querySelector('.sw-in').parentElement.lastChild.textContent = pedal ? 'Pedal input' : 'Guitar input';
    document.querySelector('.sw-out').parentElement.lastChild.textContent = pedal ? 'Pedal output' : 'Chain output';
    document.querySelector('.sw-in').parentElement.hidden = monitor !== 'dry';
    document.querySelector('.sw-out').parentElement.hidden = monitor === 'dry';
    document.querySelector('.sw-in').style.background = C.ink;
    document.querySelectorAll('#monitor button').forEach(button => {
      const on = button.dataset.value === monitor;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    });
    syncListeningPoints();
    state.dirty = true;
  }
  document.getElementById('inspect-pedal').onclick = () => { if (selectedId) listenTo(selectedId, 'wet'); };

  /* The chain strip: In, each pedal, Out, with a listening point (dot)
   * between them. Dot k is the signal after k pedals. */
  const strip = document.getElementById('chain-strip');
  function dotPoint(k) {
    const chain = state.chain;
    if (k === 0) return { pedal: '', monitor: 'dry', label: 'Your guitar' };
    if (k === chain.length) return { pedal: '', monitor: 'wet', label: 'Full chain output' };
    return { pedal: chain[k - 1].id, monitor: 'wet', label: 'After ' + pedalName(chain[k - 1]) };
  }
  function syncListeningPoints() {
    const on = activeDot();
    document.querySelectorAll('.listening-point').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.listenIndex) === on)));
    document.querySelector('.endpoint-input').setAttribute('aria-pressed', String(on === 0 && monitor === 'dry'));
    document.querySelector('.endpoint-output').setAttribute('aria-pressed', String(on === state.chain.length && monitor === 'wet'));
  }
  function activeDot() {
    const chain = state.chain;
    const index = chain.findIndex(p => p.id === inspectId);
    if (index < 0) return monitor === 'dry' ? 0 : chain.length;
    return monitor === 'dry' ? index : index + 1;
  }
  function renderStrip() {
    const chain = state.chain;
    const on = activeDot();
    const dot = k => {
      const point = dotPoint(k);
      return `<li class="strip-node"><button type="button" class="strip-dot${k === on ? ' on' : ''}" data-dot="${k}" aria-pressed="${k === on}" aria-label="Listen here: ${point.label}"><i></i></button></li>`;
    };
    const items = ['<li class="strip-end">In</li>', dot(0)];
    chain.forEach((pedal, i) => {
      items.push(`<li class="strip-pedal${pedal.enabled ? '' : ' off'}${pedal.id === selectedId && !settings.hidden ? ' selected' : ''}" data-type="${pedal.type}">` +
        `<button type="button" data-strip-edit="${pedal.id}" aria-label="Tweak ${pedalName(pedal)}">${artSvg(pedal, 'strip-art')}<span>${modelOf(pedal).short || types[pedal.type].short || kindName(pedal)}</span></button></li>`);
      if (i < chain.length - 1) items.push(dot(i + 1));
    });
    if (chain.length) items.push(dot(chain.length));
    items.push('<li class="strip-end">Out</li>');
    strip.innerHTML = items.join('');
    // Keep the selected pedal (or the listening point) in view on narrow screens.
    const focus = strip.querySelector('.strip-pedal.selected') || strip.querySelector('.strip-dot.on');
    if (focus && strip.scrollWidth > strip.clientWidth) {
      const box = focus.getBoundingClientRect(), outer = strip.getBoundingClientRect();
      if (box.right > outer.right) strip.scrollLeft += box.right - outer.right + 12;
      else if (box.left < outer.left) strip.scrollLeft -= outer.left - box.left + 12;
    }
  }
  strip.addEventListener('click', e => {
    const dotButton = e.target.closest('[data-dot]');
    if (dotButton) {
      const point = dotPoint(Number(dotButton.dataset.dot));
      listenTo(point.pedal, point.monitor);
      return;
    }
    const edit = e.target.closest('[data-strip-edit]');
    if (edit) openSettings(state.chain.find(p => p.id === edit.dataset.stripEdit));
  });
  document.getElementById('expand-scope').onclick = e => {
    const expanded = document.querySelector('.scope-disclosure').classList.toggle('scope-expanded');
    e.currentTarget.setAttribute('aria-expanded', String(expanded));
    e.currentTarget.setAttribute('aria-label', expanded ? 'Collapse waveform' : 'Expand waveform');
    e.currentTarget.textContent = expanded ? 'Collapse' : 'Expand';
    state.dirty = true;
  };
  document.getElementById('toggle-meters').onclick = e => {
    metersOpen = !metersOpen;
    e.target.setAttribute('aria-expanded', String(metersOpen));
    e.target.textContent = metersOpen ? 'Hide meters' : 'Show meters';
    state.dirty = true;
  };
  function syncBanks() {
    document.querySelectorAll('#compare-bank [data-bank], #dock-bank [data-bank]').forEach(button => {
      button.classList.toggle('on', button.dataset.bank === activeBank);
      button.setAttribute('aria-pressed', String(button.dataset.bank === activeBank));
    });
    const copy = document.getElementById('copy-bank');
    copy.title = activeBank === 'A' ? 'Copy A to B' : 'Copy B to A';
    copy.setAttribute('aria-label', copy.title);
  }
  document.getElementById('compare-bank').onclick = e => switchBank(e.target.closest('[data-bank]')?.dataset.bank);
  document.getElementById('dock-bank').onclick = e => switchBank(e.target.closest('[data-bank]')?.dataset.bank);
  function switchBank(bank) {
    if (!bank || bank === activeBank) return;
    const selectedIndex = settings.hidden ? -1 : state.chain.findIndex(p => p.id === selectedId);
    const guideOpen = !document.getElementById('inspector-guide').hidden;
    banks[activeBank] = clone(state.chain);
    activeBank = bank;
    state.chain = clone(banks[activeBank]);
    rebuildOrder = true;
    if (!settings.hidden) closeSettings();
    inspectId = inspectByBank[bank];
    selectScopeHistory();
    changed();
    syncBanks();
    refreshSlots();
    if (selectedIndex >= 0 && state.chain.length) {
      openSettings(state.chain[Math.min(selectedIndex, state.chain.length - 1)]);
      showGuide(guideOpen);
    }
    announce(activeBank + ' selected');
  }
  document.getElementById('copy-bank').onclick = () => {
    const other = activeBank === 'A' ? 'B' : 'A';
    banks[other] = buildChain(specOf(state.chain));
    slots[other] = { ...slots[activeBank] };
    state.dirty = true;
    saveBoard();
    refreshSlots();
    announce(activeBank + ' copied to ' + other);
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
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title: 'ToneLab board', url: url.href });
        announce('Board shared');
        return;
      }
      await navigator.clipboard.writeText(url.href);
      announce('Share link copied, including A and B');
    } catch (error) {
      if (error?.name === 'AbortError') return;
      const field = document.getElementById('share-link');
      field.value = url.href;
      document.getElementById('share-dialog').showModal();
      field.select();
    }
  };
  document.querySelector('#share-dialog .sheet-close').onclick = () => document.getElementById('share-dialog').close();
  syncBanks();

  /* -------------------------------------------------------------- tones */

  // Built-in sounds. Each pedal is [type, settings that differ from the
  // pedal's defaults, what it does in this sound]. Each "what if" changes
  // one thing; it loads into B so you can hear it against A.
  const TONES = [
    {
      id: 'edge-streets', group: 'Songs', title: 'The Edge · Where the Streets Have No Name', short: 'The Edge',
      summary: 'One echo, timed so every repeat lands between the notes you pick. Steady eighth notes turn into a shimmering wall of sound.',
      source: { kind: 'eighths', tempo: 126, noise: -60 },
      play: 'Pick steady eighth notes at 126 BPM, all at the same strength. The demo plays a simple pattern, not the song’s actual part.',
      chain: [
        ['comp', { threshold: -26, ratio: 3, attack: 10, release: 150, knee: 6, makeup: 4 }, 'Evens out your picking, so every note, and every echo, comes out at the same volume.'],
        ['drive', { drive: 6, mix: 0.3 }, 'Just a little grit, like an amp turned up until it starts to break up.'],
        ['delay', { time: 357, feedback: 0.3, mix: 0.45 }, 'The secret. 357 ms is ¾ of a beat at 126 BPM, so each echo lands exactly halfway between two notes you play. You pick eighth notes and hear sixteenths.'],
      ],
      tip: 'For any song, the dotted-eighth delay time is 45,000 ÷ BPM. At 120 BPM that’s 375 ms.',
      whatIfs: [
        { id: 'straight', label: 'Echo on the beat', note: 'The echo is set to a plain eighth note (238 ms), so each repeat lands right on top of your next note. Instead of filling the gaps, the echoes blur the notes together.',
          chain: [['comp', { threshold: -26, ratio: 3, attack: 10, release: 150, knee: 6, makeup: 4 }], ['drive', { drive: 6, mix: 0.3 }], ['delay', { time: 238, feedback: 0.3, mix: 0.45 }]] },
        { id: 'no-comp', label: 'No compressor', note: 'Without the compressor, loud and soft picks make loud and soft echoes, so the pattern sounds uneven.',
          chain: [['drive', { drive: 6, mix: 0.3 }], ['delay', { time: 357, feedback: 0.3, mix: 0.45 }]] },
        { id: 'no-delay', label: 'No delay', note: 'Without the delay it’s just a plain arpeggio. The delay is the whole trick.',
          chain: [['comp', { threshold: -26, ratio: 3, attack: 10, release: 150, knee: 6, makeup: 4 }], ['drive', { drive: 6, mix: 0.3 }]] },
      ],
    },
    {
      id: 'hendrix-octave', group: 'Songs', title: 'Jimi Hendrix · octave fuzz', short: 'Hendrix',
      summary: 'The ringing octave fuzz of his “Purple Haze” solo: a thick buzz with a bell-like note an octave above.',
      source: { kind: 'lead', tempo: 100, noise: -60 },
      play: 'Play single notes high up the neck. Octave effects get confused by chords.',
      chain: [
        ['octave', { dry: 0.7, sub: 0, up: 0.7 }, 'Adds a note one octave higher by folding the wave over on itself. It goes first, so it gets your clean signal to work with, and the fuzz after it makes the octave ring like a bell.'],
        ['fuzz', { fuzz: 32, tone: 0.6, level: -8 }, 'Clips everything into a thick, square-edged buzz that sustains for ages.'],
      ],
      tip: 'Turn up “Octave down” on the octave pedal for a huge, growling version of the same sound.',
      whatIfs: [
        { id: 'fuzz-first', label: 'Fuzz before the octave', note: 'The fuzz turns your notes into square waves first. Folding a square wave over adds very little, so the octave gets much weaker. Order matters.',
          chain: [['fuzz', { fuzz: 32, tone: 0.6, level: -8 }], ['octave', { dry: 0.7, sub: 0, up: 0.7 }]] },
        { id: 'no-octave', label: 'No octave', note: 'Just the fuzz: thick, but without the ringing note on top.',
          chain: [['fuzz', { fuzz: 32, tone: 0.6, level: -8 }]] },
      ],
    },
    {
      id: 'gilmour-lead', group: 'Songs', title: 'David Gilmour · singing lead', short: 'Gilmour',
      summary: 'Smooth, long sustain with a soft echo behind it, in the spirit of his “Comfortably Numb” solo.',
      source: { kind: 'sustain', tempo: 60, noise: -60 },
      play: 'Play slow single notes and let each one ring as long as it can.',
      chain: [
        ['comp', { threshold: -24, ratio: 3, attack: 20, release: 300, knee: 6, makeup: 4 }, 'Holds each note up as it fades, so long notes keep singing.'],
        ['fuzz:bigmuff', { fuzz: 26, tone: 0.45, level: -8 }, 'Plenty of gain with the tone turned a little dark: smooth sustain instead of a harsh buzz.'],
        ['delay', { time: 440, feedback: 0.35, mix: 0.3 }, 'A soft echo, low in the mix, that fills the space behind long notes.'],
      ],
      tip: 'Too harsh? Turn the fuzz’s tone down. Too muddy? Lower the delay mix.',
      whatIfs: [
        { id: 'bright', label: 'Brighter fuzz', note: 'With the tone turned all the way up, the same fuzz gets fizzy and harsh. The smoothness comes from the darker tone setting.',
          chain: [['comp', { threshold: -24, ratio: 3, attack: 20, release: 300, knee: 6, makeup: 4 }], ['fuzz:bigmuff', { fuzz: 26, tone: 1, level: -8 }], ['delay', { time: 440, feedback: 0.35, mix: 0.3 }]] },
        { id: 'no-delay', label: 'No delay', note: 'Without the echo the sound gets dry and close, and the gaps between notes feel empty.',
          chain: [['comp', { threshold: -24, ratio: 3, attack: 20, release: 300, knee: 6, makeup: 4 }], ['fuzz:bigmuff', { fuzz: 26, tone: 0.45, level: -8 }]] },
      ],
    },
    {
      id: 'endless-echo', group: 'Techniques', title: 'Endless, clean echo', short: 'Clean echo',
      summary: 'Long echoes that keep ringing, with no hiss building up between notes. It also answers a classic question: noise gate or compressor first?',
      source: { kind: 'guitar', noise: -40 },
      play: 'Play a few notes and let them ring. The demo guitar has a noisy pickup, so you can hear the hiss this sound has to deal with.',
      chain: [
        ['gate', { threshold: -32, attack: 1, hold: 60, release: 250, range: -80 }, 'Goes first. It mutes the hiss between notes before anything else can make it louder. Its threshold sits just above the hiss.'],
        ['comp:cali76', { threshold: -30, ratio: 6, attack: 15, release: 400, knee: 6, makeup: 10 }, 'Keeps each note loud for longer as it fades, so every echo starts strong. It also turns everything up, hiss included.'],
        ['delay', { time: 520, feedback: 0.62, mix: 0.4 }, 'Long echoes with lots of feedback, so they keep repeating. Whatever reaches this pedal gets repeated, hiss included.'],
      ],
      tip: 'Watch the gaps between notes: with the gate first they go flat and silent.',
      whatIfs: [
        { id: 'comp-first', label: 'Compressor before the gate', note: 'The compressor turns everything up, hiss included. Now the hiss is louder than the gate’s threshold, so the gate never closes and the delay repeats the hiss over and over.',
          chain: [['comp:cali76', { threshold: -30, ratio: 6, attack: 15, release: 400, knee: 6, makeup: 10 }], ['gate', { threshold: -32, attack: 1, hold: 60, release: 250, range: -80 }], ['delay', { time: 520, feedback: 0.62, mix: 0.4 }]] },
        { id: 'no-gate', label: 'No noise gate', note: 'Without the gate, the compressor lifts the hiss and the delay keeps repeating it. Listen to the gaps between notes.',
          chain: [['comp:cali76', { threshold: -30, ratio: 6, attack: 15, release: 400, knee: 6, makeup: 10 }], ['delay', { time: 520, feedback: 0.62, mix: 0.4 }]] },
      ],
    },
    {
      id: 'boost-drive', group: 'Techniques', title: 'Boost into overdrive', short: 'Boost + drive',
      summary: 'Why guitarists put a clean boost in front of an overdrive: more crunch and sustain from the same pedal. It also shows why the order matters.',
      source: { kind: 'power', tempo: 100, noise: -60 },
      play: 'Play notes or chords and listen to how hard the overdrive breaks up.',
      chain: [
        ['boost', { boost: 10 }, 'Sends a louder signal into the overdrive. It doesn’t distort by itself; it makes the next pedal work harder.'],
        ['drive', { drive: 10, mix: 0.8 }, 'With the boost in front, it clips harder: thicker crunch and longer sustain.'],
      ],
      tip: 'Many players use a boost as a “solo switch”: step on it and the same overdrive gets more saturated.',
      whatIfs: [
        { id: 'boost-after', label: 'Boost after the overdrive', note: 'Same two pedals, other order. The overdrive now gets your normal signal and the boost only makes the result louder. With Match volume on you’ll hear that A is more distorted, not just louder.',
          chain: [['drive', { drive: 10, mix: 0.8 }], ['boost', { boost: 10 }]] },
        { id: 'no-boost', label: 'No boost', note: 'The overdrive on its own breaks up less: a lighter crunch.',
          chain: [['drive', { drive: 10, mix: 0.8 }]] },
      ],
    },
    {
      id: 'metal', group: 'Techniques', title: 'Tight metal rhythm', short: 'Metal',
      summary: 'High-gain distortion kept tight by a noise gate, with the mids scooped out for a huge, heavy sound.',
      source: { kind: 'chug', tempo: 120, noise: -55 },
      play: 'Play short, heavy notes with rests in between, and listen to the silence in the rests.',
      chain: [
        ['gate', { threshold: -45, attack: 0.5, hold: 20, release: 60, range: -80 }, 'First in line, it shuts off the hiss and hum between notes, so the rests are silent.'],
        ['dist', { gain: 36, tone: 0.55, level: -12 }, 'Lots of gain, clipped hard. It turns every note into a wall of sound, and it would turn the hiss into a wall of noise too.'],
        ['eq:paraeq', { bass: 4, mid: -8, midFreq: 700, treble: 3, level: 0 }, 'Cuts the mids and lifts bass and treble: the “scooped” sound. Switch to the Tone view to see the dip in the middle.'],
      ],
      tip: 'Scooped mids sound huge on their own, but in a band they can make your guitar disappear. Try bringing the mids back up when playing with others.',
      whatIfs: [
        { id: 'no-gate', label: 'No noise gate', note: 'Without the gate, the distortion turns the hiss into loud noise between notes. Look at the gaps in the waveform.',
          chain: [['dist', { gain: 36, tone: 0.55, level: -12 }], ['eq:paraeq', { bass: 4, mid: -8, midFreq: 700, treble: 3, level: 0 }]] },
        { id: 'mids-back', label: 'Mids put back', note: 'With the EQ flat, the mids come back: less “huge” on its own, but more solid and easier to hear in a band. Compare them in the Tone view.',
          chain: [['gate', { threshold: -45, attack: 0.5, hold: 20, release: 60, range: -80 }], ['dist', { gain: 36, tone: 0.55, level: -12 }], ['eq:paraeq', { bass: 0, mid: 0, midFreq: 700, treble: 0, level: 0 }]] },
      ],
    },
    {
      id: 'surf', group: 'Techniques', title: 'Surf tremolo and reverb', short: 'Surf',
      summary: 'Pulsing volume into a bright, splashy reverb: the sound of 60s surf and twang.',
      source: { kind: 'guitar', noise: -60 },
      play: 'Let notes and chords ring, and listen to them pulse.',
      chain: [
        ['trem', { rate: 6, depth: 0.7, shape: 0.3 }, 'Turns the volume up and down six times a second. Watch the waveform throb.'],
        ['reverb:fender', { decay: 0.75, tone: 0.75, mix: 0.45 }, 'A bright, splashy reverb that rings on after each note, a bit like an amp’s spring reverb. Coming after the tremolo, it softens the pulses slightly.'],
      ],
      tip: 'Set the tremolo speed to the song’s tempo so the pulses lock in with the band.',
      whatIfs: [
        { id: 'reverb-first', label: 'Reverb before the tremolo', note: 'Now the tremolo chops the reverb as well, so the pulses go deeper and the reverb tail throbs too. With the tremolo first, the reverb smooths the pulses a little.',
          chain: [['reverb:fender', { decay: 0.75, tone: 0.75, mix: 0.45 }], ['trem', { rate: 6, depth: 0.7, shape: 0.3 }]] },
        { id: 'no-trem', label: 'No tremolo', note: 'Just the reverb: the ringing stays, the pulse is gone.',
          chain: [['reverb:fender', { decay: 0.75, tone: 0.75, mix: 0.45 }]] },
      ],
    },
    {
      id: 'ambient', group: 'Techniques', title: 'Ambient swells', short: 'Swells',
      summary: 'Notes that fade in with no pick attack, into long echoes and a big reverb: the soft, violin-like pad of ambient guitar.',
      source: { kind: 'sustain', tempo: 50, noise: -60 },
      play: 'Play slow single notes or chords and let them ring. The swell hides the pick.',
      chain: [
        ['swell', { rise: 400, sensitivity: -40 }, 'Fades every new note in, as if you rolled a volume pedal up by foot after each pick.'],
        ['delay:multi', { time: 450, feedback: 0.5, mix: 0.4, character: 0.6 }, 'Long echoes that overlap into a pad. With its Tone turned down, each repeat is a little darker than the last.'],
        ['reverb:bigsky', { decay: 0.85, tone: 0.4, mix: 0.5 }, 'A big, dark room that smears everything into one long wash.'],
      ],
      tip: 'Turn Match volume on: swells are quieter than picked notes, and you want to compare the sound, not the level.',
      whatIfs: [
        { id: 'no-swell', label: 'No swell', note: 'Every note now starts with the click of the pick. Look at the start of each note: in A it ramps up, in B it jumps.',
          chain: [['delay:multi', { time: 450, feedback: 0.5, mix: 0.4, character: 0.6 }], ['reverb:bigsky', { decay: 0.85, tone: 0.4, mix: 0.5 }]] },
        { id: 'clean-echoes', label: 'Clean echoes', note: 'The same echoes with the delay’s Tone turned all the way up: every repeat stays bright and exact instead of getting darker. Switch to the Tone view to see the extra treble.',
          chain: [['swell', { rise: 400, sensitivity: -40 }], ['delay:multi', { time: 450, feedback: 0.5, mix: 0.4, character: 0 }], ['reverb:bigsky', { decay: 0.85, tone: 0.4, mix: 0.5 }]] },
      ],
    },
    {
      id: 'eighties', group: 'Techniques', title: 'Lush 80s clean', short: '80s clean',
      summary: 'A shimmering clean sound: chorus for width, a short echo and a little reverb.',
      source: { kind: 'arp-slow', tempo: 100, noise: -60 },
      play: 'Play clean chords or arpeggios and let them ring.',
      chain: [
        ['comp', { threshold: -24, ratio: 3, attack: 15, release: 200, knee: 6, makeup: 3 }, 'Keeps the clean notes even and helps them ring.'],
        ['chorus:ce2w', { rate: 0.8, depth: 0.5, mix: 0.6 }, 'Adds a slightly detuned, slowly wobbling copy of your playing, like two guitars at once. That’s the shimmer.'],
        ['delay', { time: 380, feedback: 0.25, mix: 0.25 }, 'One or two soft echoes that add depth.'],
        ['reverb', { decay: 0.5, tone: 0.6, mix: 0.25 }, 'A little room around the sound.'],
      ],
      tip: 'Chorus sounds best on clean sounds. In front of heavy distortion it can get wobbly and messy.',
      whatIfs: [
        { id: 'no-chorus', label: 'No chorus', note: 'Same echo and reverb without the chorus: a single, narrower guitar.',
          chain: [['comp', { threshold: -24, ratio: 3, attack: 15, release: 200, knee: 6, makeup: 3 }], ['delay', { time: 380, feedback: 0.25, mix: 0.25 }], ['reverb', { decay: 0.5, tone: 0.6, mix: 0.25 }]] },
        { id: 'fast-chorus', label: 'Fast, deep chorus', note: 'Turned up fast and deep, the chorus becomes a seasick warble. Subtle settings are what make it lush.',
          chain: [['comp', { threshold: -24, ratio: 3, attack: 15, release: 200, knee: 6, makeup: 3 }], ['chorus:ce2w', { rate: 4, depth: 1, mix: 0.6 }], ['delay', { time: 380, feedback: 0.25, mix: 0.25 }], ['reverb', { decay: 0.5, tone: 0.6, mix: 0.25 }]] },
      ],
    },
    {
      id: 'auto-wah', group: 'Techniques', title: 'Funky auto-wah', short: 'Auto-wah', view: 'tone',
      summary: 'The quacky funk sound: an envelope filter (auto-wah) that opens each time you pick, so every note goes “wow”.',
      source: { kind: 'funk', tempo: 100, noise: -60 },
      play: 'Pick short notes. Picking harder opens the wah wider.',
      chain: [
        ['comp', { threshold: -28, ratio: 4, attack: 8, release: 120, knee: 6, makeup: 6 }, 'Evens out your picking, so the wah opens about the same amount on every note.'],
        ['wah:qtron', { mode: 1, position: 0.5, sensitivity: 16, speed: 1.5, resonance: 6 }, 'Follows your picking: each pick opens the filter and it closes as the note fades. That sweep is the “quack”. In the Tone view, watch the peak jump right on each pick.'],
      ],
      tip: 'For a classic rocking wah instead, set Mode to “Rocks by itself” and slow the speed down.',
      whatIfs: [
        { id: 'held', label: 'Wah held still', note: 'The same filter parked in one spot: a nasal, honky sound with no movement. Players call this a “cocked wah”.',
          chain: [['comp', { threshold: -28, ratio: 4, attack: 8, release: 120, knee: 6, makeup: 6 }], ['wah:crybaby', { mode: 0, position: 0.55, sensitivity: 16, speed: 1.5, resonance: 6 }]] },
        { id: 'no-comp', label: 'No compressor', note: 'Without the compressor, loud picks open the wah wide and soft ones barely move it, so the quack comes and goes.',
          chain: [['wah:qtron', { mode: 1, position: 0.5, sensitivity: 16, speed: 1.5, resonance: 6 }]] },
      ],
    },
    {
      id: 'phaser', group: 'Techniques', title: 'Slow phaser swirl', short: 'Phaser', view: 'tone',
      summary: 'A slow, swirling sweep that makes a simple part move: a classic 70s texture.',
      source: { kind: 'strum-rock', tempo: 110, noise: -60 },
      play: 'Play steady chords or a riff and listen for the slow whoosh.',
      chain: [
        ['drive', { drive: 8, mix: 0.5 }, 'A bit of grit gives the phaser more to sweep through.'],
        ['phaser', { rate: 0.5, depth: 0.7, feedback: 0.4 }, 'Cuts moving notches into the sound. In the Tone view you can see the dips slide back and forth.'],
      ],
      tip: 'Slow speeds sound smooth and spacious; fast speeds sound bubbly and dramatic.',
      whatIfs: [
        { id: 'fast', label: 'Fast phaser', note: 'Sped up, the slow swirl becomes a bubbly, underwater warble.',
          chain: [['drive', { drive: 8, mix: 0.5 }], ['phaser', { rate: 4, depth: 0.7, feedback: 0.4 }]] },
        { id: 'no-phaser', label: 'No phaser', note: 'Just the drive: the same notes, standing still.',
          chain: [['drive', { drive: 8, mix: 0.5 }]] },
      ],
    },
    {
      id: 'cerati-persiana', group: 'Songs', title: 'Gustavo Cerati · Persiana Americana', short: 'Persiana',
      summary: 'A clean, shimmering guitar floating in a wide space: soft chorus, a gentle echo and a big room. In the spirit of the song, not a copy of its recording.',
      source: { kind: 'strum-wash', tempo: 80, noise: -60 },
      play: 'Play clean chords, or single notes with space between them, and let them ring into the echo.',
      chain: [
        ['comp', { threshold: -26, ratio: 2.5, attack: 12, release: 220, knee: 6, makeup: 2, blend: 1 }, 'Keeps the clean notes even, so the chorus and echoes sit at a steady level.'],
        ['chorus:smallclone', { rate: 0.6, depth: 0.35, mix: 0.45 }, 'A slow, gentle wobble on a copy of your playing: the shimmer that makes clean chords feel wide.'],
        ['delay:dd3', { time: 375, feedback: 0.3, mix: 0.25, character: 0 }, 'A soft, clean echo on a dotted eighth, so each repeat lands between your notes.'],
        ['reverb:bigsky', { decay: 0.7, predelay: 30, mix: 0.3, tone: 0.6, mode: 1 }, 'A big hall that makes the whole thing float in the air.'],
      ],
      tip: 'Keep the chorus subtle. Turned up, it becomes a seasick warble; a little is what gives the shimmer.',
      whatIfs: [
        { id: 'no-chorus', label: 'No chorus', note: 'Without the chorus the notes sit still and narrow. The echoes and room are still there, but the shimmer is gone.',
          chain: [['comp', { threshold: -26, ratio: 2.5, attack: 12, release: 220, knee: 6, makeup: 2, blend: 1 }], ['delay:dd3', { time: 375, feedback: 0.3, mix: 0.25, character: 0 }], ['reverb:bigsky', { decay: 0.7, predelay: 30, mix: 0.3, tone: 0.6, mode: 1 }]] },
        { id: 'chorus-after-reverb', label: 'Chorus after the reverb', note: 'Now the chorus wobbles the whole reverb tail too, so the room itself seems to sway. It’s a more dreamy, unsettled sound.',
          chain: [['comp', { threshold: -26, ratio: 2.5, attack: 12, release: 220, knee: 6, makeup: 2, blend: 1 }], ['delay:dd3', { time: 375, feedback: 0.3, mix: 0.25, character: 0 }], ['reverb:bigsky', { decay: 0.7, predelay: 30, mix: 0.3, tone: 0.6, mode: 1 }], ['chorus:smallclone', { rate: 0.6, depth: 0.35, mix: 0.45 }]] },
      ],
    },
    {
      id: 'audioslave-stone', group: 'Songs', title: 'Audioslave · Like a Stone', short: 'Like a Stone',
      summary: 'A clean, ringing intro that opens up into a warm, driven lead: chorus and a wide room over a little overdrive. In the spirit of the song, not a copy of its recording.',
      source: { kind: 'arp-slow', tempo: 108, noise: -60 },
      play: 'Play a clean, ringing arpeggio, then dig in with a few single notes and listen to the room catch them.',
      chain: [
        ['drive:ts9', { drive: 5, tone: 0.5, level: -3, mix: 0.6 }, 'A light overdrive, just enough to thicken the notes without losing the clean sparkle. The chorus comes after it, so the wobble only touches your playing, and the room stays steady.'],
        ['chorus:smallclone', { rate: 0.9, depth: 0.45, mix: 0.5 }, 'Adds a wide, moving copy of your playing, so the ringing notes feel bigger.'],
        ['reverb:bigsky', { decay: 0.6, predelay: 20, mix: 0.3, tone: 0.55, dwell: 0.55, mode: 1 }, 'A big hall that carries each note out into the space, making the lead feel big.'],
      ],
      tip: 'Roll the drive back for the clean intro; push it a little for the lead. The same chain covers both.',
      whatIfs: [
        { id: 'no-drive', label: 'No overdrive', note: 'Clean all the way: the chorus and room do the work. The notes are cleaner and thinner, closer to the intro.',
          chain: [['chorus:smallclone', { rate: 0.9, depth: 0.45, mix: 0.5 }], ['reverb:bigsky', { decay: 0.6, predelay: 20, mix: 0.3, tone: 0.55, dwell: 0.55, mode: 1 }]] },
        { id: 'reverb-first', label: 'Reverb before the chorus', note: 'Now the chorus sits after the room, so it wobbles the reverb tail as well. The sound is more dreamy and swirling.',
          chain: [['drive:ts9', { drive: 5, tone: 0.5, level: -3, mix: 0.6 }], ['reverb:bigsky', { decay: 0.6, predelay: 20, mix: 0.3, tone: 0.55, dwell: 0.55, mode: 1 }], ['chorus:smallclone', { rate: 0.9, depth: 0.45, mix: 0.5 }]] },
      ],
    },
    {
      id: 'mayer-daughters', group: 'Songs', title: 'John Mayer · Daughters', short: 'Daughters',
      summary: 'A warm, clean single-coil tone with a little compression and body from a boost, sitting in a small room. In the spirit of the song, not a copy of its recording.',
      source: { kind: 'fingerstyle', tempo: 84, noise: -60 },
      play: 'Play clean, warm single notes and chords with a light touch. Notice how evenly the picks come out.',
      chain: [
        ['comp:keeley', { threshold: -24, makeup: 2, tone: 0.5, input: 0, blend: 0.7 }, 'Evens out the picking gently, so soft and loud notes sit close together.'],
        ['boost:spark', { boost: 3, voicing: 1, bass: 0, treble: 0, level: 0 }, 'A small lift with the fat setting, adding warmth in the low mids without any grit.'],
        ['reverb:bigsky', { decay: 0.35, predelay: 10, mix: 0.2, tone: 0.5, mode: 0 }, 'A small room, just enough to place the guitar in a space.'],
      ],
      tip: 'Turn the guitar’s volume knob down a little for the warmest clean. The compressor and boost reward a softer touch.',
      whatIfs: [
        { id: 'no-comp', label: 'No compressor', note: 'Without the compressor, loud picks stand out from soft ones. The sound is more dynamic and a bit less smooth.',
          chain: [['boost:spark', { boost: 3, voicing: 1, bass: 0, treble: 0, level: 0 }], ['reverb:bigsky', { decay: 0.35, predelay: 10, mix: 0.2, tone: 0.5, mode: 0 }]] },
        { id: 'mid-boost', label: 'Mid boost instead of fat', note: 'The Mid setting pushes the middle forward instead of the low mids. It cuts through more, and feels a little brighter and more vocal.',
          chain: [['comp:keeley', { threshold: -24, makeup: 2, tone: 0.5, input: 0, blend: 0.7 }], ['boost:spark', { boost: 3, voicing: 2, bass: 0, treble: 0, level: 0 }], ['reverb:bigsky', { decay: 0.35, predelay: 10, mix: 0.2, tone: 0.5, mode: 0 }]] },
      ],
    },
    {
      id: 'srv-texas', group: 'Songs', title: 'Stevie Ray Vaughan · Texas blues', short: 'Texas blues',
      summary: 'A punchy blues crunch: a tight compressor and a mid-focused overdrive that makes single notes sing and sustain. In the spirit of the style, not a copy of any recording.',
      source: { kind: 'shuffle', tempo: 120, noise: -60 },
      play: 'Hit single notes hard and let them ring. Listen to the sustain and the edge on each note.',
      chain: [
        ['comp:keeley', { threshold: -28, makeup: 4, tone: 0.5, input: 0, blend: 0.8 }, 'Evens out your picking, so hard and soft notes sit at a similar level and sustain longer.'],
        ['drive:ts9', { drive: 14, tone: 0.55, level: -2, mix: 1, voicing: 1, clipping: 0 }, 'A mid-hump overdrive: it cuts the lows before clipping, so single notes cut through the band.'],
      ],
      tip: 'Roll the guitar’s volume knob back a little to clean up chords without changing the lead tone.',
      whatIfs: [
        { id: 'no-comp', label: 'No compressor', note: 'Hard picks jump out and soft notes get lost. The sustain is shorter and less even.',
          chain: [['drive:ts9', { drive: 14, tone: 0.55, level: -2, mix: 1, voicing: 1, clipping: 0 }]] },
        { id: 'drive-first', label: 'Overdrive before the compressor', note: 'The compressor now only evens out the already-clipped sound. Notes feel squashed and lose some of their edge.',
          chain: [['drive:ts9', { drive: 14, tone: 0.55, level: -2, mix: 1, voicing: 1, clipping: 0 }], ['comp:keeley', { threshold: -28, makeup: 4, tone: 0.5, input: 0, blend: 0.8 }]] },
      ],
    },
    {
      id: 'summers-chorus', group: 'Songs', title: 'Andy Summers · clean chorus', short: 'Clean chorus',
      summary: 'Clean, bright chords with a wide, warm chorus and a soft echo. In the spirit of the clean chorus sound of the early 80s, not a copy of any recording.',
      source: { kind: 'reggae', tempo: 104, noise: -60 },
      play: 'Play clean arpeggios and chords with a light touch, and let the chorus spread them out.',
      chain: [
        ['comp:keeley', { threshold: -24, makeup: 1, tone: 0.55, input: 0, blend: 0.8 }, 'Keeps clean notes at a steady level, so the chorus and echo don’t jump around.'],
        ['chorus:ce2w', { rate: 0.9, depth: 0.5, mix: 0.5, voice: 1 }, 'A warm, wide chorus: a slightly detuned copy of your playing that moves slowly.'],
        ['delay:dd3', { time: 330, feedback: 0.25, mix: 0.2, character: 0 }, 'A quiet echo that sits in the gaps between chords.'],
        ['reverb:bigsky', { decay: 0.4, predelay: 15, mix: 0.2, tone: 0.6, mode: 0 }, 'A little room, so the guitar sits in a space.'],
      ],
      tip: 'Keep the echo low. It should be felt more than heard.',
      whatIfs: [
        { id: 'no-delay', label: 'No delay', note: 'The chorus and room are still there, but the echo in the gaps is gone. The chords sound closer and less spacious.',
          chain: [['comp:keeley', { threshold: -24, makeup: 1, tone: 0.55, input: 0, blend: 0.8 }], ['chorus:ce2w', { rate: 0.9, depth: 0.5, mix: 0.5, voice: 1 }], ['reverb:bigsky', { decay: 0.4, predelay: 15, mix: 0.2, tone: 0.6, mode: 0 }]] },
        { id: 'no-chorus', label: 'No chorus', note: 'Clean and narrow. The echo and room remain, but the wide, moving shimmer is gone.',
          chain: [['comp:keeley', { threshold: -24, makeup: 1, tone: 0.55, input: 0, blend: 0.8 }], ['delay:dd3', { time: 330, feedback: 0.25, mix: 0.2, character: 0 }], ['reverb:bigsky', { decay: 0.4, predelay: 15, mix: 0.2, tone: 0.6, mode: 0 }]] },
      ],
    },
    {
      id: 'marr-jangle', group: 'Songs', title: 'Johnny Marr · jangle', short: 'Jangle',
      summary: 'Bright, ringing clean chords with a light chorus and a plate room. In the spirit of the jangly clean style, not a copy of any recording.',
      source: { kind: 'strum-jangle', tempo: 124, noise: -60 },
      play: 'Strum open chords with a bright, quick attack, and let them ring.',
      chain: [
        ['comp:keeley', { threshold: -22, makeup: 1, tone: 0.6, input: 0, blend: 0.8 }, 'Keeps the strums even, so every chord rings out at the same level.'],
        ['chorus:smallclone', { rate: 0.7, depth: 0.3, mix: 0.4 }, 'A light shimmer, enough to make the strings sound bright without blurring them.'],
        ['reverb:bigsky', { decay: 0.45, predelay: 10, mix: 0.25, tone: 0.75, mode: 2 }, 'A bright plate: a dense, smooth reverb that keeps the chords crisp.'],
      ],
      tip: 'Bright is the point here: lift the treble on the reverb before you touch the guitar’s tone knob.',
      whatIfs: [
        { id: 'room', label: 'Room instead of plate', note: 'A room is darker and less bright. The chords lose their sparkle and sit back in the mix.',
          chain: [['comp:keeley', { threshold: -22, makeup: 1, tone: 0.6, input: 0, blend: 0.8 }], ['chorus:smallclone', { rate: 0.7, depth: 0.3, mix: 0.4 }], ['reverb:bigsky', { decay: 0.45, predelay: 10, mix: 0.25, tone: 0.75, mode: 0 }]] },
        { id: 'deep-chorus', label: 'Deeper chorus', note: 'With more depth the chorus wobbles much more. The chords get seasick and lose their crispness.',
          chain: [['comp:keeley', { threshold: -22, makeup: 1, tone: 0.6, input: 0, blend: 0.8 }], ['chorus:smallclone', { rate: 0.7, depth: 0.9, mix: 0.4 }], ['reverb:bigsky', { decay: 0.45, predelay: 10, mix: 0.25, tone: 0.75, mode: 2 }]] },
      ],
    },
    {
      id: 'queen-layers', group: 'Songs', title: 'Brian May · layered lead echo', short: 'Layered lead',
      summary: 'A singing lead with mild overdrive and two echoes at different times, so each note comes back in layers. In the spirit of the style, not a copy of any recording.',
      source: { kind: 'lead', tempo: 90, noise: -60 },
      play: 'Play a melody with long notes and bends. Listen for the echoes stacking up behind each note.',
      chain: [
        ['drive:ts9', { drive: 8, tone: 0.6, level: -1, mix: 0.9, voicing: 0, clipping: 1 }, 'A mild, warm overdrive: enough to make the lead sing, without hiding the notes.'],
        ['delay:dd3', { time: 300, feedback: 0.35, mix: 0.3, character: 0 }, 'The first echo: quick and clean, so it doubles each note.'],
        ['delay:multi', { time: 600, feedback: 0.3, mix: 0.25, character: 0.1, type: 0 }, 'A second, slower echo that lands after the first. Together they build layers.'],
        ['reverb:bigsky', { decay: 0.5, predelay: 10, mix: 0.25, tone: 0.55, mode: 2 }, 'A plate that gives the layers some room.'],
      ],
      tip: 'Set the second echo to about twice the first one’s time for a layered, stacked feel.',
      whatIfs: [
        { id: 'one-echo', label: 'One echo', note: 'Only the first echo. Each note has one repeat, so it sounds simpler and less layered.',
          chain: [['drive:ts9', { drive: 8, tone: 0.6, level: -1, mix: 0.9, voicing: 0, clipping: 1 }], ['delay:dd3', { time: 300, feedback: 0.35, mix: 0.3, character: 0 }], ['reverb:bigsky', { decay: 0.5, predelay: 10, mix: 0.25, tone: 0.55, mode: 2 }]] },
        { id: 'echo-before-drive', label: 'Echo before the overdrive', note: 'Now the echoes are overdriven too, so the repeats grow gritty and harsher with each one.',
          chain: [['delay:dd3', { time: 300, feedback: 0.35, mix: 0.3, character: 0 }], ['delay:multi', { time: 600, feedback: 0.3, mix: 0.25, character: 0.1, type: 0 }], ['drive:ts9', { drive: 8, tone: 0.6, level: -1, mix: 0.9, voicing: 0, clipping: 1 }], ['reverb:bigsky', { decay: 0.5, predelay: 10, mix: 0.25, tone: 0.55, mode: 2 }]] },
      ],
    },
    {
      id: 'beck-wah', group: 'Songs', title: 'Jeff Beck · wah lead', short: 'Wah lead',
      summary: 'A vocal wah lead on a bright overdrive, with the wah parked in the middle. In the spirit of the style, not a copy of any recording.',
      source: { kind: 'lead', tempo: 100, noise: -60 },
      play: 'Bend a note and rock the wah with your foot. Hold the wah still and play single notes to hear it sing.',
      chain: [
        ['drive:ts9', { drive: 12, tone: 0.7, level: 0, mix: 1, voicing: 0, clipping: 0 }, 'A bright overdrive that gives the wah something to shape.'],
        ['wah:crybaby', { position: 0.6, mode: 0, resonance: 5, filter: 0, sensitivity: 14, speed: 1.5, direction: 0, range: 0.5, level: 0 }, 'The wah is parked just past the middle. A peak in the sound gives the notes a vocal, talking quality.'],
        ['reverb:bigsky', { decay: 0.45, predelay: 20, mix: 0.2, tone: 0.6, mode: 1 }, 'A small hall, so the wah lead has space around it.'],
      ],
      tip: 'Rock the wah slowly during a long bend. That sweep is the vocal sound.',
      whatIfs: [
        { id: 'auto-wah', label: 'Wah rocks by itself', note: 'The wah now sweeps on its own, with no foot needed. The lead pulses steadily, like an automatic wah.',
          chain: [['drive:ts9', { drive: 12, tone: 0.7, level: 0, mix: 1, voicing: 0, clipping: 0 }], ['wah:crybaby', { position: 0.6, mode: 2, resonance: 5, filter: 0, sensitivity: 14, speed: 1.2, direction: 0, range: 0.5, level: 0 }], ['reverb:bigsky', { decay: 0.45, predelay: 20, mix: 0.2, tone: 0.6, mode: 1 }]] },
        { id: 'wah-after-drive', label: 'Wah after the overdrive', note: 'The overdrive now feeds the wah, so the filter gets a harder, fuzzier signal. The sweep is more aggressive and less smooth.',
          chain: [['wah:crybaby', { position: 0.6, mode: 0, resonance: 5, filter: 0, sensitivity: 14, speed: 1.5, direction: 0, range: 0.5, level: 0 }], ['drive:ts9', { drive: 12, tone: 0.7, level: 0, mix: 1, voicing: 0, clipping: 0 }], ['reverb:bigsky', { decay: 0.45, predelay: 20, mix: 0.2, tone: 0.6, mode: 1 }]] },
      ],
    },
    {
      id: 'lizzy-harmony', group: 'Songs', title: 'Thin Lizzy · harmony lead', short: 'Harmony lead',
      summary: 'Melodies with a harmony a third above, on a bright overdrive and a plate-like room. The harmony follows the key, so it stays in the scale. In the spirit of the style, not a copy of any recording.',
      source: { kind: 'melody', tempo: 112, noise: -60 },
      play: 'Play a melody in A major, mostly single notes. Single notes give the cleanest harmony.',
      chain: [
        ['drive:ts9', { drive: 8, tone: 0.6, level: -2, mix: 0.8, voicing: 1, clipping: 0 }, 'A moderate overdrive: enough sustain for the lead, with the notes still clear.'],
        ['harm:ps6', { mode: 1, key: 9, mix: 0.5, steps1: 2, steps2: 0 }, 'Adds a third above each note, using only the notes of A major so the harmony sounds right.'],
        ['reverb:bigsky', { decay: 0.4, predelay: 15, mix: 0.2, tone: 0.6, mode: 2 }, 'A bright room that carries the harmony with the lead.'],
      ],
      tip: 'Harmony works best on slow, clear melodies. Fast runs can make the harmony lag behind.',
      whatIfs: [
        { id: 'fixed-third', label: 'Always a major third', note: 'The harmony is always a major third up, even when the note makes it clash with the key. Some harmonies sound off.',
          chain: [['drive:ts9', { drive: 8, tone: 0.6, level: -2, mix: 0.8, voicing: 1, clipping: 0 }], ['harm:ps6', { mode: 0, voice1: 4, voice2: 0, mix: 0.5 }], ['reverb:bigsky', { decay: 0.4, predelay: 15, mix: 0.2, tone: 0.6, mode: 2 }]] },
        { id: 'minor-key', label: 'Minor key', note: 'Using the minor scale gives a darker harmony. The same melody sounds moodier.',
          chain: [['drive:ts9', { drive: 8, tone: 0.6, level: -2, mix: 0.8, voicing: 1, clipping: 0 }], ['harm:ps6', { mode: 2, key: 9, mix: 0.5, steps1: 2, steps2: 0 }], ['reverb:bigsky', { decay: 0.4, predelay: 15, mix: 0.2, tone: 0.6, mode: 2 }]] },
      ],
    },
    {
      id: 'shoegaze-wall', group: 'Techniques', title: 'Shoegaze wall of sound', short: 'Wall of sound',
      summary: 'A huge, washed-out wall: fuzz, a wide chorus, a long echo and a big reverb. In the spirit of the shoegaze style.',
      source: { kind: 'strum-wash', tempo: 72, noise: -60 },
      play: 'Hold big chords and let them swell into the fuzz. The sound is in the sustain.',
      chain: [
        ['fuzz:bigmuff', { fuzz: 28, tone: 0.5, level: -8, bias: 0.5, gate: 0, compress: 0.3, stability: 1 }, 'Heavy, sustaining fuzz: it turns chords into a thick, smooth wall.'],
        ['chorus:smallclone', { rate: 0.4, depth: 0.6, mix: 0.5 }, 'A slow, deep wobble that makes the wall feel like it’s moving.'],
        ['delay:dd3', { time: 450, feedback: 0.45, mix: 0.35, character: 0.3 }, 'Long, slightly dark echoes that fill the gaps between chords.'],
        ['reverb:bigsky', { decay: 0.8, predelay: 30, mix: 0.4, tone: 0.45, mode: 1 }, 'A huge hall: the whole sound drifts in the air.'],
      ],
      tip: 'Lower the fuzz if the chords blur into mud. Some clarity makes the wall more impressive.',
      whatIfs: [
        { id: 'clean-wall', label: 'Clean wall (no fuzz)', note: 'Without the fuzz it’s a clean, shimmering wash of chorus and echo. Softer, but the sound loses its weight.',
          chain: [['chorus:smallclone', { rate: 0.4, depth: 0.6, mix: 0.5 }], ['delay:dd3', { time: 450, feedback: 0.45, mix: 0.35, character: 0.3 }], ['reverb:bigsky', { decay: 0.8, predelay: 30, mix: 0.4, tone: 0.45, mode: 1 }]] },
        { id: 'reverb-in-fuzz', label: 'Reverb before the fuzz', note: 'The fuzz now clips the reverb too, so the room turns into a noisy, gritty haze.',
          chain: [['chorus:smallclone', { rate: 0.4, depth: 0.6, mix: 0.5 }], ['delay:dd3', { time: 450, feedback: 0.45, mix: 0.35, character: 0.3 }], ['reverb:bigsky', { decay: 0.8, predelay: 30, mix: 0.4, tone: 0.45, mode: 1 }], ['fuzz:bigmuff', { fuzz: 28, tone: 0.5, level: -8, bias: 0.5, gate: 0, compress: 0.3, stability: 1 }]] },
      ],
    },
    {
      id: 'dub-echo', group: 'Techniques', title: 'Dub echo', short: 'Dub echo',
      summary: 'A long, dark tape echo over a spring-like room, the sound of studio dub reggae. In the spirit of the style.',
      source: { kind: 'reggae', tempo: 72, noise: -60 },
      play: 'Play short, sparse chords or single stabs, then let the echoes do the rest.',
      chain: [
        ['delay:multi', { time: 480, feedback: 0.6, mix: 0.45, character: 0.5, type: 2, subdivision: 0, modDepth: 0.2, modRate: 0.6 }, 'A tape echo: each repeat gets darker and wobbles a little, the core of the dub sound.'],
        ['reverb:fender', { dwell: 0.5, mix: 0.3, tone: 0.4 }, 'A spring room: a small, boingy space that the echoes bounce around in.'],
      ],
      tip: 'Mute the echo for a beat, then bring it back in. The gaps are part of the sound.',
      whatIfs: [
        { id: 'digital', label: 'Digital echo', note: 'Clean, exact repeats. Bright and precise, but the dark, wobbling dub character is gone.',
          chain: [['delay:multi', { time: 480, feedback: 0.6, mix: 0.45, character: 0, type: 0, subdivision: 0, modDepth: 0, modRate: 0.6 }], ['reverb:fender', { dwell: 0.5, mix: 0.3, tone: 0.4 }]] },
        { id: 'reverb-first', label: 'Echo after the room', note: 'The echoes now repeat the room as well, so they wash over each other into a long, murky haze.',
          chain: [['reverb:fender', { dwell: 0.5, mix: 0.3, tone: 0.4 }], ['delay:multi', { time: 480, feedback: 0.6, mix: 0.45, character: 0.5, type: 2, subdivision: 0, modDepth: 0.2, modRate: 0.6 }]] },
      ],
    },
    {
      id: 'country-twang', group: 'Techniques', title: 'Country twang', short: 'Twang',
      summary: 'A snappy, clean twang with a touch of drive and a spring room. In the spirit of the style.',
      source: { kind: 'boomchick', tempo: 130, noise: -60 },
      play: 'Pick quick single notes and double-stops, and listen for the snap on each attack.',
      chain: [
        ['comp:dynacomp', { threshold: -26, ratio: 4, attack: 3, release: 120, knee: 3, makeup: 3, tone: 0.5, input: 0 }, 'A quick compressor that keeps the snap of each pick even.'],
        ['drive:ts9', { drive: 3, tone: 0.7, level: 0, mix: 0.5, voicing: 0, clipping: 0 }, 'Just a touch of grit, so the twang has some bite.'],
        ['reverb:fender', { dwell: 0.5, mix: 0.3, tone: 0.7 }, 'A spring room: the classic boing that makes twang sound like twang.'],
      ],
      tip: 'Use the bridge pickup and a little less drive for the cleanest twang.',
      whatIfs: [
        { id: 'no-drive', label: 'No drive', note: 'Clean twang: crisp and bright, with no grit. The snap is still there, but it sounds more polite.',
          chain: [['comp:dynacomp', { threshold: -26, ratio: 4, attack: 3, release: 120, knee: 3, makeup: 3, tone: 0.5, input: 0 }], ['reverb:fender', { dwell: 0.5, mix: 0.3, tone: 0.7 }]] },
        { id: 'plate', label: 'Plate instead of spring', note: 'A plate is smoother and less boingy. The twang loses its snap and sounds more like a smooth ballad.',
          chain: [['comp:dynacomp', { threshold: -26, ratio: 4, attack: 3, release: 120, knee: 3, makeup: 3, tone: 0.5, input: 0 }], ['drive:ts9', { drive: 3, tone: 0.7, level: 0, mix: 0.5, voicing: 0, clipping: 0 }], ['reverb:bigsky', { decay: 0.4, predelay: 10, mix: 0.3, tone: 0.7, mode: 2 }]] },
      ],
    },
    {
      id: 'funk-chank', group: 'Techniques', title: 'Funk chank', short: 'Funk chank',
      summary: 'Tight, bright, percussive rhythm guitar: a fast compressor and a little presence and mid lift for the chicken-scratch sound. In the spirit of the style.',
      source: { kind: 'funk', tempo: 100, noise: -60 },
      play: 'Play short, muted chords on the upbeats. Listen for the tight, percussive “chank”.',
      chain: [
        ['comp:cali76', { threshold: -30, makeup: 4, ratio: 6, attack: 2, release: 90, blend: 1 }, 'A fast, tight compressor: it grabs each chord and lets it go quickly, so the rhythm stays crisp.'],
        ['eq:paraeq', { mid: 3, midFreq: 1500, midQ: 1, bass: -2, bassFreq: 120, bassQ: 0.7, treble: 2, trebleFreq: 3000, trebleQ: 0.7, presence: 3, level: 0 }, 'Lifts the middle and the top, so the chank cuts through a band. The low end is trimmed to stay tight.'],
      ],
      tip: 'Mute the strings slightly with your fretting hand for the percussive version.',
      whatIfs: [
        { id: 'slow-attack', label: 'Slower compressor attack', note: 'A slower attack lets each pick click through before the compression, so the chank loses its snap.',
          chain: [['comp:cali76', { threshold: -30, makeup: 4, ratio: 6, attack: 40, release: 90, blend: 1 }], ['eq:paraeq', { mid: 3, midFreq: 1500, midQ: 1, bass: -2, bassFreq: 120, bassQ: 0.7, treble: 2, trebleFreq: 3000, trebleQ: 0.7, presence: 3, level: 0 }]] },
        { id: 'no-eq', label: 'No EQ lift', note: 'Without the mid and top lift the sound is flatter and less cutting. It sits back in the band.',
          chain: [['comp:cali76', { threshold: -30, makeup: 4, ratio: 6, attack: 2, release: 90, blend: 1 }]] },
      ],
    },
  ];
  const toneById = id => TONES.find(tone => tone.id === id);

  // What a pedal does, in a guitarist's words, when a sound has no note for it.
  const ROLES = {
    gate: 'Mutes the hiss and hum when you stop playing.',
    comp: 'Evens out loud and soft picking, and helps notes ring longer.',
    drive: 'Adds grit, like an amp turned up until it breaks up.',
    fuzz: 'Clips the signal hard into a thick, buzzy sustain.',
    octave: 'Adds a note an octave below or above what you play.',
    harm: 'Adds harmony notes above or below what you play.',
    delay: 'Repeats what you play, like an echo.',
    boost: 'Clean extra volume. Before a drive it means more crunch; after it, just louder.',
    dist: 'Clips the wave flat for a heavy, even crunch.',
    eq: 'Turns bass, mids and treble up or down.',
    wah: 'A moving peak in the sound that says “wah”.',
    chorus: 'Adds a slightly wobbling copy, like two guitars playing together.',
    phaser: 'Sweeps moving notches through the sound for a swirling whoosh.',
    trem: 'Pulses the volume up and down.',
    swell: 'Fades each note in, hiding the pick attack.',
    reverb: 'Adds the sound of a room ringing on after each note.',
  };

  // Your own sounds, kept on this device. A board you built is never lost:
  // before a sound replaces it, it's kept as "My last board".
  const myTonesKey = 'tonelab-my-tones-v1';
  let myTones = [];
  try {
    myTones = (JSON.parse(localStorage.getItem(myTonesKey)) || []).filter(t => t && typeof t.id === 'string' && typeof t.name === 'string' && Array.isArray(t.spec));
  } catch { myTones = []; }
  function saveMyTones() { try { localStorage.setItem(myTonesKey, JSON.stringify(myTones)); } catch {} }
  const specOf = chain => chain.map(p => [p.type + ':' + p.model, { ...p.params }, null, p.enabled]);
  function rememberMyBoard(chain) {
    if (!chain.length) return;
    const entry = { id: 'my-last-board', name: 'My last board', spec: specOf(chain) };
    myTones = [entry, ...myTones.filter(t => t.id !== entry.id)];
    saveMyTones();
  }

  // A sound's pedal entry: "type" or "type:model", settings, note, on/off.
  const entryType = entry => entry[0].split(':')[0];
  function entryModel(entry) {
    const [type, model] = entry[0].split(':');
    return types[type].models.some(m => m.id === model) ? model : types[type].models[0].id;
  }
  // What a sound expects a pedal's controls to be: effect defaults, then the
  // model's characteristic settings, then the sound's own.
  const entryParams = entry => ({ ...P.modelDefaults(entryType(entry), entryModel(entry)), ...entry[1] });
  function buildChain(spec) {
    const seen = {};
    return validateChain(spec.filter(entry => types[entryType(entry)]).map(entry => {
      const type = entryType(entry);
      const number = (seen[type] = (seen[type] || 0) + 1);
      counts[type] = Math.max(counts[type], number);
      return { id: 'pedal-' + (++nextId), type, model: entryModel(entry), number, enabled: entry[3] !== false, params: entryParams(entry) };
    }));
  }

  // What each slot holds: a built-in sound, one of its what-ifs, one of your
  // sounds, or a board you built yourself ("custom"). Edits mark it edited.
  const validSlot = s => s && ((s.kind === 'tone' && toneById(s.tone)) || (s.kind === 'whatif' && toneById(s.tone)?.whatIfs.some(w => w.id === s.whatIf)) ||
    (s.kind === 'mine' && myTones.some(t => t.id === s.mine)) || s.kind === 'custom');
  let slots = { A: { kind: 'custom' }, B: { kind: 'custom' } };
  for (const bank of ['A', 'B']) if (validSlot(restoredSlots?.[bank])) slots[bank] = { kind: restoredSlots[bank].kind, tone: restoredSlots[bank].tone, whatIf: restoredSlots[bank].whatIf, mine: restoredSlots[bank].mine, edited: !!restoredSlots[bank].edited };
  const otherBank = bank => (bank === 'A' ? 'B' : 'A');
  const toneOf = s => (s.kind === 'tone' || s.kind === 'whatif' ? toneById(s.tone) : null);
  const whatIfOf = s => (s.kind === 'whatif' ? toneById(s.tone).whatIfs.find(w => w.id === s.whatIf) : null);
  function slotLabel(s) {
    let text = 'My board';
    if (s.kind === 'tone') text = toneById(s.tone).title;
    else if (s.kind === 'whatif') text = 'What if: ' + whatIfOf(s).label;
    else if (s.kind === 'mine') text = myTones.find(t => t.id === s.mine)?.name || 'My sound';
    return text + (s.edited && s.kind !== 'custom' ? ' (edited)' : '');
  }
  // The sound being explained: the one in A, or else the one in B.
  const lessonTone = () => toneOf(slots.A) || toneOf(slots.B);
  function markEdited() {
    if (slots[activeBank].kind !== 'custom') slots[activeBank].edited = true;
    refreshSlots();
  }

  // Replace both boards, their slot info and the guitar settings (used by undo).
  function boardState() {
    banks[activeBank] = clone(state.chain);
    return { A: clone(banks.A), B: clone(banks.B), slots: clone(slots), active: activeBank, noiseDb: source.noiseDb, kind: source.kind, tempo: source.tempo };
  }
  function applyBoard(saved) {
    banks = { A: clone(saved.A), B: clone(saved.B) };
    slots = clone(saved.slots);
    activeBank = saved.active;
    state.chain = clone(banks[activeBank]);
    rebuildOrder = true;
    selectedId = null;
    inspectId = inspectByBank.A = inspectByBank.B = '';
    selectScopeHistory();
    applySource({ noise: saved.noiseDb, kind: saved.kind, tempo: saved.tempo });
    changed();
    syncBanks();
    refreshSlots();
  }
  function applySource({ noise: noiseDb, kind, tempo }) {
    if (typeof noiseDb === 'number') {
      source.noiseDb = noiseDb;
      noise.value = noiseDb;
      noiseOut.textContent = fmtDb(noiseDb);
    }
    if (tempo) source.tempo = tempo;
    if (kind && source.kind !== kind && source.kind !== 'recording') source.setKind(kind);
    syncPattern();
  }

  // Put a sound into a slot. `value` comes from a picker: tone:<id>,
  // whatif:<tone>:<id>, mine:<id> or same (copy the other slot).
  function fillSlot(bank, value) {
    banks[activeBank] = clone(state.chain);
    const [kind, a, b] = value.split(':');
    let chain, info, sound;
    if (kind === 'tone') { const tone = toneById(a); chain = buildChain(tone.chain); info = { kind, tone: a }; sound = tone.source; }
    else if (kind === 'whatif') { const tone = toneById(a); chain = buildChain(tone.whatIfs.find(w => w.id === b).chain); info = { kind, tone: a, whatIf: b }; sound = tone.source; }
    else if (kind === 'mine') { chain = buildChain(myTones.find(t => t.id === a).spec); info = { kind, mine: a }; }
    else if (kind === 'same') { const from = otherBank(bank); chain = buildChain(specOf(banks[from])); info = { ...slots[from] }; }
    else return;
    const old = slots[bank];
    if ((old.kind === 'custom' || old.edited) && kind !== 'mine') rememberMyBoard(banks[bank]);
    banks[bank] = chain;
    slots[bank] = info;
    inspectByBank[bank] = '';
    if (bank === activeBank) {
      state.chain = clone(chain);
      rebuildOrder = true;
      selectedId = null;
      inspectId = '';
    }
    if (sound) applySource(sound);
  }
  function pickSound(bank, value, label) {
    const before = boardState();
    fillSlot(bank, value);
    changed();
    refreshSlots();
    announce(label + ' loaded into ' + bank);
    offerUndo(label + ' loaded into ' + bank, () => applyBoard(before));
  }

  /* Pickers: "I want to sound like" and one per slot. */
  const heroSelect = document.getElementById('tone-pick');
  let syncCombo = () => {};
  const slotSelects = { A: document.getElementById('slot-A'), B: document.getElementById('slot-B') };
  function group(label, entries) {
    const g = document.createElement('optgroup');
    g.label = label;
    for (const [text, value] of entries) g.appendChild(new Option(text, value));
    return g;
  }
  function refreshSlots() {
    heroSelect.replaceChildren(new Option('Choose a sound…', ''));
    for (const name of ['Songs', 'Techniques']) heroSelect.appendChild(group(name, TONES.filter(t => t.group === name).map(t => [t.title, 'tone:' + t.id])));
    if (myTones.length) heroSelect.appendChild(group('My sounds', myTones.map(t => [t.name, 'mine:' + t.id])));
    const shown = toneOf(slots.A);
    heroSelect.value = shown ? 'tone:' + shown.id : slots.A.kind === 'mine' ? 'mine:' + slots.A.mine : '';
    syncCombo();
    const lesson = lessonTone();
    document.getElementById('tone-summary').textContent = lesson ? lesson.summary : 'Pick a famous sound to see how it’s built, pedal by pedal. Or build your own on the board below.';

    for (const bank of ['A', 'B']) {
      const select = slotSelects[bank];
      const other = otherBank(bank);
      select.replaceChildren(new Option(slotLabel(slots[bank]), 'current'));
      const base = toneOf(slots[other]) || toneOf(slots[bank]);
      if (base) select.appendChild(group('What if… (' + base.short + ')', base.whatIfs.map(w => [w.label, 'whatif:' + base.id + ':' + w.id]).concat([['The original ' + base.short + ' sound', 'tone:' + base.id]])));
      select.appendChild(group('Copy', [['Same as ' + other, 'same']]));
      for (const name of ['Songs', 'Techniques']) select.appendChild(group(name, TONES.filter(t => t.group === name).map(t => [t.title, 'tone:' + t.id])));
      if (myTones.length) select.appendChild(group('My sounds', myTones.map(t => [t.name, 'mine:' + t.id])));
      select.value = 'current';
      select.setAttribute('aria-label', 'Sound in ' + bank);
    }
    document.getElementById('board-slot').textContent = 'Editing ' + activeBank + ': ' + slotLabel(slots[activeBank]);
    renderJourney();
  }
  document.getElementById('new-board').onclick = () => {
    if (!window.confirm('Start from scratch? Your current A and B setups will be lost. Saved sounds will be kept.')) return;
    const before = boardState();
    applyBoard({ ...before, A: [], B: [], slots: { A: { kind: 'custom' }, B: { kind: 'custom' } }, active: 'A' });
    closeSettings();
    resetScopeHistory();
    scopeHistory.B.input.fill(0);
    scopeHistory.B.output.fill(0);
    offerUndo('New pedalboard started', () => applyBoard(before));
  };
  heroSelect.onchange = () => {
    const value = heroSelect.value;
    if (!value) return;
    const hasBoardWork = ['A', 'B'].some(bank => slots[bank].kind === 'custom' || slots[bank].edited);
    if (hasBoardWork && !window.confirm('Loading this sound replaces both A and B, including your current pedal settings. You can undo the change afterward. Continue?')) {
      refreshSlots();
      return;
    }
    const before = boardState();
    fillSlot('A', value);
    const tone = value.startsWith('tone:') && toneById(value.slice(5));
    if (tone?.whatIfs.length) fillSlot('B', 'whatif:' + tone.id + ':' + tone.whatIfs[0].id);
    if (activeBank !== 'A') switchBank('A');
    if (tone?.view) setView(tone.view);
    changed();
    refreshSlots();
    if (state.chain.length) openSettings(state.chain[0]);
    else closeSettings();
    const label = tone ? tone.title : heroSelect.selectedOptions[0].textContent;
    announce(label + ' loaded');
    offerUndo(label + ' loaded', () => applyBoard(before));
    advanceQuickStart(0);
  };
  /* Searchable "I want to sound like…": a text box over the sound list. The
   * hidden <select> stays the source of truth, so choosing an item fires the
   * same change as before. */
  {
    const search = document.getElementById('tone-search');
    const list = document.getElementById('tone-list');
    const fold = text => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    let items = [], shown = [], active = -1, open = false;
    const options = () => [...list.querySelectorAll('[role="option"]')];
    function readItems() {
      items = [];
      for (const child of heroSelect.children) {
        if (child.tagName === 'OPTGROUP') for (const o of child.children) items.push({ value: o.value, label: o.textContent, group: child.label });
        else if (child.value) items.push({ value: child.value, label: child.textContent, group: '' });
      }
    }
    function setActive(i, scroll) {
      active = i;
      const opts = options();
      opts.forEach((o, k) => { o.setAttribute('aria-selected', String(k === i)); o.classList.toggle('active', k === i); });
      if (i >= 0 && opts[i]) {
        search.setAttribute('aria-activedescendant', opts[i].id);
        if (scroll) opts[i].scrollIntoView({ block: 'nearest' });
      } else search.removeAttribute('aria-activedescendant');
    }
    function render(query) {
      const q = fold(query.trim());
      shown = items.filter(item => !q || fold(item.label).includes(q) || fold(item.group).includes(q));
      list.replaceChildren();
      let group = null;
      shown.forEach((item, i) => {
        if (item.group && item.group !== group) {
          group = item.group;
          const heading = document.createElement('li');
          heading.className = 'combo-group';
          heading.setAttribute('role', 'presentation');
          heading.textContent = group;
          list.appendChild(heading);
        }
        const li = document.createElement('li');
        li.id = 'tone-opt-' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.dataset.value = item.value;
        li.textContent = item.label;
        li.onmousedown = e => { e.preventDefault(); choose(item.value); };
        list.appendChild(li);
      });
      if (!shown.length) {
        const empty = document.createElement('li');
        empty.className = 'combo-empty';
        empty.setAttribute('role', 'presentation');
        empty.textContent = 'No sound matches “' + query.trim() + '”. Try another word.';
        list.appendChild(empty);
      }
      setActive(shown.length ? 0 : -1, false);
    }
    function show() { if (!open) { open = true; list.hidden = false; search.setAttribute('aria-expanded', 'true'); } }
    function hide() {
      open = false;
      list.hidden = true;
      search.setAttribute('aria-expanded', 'false');
      search.removeAttribute('aria-activedescendant');
    }
    // Show the chosen sound's name in the box, unless the user is typing.
    function restore() {
      const current = heroSelect.selectedOptions[0];
      search.value = current && current.value ? current.textContent : '';
    }
    function choose(value) {
      const item = items.find(i => i.value === value);
      if (!item) return;
      hide();
      heroSelect.value = value;
      search.value = item.label;
      heroSelect.dispatchEvent(new Event('change'));
      search.blur();
    }
    syncCombo = () => { readItems(); if (document.activeElement !== search) restore(); };
    search.addEventListener('focus', () => { search.select(); render(''); show(); });
    search.addEventListener('click', () => { if (!open) { search.select(); render(''); show(); } });
    search.addEventListener('input', () => { render(search.value); show(); });
    search.addEventListener('blur', () => { hide(); restore(); });
    search.addEventListener('keydown', e => {
      const n = shown.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) { render(search.value); show(); }
        if (n) setActive((Math.max(active, 0) + (e.key === 'ArrowDown' ? 1 : -1) + n) % n, true);
      } else if (e.key === 'Home' && open && n) { e.preventDefault(); setActive(0, true); }
      else if (e.key === 'End' && open && n) { e.preventDefault(); setActive(n - 1, true); }
      else if (e.key === 'Enter') {
        if (open && active >= 0 && shown[active]) { e.preventDefault(); choose(shown[active].value); }
      } else if (e.key === 'Escape') {
        if (open) { e.preventDefault(); hide(); restore(); }
      }
    });
    readItems();
    restore();
  }
  for (const bank of ['A', 'B']) slotSelects[bank].onchange = () => {
    const select = slotSelects[bank];
    if (select.value === 'current') return;
    pickSound(bank, select.value, select.selectedOptions[0].textContent);
  };
  document.getElementById('save-tone').onclick = () => {
    const suggestion = slots[activeBank].kind === 'custom' ? 'My sound ' + (myTones.filter(t => t.id !== 'my-last-board').length + 1) : slotLabel(slots[activeBank]).replace(' (edited)', '') + ' (mine)';
    const name = window.prompt('Name this sound', suggestion);
    if (!name || !name.trim()) return;
    const entry = { id: 'mine-' + Date.now().toString(36), name: name.trim().slice(0, 60), spec: specOf(state.chain) };
    myTones = [entry, ...myTones];
    saveMyTones();
    slots[activeBank] = { kind: 'mine', mine: entry.id };
    saveBoard();
    refreshSlots();
    announce('Saved as “' + entry.name + '” in My sounds');
  };

  /* Step by step: your guitar, then each pedal with what it does and the
   * signal after it (drawn live from the same chain you hear). */
  const journeyList = document.getElementById('journey-steps');
  const pedalKey = (chain, pedal) => pedal.type + '#' + chain.filter(p => p.type === pedal.type).indexOf(pedal);
  // What a pedal is doing here: the sound's own note when the pedal is set
  // as in the original sound, the what-if's note when that's the change.
  function noteFor(pedal, chain) {
    if (!pedal.enabled) return 'Switched off: your signal passes straight through.';
    const s = slots[activeBank];
    const tone = toneOf(s);
    if (!tone) return ROLES[pedal.type];
    const key = pedalKey(chain, pedal);
    const seen = {};
    const toneKeys = tone.chain.map(entry => { const type = entryType(entry); return type + '#' + ((seen[type] = (seen[type] ?? -1) + 1)); });
    const i = toneKeys.indexOf(key);
    if (i < 0) return ROLES[pedal.type];
    const type = entryType(tone.chain[i]), params = entryParams(tone.chain[i]), note = tone.chain[i][2];
    // Same settings and same place (relative to the pedals both share)?
    const chainKeys = chain.map(p => pedalKey(chain, p));
    const shared = k => k.filter(x => chainKeys.includes(x) && toneKeys.includes(x));
    const samePlace = shared(chainKeys).indexOf(key) === shared(toneKeys).indexOf(key);
    const sameSettings = entryModel(tone.chain[i]) === pedal.model && types[type].specs.every(spec => Math.abs(params[spec.key] - pedal.params[spec.key]) < 1e-6);
    if (samePlace && sameSettings) return note;
    // The pedal this what-if is about explains the change; others get their basic role.
    const whatIf = whatIfOf(s);
    const firstChanged = chain.find(p => p.enabled && p !== pedal && chainKeys.indexOf(pedalKey(chain, p)) < chainKeys.indexOf(key) && noteDiffers(p, chain, tone, toneKeys, chainKeys));
    if (whatIf && !s.edited && !firstChanged) return whatIf.note;
    return ROLES[pedal.type] + (sameSettings ? '' : ' (Set differently from the original sound.)');
  }
  function noteDiffers(pedal, chain, tone, toneKeys, chainKeys) {
    const key = pedalKey(chain, pedal);
    const i = toneKeys.indexOf(key);
    if (i < 0) return true;
    const shared = k => k.filter(x => chainKeys.includes(x) && toneKeys.includes(x));
    const params = entryParams(tone.chain[i]);
    return shared(chainKeys).indexOf(key) !== shared(toneKeys).indexOf(key) || entryModel(tone.chain[i]) !== pedal.model ||
      !types[pedal.type].specs.every(spec => Math.abs(params[spec.key] - pedal.params[spec.key]) < 1e-6);
  }
  // How a pedal differs in the other slot: missing, other settings, other order.
  function differences(chain, otherChain, other) {
    const otherByKey = new Map(otherChain.map(p => [pedalKey(otherChain, p), p]));
    const thisKeys = chain.map(p => pedalKey(chain, p));
    const shared = thisKeys.filter(k => otherByKey.has(k));
    const otherShared = otherChain.map(p => pedalKey(otherChain, p)).filter(k => shared.includes(k));
    const result = new Map();
    chain.forEach((pedal, i) => {
      const key = thisKeys[i];
      const twin = otherByKey.get(key);
      if (!twin) { result.set(pedal.id, 'Not in ' + other); return; }
      const parts = [];
      if (twin.enabled !== pedal.enabled) parts.push(twin.enabled ? 'on' : 'switched off');
      if (twin.model !== pedal.model) parts.push('a ' + modelOf(twin).name);
      for (const c of controlsFor(twin, true)) {
        if (Math.abs(twin.params[c.key] - pedal.params[c.key]) > 1e-6) parts.push(c.label.toLowerCase() + ' ' + controlValue(twin, c));
      }
      if (shared.indexOf(key) !== otherShared.indexOf(key)) parts.push('in a different order');
      if (parts.length) result.set(pedal.id, 'In ' + other + ': ' + parts.join(', '));
    });
    const missing = otherChain.filter(p => !thisKeys.includes(pedalKey(otherChain, p)));
    return { byPedal: result, missing };
  }
  function renderJourney() {
    const chain = state.chain;
    const other = otherBank(activeBank);
    const s = slots[activeBank];
    const tone = toneOf(s);
    const { byPedal, missing } = differences(chain, banks[other], other);
    document.getElementById('journey-slot').textContent = activeBank + ' · ' + slotLabel(s);
    const demoPattern = TL.PATTERNS[source.kind];
    const playsNote = demoPattern?.tempo
      ? ' The demo plays “' + demoPattern.label + '” at ' + Math.round(source.tempo) + ' BPM, a generic pattern in the spirit of the style, not the actual part. Change it with Playing and Speed.'
      : '';
    document.getElementById('journey-play').textContent = ((tone || lessonTone())?.play || 'Your guitar, before any pedals.') + playsNote;
    const items = [];
    // Each step has a Hear button: it plays, and shows on the scope, the
    // signal right after that pedal.
    chain.forEach((pedal, i) => {
      const info = { name: kindName(pedal) };
      const chips = '<span class="chip-model">' + modelOf(pedal).name + '</span>' + controlsFor(pedal).slice(0, 3).map(c => `<span>${c.label} ${controlValue(pedal, c)}</span>`).join('');
      const diff = byPedal.get(pedal.id);
      items.push(`<li class="journey-step${pedal.enabled ? '' : ' off'}${diff ? ' differs' : ''}" data-type="${pedal.type}">` +
        artSvg(pedal, 'journey-art') +
        `<div><button class="journey-name" data-edit="${pedal.id}">${i + 1} · ${info.name}</button><div class="journey-chips">${chips}</div>` +
        `<p class="journey-note"></p>${diff ? `<p class="journey-diff">${diff}</p>` : ''}` +
        `<button type="button" class="journey-listen" data-pedal="${pedal.id}" data-monitor="wet" aria-label="Hear after the ${info.name.toLowerCase()}">▶ Hear after this</button></div></li>`);
    });
    journeyList.innerHTML = items.join('');
    // Notes are plain text: set them as text, not markup.
    journeyList.querySelectorAll('.journey-step').forEach((li, i) => { li.querySelector('.journey-note').textContent = noteFor(chain[i], chain); });
    journeyList.querySelectorAll('[data-edit]').forEach(button => {
      button.onclick = () => openSettings(state.chain.find(p => p.id === button.dataset.edit));
    });
    if (!chain.length) journeyList.insertAdjacentHTML('beforeend', '<li class="journey-empty">No pedals yet: you hear your guitar just as it is. Pick a sound above or add pedals below.</li>');
    renderStrip();
    if (!settings.hidden) {
      const open = selected();
      if (open) showPedalNotes(open); else closeSettings();
    }

    // What B changes: the what-if's explanation, or a plain list of differences.
    const box = document.getElementById('whatif-box');
    const whatIfBank = ['B', 'A'].find(b => slots[b].kind === 'whatif' && toneOf(slots[otherBank(b)])?.id === slots[b].tone);
    const title = document.getElementById('whatif-title');
    const text = document.getElementById('whatif-text');
    if (whatIfBank) {
      title.textContent = 'What ' + whatIfBank + ' changes: ' + whatIfOf(slots[whatIfBank]).label.toLowerCase();
      text.textContent = whatIfOf(slots[whatIfBank]).note;
    } else if (byPedal.size || missing.length) {
      title.textContent = 'How ' + other + ' is different';
      text.textContent = [...[...byPedal.entries()].map(([id, d]) => pedalName(chain.find(p => p.id === id)) + ': ' + d.replace(/^In [AB]: /, '')),
        ...missing.map(p => 'Only ' + other + ' has ' + types[p.type].name.toLowerCase())].join(' · ');
    } else {
      title.textContent = 'A and B are the same';
      text.textContent = 'Pick a “What if…” for B to hear what one change does.';
    }
    const dockWhatIf = document.getElementById('dock-whatif');
    dockWhatIf.textContent = whatIfBank ? whatIfBank + ': ' + whatIfOf(slots[whatIfBank]).label : (byPedal.size || missing.length ? 'A and B differ' : 'A and B are the same');
    dockWhatIf.title = text.textContent;
    document.getElementById('journey-tip').textContent = (tone || lessonTone())?.tip || '';
    document.getElementById('journey-tip').hidden = !(tone || lessonTone())?.tip;
    if (selected() && !settings.hidden) updateGuide(selected());
    box.querySelectorAll('[data-hear]').forEach(button => button.classList.toggle('on', button.dataset.hear === activeBank));
  }
  document.querySelectorAll('#whatif-box [data-hear]').forEach(button => button.onclick = () => {
    const bank = button.dataset.hear;
    if (bank !== activeBank) switchBank(bank);
    listenTo('', 'wet', bank);
  });
  // Play the signal at one point in the chain: "after a pedal" means that
  // pedal's output (wet), "your guitar" means the dry input, and an empty
  // pedal id means the whole chain. The audio starts if it isn't already.
  async function listenTo(pedal, monitorChoice, bank = activeBank) {
    if (listening && activeBank === bank && inspectId === pedal && monitor === monitorChoice) {
      audition = null;
      listen.click();
      updateAuditionButtons();
      return;
    }
    audition = { bank, pedal, monitor: monitorChoice };
    inspectId = pedal;
    inspectByBank[activeBank] = pedal;
    monitor = monitorChoice;
    document.querySelectorAll('#monitor button').forEach(b => {
      const on = b.dataset.value === monitorChoice;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    resetScopeHistory();
    refreshInspect();
    if (bank !== activeBank) switchBank(bank);
    if (listening) sendAudioState();
    else listen.click();
    updateAuditionButtons();
  }
  function updateAuditionButtons() {
    const active = listening && audition;
    const inspect = document.getElementById('inspect-pedal');
    const playingPedal = listening && inspectId === selectedId && monitor === 'wet';
    for (const button of [inspect, document.getElementById('guide-listen')]) {
      const label = playingPedal ? 'Stop listening' : button === inspect ? 'Hear this pedal' : 'Hear after this pedal';
      button.innerHTML = '<svg class="action-icon" aria-hidden="true"><use href="#icon-' + (playingPedal ? 'stop' : 'play') + '"/></svg>';
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(playingPedal));
      button.title = label;
    }
    journeyList.querySelectorAll('.journey-listen').forEach(button => {
      const playing = active?.pedal === button.dataset.pedal && active?.monitor === button.dataset.monitor;
      button.textContent = playing ? '■ Stop' : '▶ Hear after this';
      button.setAttribute('aria-pressed', String(!!playing));
    });
    document.querySelectorAll('#whatif-box [data-hear]').forEach(button => {
      const playing = active?.bank === button.dataset.hear && active.pedal === '' && active.monitor === 'wet';
      button.textContent = (playing ? '■ Stop ' : '▶ Hear ') + button.dataset.hear;
      button.setAttribute('aria-pressed', String(!!playing));
    });
  }
  function updateGuide(pedal) {
    const index = state.chain.findIndex(p => p.id === pedal.id);
    if (index < 0) return;
    document.getElementById('guide-position').textContent = (index + 1) + ' of ' + state.chain.length + ' · ' + pedalName(pedal);
    document.getElementById('guide-note').textContent = noteFor(pedal, state.chain);
    document.getElementById('guide-values').textContent = modelOf(pedal).name + ' · ' + controlsFor(pedal).map(c => c.label + ' ' + controlValue(pedal, c)).join(' · ');
    document.getElementById('guide-diff').textContent = differences(state.chain, banks[otherBank(activeBank)], otherBank(activeBank)).byPedal.get(pedal.id) || '';
    document.getElementById('guide-intro').textContent = document.getElementById('journey-play').textContent;
    document.getElementById('guide-tip').textContent = document.getElementById('journey-tip').textContent;
    document.getElementById('guide-prev').disabled = index === 0;
    document.getElementById('guide-next').disabled = index === state.chain.length - 1;
  }
  function showGuide(show) {
    document.getElementById('inspector-guide').hidden = !show;
    document.getElementById('inspector-controls').hidden = show;
    document.getElementById('tab-guide').setAttribute('aria-pressed', String(show));
    document.getElementById('tab-controls').setAttribute('aria-pressed', String(!show));
    if (selected()) updateGuide(selected());
  }
  document.getElementById('tab-guide').onclick = () => showGuide(true);
  document.getElementById('tab-controls').onclick = () => showGuide(false);
  document.getElementById('start-guide').onclick = () => {
    if (!state.chain.length) { announce('Add an effect to start the guide.'); return; }
    openSettings(state.chain[0]);
    showGuide(true);
  };
  document.getElementById('guide-prev').onclick = () => {
    const index = state.chain.findIndex(p => p.id === selectedId);
    if (index > 0) { openSettings(state.chain[index - 1]); showGuide(true); }
  };
  document.getElementById('guide-next').onclick = () => {
    const index = state.chain.findIndex(p => p.id === selectedId);
    if (index >= 0 && index < state.chain.length - 1) { openSettings(state.chain[index + 1]); showGuide(true); }
  };
  document.getElementById('guide-listen').onclick = () => { if (selected()) listenTo(selectedId, 'wet'); };
  document.getElementById('print-guide').onclick = () => {
    const printGuide = document.querySelector('.full-guide');
    printGuide.hidden = false;
    printGuide.open = true;
    document.body.classList.add('printing-guide');
    window.print();
  };
  window.addEventListener('afterprint', () => { document.body.classList.remove('printing-guide'); document.querySelector('.full-guide').hidden = true; });
  journeyList.addEventListener('click', e => {
    const button = e.target.closest('.journey-listen');
    if (button) listenTo(button.dataset.pedal, button.dataset.monitor);
  });
  const quickStartSteps = [
    { target: '#tone-combo', title: 'Pick a sound to explore', copy: 'Choose a familiar tone above. ToneLab builds the pedals for you, so you can start listening right away.' },
    { target: '#listen', title: 'Press Play and listen', copy: 'Turn up system volume and switch off mute. On iPhone, Silent mode must be off (side switch or Action button), or playback may be silent.' },
    { target: '#pattern', title: 'Try a different playing pattern', copy: 'Choose single notes, strums, or picking. The same pedals can sound different with a new pattern.' },
    { target: '#monitor', title: 'Compare dry and effected', copy: 'Switch between the clean input and the full effect chain to hear what changed.' },
    { target: '#dock-bank', title: 'Switch between A and B', copy: 'A and B hold separate pedalboards. Tap each side to compare two versions of your sound.' },
    { target: '#effect-order li .pedal-toggle', title: 'Open a pedal', copy: 'Choose a pedal to see its controls and learn what each one changes.' },
    { target: '#pedal-params input, #pedal-params button', title: 'Change a control and listen', copy: 'Move a control to shape the sound. The tour will take you to the pedal guide next.' },
    { target: '#tab-guide', title: 'See how to make the effect', copy: 'Open Guide for this pedal’s settings, a listening explanation, and a practical tip.' }
  ];
  const quickStartTour = document.getElementById('quick-start-tour');
  let quickStartIndex = 0;
  function advanceQuickStart(expectedIndex) {
    if (quickStartTour.hidden || quickStartIndex !== expectedIndex) return;
    quickStartIndex += 1;
    if (quickStartIndex >= quickStartSteps.length) closeQuickStart();
    else renderQuickStart();
  }
  function renderQuickStart() {
    document.querySelectorAll('.quick-start-target').forEach(el => el.classList.remove('quick-start-target'));
    if (quickStartTour.hidden) return;
    document.body.classList.toggle('quick-start-controls-step', quickStartIndex >= 6);
    const step = quickStartSteps[quickStartIndex];
    if (quickStartIndex === 6 && selected() && !document.getElementById('inspector-guide').hidden) showGuide(false);
    document.getElementById('quick-start-count').textContent = (quickStartIndex + 1) + ' of ' + quickStartSteps.length;
    document.getElementById('quick-start-title').textContent = step.title;
    document.getElementById('quick-start-copy').textContent = step.copy;
    document.getElementById('quick-start-progress-fill').style.width = ((quickStartIndex + 1) / quickStartSteps.length * 100) + '%';
    document.getElementById('quick-start-back').disabled = quickStartIndex === 0;
    document.getElementById('quick-start-next').innerHTML = quickStartIndex === quickStartSteps.length - 1 ? 'Finish <span aria-hidden="true">✓</span>' : 'Next step <span aria-hidden="true">→</span>';
    const target = document.querySelector(step.target) || (quickStartIndex === 5 ? document.getElementById('strip-add') : null);
    if (target) target.classList.add('quick-start-target');
  }
  function closeQuickStart() {
    quickStartTour.hidden = true;
    document.body.classList.remove('quick-start-controls-step');
    document.querySelectorAll('.quick-start-target').forEach(el => el.classList.remove('quick-start-target'));
  }
  document.getElementById('open-quick-start').onclick = () => { quickStartIndex = 0; quickStartTour.hidden = false; renderQuickStart(); };
  document.getElementById('close-quick-start').onclick = closeQuickStart;
  document.getElementById('quick-start-back').onclick = () => { quickStartIndex = Math.max(0, quickStartIndex - 1); renderQuickStart(); };
  document.getElementById('quick-start-skip').onclick = () => { quickStartIndex += 1; if (quickStartIndex >= quickStartSteps.length) closeQuickStart(); else renderQuickStart(); };
  document.getElementById('quick-start-next').onclick = () => { quickStartIndex += 1; if (quickStartIndex >= quickStartSteps.length) closeQuickStart(); else renderQuickStart(); };
  document.getElementById('listen').addEventListener('click', () => advanceQuickStart(1));
  patternSelect.addEventListener('change', () => advanceQuickStart(2));
  document.getElementById('monitor').addEventListener('click', e => { if (e.target.closest('button')) advanceQuickStart(3); });
  document.getElementById('dock-bank').addEventListener('click', e => {
    const bank = e.target.closest('[data-bank]')?.dataset.bank;
    if (bank && bank !== activeBank) advanceQuickStart(4);
  }, true);
  document.addEventListener('input', e => { if (quickStartIndex === 6 && e.target.closest('#pedal-params input')) advanceQuickStart(6); });
  document.getElementById('pedal-params').addEventListener('click', e => { if (quickStartIndex === 6 && e.target.closest('button')) advanceQuickStart(6); });
  document.getElementById('tab-guide').addEventListener('click', () => advanceQuickStart(7));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !quickStartTour.hidden) closeQuickStart(); });
  onBoardChange = () => { renderJourney(); renderQuickStart(); };
  refreshSlots();

  /* Loudness or Tone: what the scope and the step-by-step show. */
  function setView(view) {
    state.view = view;
    try { localStorage.setItem('tonelab-view', view); } catch {}
    document.querySelectorAll('.view-toggle button').forEach(button => {
      button.classList.toggle('on', button.dataset.view === view);
      button.setAttribute('aria-pressed', String(button.dataset.view === view));
    });
    document.body.classList.toggle('tone-view', view === 'tone');
    document.getElementById('view-hint').textContent = view === 'tone'
      ? 'Tone: bass on the left, treble on the right. Grey is before the pedal, black after.'
      : 'Loudness over the last moments. Grey is before the pedal, black after.';
    spectrumMemory.clear();
    state.dirty = true;
  }
  document.querySelectorAll('.view-toggle').forEach(group => group.addEventListener('click', e => {
    const button = e.target.closest('[data-view]');
    if (button) setView(button.dataset.view);
  }));

  /* Tone view: how much bass, mids and treble there is (a spectrum),
   * from the last ~85 ms of each signal, smoothed so it reads steadily. */
  const FFT_N = 2048, SPEC_BINS = 140, F_LO = 60, F_HI = 10000, SPEC_LO = -90, SPEC_HI = -6;
  const fftRe = new Float64Array(FFT_N), fftIm = new Float64Array(FFT_N);
  const hann = Float64Array.from({ length: FFT_N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_N - 1)));
  const fftScale = 2 / hann.reduce((a, b) => a + b, 0);
  const bitRev = new Uint32Array(FFT_N);
  for (let i = 0, bits = Math.log2(FFT_N); i < FFT_N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); bitRev[i] = r; }
  const cosT = Float64Array.from({ length: FFT_N / 2 }, (_, k) => Math.cos(2 * Math.PI * k / FFT_N));
  const sinT = Float64Array.from({ length: FFT_N / 2 }, (_, k) => Math.sin(2 * Math.PI * k / FFT_N));
  const binEdges = Float64Array.from({ length: SPEC_BINS + 1 }, (_, b) => F_LO * Math.pow(F_HI / F_LO, b / SPEC_BINS) / SR * FFT_N);
  function fft() {
    for (let i = 0; i < FFT_N; i++) {
      const j = bitRev[i];
      if (j > i) { [fftRe[i], fftRe[j]] = [fftRe[j], fftRe[i]]; [fftIm[i], fftIm[j]] = [fftIm[j], fftIm[i]]; }
    }
    for (let size = 2; size <= FFT_N; size *= 2) {
      const half = size / 2, step = FFT_N / size;
      for (let i = 0; i < FFT_N; i += size) {
        for (let j = 0; j < half; j++) {
          const c = cosT[j * step], sn = sinT[j * step], a = i + j, b = a + half;
          const tr = fftRe[b] * c + fftIm[b] * sn, ti = fftIm[b] * c - fftRe[b] * sn;
          fftRe[b] = fftRe[a] - tr; fftIm[b] = fftIm[a] - ti;
          fftRe[a] += tr; fftIm[a] += ti;
        }
      }
    }
  }
  function spectrum(buf) {
    const start = N - FFT_N;
    for (let i = 0; i < FFT_N; i++) { fftRe[i] = buf[start + i] * hann[i]; fftIm[i] = 0; }
    fft();
    const out = new Float32Array(SPEC_BINS);
    for (let b = 0; b < SPEC_BINS; b++) {
      const lo = Math.floor(binEdges[b]), hi = Math.max(lo + 1, Math.ceil(binEdges[b + 1]));
      let m = 0;
      for (let k = lo; k < hi; k++) m = Math.max(m, Math.hypot(fftRe[k], fftIm[k]));
      out[b] = 20 * Math.log10(Math.max(m * fftScale, 1e-9));
    }
    return out;
  }
  const spectrumMemory = new Map();
  function smoothedSpectrum(key, buf) {
    const now = spectrum(buf), prev = spectrumMemory.get(key);
    if (!prev) { spectrumMemory.set(key, now); return now; }
    for (let b = 0; b < SPEC_BINS; b++) prev[b] = prev[b] * 0.65 + now[b] * 0.35;
    return prev;
  }
  const BANDS = [['Bass', 60, 250], ['Mids', 250, 2000], ['Treble', 2000, 10000]];
  function drawSpectrum(ctx, w, h, before, after, key, detailed) {
    const xf = f => Math.log(f / F_LO) / Math.log(F_HI / F_LO) * w;
    const top = detailed ? 20 : 13, bottom = detailed ? 18 : 2;
    const y = db => h - bottom - Math.max(0, Math.min(1, (db - SPEC_LO) / (SPEC_HI - SPEC_LO))) * (h - top - bottom);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (const [name, f0, f1] of BANDS) {
      if (f0 > F_LO) { ctx.beginPath(); ctx.moveTo(Math.round(xf(f0)) + 0.5, 0); ctx.lineTo(Math.round(xf(f0)) + 0.5, h); ctx.stroke(); }
      ctx.font = (detailed ? '500 11px ' : '500 9.5px ') + C.mono;
      ctx.fillStyle = C.ink3;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(name.toUpperCase(), (xf(f0) + xf(f1)) / 2, detailed ? 5 : 2);
    }
    if (detailed) for (const f of [100, 300, 1000, 3000, 10000]) label(ctx, f >= 1000 ? f / 1000 + 'k' : String(f), Math.min(w - 12, xf(f)), h - 4, C.ink3, 'center');
    const area = (spec, fill) => {
      ctx.beginPath();
      ctx.moveTo(0, h - bottom);
      for (let b = 0; b < SPEC_BINS; b++) ctx.lineTo((b + 0.5) / SPEC_BINS * w, y(spec[b]));
      ctx.lineTo(w, h - bottom);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    ctx.globalAlpha = 0.85;
    const dry = monitor === 'dry';
    area(smoothedSpectrum(key + (dry ? ':in' : ':out'), dry ? before : after), C.ink);
    ctx.globalAlpha = 1;
  }
  setView(state.view);

  function reserveBoardHeight() {
    const card = orderList.firstElementChild;
    const cardWidth = card ? card.getBoundingClientRect().width : 62;
    const cardHeight = card ? card.getBoundingClientRect().height : 101;
    const gap = parseFloat(getComputedStyle(orderList).gap) || 6;
    const columns = Math.max(1, Math.floor((orderList.clientWidth + gap) / (cardWidth + gap)));
    const other = activeBank === 'A' ? 'B' : 'A';
    const rows = getComputedStyle(orderList).flexWrap === 'nowrap' ? 1 : Math.ceil(Math.max(state.chain.length, banks[other].length) / columns);
    dropArea.style.minHeight = Math.max(126, rows * (cardHeight + gap) - gap + 28) + 'px';
  }
  window.addEventListener('resize', reserveBoardHeight);
  function renderOrder() {
    const previousList = rebuildOrder ? orderList : null;
    if (previousList) orderList = previousList.cloneNode(false);
    rebuildOrder = false;
    for (const item of orderList.querySelectorAll('[data-effect]')) if (!state.chain.some(p => p.id === item.dataset.effect)) item.remove();
    state.chain.forEach((pedal, index) => {
      const id = pedal.id;
      let item = orderList.querySelector('[data-effect="' + id + '"]');
      if (!item) {
        item = document.createElement('li');
        item.dataset.effect = id;
        item.dataset.type = pedal.type;
        item.innerHTML = artSvg(pedal, 'pedal-art') + '<div class="pedal-top"><span class="pedal-position"></span><button class="pedal-edit" aria-label="Edit ' + pedalName(pedal) + '">Edit</button></div><button class="pedal-toggle"><span class="pedal-label"><span class="pedal-name"></span><span class="pedal-status"></span></span></button><button class="drag-handle" aria-label="Drag ' + pedalName(pedal) + ', or use arrow keys to reorder">⠿</button>';
        item.querySelector('.pedal-toggle').onclick = () => { openSettings(pedal); showGuide(false); advanceQuickStart(5); };
        item.querySelector('.pedal-edit').onclick = () => {
          pedal.enabled = !pedal.enabled;
          edited();
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
        // Dragging: a copy of the pedal follows the pointer. Outside the
        // dashed board it turns red with an ✕, and letting go removes it.
        let drag = null;
        const outsideBoard = e => {
          const r = dropArea.getBoundingClientRect();
          return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        };
        handle.onpointerdown = e => {
          if (e.button !== 0) return;
          e.preventDefault();
          handle.focus({ preventScroll: true });
          window.getSelection()?.removeAllRanges();
          document.body.classList.add('pedal-drag-active');
          handle.setPointerCapture(e.pointerId);
          const r = item.getBoundingClientRect();
          drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, width: r.width, ghost: null };
        };
        const clearDrag = () => {
          drag?.ghost?.remove();
          drag = null;
          document.body.classList.remove('pedal-drag-active');
          item.classList.remove('dragging');
          dropArea.classList.remove('drag-over', 'drag-out');
          orderList.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        };
        handle.onpointermove = e => {
          if (!drag || !handle.hasPointerCapture(e.pointerId)) return;
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          if (!drag.ghost) {
            if (Math.hypot(dx, dy) < 4) return; // a tap or tiny wobble isn't a drag
            const ghost = item.cloneNode(true);
            ghost.classList.add('drag-ghost');
            ghost.removeAttribute('data-effect');
            ghost.setAttribute('aria-hidden', 'true');
            ghost.insertAdjacentHTML('beforeend', '<span class="remove-mark">✕</span>');
            Object.assign(ghost.style, { left: drag.left + 'px', top: drag.top + 'px', width: drag.width + 'px' });
            document.body.appendChild(ghost);
            drag.ghost = ghost;
            item.classList.add('dragging');
          }
          drag.ghost.style.transform = `translate(${dx}px, ${dy}px)`;
          const out = outsideBoard(e);
          drag.ghost.classList.toggle('removing', out);
          dropArea.classList.toggle('drag-over', !out);
          dropArea.classList.toggle('drag-out', out);
          const target = out ? null : document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-effect]');
          orderList.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
          if (target && target !== item && orderList.contains(target)) target.classList.add('drop-target');
          // Allow long boards to scroll while holding a pedal near a screen edge.
          if (e.clientY > innerHeight - 65) window.scrollBy(0, 12);
          else if (e.clientY < 65) window.scrollBy(0, -12);
        };
        handle.onpointerup = e => {
          if (!drag || !handle.hasPointerCapture(e.pointerId)) return;
          const moved = !!drag.ghost;
          const out = outsideBoard(e);
          const target = out ? null : document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-effect]');
          clearDrag();
          if (!moved) return;
          if (out) removePedal(id);
          else if (target && target !== item && orderList.contains(target)) {
            moveEffect(id, state.chain.findIndex(p => p.id === target.dataset.effect));
          }
          else if (!target) moveEffect(id, state.chain.length - 1);
        };
        handle.onpointercancel = clearDrag;
        handle.onlostpointercapture = clearDrag;
      }
      item.classList.toggle('off', !pedal.enabled);
      item.classList.toggle('selected-pedal', pedal.id === selectedId);
      item.querySelector('.pedal-art').innerHTML = pedalArt(pedal);
      item.querySelector('.pedal-position').textContent = index + 1;
      item.querySelector('.pedal-name').textContent = shortName(pedal) + ' ' + pedal.number;
      item.dataset.shape = modelOf(pedal).shape;
      const toggle = item.querySelector('.pedal-toggle');
      toggle.setAttribute('aria-label', 'Edit ' + pedalName(pedal));
      toggle.setAttribute('aria-pressed', String(pedal.id === selectedId));
      const bypass = item.querySelector('.pedal-edit');
      bypass.textContent = pedal.enabled ? 'On' : 'Off';
      bypass.setAttribute('aria-label', (pedal.enabled ? 'Bypass ' : 'Enable ') + pedalName(pedal));
      bypass.setAttribute('aria-pressed', String(pedal.enabled));
      item.querySelector('.pedal-status').textContent = pedal.enabled ? 'On' : 'Off';
      // Keep DOM nodes in place during playback and editing to preserve focus.
      if (orderList.querySelectorAll('[data-effect]')[index] !== item) {
        const nextEffect = orderList.querySelectorAll('[data-effect]')[index];
        if (nextEffect && nextEffect !== item) orderList.insertBefore(item, nextEffect);
        else orderList.appendChild(item);
      }
    });
    let addTile = orderList.querySelector('.board-add-slot');
    if (!addTile) {
      const kinds = Object.keys(types);
      const type = kinds[Math.floor(Math.random() * kinds.length)];
      const info = types[type];
      const preview = { type, model: info.models[0].id, params: P.modelDefaults(type, info.models[0].id) };
      addTile = document.createElement('li');
      addTile.className = 'board-add-slot';
      addTile.innerHTML = artSvg(preview, 'pedal-art') + '<button type="button" class="board-add-tile"><span class="add-tile-plus">+</span><span class="add-tile-label"></span></button>';
      addTile.querySelector('.add-tile-label').textContent = state.chain.length ? 'Add next pedal' : 'Add a pedal here';
      addTile.querySelector('button').onclick = () => library.showModal();
    }
    addTile.querySelector('.add-tile-label').textContent = state.chain.length ? 'Add next pedal' : 'Add a pedal here';
    orderList.appendChild(addTile);
    if (previousList) previousList.replaceWith(orderList);
    document.getElementById('empty-chain').hidden = true;
    if (!settings.hidden && !selectedId) document.getElementById('inspector-empty').hidden = state.chain.length > 0;
    reserveBoardHeight();
    drawCables();
    refreshInspect();
  }

  /* Cable: Input → each pedal in processing order → Output. Runs straight
   * between neighbours and snakes through the gap when the board wraps. */
  const signalPath = document.querySelector('.signal-path');
  const cables = document.getElementById('cables');
  const listeningPoints = document.querySelector('.listening-points');
  document.querySelector('.endpoint-input').onclick = () => listenTo('', 'dry');
  document.querySelector('.endpoint-output').onclick = () => listenTo('', 'wet');
  listeningPoints.onclick = e => {
    const button = e.target.closest('[data-listen-index]');
    if (!button) return;
    const point = dotPoint(Number(button.dataset.listenIndex));
    listenTo(point.pedal, point.monitor);
  };
  function positionListeningPoints(items, box) {
    const count = Math.max(0, items.length - 1);
    for (const button of listeningPoints.querySelectorAll('button')) if (Number(button.dataset.listenIndex) > count) button.remove();
    for (let i = 1; i <= count; i++) {
      const a = box(items[i - 1]), b = box(items[i]);
      const ay = a.top + P.JACK_Y * a.width / ART_W;
      const by = b.top + P.JACK_Y * b.width / ART_W;
      const wrapped = b.left < a.right;
      const x = (a.right + b.left) / 2;
      const y = wrapped ? (a.bottom + b.top) / 2 : (ay + by) / 2;
      let button = listeningPoints.querySelector('[data-listen-index="' + i + '"]');
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'listening-point';
        button.dataset.listenIndex = i;
        button.innerHTML = '<span aria-hidden="true"></span>';
        listeningPoints.appendChild(button);
      }
      button.title = 'Listen here: ' + dotPoint(i).label;
      button.setAttribute('aria-label', button.title);
      button.style.left = x + 'px';
      button.style.top = y + 'px';
    }
    syncListeningPoints();
  }
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
    const endpoints = [...signalPath.querySelectorAll('.endpoint')];
    const items = [...orderList.querySelectorAll('[data-effect]')];
    const single = new Set(items.map(item => Math.round(item.offsetTop))).size <= 1;
    signalPath.classList.toggle('single-row', single);
    if (single) {
      // One row: line Input and Output up with the jacks and run one straight
      // cable behind the pedals.
      const first = items[0] ? box(items[0]) : null;
      const lineY = first ? first.top + P.JACK_Y * first.width / ART_W : box(dropArea).top + box(dropArea).height / 2;
      for (const endpoint of endpoints) {
        const dot = box(endpoint.querySelector('i'));
        const shift = lineY - (dot.top + dot.height / 2);
        if (Math.abs(shift) > 0.5) endpoint.style.paddingTop = Math.max(0, parseFloat(getComputedStyle(endpoint).paddingTop) + shift) + 'px';
      }
      const a = box(endpoints[0].querySelector('i')), b = box(endpoints[1].querySelector('i'));
      const y = a.top + a.height / 2;
      cables.innerHTML = `<path d="M${a.right.toFixed(1)},${y.toFixed(1)} H${b.left.toFixed(1)}"/>`;
      positionListeningPoints(items, box);
      return;
    }
    for (const endpoint of endpoints) endpoint.style.paddingTop = '';
    const inDot = box(document.querySelector('.endpoint-input i'));
    const outDot = box(document.querySelector('.endpoint-output i'));
    const nodes = [{ out: inDot.right, y: inDot.top + inDot.height / 2, left: inDot.left, right: inDot.right, top: inDot.top, bottom: inDot.bottom }];
    for (const item of orderList.querySelectorAll('[data-effect]')) {
      const b = box(item);
      const art = P.SHAPES[item.dataset.shape] || P.SHAPES.box;
      const scale = b.width / ART_W;
      nodes.push({ in: b.left + art.inset * scale, out: b.right - art.inset * scale, y: b.top + P.JACK_Y * scale, ...b });
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
      paths += `<path d="${roundedPath(pts)}"/>`;
    }
    cables.innerHTML = paths;
    positionListeningPoints(items, box);
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
  function columns(buf, cols, from = PRE, length = VIEW) {
    const top = new Float32Array(cols);
    const bot = new Float32Array(cols);
    const env = state.scale === 'db';
    for (let c = 0; c < cols; c++) {
      let s0 = from + Math.floor((c * length) / cols);
      let s1 = Math.max(s0 + 1, from + Math.floor(((c + 1) * length) / cols));
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
    if (state.view === 'tone') {
      drawSpectrum(ctx, w, h, scopeInput, scopeOutput, 'scope', true);
      return;
    }
    const mid = h / 2;
    const half = (h / 2) * 0.88;
    const y = (v) => mid - amp(v) * half;

    timeLines(ctx, w, h, true);

    // Amplitude grid
    const marks =
      state.scale === 'lin'
        ? [0.25, 0.5, 0.75, 1].map((v) => [v, fmt(v, 2)])
        : (h < 160 ? [0, -24] : [0, -12, -24, -36, -48, -60]).map((d) => [dbToLin(d), fmt(d, 0) + ' dB']);
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
    fillWave(ctx, columns(monitor === 'dry' ? scopeInput : scopeOutput, cols), cols, step, y, C.ink);

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
    if (settings.hidden || !pedal || !['gate', 'comp'].includes(pedal.type)) return;
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
  let audioStarting = false;
  const listen = document.getElementById('listen');
  const audioStatus = document.getElementById('audio-status');
  function sendAudioState() {
    banks[activeBank] = clone(state.chain);
    audioNode?.port.postMessage({ type: 'settings', state: { playing: state.playing, speed: state.speed, chain: state.chain }, kind: source.kind, tempo: source.tempo,
      noiseDb: source.noiseDb, banks, activeBank, inspectId, inspectByBank, matchVolume, monitor, volume: Number(document.getElementById('volume').value) });
  }
  segmented('monitor', v => { monitor = v; refreshInspect(); updateAuditionButtons(); sendAudioState(); });
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
        sendRecording();
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
      listen.setAttribute('aria-label', listening ? 'Pause' : 'Play');
      listen.setAttribute('aria-pressed', String(listening));
      listen.classList.toggle('playing', listening);
      audioStatus.textContent = listening ? 'Listening · tap a dot on the chain to hear that point' : source.kind === 'recording' ? 'Recording paused' : 'Synthesized guitar';
      if (!listening) audition = null;
      updateAuditionButtons();
    } catch (error) {
      listening = false;
      if (audioContext) await audioContext.close().catch(() => {});
      audioContext = audioNode = null;
      audioStatus.textContent = 'Audio could not start. Tap Play to try again in Safari or Chrome.';
      announce(audioStatus.textContent);
    } finally { audioStarting = false; listen.disabled = false; }
  };

  /* --------------------------------------------------------------- loop */

  let last = performance.now();
  let carry = 0;
  let lastDraw = 0;

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (state.playing && !listening && source.kind !== 'recording') {
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

  if (state.chain.length) {
    openSettings(state.chain[0]);
    if (matchMedia('(max-width: 700px), (max-width: 1023px) and (max-height: 500px)').matches) dismissSettings(false);
  }
  else closeSettings();
  document.getElementById('save-status').textContent = restoreMessage || (storageAvailable ? 'Autosave enabled' : 'Local saving unavailable · use Share');
  saveBoard();
  requestAnimationFrame(frame);
})(window.TL);
