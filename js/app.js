/*
 * Tonelab UI: builds the controls, runs the signal through the effect chain
 * every frame and draws the scope, the gain lanes and the transfer curves.
 */
(async function (TL) {
  'use strict';

  const I18n = TL.I18n;
  const tr = I18n?.t || (value => value);
  I18n?.initializeStatic();

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
  const state = { view: savedView, playing: false, speed: 1, scale: 'db', chain: ['gate', 'comp', 'drive', 'delay'].map(type => createPedal(type)), dirty: true };
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
  if (/^#boardz?=/.test(location.hash)) {
    try {
      const compressed = location.hash.startsWith('#boardz=');
      const encoded = location.hash.slice(compressed ? 8 : 7).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(encoded);
      const json = compressed ? await new Response(new Blob([Uint8Array.from(raw, c => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('deflate'))).text() : (() => { try { return decodeURIComponent(escape(raw)); } catch { return raw; } })();
      restoreBoard(JSON.parse(json));
      restoreMessage = tr('Shared pedalboard loaded');
      history.replaceState(null, '', location.pathname + location.search);
    } catch { restoreMessage = tr('This shared link is invalid. Your saved board was kept.'); }
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
        document.getElementById('save-status').textContent = tr('Saved on this device');
      } catch {
        storageAvailable = false;
        document.getElementById('save-status').textContent = tr('Local saving unavailable · use Share');
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
        h.textContent = tr('More controls (not on this pedal)');
        container.appendChild(h);
      }
      if (typeof target[c.key] !== 'number') target[c.key] = spec.value;
      if (c.options) {
        const row = document.createElement('div');
        row.className = 'param param-switch';
        row.innerHTML = '<span class="param-top"><span class="param-name"></span></span><div class="segmented switch-options" role="group"></div><span class="param-hint"></span>';
        row.querySelector('.param-name').textContent = c.label;
        row.querySelector('.param-hint').textContent = pedal.type === 'reverb' && c.key === 'mode' ? c.options.map(([, name]) => ({ Room: tr('Room is small and close'), Hall: tr('Hall is spacious'), Plate: tr('Plate is bright and dense'), Spring: tr('Spring has a bouncy tail'), Shimmer: tr('Shimmer rings an octave up') }[I18n?.english(name) || name] || name)).join('; ') + '.' : spec.hint || '';
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
  patternSelect.replaceChildren(...[tr('Free'), tr('Single notes'), tr('Strums'), tr('Picking'), tr('Rhythm')].map(name => {
    const group = document.createElement('optgroup');
    group.label = name;
    for (const [id, pattern] of Object.entries(TL.PATTERNS)) if (pattern.group === name) group.appendChild(new Option(pattern.label, id));
    return group;
  }));
  const recordingGroup = document.createElement('optgroup');
  recordingGroup.label = tr('Your sound');
  const bringYourOwn = document.getElementById('bring-your-own');
  const recordingFile = document.getElementById('recording-file');
  let recordingLoad = 0;
  const sendRecording = () => {
    if (!audioNode || !localRecording) return;
    const samples = localRecording.samples.slice();
    audioNode.port.postMessage({ type: 'recording', samples }, [samples.buffer]);
  };
  bringYourOwn.onclick = e => { if (bringYourOwn.disabled) e.preventDefault(); };
  bringYourOwn.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && !bringYourOwn.disabled) {
      e.preventDefault();
      recordingFile.click();
    }
  });
  bringYourOwn.addEventListener('dragover', e => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = bringYourOwn.disabled ? 'none' : 'copy';
    bringYourOwn.classList.toggle('drag-over', !bringYourOwn.disabled);
  });
  bringYourOwn.addEventListener('dragleave', e => {
    if (!e.relatedTarget || !bringYourOwn.contains(e.relatedTarget)) bringYourOwn.classList.remove('drag-over');
  });
  bringYourOwn.addEventListener('drop', e => {
    e.preventDefault();
    bringYourOwn.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && !bringYourOwn.disabled) loadRecording(file);
  });
  recordingFile.addEventListener('cancel', syncPattern);
  recordingFile.onchange = async () => {
    const file = recordingFile.files[0];
    if (!file) { syncPattern(); return; }
    await loadRecording(file);
  };
  // Open a local audio file, or a riff just recorded (`riff` trims the silence
  // before the first note so the loop starts on the attack). True on success.
  async function loadRecording(file, { riff = false } = {}) {
    const load = ++recordingLoad;
    document.getElementById('recording-error').hidden = true;
    bringYourOwn.disabled = true;
    bringYourOwn.setAttribute('aria-disabled', 'true');
    bringYourOwn.setAttribute('aria-busy', 'true');
    bringYourOwn.title = tr('Opening recording…');
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error(tr('Choose a recording smaller than 50 MB.'));
      const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const decoder = new OfflineContext(1, 1, SR);
      const decoded = await decoder.decodeAudioData(await file.arrayBuffer());
      if (load !== recordingLoad) return;
      if (!decoded.length || decoded.duration > 600) throw new Error(tr('Choose a recording between a moment and 10 minutes long.'));
      // The pedal engine is mono. Decode/resample locally, then mix channels.
      let samples = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const data = decoded.getChannelData(channel);
        for (let i = 0; i < samples.length; i++) samples[i] += data[i] / decoded.numberOfChannels;
      }
      if (riff) {
        // Level the take like the built-in guitars, whatever level the phone delivered.
        samples = TL.levelRiff(TL.trimRiff(samples));
        if (!samples) throw new Error('silent riff');
      }
      localRecording = { samples, name: file.name };
      source.setRecording(samples);
      source.setKind('recording');
      let option = recordingGroup.querySelector('[value="recording"]');
      if (!option) { option = new Option('', 'recording'); recordingGroup.prepend(option); }
      option.textContent = tr('Your recording · ') + file.name;
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
      announce(tr('Recording ready · stays on this device · loops during playback'));
      return true;
    } catch (error) {
      if (load !== recordingLoad) return false;
      syncPattern();
      const errorBox = document.getElementById('recording-error');
      errorBox.querySelector('span').textContent = error.message?.startsWith(tr('Choose a recording')) ? error.message
        : riff ? tr('Nothing usable was recorded. Check your microphone or raise the input gain, then try again.')
        : tr('This audio file could not be opened. Try a WAV, MP3, or M4A recording.');
      errorBox.hidden = false;
      return false;
    } finally {
      if (load === recordingLoad) {
        bringYourOwn.disabled = false;
        bringYourOwn.removeAttribute('aria-busy');
        bringYourOwn.title = tr('Bring your own recording');
        bringYourOwn.removeAttribute('aria-disabled');
        recordingFile.value = '';
      }
    }
  }
  // Record a riff from the microphone or interface, then loop it through the
  // board like an imported file. Playback pauses while recording, so the
  // speakers can't feed back into the microphone. Nothing leaves the device.
  const recordButton = document.getElementById('record-riff');
  const recordTime = document.getElementById('record-time');
  const countdownEl = document.getElementById('record-countdown');
  const countdownNumber = document.getElementById('countdown-number');
  const inputGain = document.getElementById('input-gain');
  const inputGainOut = document.getElementById('input-gain-out');
  const RIFF_MAX_SECONDS = 60, COUNTDOWN_SECONDS = 3, GAIN_KEY = 'tonelab-input-gain';
  // idle → starting (microphone opening) → countdown → recording → idle
  let riff = null, riffCount = 0, riffPhase = 'idle', riffResume = false, riffClipped = false, countdownCancel = null;
  recordButton.hidden = document.getElementById('dock-gain').hidden = !(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

  // One microphone chain feeds the level meter and the recorder: input → gain →
  // (meter, recorder). It is never connected to the speakers, so it cannot feed
  // back. It stays open only while the gain panel, countdown or recording needs it.
  let mic = null, micOpening = null, meterFrame = 0, meterLevel = 0;
  const inputHolds = new Set();
  try { const saved = Number(localStorage.getItem(GAIN_KEY)); if (Number.isFinite(saved)) inputGain.value = Math.max(-12, Math.min(36, saved)); } catch {}
  const inputGainDb = () => Number(inputGain.value);
  function syncInputGain() {
    const db = inputGainDb();
    inputGainOut.textContent = (db > 0 ? '+' : db < 0 ? '−' : '') + Math.abs(db) + ' dB';
    mic?.gain.gain.setTargetAtTime(dbToLin(db), mic.ctx.currentTime, 0.01);
    try { localStorage.setItem(GAIN_KEY, String(db)); } catch {}
  }
  inputGain.addEventListener('input', syncInputGain);
  syncInputGain();
  async function openInput() {
    // Voice-call processing (echo cancellation, noise suppression, automatic
    // gain) would squash and gate a guitar, so it is switched off.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    await ctx.resume().catch(() => {});
    const gain = ctx.createGain();
    gain.gain.value = dbToLin(inputGainDb());
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096; // about 85 ms, enough to catch up between frames
    const destination = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(stream).connect(gain);
    gain.connect(analyser);
    gain.connect(destination);
    return { stream, ctx, gain, analyser, destination, buffer: new Float32Array(analyser.fftSize) };
  }
  function closeInput(chain) {
    chain.stream.getTracks().forEach(track => track.stop());
    chain.ctx.close().catch(() => {});
  }
  function holdInput(reason) {
    inputHolds.add(reason);
    if (mic) return Promise.resolve(mic);
    micOpening ||= openInput().then(chain => {
      micOpening = null;
      if (!inputHolds.size) { closeInput(chain); return null; }
      mic = chain;
      runMeter();
      return chain;
    }, error => { micOpening = null; inputHolds.clear(); throw error; });
    return micOpening;
  }
  function releaseInput(reason) {
    inputHolds.delete(reason);
    if (inputHolds.size || !mic) return;
    closeInput(mic);
    mic = null;
    cancelAnimationFrame(meterFrame);
    meterLevel = 0;
    showInputPeak(0);
  }
  function showInputPeak(peak) {
    meterLevel = Math.max(peak, meterLevel * 0.88);
    const db = 20 * Math.log10(Math.max(meterLevel, 1e-5));
    for (const bar of document.querySelectorAll('.input-meter > span')) {
      bar.style.width = Math.max(0, Math.min(100, (db + 48) / 48 * 100)) + '%';
      bar.classList.toggle('hot', db > -6 && db <= -1);
      bar.classList.toggle('clip', db > -1);
    }
  }
  function runMeter() {
    cancelAnimationFrame(meterFrame);
    const tick = () => {
      if (!mic) return;
      mic.analyser.getFloatTimeDomainData(mic.buffer);
      let peak = 0;
      for (const v of mic.buffer) peak = Math.max(peak, Math.abs(v));
      if (riffPhase === 'recording' && peak >= 0.99) riffClipped = true;
      showInputPeak(peak);
      meterFrame = requestAnimationFrame(tick);
    };
    tick();
  }
  function showInputError(error) {
    const errorBox = document.getElementById('recording-error');
    errorBox.querySelector('span').textContent = error?.name === 'NotAllowedError'
      ? tr('Microphone access was blocked. Allow it in the browser’s site settings to record a riff.')
      : tr('No microphone or audio interface could be opened.');
    errorBox.hidden = false;
  }

  function showRiffState(phase, count) {
    const recording = phase === 'recording', counting = phase === 'countdown';
    recordButton.classList.toggle('recording', recording);
    recordButton.classList.toggle('counting', counting);
    recordButton.setAttribute('aria-pressed', String(recording || counting));
    recordButton.setAttribute('aria-label', recording ? tr('Stop recording') : counting ? tr('Cancel countdown') : tr('Record a riff'));
    recordButton.title = recording ? tr('Stop recording and loop the riff (Space)') : counting ? tr('Cancel the countdown (Space)') : tr('Record a riff to loop through the board');
    recordTime.hidden = !(recording || counting);
    recordTime.textContent = counting ? String(count) : '0:00';
    bringYourOwn.disabled = recording || counting;
    bringYourOwn.toggleAttribute('aria-disabled', recording || counting);
  }
  recordButton.onclick = () => {
    if (riffPhase === 'idle') startRiff();
    else if (riffPhase === 'countdown') countdownCancel?.();
    else if (riffPhase === 'recording') stopRiff();
  };
  countdownEl.addEventListener('click', () => countdownCancel?.());

  // A big 3… 2… 1… in the middle of the screen. Resolves true when it reaches
  // zero and false if it is cancelled.
  function runCountdown() {
    return new Promise(resolve => {
      let n = COUNTDOWN_SECONDS, timer;
      const show = () => {
        countdownNumber.textContent = n;
        countdownNumber.style.animation = 'none';
        void countdownNumber.offsetWidth;
        countdownNumber.style.animation = '';
        showRiffState('countdown', n);
      };
      const finish = done => {
        clearInterval(timer);
        countdownCancel = null;
        countdownEl.hidden = true;
        resolve(done);
      };
      riffPhase = 'countdown';
      countdownEl.hidden = false;
      show();
      timer = setInterval(() => { if (--n > 0) show(); else finish(true); }, 1000);
      countdownCancel = () => finish(false);
    });
  }
  async function startRiff() {
    if (riffPhase !== 'idle') return;
    riffPhase = 'starting';
    recordButton.disabled = true;
    document.getElementById('recording-error').hidden = true;
    let chain = null;
    try {
      chain = await holdInput('record');
      if (!chain) { riffPhase = 'idle'; return; }
      riffResume = listening;
      if (listening) await listen.onclick();
      recordButton.disabled = false;
      if (!await runCountdown()) {
        riffPhase = 'idle';
        showRiffState('idle');
        releaseInput('record');
        announce(tr('Recording cancelled'));
        if (riffResume && !listening) listen.click();
        return;
      }
      const recorder = new MediaRecorder(chain.destination.stream);
      const chunks = [];
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      riffClipped = false;
      // Start the waveform fresh; it then follows the microphone (see frame()).
      input.fill(0);
      for (const history of Object.values(scopeHistory)) { history.input.fill(0); history.output.fill(0); }
      state.dirty = true;
      riff = { recorder, chunks, started: performance.now() };
      riff.timer = setInterval(() => {
        const seconds = Math.floor((performance.now() - riff.started) / 1000);
        recordTime.textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
        if (seconds >= RIFF_MAX_SECONDS) stopRiff();
      }, 250);
      recorder.start();
      riffPhase = 'recording';
      showRiffState('recording');
      announce(tr('Recording · play your riff, then press stop or Space'));
    } catch (error) {
      riffPhase = 'idle';
      riff = null;
      showRiffState('idle');
      releaseInput('record');
      showInputError(error);
    } finally {
      recordButton.disabled = false;
    }
  }
  function stopRiff() {
    if (!riff) return;
    const { recorder, chunks, timer } = riff;
    const clipped = riffClipped;
    riff = null;
    clearInterval(timer);
    riffPhase = 'idle';
    showRiffState('idle');
    recorder.onstop = async () => {
      releaseInput('record');
      const type = recorder.mimeType || chunks[0]?.type || 'audio/webm';
      const file = new File([new Blob(chunks, { type })], tr('My riff') + ' ' + ++riffCount, { type });
      const loaded = await loadRecording(file, { riff: true });
      if (!loaded) return;
      // Resume only if it was playing before; otherwise Play starts the loop.
      if (riffResume && !listening) listen.click();
      else if (!listening) announce(clipped ? tr('Riff ready, but it clipped · lower the input gain · press Play to loop it') : tr('Riff ready · press Play to loop it through the board'));
      if (clipped) announce(tr('Your riff clipped. Lower the input gain and record it again.'));
    };
    recorder.stop();
  }

  // Free picking has no tempo; every other pattern follows the Speed slider.
  function syncPattern() {
    patternSelect.value = source.kind;
    const tempo = Math.round(source.tempo);
    const free = !TL.PATTERNS[source.kind]?.tempo;
    speed.value = tempo;
    speed.disabled = free;
    speedOut.textContent = free ? tr('not used') : tempo + ' BPM';
    document.getElementById('dock-playing-text').textContent = free ? (source.kind === 'recording' ? 'Original' : tr('Free time')) : tempo + ' BPM';
    const tempoButton = document.getElementById('dock-playing');
    tempoButton.disabled = free;
    tempoButton.title = free ? (source.kind === 'recording' ? tr('Recording plays at its original speed') : tr('No tempo for free picking')) : tr('Adjust tempo');
    tempoButton.setAttribute('aria-label', free ? tempoButton.title : tr('Adjust tempo: ') + tempo + ' BPM');
    patternSelect.title = source.kind === 'recording' ? localRecording.name + tr(' · local recording · loops during playback') : '';
    document.getElementById('noise').disabled = source.kind === 'recording';
    document.querySelector('.noise-hint').textContent = source.kind === 'recording'
      ? tr('Your recording keeps its own background noise.')
      : tr('Add background hiss to try the noise gate.');
  }
  // Temporary controls stay within the player bar and share the same behavior.
  let activePlayerControl = null;
  function inlinePlayerControl(buttonId, fieldId, sliderId, { autoClose = true, onOpen, onClose } = {}) {
    const button = document.getElementById(buttonId);
    const field = document.getElementById(fieldId);
    const slider = document.getElementById(sliderId);
    let timer, dragging = false;
    const close = () => {
      clearTimeout(timer);
      const wasOpen = !field.hidden;
      field.hidden = true;
      if (wasOpen) onClose?.();
      button.setAttribute('aria-expanded', 'false');
      if (activePlayerControl?.close === close) {
        activePlayerControl = null;
        button.closest('.player-dock').classList.remove('adjusting-player');
      }
      if (document.activeElement === slider) button.focus({ preventScroll: true });
    };
    const finish = () => {
      clearTimeout(timer);
      if (autoClose && !dragging) timer = setTimeout(close, 1500);
    };
    button.onclick = () => {
      if (!field.hidden) { close(); return; }
      activePlayerControl?.close();
      activePlayerControl = { button, field, close };
      field.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      button.closest('.player-dock').classList.add('adjusting-player');
      slider.focus({ preventScroll: true });
      onOpen?.(close);
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
  // The gain panel stays open (no timer) so its meter can be watched while you
  // play; the microphone is only open while it is shown.
  inlinePlayerControl('dock-gain', 'inline-gain', 'input-gain', { autoClose: false,
    onOpen: close => holdInput('panel').catch(error => { close(); showInputError(error); }),
    onClose: () => releaseInput('panel') });
  // Play keeps an open panel open: you often adjust tempo or volume while
  // starting playback, and closing it would move Play out from under the tap.
  const closesPlayerControl = (control, target) => control && !control.field.contains(target) && !control.button.contains(target) && !listen.contains(target) && !recordButton.contains(target);
  document.addEventListener('click', e => { if (closesPlayerControl(activePlayerControl, e.target)) activePlayerControl.close(); });
  document.addEventListener('focusin', e => { if (closesPlayerControl(activePlayerControl, e.target)) activePlayerControl.close(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (riffPhase === 'countdown') { countdownCancel?.(); return; }
    activePlayerControl?.close();
  });
  // Space: stop a recording or cancel its countdown; otherwise play and stop the
  // loop. Typing fields and open dialogs keep Space. A button you tabbed to
  // keeps it too (so keyboard users can still press it), but a button you only
  // clicked does not, so Space works right after any click. Chromium's
  // :focus-visible is unreliable after script-driven focus, so track it here.
  let swallowSpaceUp = false, keyboardNavigation = false;
  document.addEventListener('pointerdown', () => { keyboardNavigation = false; }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Tab') keyboardNavigation = true; }, true);
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const busy = riffPhase === 'countdown' || riffPhase === 'recording';
    if (e.defaultPrevented && !busy) return;
    const target = e.target instanceof Element ? e.target : document.body;
    if (target.closest('textarea, select, [contenteditable=""], [contenteditable="true"], input:not([type=range])')) return;
    if (document.querySelector('dialog[open]')) return;
    if (!busy && keyboardNavigation && target.closest('button, a[href], summary, [role=button], [role=tab]')) return;
    if (riffPhase === 'starting') { e.preventDefault(); return; }
    e.preventDefault();
    swallowSpaceUp = true;
    if (riffPhase === 'recording') stopRiff();
    else if (riffPhase === 'countdown') countdownCancel?.();
    else if (!listen.disabled) listen.click();
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space' && swallowSpaceUp) { swallowSpaceUp = false; e.preventDefault(); }
  });
  patternSelect.onchange = () => {
    recordingLoad++;
    bringYourOwn.disabled = false;
    bringYourOwn.removeAttribute('aria-disabled');
    bringYourOwn.removeAttribute('aria-busy');
    bringYourOwn.title = tr('Bring your own recording');
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
  const mobileEditor = matchMedia('(max-width: 1023px)');
  const guideDialog = document.getElementById('pedal-guide-dialog');
  const guideContent = document.getElementById('inspector-guide');
  const boardGuideDialog = document.getElementById('board-guide-dialog');
  boardGuideDialog.querySelector('.sheet-close').onclick = () => boardGuideDialog.close();
  let guideSelected = false;
  const modelRow = settings.querySelector('.model-row');
  const moreSettings = settings.querySelector('.more-pedal-settings');
  const pedalNote = document.getElementById('pedal-note');
  const pedalDiff = document.getElementById('pedal-diff');
  function syncMobileEditor() {
    const wasGuide = guideSelected;
    if (guideDialog.open) guideDialog.close();
    document.body.classList.remove('pedal-guide-open');
    guideContent.hidden = true;
    modelRow.hidden = false;
    document.getElementById('inspector-controls').hidden = false;
    document.getElementById('tab-controls').setAttribute('aria-pressed', 'true');
    document.getElementById('tab-guide').setAttribute('aria-pressed', 'false');
    document.getElementById('inspector-controls').before(modelRow);
    if (mobileEditor.matches) {
      moreSettings.append(pedalNote, pedalDiff);
      document.getElementById('mobile-guide-content').append(guideContent);
    } else {
      document.getElementById('inspect-pedal').before(pedalNote, pedalDiff);
      settings.append(guideContent);
    }
    if (wasGuide && !settings.hidden) showGuide(true);
  }
  syncMobileEditor();
  mobileEditor.addEventListener('change', syncMobileEditor);
  guideDialog.querySelector('.sheet-close').onclick = () => guideDialog.close();
  guideDialog.addEventListener('close', () => {
    if (!guideDialog.open) {
      document.body.classList.remove('pedal-guide-open');
      if (mobileEditor.matches) showGuide(false);
    }
  });
  document.getElementById('mobile-pedal-guide').onclick = () => showGuide(true);
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
    announce(pedalName(pedal) + tr(' moved to position ') + (to + 1));
  }
  function syncMoveButtons() {
    const index = state.chain.findIndex(p => p.id === selectedId);
    document.getElementById('pedal-earlier').disabled = index <= 0;
    document.getElementById('pedal-later').disabled = index === state.chain.length - 1;
  }
  // Editing happens inline, under the chain and the scope, so the live
  // waveform stays in view while you turn the knobs.
  function closeSettings() {
    guideSelected = false;
    if (guideDialog.open) guideDialog.close();
    settings.hidden = true;
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
    orderList.querySelectorAll('.selected-pedal').forEach(item => { item.classList.remove('selected-pedal'); item.querySelector('.pedal-edit').setAttribute('aria-pressed', 'false'); });
    document.body.classList.remove('editing');
    renderStrip();
    if (!undoToast.hidden) placeUndo();
  }
  function showPedalNotes(pedal) {
    document.getElementById('settings-state').textContent = pedal.enabled ? tr('Enabled') : tr('Bypassed');
    document.getElementById('pedal-note').textContent = noteFor(pedal, state.chain);
    const other = otherBank(activeBank);
    const diff = differences(state.chain, banks[other], other).byPedal.get(pedal.id);
    const diffEl = document.getElementById('pedal-diff');
    diffEl.textContent = diff ? tr('A/B difference · ') + diff : '';
    diffEl.hidden = !diff;
    updateGuide(pedal);
  }
  let savedTimer;
  function flashSaved() {
    const el = document.getElementById('pedal-saved');
    el.textContent = tr('✓ Saved');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { el.textContent = ''; }, 1600);
  }
  function openSettings(pedal, reveal = false) {
    const wasOpen = !settings.hidden && selectedId === pedal.id;
    if (!wasOpen) {
      settings.scrollTop = 0;
      document.querySelector('.workspace-side').scrollTop = 0;
      moreSettings.open = false;
      document.getElementById('guide-settings').open = true;
    }
    selectedId = pedal.id;
    // Editing a pedal leaves the explicitly chosen listening point unchanged.
    document.getElementById('settings-title').textContent = pedalName(pedal);
    document.getElementById('settings-state').textContent = pedal.enabled ? tr('Enabled') : tr('Bypassed');
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
      announce(pedalName(pedal) + tr(' is now a ') + modelOf(pedal).name);
    };
    pedal.advanced = moreSettings.open;
    const container = document.getElementById('pedal-params');
    const renderControls = () => {
      container.replaceChildren();
      buildControls(container, pedal, () => {
        const art = orderList.querySelector('[data-effect="' + pedal.id + '"] .pedal-art');
        if (art) art.innerHTML = pedalArt(pedal);
        document.getElementById('selected-pedal-preview').innerHTML = artSvg(pedal, 'editor-pedal-art');
        markEdited();
        showPedalNotes(pedal);
        flashSaved();
      });
    };
    moreSettings.ontoggle = () => {
      pedal.advanced = moreSettings.open;
      renderControls();
    };
    renderControls();
    document.getElementById('pedal-curve-wrap').hidden = !['gate', 'comp'].includes(pedal.type);
    document.getElementById('selected-pedal-preview').innerHTML = artSvg(pedal, 'editor-pedal-art');
    trails.gate.length = trails.comp.length = 0;
    showPedalNotes(pedal);
    syncMoveButtons();
    settings.hidden = false;
    document.getElementById('inspector-empty').hidden = true;
    settings.querySelector('.sheet-head').hidden = false;
    settings.querySelector('.inspector-tabs').hidden = false;
    showGuide(guideSelected);
    document.body.classList.add('editing');
    renderStrip();
    orderList.querySelectorAll('[data-effect]').forEach(item => {
      const isSelected = item.dataset.effect === pedal.id;
      item.classList.toggle('selected-pedal', isSelected);
      item.querySelector('.pedal-edit').setAttribute('aria-pressed', String(isSelected));
    });
    if (!undoToast.hidden) placeUndo();
    updateAuditionButtons();
    if (((mobileEditor.matches && !wasOpen) || reveal) && !guideDialog.open) {
      requestAnimationFrame(() => {
        if (settings.hidden || guideDialog.open) return;
        const top = settings.getBoundingClientRect().top;
        const available = window.innerHeight - document.querySelector('.player-dock').getBoundingClientRect().height;
        if (mobileEditor.matches) {
          if (top < 0 || top > available - 240) settings.scrollIntoView({ block: 'start', behavior: 'smooth' });
        } else {
          const playerHeight = document.querySelector('.player-dock').getBoundingClientRect().height;
          if (top < playerHeight + 12 || top > window.innerHeight - 180) {
            window.scrollBy({ top: top - playerHeight - 20, behavior: 'smooth' });
          }
        }
      });
    }
  }
  function addPedal(type, params, model) {
    const pedal = createPedal(type, params, model);
    state.chain.push(pedal);
    edited();
    announce(pedalName(pedal) + tr(' added at position ') + state.chain.length);
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
      announce(pedalName(pedal) + tr(' restored at position ') + (state.chain.indexOf(pedal) + 1));
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
    document.getElementById('undo-text').textContent = '';
  }
  // Keep notifications outside workspace layout and stacking contexts.
  const undoHome = document.body;
  function placeUndo() {
    if (undoToast.parentElement !== undoHome) undoHome.appendChild(undoToast);
    undoToast.classList.remove('inline', 'home');
    undoToast.classList.add('floating');
  }
  addEventListener('scroll', () => { if (!undoToast.hidden) placeUndo(); }, { passive: true });
  function offerUndo(text, restore) {
    hideUndo();
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
  document.getElementById('dismiss-undo').onclick = hideUndo;
  document.addEventListener('keydown', e => {
    if (!undoAction || e.key.toLowerCase() !== 'z' || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    e.preventDefault();
    undo();
  });
  document.querySelector('.board-add-tile')?.addEventListener('click', () => library.showModal());
  document.getElementById('strip-add').onclick = () => library.showModal();
  const effectGroups = [['Dynamics', ['gate', 'comp']], ['Drive', ['boost', 'drive', 'dist', 'fuzz']], ['Pitch', ['octave', 'harm']], ['Filter', ['eq', 'wah']], ['Modulation', ['chorus', 'phaser', 'trem']], ['Time', ['swell', 'delay', 'reverb']]];
  function renderLibrary() {
    const choices = document.getElementById('effect-choices');
    choices.replaceChildren();
    for (const [name, effectTypes] of effectGroups) {
      const section = document.createElement('section');
      section.className = 'effect-group';
      const heading = document.createElement('h3');
      heading.textContent = name;
      section.append(heading);
      choices.append(section);
      for (const type of effectTypes) {
        const info = types[type];
        const button = document.createElement('button');
        button.dataset.type = type;
        const preview = { type, model: info.models[0].id, params: P.modelDefaults(type, info.models[0].id) };
        button.innerHTML = artSvg(preview, 'choice-art') + '<strong>' + (type === 'chorus' ? 'Chorus / flanger' : info.name) + '</strong><span class="choice-text">' + info.explanation.split('.')[0] + '.</span><span class="choice-model">' + info.models.map(m => m.name).join(' · ') + '</span><span class="choice-add" aria-hidden="true">+</span>';
        button.onclick = () => {
          const pedal = addPedal(type);
          library.close();
          openSettings(pedal);
        };
        section.appendChild(button);
      }
    }
  }
  renderLibrary();
  settings.querySelector('.sheet-close').onclick = () => dismissSettings();
  function dismissSettings(restoreFocus = true) {
    const id = selectedId;
    closeSettings();
    if (restoreFocus) orderList.querySelector('[data-effect="' + id + '"] .pedal-toggle')?.focus({ preventScroll: true });
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !settings.hidden && !document.querySelector('dialog[open]')) dismissSettings();
  });
  mobileEditor.addEventListener('change', () => {
    if (!settings.hidden) {
      const pedal = selected();
      if (pedal) openSettings(pedal); else closeSettings();
    }
  });
  const player = document.querySelector('.player-dock');
  const sizePlayer = () => {
    const rect = player.getBoundingClientRect();
    const style = document.documentElement.style;
    style.setProperty('--player-height', rect.height + 'px');
    style.setProperty('--player-bottom', Math.max(12, rect.bottom + 12) + 'px');
    style.setProperty('--quick-start-bottom', Math.max(0, innerHeight - rect.top + 12) + 'px');
    style.setProperty('--quick-start-available', Math.max(0, rect.top - 32) + 'px');
  };
  new ResizeObserver(sizePlayer).observe(player);
  addEventListener('resize', sizePlayer, { passive: true });
  addEventListener('scroll', sizePlayer, { passive: true });
  window.visualViewport?.addEventListener('resize', sizePlayer, { passive: true });
  window.visualViewport?.addEventListener('scroll', sizePlayer, { passive: true });
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
    document.querySelector('#monitor [data-value="dry"]').textContent = pedal ? tr('Before') : tr('Dry guitar');
    document.querySelector('#monitor [data-value="wet"]').textContent = pedal ? tr('After') : tr('With pedals');
    const name = pedal && kindName(pedal).toLowerCase();
    document.getElementById('scope-caption').textContent = !pedal
      ? (monitor === 'dry' || !state.chain.length ? tr('Your guitar') : tr('Full chain output'))
      : (monitor === 'dry' ? tr('Before the ') : tr('After the ')) + name;
    renderStrip();
    document.querySelector('.sw-in').parentElement.lastChild.textContent = pedal ? tr('Pedal input') : tr('Guitar input');
    document.querySelector('.sw-out').parentElement.lastChild.textContent = pedal ? tr('Pedal output') : tr('Chain output');
    document.querySelector('.sw-in').parentElement.hidden = false;
    document.querySelector('.sw-out').parentElement.hidden = monitor === 'dry';
    document.querySelector('.sw-in').style.background = C.ink3;
    document.querySelectorAll('#monitor button').forEach(button => {
      const on = button.dataset.value === monitor;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    });
    syncListeningPoints();
    syncBanks();
    state.dirty = true;
  }
  document.getElementById('inspect-pedal').onclick = () => { if (selectedId) listenTo(selectedId, 'wet'); };

  /* The chain strip: In, each pedal, Out, with a listening point (dot)
   * between them. Dot k is the signal after k pedals. */
  const strip = document.getElementById('chain-strip');
  function dotPoint(k) {
    const chain = state.chain;
    if (k === 0) return { pedal: '', monitor: 'dry', label: tr('Your guitar') };
    if (k === chain.length) return { pedal: '', monitor: 'wet', label: tr('Full chain output') };
    return { pedal: chain[k - 1].id, monitor: 'wet', label: tr('After ') + pedalName(chain[k - 1]) };
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
      return `<li class="strip-node"><button type="button" class="strip-dot${k === on ? ' on' : ''}" data-dot="${k}" aria-pressed="${k === on}" aria-label="${tr('Listen here: ')}${point.label}"><i></i></button></li>`;
    };
    const items = ['<li class="strip-end">' + tr('In') + '</li>', dot(0)];
    chain.forEach((pedal, i) => {
      items.push(`<li class="strip-pedal${pedal.enabled ? '' : ' off'}${pedal.id === selectedId && !settings.hidden ? ' selected' : ''}" data-type="${pedal.type}">` +
        `<button type="button" data-strip-edit="${pedal.id}" aria-label="${tr('Edit ')}${pedalName(pedal)}">${artSvg(pedal, 'strip-art')}<span>${modelOf(pedal).short || types[pedal.type].short || kindName(pedal)}</span></button></li>`);
      if (i < chain.length - 1) items.push(dot(i + 1));
    });
    if (chain.length) items.push(dot(chain.length));
    items.push('<li class="strip-end">' + tr('Out') + '</li>');
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
    if (edit) openSettings(state.chain.find(p => p.id === edit.dataset.stripEdit), true);
  });
  const roomyLayout = matchMedia('(min-width: 701px) and (min-height: 501px), (min-width: 1024px)');
  const scopePreferences = { compact: false, roomy: true };
  function setScopeExpanded(expanded) {
    document.querySelector('.scope-disclosure').classList.toggle('scope-expanded', expanded);
    document.body.classList.toggle('analysing', expanded);
    const button = document.getElementById('expand-scope');
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', expanded ? tr('Collapse waveform') : tr('Expand waveform'));
    button.title = expanded ? tr('Collapse waveform') : tr('Expand waveform');
    button.textContent = expanded ? tr('Analyse −') : tr('Analyse +');
    state.dirty = true;
  }
  document.getElementById('expand-scope').onclick = () => {
    const expanded = !document.querySelector('.scope-disclosure').classList.contains('scope-expanded');
    scopePreferences[roomyLayout.matches ? 'roomy' : 'compact'] = expanded;
    setScopeExpanded(expanded);
  };
  roomyLayout.addEventListener('change', () => setScopeExpanded(scopePreferences[roomyLayout.matches ? 'roomy' : 'compact']));
  document.getElementById('toggle-meters').onclick = e => {
    metersOpen = !metersOpen;
    e.target.setAttribute('aria-expanded', String(metersOpen));
    e.target.textContent = metersOpen ? tr('Hide meters') : tr('Show meters');
    state.dirty = true;
  };
  function syncBanks() {
    document.querySelectorAll('#compare-bank [data-bank], #dock-bank [data-bank]').forEach(button => {
      button.classList.toggle('on', button.dataset.bank === activeBank && (button.closest('#compare-bank') || monitor !== 'dry' || inspectId));
      button.setAttribute('aria-pressed', String(button.dataset.bank === activeBank && (button.closest('#compare-bank') || monitor !== 'dry' || inspectId)));
    });
    const dry = document.querySelector('#dock-bank [data-dry]');
    dry.classList.toggle('on', monitor === 'dry' && !inspectId);
    dry.setAttribute('aria-pressed', String(monitor === 'dry' && !inspectId));
    document.getElementById('copy-bank-label').textContent = activeBank === 'A' ? 'A → B' : 'B → A';
    const copy = document.getElementById('copy-bank');
    copy.title = activeBank === 'A' ? tr('Copy A to B') : tr('Copy B to A');
    copy.setAttribute('aria-label', copy.title);
  }
  document.getElementById('compare-bank').onclick = e => switchBank(e.target.closest('[data-bank]')?.dataset.bank);
  document.getElementById('dock-bank').onclick = e => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.dataset.bank) switchBank(button.dataset.bank);
    inspectId = '';
    inspectByBank[activeBank] = '';
    monitor = button.hasAttribute('data-dry') ? 'dry' : 'wet';
    refreshInspect();
    updateAuditionButtons();
    sendAudioState();
  };
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
    announce(activeBank + tr(' copied to ') + other);
  };
  document.getElementById('match-volume').checked = matchVolume;
  document.getElementById('match-volume').onchange = e => {
    matchVolume = e.target.checked;
    state.dirty = true;
    saveBoard();
  };
  document.getElementById('share-board').onclick = async () => {
    const json = JSON.stringify(snapshot());
    let raw = unescape(encodeURIComponent(json)), key = 'board';
    if (typeof CompressionStream !== 'undefined') {
      const compressed = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
      raw = String.fromCharCode(...new Uint8Array(compressed));
      key = 'boardz';
    }
    const url = new URL(location.href);
    url.hash = key + '=' + btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    document.getElementById('share-link').value = url.href;
    document.getElementById('share-copy-status').textContent = '';
    document.getElementById('copy-share-link').textContent = tr('Copy link');
    document.getElementById('share-dialog').showModal();
  };
  document.getElementById('copy-share-link').onclick = async () => {
    const field = document.getElementById('share-link');
    try {
      await navigator.clipboard.writeText(field.value);
      document.getElementById('copy-share-link').textContent = tr('Copied');
      document.getElementById('share-copy-status').textContent = tr('Link copied, including A and B');
    } catch {
      field.focus();
      field.select();
      document.getElementById('share-copy-status').textContent = tr('Select and copy the link above.');
    }
  };
  document.querySelector('#share-dialog .sheet-close').onclick = () => document.getElementById('share-dialog').close();
  document.querySelector('#recording-error button').onclick = () => { document.getElementById('recording-error').hidden = true; };
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
        ['delay', { time: 480, feedback: 0.35, mix: 0.3 }, 'A soft echo, low in the mix, that fills the space behind long notes.'],
      ],
      tip: 'Too harsh? Turn the fuzz’s tone down. Too muddy? Lower the delay mix.',
      whatIfs: [
        { id: 'bright', label: 'Brighter fuzz', note: 'With the tone turned all the way up, the same fuzz gets fizzy and harsh. The smoothness comes from the darker tone setting.',
          chain: [['comp', { threshold: -24, ratio: 3, attack: 20, release: 300, knee: 6, makeup: 4 }], ['fuzz:bigmuff', { fuzz: 26, tone: 1, level: -8 }], ['delay', { time: 480, feedback: 0.35, mix: 0.3 }]] },
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
      summary: 'Tom Morello’s solo sound: a DigiTech Whammy two octaves up into a crunchy Marshall-style drive, with a long, loud Boss echo. In the spirit of the song, not a copy of its recording.',
      source: { kind: 'lead', tempo: 108, noise: -60 },
      play: 'Play a slow melody high on the neck. On a real Whammy, rock between heel and toe; for the verses, switch it off and roll the guitar volume back.',
      chain: [
        ['octave:whammy', { interval: 24, treadle: 1, shift: 1, dry: 0, sub: 0, up: 0, sub2: 0 }, 'Two octaves up with the treadle at the toe, so every note jumps into a high, synth-like squeal.'],
        ['drive:ocd', { drive: 16, tone: 0.55, mix: 1, level: -6, voicing: 0, clipping: 1 }, 'Stands in for Morello’s Marshall JCM800: his crunch comes from the amp, not from a distortion pedal.'],
        ['delay:dd3', { time: 430, feedback: 0.35, mix: 0.4, range: 2000 }, 'A Boss digital delay in Long mode with the effect level turned up, so the solo trails off into repeats.'],
      ],
      tip: 'Morello’s board has no chorus or reverb pedal: the space comes from the delay. Turn the delay off for drier rhythm parts.',
      whatIfs: [
        { id: 'no-whammy', label: 'Whammy off', note: 'Without the pitch shift you hear the plain crunch and echo underneath, closer to the verses.',
          chain: [['drive:ocd', { drive: 16, tone: 0.55, mix: 1, level: -6, voicing: 0, clipping: 1 }], ['delay:dd3', { time: 430, feedback: 0.35, mix: 0.4, range: 2000 }]] },
        { id: 'one-octave', label: 'One octave up', note: 'One octave instead of two: the solo is less shrill and sounds more like a guitar.',
          chain: [['octave:whammy', { interval: 12, treadle: 1, shift: 1, dry: 0, sub: 0, up: 0, sub2: 0 }], ['drive:ocd', { drive: 16, tone: 0.55, mix: 1, level: -6, voicing: 0, clipping: 1 }], ['delay:dd3', { time: 430, feedback: 0.35, mix: 0.4, range: 2000 }]] },
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
      summary: 'A punchy blues crunch: a Tube Screamer with Drive low and Level high, pushing a cranked Fender amp so single notes sing and sustain. In the spirit of the style, not a copy of any recording.',
      source: { kind: 'shuffle', tempo: 120, noise: -60 },
      play: 'Hit single notes hard and let them ring. Listen to the sustain and the edge on each note.',
      chain: [
        ['drive:ts9', { drive: 3, tone: 0.6, level: 6, mix: 1, voicing: 1, clipping: 0 }, 'Drive almost off and Level all the way up: Vaughan used the Tube Screamer mostly as a mid-heavy boost that hits the amp harder.'],
        ['drive:ocd', { drive: 12, tone: 0.55, mix: 1, level: -6, voicing: 3, clipping: 1 }, 'Stands in for his cranked Fender Vibroverb: most of the grit comes from the amp, not the pedal.'],
      ],
      tip: 'Roll the guitar’s volume knob back a little to clean up chords without changing the lead tone.',
      whatIfs: [
        { id: 'drive-up', label: 'Drive up, Level down', note: 'More pedal gain and less output: fizzier and more squashed, and the amp is pushed less. Low Drive with high Level keeps more punch.',
          chain: [['drive:ts9', { drive: 18, tone: 0.6, level: -6, mix: 1, voicing: 1, clipping: 0 }], ['drive:ocd', { drive: 12, tone: 0.55, mix: 1, level: -6, voicing: 3, clipping: 1 }]] },
        { id: 'no-ts', label: 'No Tube Screamer', note: 'The amp on its own breaks up less: thinner notes, with less sustain and mid push.',
          chain: [['drive:ocd', { drive: 12, tone: 0.55, mix: 1, level: -6, voicing: 3, clipping: 1 }]] },
      ],
    },
    {
      id: 'summers-chorus', group: 'Songs', title: 'Andy Summers · clean chorus', short: 'Clean chorus',
      summary: 'Clean, bright chords with the watery shimmer of a flanger set like a chorus, and a soft tape echo. In the spirit of the clean early-80s sound, not a copy of any recording.',
      source: { kind: 'reggae', tempo: 104, noise: -60 },
      play: 'Play clean arpeggios and chords with a light touch, and let the chorus spread them out.',
      chain: [
        ['comp:dynacomp', { threshold: -24, makeup: 1 }, 'Keeps clean notes at a steady level, so the chorus and echo don’t jump around.'],
        ['chorus:flanger', { manual: 6, depth: 0.5, rate: 0.4, feedback: 0.15, mix: 0.5, wave: 1 }, 'An Electric Mistress-style flanger with a longer, gentler setting: a watery, chorus-like shimmer instead of a jet sweep.'],
        ['delay:multi', { time: 330, feedback: 0.25, mix: 0.2, type: 2 }, 'A quiet tape echo, like his Echoplex and Space Echo, sitting in the gaps between chords.'],
        ['reverb:bigsky', { decay: 0.4, predelay: 15, mix: 0.2, tone: 0.6, mode: 0 }, 'A little room, so the guitar sits in a space.'],
      ],
      tip: 'Keep the echo low. It should be felt more than heard.',
      whatIfs: [
        { id: 'no-delay', label: 'No delay', note: 'The chorus and room are still there, but the echo in the gaps is gone. The chords sound closer and less spacious.',
          chain: [['comp:dynacomp', { threshold: -24, makeup: 1 }], ['chorus:flanger', { manual: 6, depth: 0.5, rate: 0.4, feedback: 0.15, mix: 0.5, wave: 1 }], ['reverb:bigsky', { decay: 0.4, predelay: 15, mix: 0.2, tone: 0.6, mode: 0 }]] },
        { id: 'no-chorus', label: 'No flanger', note: 'Clean and narrow. The echo and room remain, but the wide, moving shimmer is gone.',
          chain: [['comp:dynacomp', { threshold: -24, makeup: 1 }], ['delay:multi', { time: 330, feedback: 0.25, mix: 0.2, type: 2 }], ['reverb:bigsky', { decay: 0.4, predelay: 15, mix: 0.2, tone: 0.6, mode: 0 }]] },
      ],
    },
    {
      id: 'marr-jangle', group: 'Songs', title: 'Johnny Marr · jangle', short: 'Jangle',
      summary: 'Bright, ringing clean chords with a light Boss chorus and an amp’s spring reverb. In the spirit of the jangly clean style, not a copy of any recording.',
      source: { kind: 'strum-jangle', tempo: 124, noise: -60 },
      play: 'Strum open chords with a bright, quick attack, and let them ring.',
      chain: [
        ['comp:keeley', { threshold: -22, makeup: 1, tone: 0.6, input: 0, blend: 0.8 }, 'Keeps the strums even, so every chord rings out at the same level.'],
        ['chorus:ce2w', { rate: 0.7, depth: 0.3, mix: 0.4 }, 'A light shimmer, enough to make the strings sound bright without blurring them.'],
        ['reverb:fender', { dwell: 0.4, mix: 0.25, tone: 0.75 }, 'The Fender Twin’s built-in spring reverb: a short, bright splash that keeps the chords crisp.'],
      ],
      tip: 'Bright is the point here: lift the treble on the reverb before you touch the guitar’s tone knob.',
      whatIfs: [
        { id: 'plate', label: 'Plate instead of spring', note: 'A plate is denser and smoother. The chords lose some of their splash and sit further back.',
          chain: [['comp:keeley', { threshold: -22, makeup: 1, tone: 0.6, input: 0, blend: 0.8 }], ['chorus:ce2w', { rate: 0.7, depth: 0.3, mix: 0.4 }], ['reverb:bigsky', { decay: 0.45, predelay: 10, mix: 0.25, tone: 0.75, mode: 2 }]] },
        { id: 'deep-chorus', label: 'Deeper chorus', note: 'With more depth the chorus wobbles much more. The chords get seasick and lose their crispness.',
          chain: [['comp:keeley', { threshold: -22, makeup: 1, tone: 0.6, input: 0, blend: 0.8 }], ['chorus:ce2w', { rate: 0.7, depth: 0.9, mix: 0.4 }], ['reverb:fender', { dwell: 0.4, mix: 0.25, tone: 0.75 }]] },
      ],
    },
    {
      id: 'queen-layers', group: 'Songs', title: 'Brian May · layered lead echo', short: 'Layered lead',
      summary: 'A singing lead with mild overdrive and two echoes at different times, so each note comes back in layers. In the spirit of the style, not a copy of any recording.',
      source: { kind: 'lead', tempo: 75, noise: -60 },
      play: 'Play a melody with long notes and bends. Listen for the echoes stacking up behind each note.',
      chain: [
        ['drive:ts9', { drive: 8, tone: 0.6, level: -1, mix: 0.9, voicing: 0, clipping: 1 }, 'A mild, warm overdrive: enough to make the lead sing, without hiding the notes.'],
        ['delay:dd3', { time: 800, feedback: 0, mix: 0.4, character: 0 }, 'The first echo: a single repeat 800 ms after each note, the time Brian May used.'],
        ['delay:dd3', { time: 800, feedback: 0, mix: 0.4, character: 0 }, 'A second 800 ms echo in series. It repeats the first one too, so a third copy arrives at 1600 ms, like May’s second delay.'],
        ['reverb:bigsky', { decay: 0.5, predelay: 10, mix: 0.25, tone: 0.55, mode: 2 }, 'A plate that gives the layers some room.'],
      ],
      tip: 'Brian May set two delays to 800 and 1600 ms with one repeat each. Play phrases that harmonize with themselves as the echoes arrive.',
      whatIfs: [
        { id: 'one-echo', label: 'One echo', note: 'Only the 800 ms echo. Each note comes back once, so you hear two parts instead of three.',
          chain: [['drive:ts9', { drive: 8, tone: 0.6, level: -1, mix: 0.9, voicing: 0, clipping: 1 }], ['delay:dd3', { time: 800, feedback: 0, mix: 0.4, character: 0 }], ['reverb:bigsky', { decay: 0.5, predelay: 10, mix: 0.25, tone: 0.55, mode: 2 }]] },
        { id: 'echo-before-drive', label: 'Echo before the overdrive', note: 'Now the echoes are overdriven too, so the repeats grow gritty and harsher with each one.',
          chain: [['delay:dd3', { time: 800, feedback: 0, mix: 0.4, character: 0 }], ['delay:dd3', { time: 800, feedback: 0, mix: 0.4, character: 0 }], ['drive:ts9', { drive: 8, tone: 0.6, level: -1, mix: 0.9, voicing: 0, clipping: 1 }], ['reverb:bigsky', { decay: 0.5, predelay: 10, mix: 0.25, tone: 0.55, mode: 2 }]] },
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
    {
      id: "dimebag-walk", group: 'Songs', title: "Dimebag Darrell · Walk", short: "Dimebag",
      summary: "A dry, scooped groove-metal bite: tight lows, a deep mid cut and a sharp top edge. A pedal approximation of the Walk rhythm sound.",
      source: {"kind": "chug", "tempo": 117, "noise": -60},
      play: "Use a bridge humbucker, palm-mute firmly and leave space between accents. Pinch harmonics and dive bombs need your picking and a vibrato bridge.",
      chain: [
        ["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}, "Keeps the gaps between heavy riffs quiet without a long release."],
        ["dist:heavy", {"gain": 36, "tone": 0.62, "level": -16, "weight": 100, "tight": 1, "bass": 0, "mid": 0, "treble": 0}, "High gain and a low cut keep palm mutes hard and defined."],
        ["eq:paraeq", {"bass": 3, "mid": -9, "midFreq": 750, "treble": 3, "presence": 1, "level": 0}, "A deep mid scoop leaves bass thump and cutting treble."],
      ],
      tip: "Use less bass if the low strings start to blur. The demo is a generic groove, not the Walk riff.",
      whatIfs: [
        { id: "comparison", label: "Restore the mids", note: "The same gain with the mids restored sounds fuller and less hollow.",
          chain: [["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}], ["dist:heavy", {"gain": 36, "tone": 0.62, "level": -16, "weight": 100, "tight": 1, "bass": 0, "mid": 0, "treble": 0}], ["eq:paraeq", {"bass": 3, "mid": 0, "midFreq": 750, "treble": 3, "presence": 1, "level": 0}]] },
      ],
    },
    {
      id: "iommi-iron-man", group: 'Songs', title: "Tony Iommi · Iron Man", short: "Iommi",
      summary: "Thick, dark early-metal crunch with a strong low middle and a softened top. A starting point for Iron Man-style riffs.",
      source: {"kind": "power", "tempo": 76, "noise": -60},
      play: "Play deliberate power chords and let the spaces breathe. Tune your guitar for the particular recording; this board does not retune the strings.",
      chain: [
        ["boost:spark", {"boost": 6, "bass": -4, "treble": 3, "voicing": 0, "level": 0}, "Trims bass and pushes the next stage for a treble-booster-like attack."],
        ["drive:ocd", {"drive": 24, "tone": 0.42, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Warm clipping supplies thick sustain and a grainy riff edge."],
        ["eq:paraeq", {"bass": 2, "mid": 4, "midFreq": 550, "treble": -3, "presence": -2, "level": 0}, "Low mids add weight while the darker top takes away fizz."],
      ],
      tip: "Keep the low end firm rather than adding maximum bass. The gain stages stand in for a driven amp.",
      whatIfs: [
        { id: "comparison", label: "No treble boost", note: "Without the bass-trimming boost, the drive is softer and less focused.",
          chain: [["drive:ocd", {"drive": 24, "tone": 0.42, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}], ["eq:paraeq", {"bass": 2, "mid": 4, "midFreq": 550, "treble": -3, "presence": -2, "level": 0}]] },
      ],
    },
    {
      id: "morello-killing", group: 'Songs', title: "Tom Morello · Killing in the Name", short: "Morello",
      summary: "A focused, punchy crunch for Killing in the Name-style riffs, with pronounced mids and very little ambience.",
      source: {"kind": "chug", "tempo": 89, "noise": -60},
      play: "Use drop D on a real guitar for the low riffs. Scratches and killswitch stutters are performance techniques; the demo plays a generic rhythm.",
      chain: [
        ["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}, "Keeps the gaps between heavy riffs quiet without a long release."],
        ["dist:rat", {"gain": 24, "tone": 0.58, "level": -14, "weight": 90}, "Moderate distortion keeps the riff percussive rather than overly saturated."],
        ["eq:paraeq", {"bass": -1, "mid": 4, "midFreq": 1100, "treble": 1, "presence": 0, "level": 0}, "Upper mids give the riff its forward, nasal bite."],
      ],
      tip: "For the solo, try the Whammy model of Octave at +24 semitones with the Treadle at the toe. It gives a fixed high pitch, not a foot-controlled Whammy sweep.",
      whatIfs: [
        { id: "comparison", label: "Scoop the riff", note: "Cutting the mids makes the riff hollow and less forward.",
          chain: [["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}], ["dist:rat", {"gain": 24, "tone": 0.58, "level": -14, "weight": 90}], ["eq:paraeq", {"bass": -1, "mid": -5, "midFreq": 1100, "treble": 1, "presence": 0, "level": 0}]] },
      ],
    },
    {
      id: "van-halen-eruption", group: 'Songs', title: "Eddie Van Halen · Eruption / Jump", short: "Van Halen",
      summary: "A warm, bright brown-sound approximation for guitar leads: saturated crunch, a gentle phaser and a short echo. This targets the guitar, not the Jump synthesizer.",
      source: {"kind": "lead", "tempo": 144, "noise": -60},
      play: "Use a bridge humbucker, tap cleanly and mute unused strings. Tapping, harmonics and vibrato-bar dives come from the player.",
      chain: [
        ["phaser:phase90", {"rate": 0.35, "depth": 0.35, "feedback": 0.12}, "A slow, shallow phase sweep adds movement before the gain."],
        ["drive:ocd", {"drive": 28, "tone": 0.62, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Strong asymmetric clipping approximates a cranked, warm rock amp."],
        ["eq:paraeq", {"bass": 0, "mid": 2, "midFreq": 800, "treble": -1, "presence": -2, "level": 0}, "A little middle and a softer top keep the gain rounded."],
        ["delay:multi", {"time": 120, "feedback": 0.22, "mix": 0.13, "character": 0.25, "type": 2}, "A quiet, short tape echo, like his Echoplex, gives the lead a little depth."],
      ],
      tip: "Keep the phaser subtle and reduce gain if tapped notes smear together.",
      whatIfs: [
        { id: "comparison", label: "No phase sweep", note: "The same gain and echo become more direct when the phaser is removed.",
          chain: [["drive:ocd", {"drive": 28, "tone": 0.62, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}], ["eq:paraeq", {"bass": 0, "mid": 2, "midFreq": 800, "treble": -1, "presence": -2, "level": 0}], ["delay:multi", {"time": 120, "feedback": 0.22, "mix": 0.13, "character": 0.25, "type": 2}]] },
      ],
    },
    {
      id: "santana-black-magic", group: 'Songs', title: "Carlos Santana · Black Magic Woman / Samba Pa Ti", short: "Santana",
      summary: "Rounded, vocal sustain with a strong middle and a soft halo of reverb, inspired by Santana’s singing Latin-blues leads.",
      source: {"kind": "lead", "tempo": 112, "noise": -60},
      play: "Use a neck humbucker, roll the guitar tone back a little and hold notes with slow, wide vibrato.",
      chain: [
        ["wah:crybaby", {"mode": 0, "position": 0.5}, "A wah parked about half open, as on Samba Pa Ti: a fixed, vocal peak in the middle of the sound."],
        ["drive:ts9", {"drive": 23, "tone": 0.38, "level": -7, "mix": 1, "voicing": 1}, "Stands in for his loud, cranked amp: a mid-focused drive gives the lead a smooth, vocal center."],
        ["eq:paraeq", {"bass": -1, "mid": 3, "midFreq": 750, "treble": -3, "presence": -2, "level": 0}, "Softens the pick edge and emphasizes the singing mids."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.16, "tone": 0.5, "mode": 0}, "A small room gives long notes a little air."],
      ],
      tip: "Santana gets sustain from a loud amp and his fingers, not a compressor. Move the parked wah a little to find the vocal sweet spot.",
      whatIfs: [
        { id: "no-wah", label: "No parked wah", note: "Without the parked wah the lead is flatter and less vocal: the singing peak in the middle disappears.",
          chain: [["drive:ts9", {"drive": 23, "tone": 0.38, "level": -7, "mix": 1, "voicing": 1}], ["eq:paraeq", {"bass": -1, "mid": 3, "midFreq": 750, "treble": -3, "presence": -2, "level": 0}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.16, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "knopfler-sultans", group: 'Songs', title: "Mark Knopfler · Sultans of Swing", short: "Knopfler",
      summary: "Clean, dry fingerstyle chime with a light squeeze and a lean low end, inspired by Sultans of Swing.",
      source: {"kind": "fingerstyle", "tempo": 148, "noise": -60},
      play: "Use the bridge-and-middle pickup position on a Strat-style guitar and pluck with bare fingers. Snap the strings lightly and leave room between phrases.",
      chain: [
        ["comp:keeley", {"threshold": -23, "ratio": 2, "attack": 25, "release": 120, "makeup": 2, "blend": 0.65}, "Light compression keeps the finger attack while evening out quiet notes."],
        ["eq:paraeq", {"bass": -3, "mid": 2, "midFreq": 1800, "treble": 2, "presence": 0, "level": 0}, "Lean bass and an upper-mid lift bring out the percussive chime."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.08, "tone": 0.5, "mode": 0}, "A trace of room keeps the clean notes close and dry."],
      ],
      tip: "The hollow pickup character comes mainly from your guitar; EQ cannot recreate pickup cancellation exactly.",
      whatIfs: [
        { id: "comparison", label: "Uncompressed fingers", note: "Without compression, each pluck stands out more and quiet notes fade sooner.",
          chain: [["eq:paraeq", {"bass": -3, "mid": 2, "midFreq": 1800, "treble": 2, "presence": 0, "level": 0}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.08, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "acdc-back-in-black", group: 'Songs', title: "Angus & Malcolm Young · Back in Black", short: "AC/DC",
      summary: "Open, dry rock crunch with a firm middle and clear chord attacks. A shared starting point for Malcolm’s rhythm and Angus’s leads.",
      source: {"kind": "power", "tempo": 94, "noise": -60},
      play: "Use a bridge humbucker and strike short, confident chords. Control the gaps with both hands and raise guitar volume for leads.",
      chain: [
        ["drive:ocd", {"drive": 14, "tone": 0.62, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Moderate drive leaves space between the notes of each chord."],
        ["eq:paraeq", {"bass": -2, "mid": 3, "midFreq": 900, "treble": 1, "presence": 0, "level": 0}, "A lean bottom and strong middle make the crunch punchy."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.06, "tone": 0.5, "mode": 0}, "Only a hint of room, so the stops stay immediate."],
      ],
      tip: "Keep the gain lower than a modern metal tone. Pick attack supplies much of the aggression.",
      whatIfs: [
        { id: "comparison", label: "More saturated crunch", note: "Extra gain adds sustain but blurs some of the chord separation and punch.",
          chain: [["drive:ocd", {"drive": 27, "tone": 0.62, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}], ["eq:paraeq", {"bass": -2, "mid": 3, "midFreq": 900, "treble": 1, "presence": 0, "level": 0}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.06, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "slash-sweet-child", group: 'Songs', title: "Slash · Sweet Child O’ Mine", short: "Slash",
      summary: "A rounded, singing rock lead with upper-mid bite, long sustain and a restrained echo, inspired by Sweet Child O’ Mine.",
      source: {"kind": "lead", "tempo": 125, "noise": -60},
      play: "Start on a neck humbucker for the opening melody; use the bridge for a sharper solo. Play connected phrases and wide bends.",
      chain: [
        ["drive:ocd", {"drive": 25, "tone": 0.5, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Saturated drive stands in for a loud rock amp and carries bent notes."],
        ["eq:paraeq", {"bass": -1, "mid": 4, "midFreq": 1000, "treble": -1, "presence": -1, "level": 0}, "A broad mid lift keeps the lead vocal without a sharp top."],
        ["delay:dd3", {"time": 318, "feedback": 0.3, "mix": 0.15}, "A low echo fills the pauses without covering the melody."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.1, "tone": 0.5, "mode": 2}, "A plate reverb, as on the record, rounds off the lead tail."],
      ],
      tip: "Use the guitar tone control to soften the opening melody before changing pedal gain.",
      whatIfs: [
        { id: "comparison", label: "Dry lead", note: "Removing the echo brings the lead closer and exposes the gaps between phrases.",
          chain: [["drive:ocd", {"drive": 25, "tone": 0.5, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}], ["eq:paraeq", {"bass": -1, "mid": 4, "midFreq": 1000, "treble": -1, "presence": -1, "level": 0}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.1, "tone": 0.5, "mode": 2}]] },
      ],
    },
    {
      id: "bb-king-thrill", group: 'Songs', title: "B.B. King · The Thrill Is Gone", short: "B.B. King",
      summary: "A clear, warm blues lead with just a little breakup and a restrained room. The space between notes is part of the sound.",
      source: {"kind": "lead", "tempo": 90, "noise": -60},
      play: "Use a neck pickup, play short single-note phrases and answer them with silence. Add quick, light butterfly vibrato by hand.",
      chain: [
        ["drive:klon", {"drive": 5, "tone": 0.7, "mix": 0.35, "level": -3, "voicing": 0}, "A little blended drive adds edge to harder picks while leaving the clean note."],
        ["eq:paraeq", {"bass": -2, "mid": 2, "midFreq": 1100, "treble": -1, "presence": 0, "level": 0}, "A modest middle lift brings the single-note voice forward."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.13, "tone": 0.5, "mode": 0}, "A little room supports the silences without a long wash."],
      ],
      tip: "Leave compression off to keep the difference between soft replies and accented notes.",
      whatIfs: [
        { id: "comparison", label: "Push into heavy breakup", note: "More drive sustains the notes but takes away some of the clean touch and space.",
          chain: [["drive:klon", {"drive": 20, "tone": 0.7, "mix": 1, "level": -3, "voicing": 0}], ["eq:paraeq", {"bass": -2, "mid": 2, "midFreq": 1100, "treble": -1, "presence": 0, "level": 0}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.13, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "zakk-no-more-tears", group: 'Songs', title: "Zakk Wylde · No More Tears", short: "Zakk Wylde",
      summary: "A tight, aggressive high-gain lead and rhythm sound with forward mids and chorus width.",
      source: {"kind": "chug", "tempo": 103, "noise": -60},
      play: "Use a bridge humbucker and a firm palm mute. Pinch harmonics need the pick and thumb to brush the string together; gain only helps them ring.",
      chain: [
        ["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}, "Keeps the gaps between heavy riffs quiet without a long release."],
        ["drive:ts9", {"drive": 13, "tone": 0.5, "level": -1, "mix": 1, "voicing": 1}, "Stands in for his Boss SD-1 with Drive and Level around 6.5: a mid boost that tightens the distortion."],
        ["chorus:ce2w", {"rate": 1.2, "depth": 0.5, "mix": 0.35}, "Stands in for his Boss CH-1 chorus, which sat before the amps: a wide, moving edge under the gain."],
        ["dist:heavy", {"gain": 30, "tone": 0.57, "level": -16, "weight": 110, "tight": 1, "bass": 0, "mid": 3, "treble": 0, "midFreq": 900}, "Tight high gain keeps the attack hard and gives harmonics sustain."],
      ],
      tip: "Try long bends and wide vibrato on leads; avoid adding so much gain that every mute turns noisy.",
      whatIfs: [
        { id: "comparison", label: "No tightening overdrive", note: "Without the input boost, the distortion feels looser and less mid-focused.",
          chain: [["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}], ["chorus:ce2w", {"rate": 1.2, "depth": 0.5, "mix": 0.35}], ["dist:heavy", {"gain": 30, "tone": 0.57, "level": -16, "weight": 110, "tight": 1, "bass": 0, "mid": 3, "treble": 0, "midFreq": 900}]] },
      ],
    },
    {
      id: "rhoads-crazy-train", group: 'Songs', title: "Randy Rhoads · Crazy Train", short: "Randy Rhoads",
      summary: "Bright, mid-forward metal crunch with a lean bottom and a short doubling echo, inspired by Crazy Train-era guitar.",
      source: {"kind": "power", "tempo": 138, "noise": -60},
      play: "Alternate-pick the low notes cleanly and separate chord accents. Use precise single-note runs for the neoclassical lead feel.",
      chain: [
        ["dist:rat", {"gain": 22, "tone": 0.8, "level": -14}, "Stands in for his MXR Distortion+ with Output up and Distortion around 4: a bright, simple distortion with no tone control."],
        ["eq:ge7", {"g200": 6, "g400": 9, "g800": 6, "level": -4}, "A graphic EQ after the distortion, like his MXR 10-band, boosts the mids around 250 Hz–1 kHz for a thick, vocal bite."],
        ["delay:dd3", {"time": 60, "feedback": 0.22, "mix": 0.16, "character": 0.25}, "A very short echo approximates a doubled guitar without adding a harmony."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.1, "tone": 0.5, "mode": 0}, "A short room adds a little recorded-space feel."],
      ],
      tip: "The echo suggests double-tracking; it cannot reproduce two separately played takes.",
      whatIfs: [
        { id: "comparison", label: "No mid-boost EQ", note: "Without the graphic EQ after the distortion, the tone is thinner and less vocal.",
          chain: [["dist:rat", {"gain": 22, "tone": 0.8, "level": -14}], ["delay:dd3", {"time": 60, "feedback": 0.22, "mix": 0.16, "character": 0.25}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.1, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "gibbons-la-grange", group: 'Songs', title: "Billy Gibbons · La Grange", short: "Billy Gibbons",
      summary: "A dry, woody Texas-blues crunch with warm clipping and a bark in the middle, inspired by La Grange.",
      source: {"kind": "shuffle", "tempo": 162, "noise": -60},
      play: "Gibbons recorded it on a Stratocaster into a Marshall. Use a light touch for the boogie and harder accents for bite. Add pinch harmonics with your pick and thumb.",
      chain: [
        ["drive:ocd", {"drive": 17, "tone": 0.43, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Warm asymmetric clipping keeps the boogie gritty and touch-sensitive."],
        ["eq:paraeq", {"bass": 1, "mid": 3, "midFreq": 650, "treble": -2, "presence": -1, "level": 0}, "Low-middle warmth gives the small riff a thick, woody center."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.07, "tone": 0.5, "mode": 0}, "A trace of room keeps the groove dry and close."],
      ],
      tip: "Roll the guitar volume back for the quieter boogie, then open it up for the louder phrases.",
      whatIfs: [
        { id: "comparison", label: "Symmetrical clipping", note: "Changing the clipping symmetry changes the grain of the same warm overdrive.",
          chain: [["drive:ocd", {"drive": 17, "tone": 0.43, "mix": 1, "level": -6, "voicing": 0, "clipping": 0}], ["eq:paraeq", {"bass": 1, "mid": 3, "midFreq": 650, "treble": -2, "presence": -1, "level": 0}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.07, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "jones-schism", group: 'Songs', title: "Adam Jones · Schism", short: "Adam Jones",
      summary: "A dense, mid-rich progressive-metal crunch with tight low strings and a quiet echo behind the riff.",
      source: {"kind": "chug", "tempo": 107, "noise": -60},
      play: "Use drop D on a real guitar and accent uneven groups deliberately. The demo uses a regular chug pattern, not Schism’s changing meters or bass intro.",
      chain: [
        ["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}, "Keeps the gaps between heavy riffs quiet without a long release."],
        ["dist:heavy", {"gain": 29, "tone": 0.48, "level": -16, "weight": 100, "tight": 1, "bass": 0, "mid": 4, "treble": 0, "midFreq": 800}, "Firm low-cut distortion leaves room for rhythmic accents and strong mids."],
        ["eq:paraeq", {"bass": 2, "mid": 2, "midFreq": 600, "treble": -2, "presence": -2, "level": 0}, "Dense low mids and softened highs keep the riff heavy without a deep scoop."],
        ["delay:dd3", {"time": 380, "feedback": 0.28, "mix": 0.12}, "A quiet Boss digital delay adds a little space without hiding the main pulse."],
      ],
      tip: "Lower the delay mix for hard stops; raise it for sparse, eerie passages.",
      whatIfs: [
        { id: "comparison", label: "Scoop the distortion mids", note: "A deep mid cut hollows out the dense center even though the gain stays the same.",
          chain: [["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}], ["dist:heavy", {"gain": 29, "tone": 0.48, "level": -16, "weight": 100, "tight": 1, "bass": 0, "mid": -6, "treble": 0, "midFreq": 800}], ["eq:paraeq", {"bass": 2, "mid": 2, "midFreq": 600, "treble": -2, "presence": -2, "level": 0}], ["delay:dd3", {"time": 380, "feedback": 0.28, "mix": 0.12}]] },
      ],
    },
    {
      id: "white-seven-nation", group: 'Songs', title: "Jack White · Seven Nation Army", short: "Jack White",
      summary: "An octave-down single-note riff voice with a thick fuzz edge, combining the low hook and raw lead attitude of Seven Nation Army.",
      source: {"kind": "lead", "tempo": 124, "noise": -60},
      play: "Play single notes with firm muting. For the cleaner low hook, reduce the fuzz or bypass it; bring it back for the raw lead sections.",
      chain: [
        ["octave:whammy", {"interval": -12, "treadle": 1, "shift": 1, "dry": 0, "sub": 0, "up": 0, "sub2": 0}, "Shifts the whole note one octave down, with no original pitch mixed in."],
        ["fuzz:bigmuff", {"fuzz": 29, "tone": 0.48, "level": -15, "compress": 0.15}, "A thick fuzz gives the low riff a ragged, sustained edge."],
        ["eq:paraeq", {"bass": 1, "mid": 2, "midFreq": 900, "treble": -2, "presence": -2, "level": 0}, "Keeps the fuzz thick while taming the scratchy top."],
      ],
      tip: "The fixed octave shift is a pedal approximation. Single notes track more clearly than chords.",
      whatIfs: [
        { id: "comparison", label: "Clean octave-down hook", note: "Removing fuzz leaves the low octave voice clearer and closer to the sparse hook texture.",
          chain: [["octave:whammy", {"interval": -12, "treadle": 1, "shift": 1, "dry": 0, "sub": 0, "up": 0, "sub2": 0}], ["eq:paraeq", {"bass": 1, "mid": 2, "midFreq": 900, "treble": -2, "presence": -2, "level": 0}]] },
      ],
    },
    {
      id: "eagles-hotel-california", group: 'Songs', title: "Eagles · Hotel California", short: "Hotel California",
      summary: "Warm, lightly driven leads with a second voice a third above, inspired by the twin-guitar outro of Hotel California.",
      source: {"kind": "lead", "tempo": 74, "noise": -60},
      play: "Play a melody in B minor with clear single notes. On the record two guitarists (Don Felder and Joe Walsh) play the harmony together.",
      chain: [
        ["drive:ts9", {"drive": 10, "tone": 0.55, "level": -4, "mix": 1, "voicing": 1}, "Stands in for the small, cranked amps the leads were recorded through: warm breakup rather than heavy gain."],
        ["harm:ps6", {"mode": 2, "key": 11, "mix": 0.5, "steps1": 2, "steps2": 0}, "Stands in for the second guitar: a third above each note, kept inside B minor."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.14, "tone": 0.5, "mode": 0}, "A small room keeps the two voices close together."],
      ],
      tip: "The harmonizer only approximates two players. Slow, clear phrases track best.",
      whatIfs: [
        { id: "one-guitar", label: "One guitar", note: "Without the harmony you hear a single lead line: the outro loses its twin-guitar lift.",
          chain: [["drive:ts9", {"drive": 10, "tone": 0.55, "level": -4, "mix": 1, "voicing": 1}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.14, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "gnr-november-rain", group: 'Songs', title: "Guns N’ Roses · November Rain", short: "November Rain",
      summary: "A soaring, saturated lead with a dotted-eighth echo and a big hall around the long notes.",
      source: {"kind": "lead", "tempo": 79, "noise": -60},
      play: "Use a neck humbucker for the slow melody and let bends overshoot slightly before settling, as Slash often does.",
      chain: [
        ["drive:ocd", {"drive": 22, "tone": 0.5, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Stands in for Slash’s Marshall: a saturated, singing lead from the amp."],
        ["delay:dd3", {"time": 570, "feedback": 0.35, "mix": 0.25}, "A Boss DD-3-style echo on a dotted eighth (570 ms at 79 BPM), with a few repeats behind the long notes."],
        ["reverb:bigsky", {"decay": 0.6, "predelay": 25, "mix": 0.25, "tone": 0.5, "mode": 1}, "A hall gives the ballad its wide, polished space."],
      ],
      tip: "Keep the echo under the melody; it should fill the gaps, not double every note.",
      whatIfs: [
        { id: "no-delay", label: "No delay", note: "Without the echo the lead is closer and drier, and the long notes feel more exposed.",
          chain: [["drive:ocd", {"drive": 22, "tone": 0.5, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}], ["reverb:bigsky", {"decay": 0.6, "predelay": 25, "mix": 0.25, "tone": 0.5, "mode": 1}]] },
      ],
    },
    {
      id: "queen-bohemian-rhapsody", group: 'Songs', title: "Queen · Bohemian Rhapsody", short: "Bohemian Rhapsody",
      summary: "Brian May’s vocal-like solo voice: a treble booster slamming a cranked Vox AC30, with a nasal, out-of-phase pickup sound.",
      source: {"kind": "lead", "tempo": 72, "noise": -60},
      play: "Play a slow, singing melody. May used the middle and neck pickups out of phase for this solo.",
      chain: [
        ["boost:spark", {"boost": 14, "bass": -8, "treble": 4, "voicing": 2, "level": -3}, "Stands in for a Rangemaster-style treble booster on full: it trims the bass and slams the amp."],
        ["drive:ocd", {"drive": 16, "tone": 0.55, "mix": 1, "level": -9, "voicing": 3, "clipping": 1}, "Stands in for a fully cranked Vox AC30: smooth, singing saturation."],
        ["eq:paraeq", {"bass": -3, "mid": 4, "midFreq": 1200, "midQ": 1.5, "treble": 0, "level": 0}, "Approximates the out-of-phase pickup sound: thinner lows and a nasal middle."],
      ],
      tip: "May has said the core tone is just the guitar, the treble booster and the AC30.",
      whatIfs: [
        { id: "no-booster", label: "No treble booster", note: "Without the booster the amp is pushed less: rounder, less vocal and with less sustain.",
          chain: [["drive:ocd", {"drive": 16, "tone": 0.55, "mix": 1, "level": -9, "voicing": 3, "clipping": 1}], ["eq:paraeq", {"bass": -3, "mid": 4, "midFreq": 1200, "midQ": 1.5, "treble": 0, "level": 0}]] },
      ],
    },
    {
      id: "zeppelin-stairway", group: 'Songs', title: "Led Zeppelin · Stairway to Heaven", short: "Stairway",
      summary: "A gritty, building blues-rock solo from a Telecaster into a small, cranked amp.",
      source: {"kind": "lead", "tempo": 98, "noise": -60},
      play: "Use a bridge single coil and dig in harder as the solo builds. Page played it on the 1959 Telecaster Jeff Beck gave him.",
      chain: [
        ["drive:ocd", {"drive": 15, "tone": 0.65, "mix": 1, "level": -6, "voicing": 2, "clipping": 1}, "Stands in for the small Supro amp most accounts name, turned up into a gritty, bright breakup."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.12, "tone": 0.5, "mode": 0}, "A short room, like the studio space on the record."],
      ],
      tip: "No pedal is needed: the grit comes from a small amp working hard.",
      whatIfs: [
        { id: "lighter-amp", label: "Amp turned down", note: "Less drive keeps the opening phrases cleaner, before the solo builds.",
          chain: [["drive:ocd", {"drive": 6, "tone": 0.65, "mix": 1, "level": -6, "voicing": 2, "clipping": 1}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.12, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "nirvana-teen-spirit", group: 'Songs', title: "Nirvana · Smells Like Teen Spirit", short: "Teen Spirit",
      summary: "Raw grunge distortion from a Boss DS-1 into a clean amp, with an Electro-Harmonix Small Clone for the solo’s warble.",
      source: {"kind": "power", "tempo": 117, "noise": -58},
      play: "Play loose power chords; the solo mostly follows the vocal melody note for note.",
      chain: [
        ["dist:ds1", {"gain": 30, "tone": 0.5, "level": -14}, "Boss DS-1 into a clean amp: the pedal supplies nearly all the distortion."],
        ["chorus:smallclone", {"rate": 1.1, "depth": 1, "mix": 0.5}, "Small Clone chorus, as Cobain used on the pre-chorus and the solo."],
      ],
      tip: "Turn the chorus off for the verses and choruses; switch it on for the solo.",
      whatIfs: [
        { id: "no-chorus", label: "No chorus", note: "The same distortion without the Small Clone: flatter and more direct, closer to the choruses.",
          chain: [["dist:ds1", {"gain": 30, "tone": 0.5, "level": -14}]] },
      ],
    },
    {
      id: "metallica-puppets", group: 'Songs', title: "Metallica · Master of Puppets", short: "Master of Puppets",
      summary: "Sharp, tight thrash gain: a Tube Screamer tightening a Mesa/Boogie Mark IIC+, with Kirk Hammett’s Cry Baby on the solos.",
      source: {"kind": "chug", "tempo": 212, "noise": -55},
      play: "Downpick tight palm mutes at full speed. The gain needs to stay tight, not loose.",
      chain: [
        ["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}, "Keeps the gaps between heavy riffs quiet without a long release."],
        ["drive:ts9", {"drive": 2, "tone": 0.5, "level": 4, "mix": 1, "voicing": 1, "clipping": 0}, "A Tube Screamer as a tight boost in front of the amp: low drive, high level, to tighten the gain."],
        ["dist:heavy", {"gain": 34, "tone": 0.55, "level": -16, "weight": 90, "tight": 1, "bass": 2, "mid": -4, "treble": 2, "midFreq": 750}, "Stands in for the Mesa/Boogie Mark IIC+: tight high gain with the mids pulled back."],
      ],
      tip: "For Hammett’s solos, try the wah what-if: he rocks a Cry Baby through most of them.",
      whatIfs: [
        { id: "solo-wah", label: "Wah on the solo", note: "A Cry Baby sweeping by itself stands in for Hammett’s foot on the solo.",
          chain: [["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}], ["drive:ts9", {"drive": 2, "tone": 0.5, "level": 4, "mix": 1, "voicing": 1, "clipping": 0}], ["dist:heavy", {"gain": 34, "tone": 0.55, "level": -16, "weight": 90, "tight": 1, "bass": 2, "mid": -4, "treble": 2, "midFreq": 750}], ["wah:crybaby", {"mode": 2, "speed": 1.2, "resonance": 5}]] },
        { id: "no-boost", label: "No Tube Screamer", note: "Without the boost the low end is looser and the palm mutes blur a little.",
          chain: [["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}], ["dist:heavy", {"gain": 34, "tone": 0.55, "level": -16, "weight": 90, "tight": 1, "bass": 2, "mid": -4, "treble": 2, "midFreq": 750}]] },
      ],
    },
    {
      id: "metallica-one", group: 'Songs', title: "Metallica · One", short: "One",
      summary: "A clean, chorused melody that builds into heavy distortion. The clean part comes from a Roland JC-120 with its built-in chorus.",
      source: {"kind": "arp-slow", "tempo": 108, "noise": -60},
      play: "Play the clean arpeggio with a light touch, then compare it with the heavy section in B.",
      chain: [
        ["chorus:ce2w", {"rate": 0.8, "depth": 0.5, "mix": 0.5}, "Stands in for the Roland JC-120’s built-in chorus, the clean amp Metallica used on One."],
        ["reverb:bigsky", {"decay": 0.4, "predelay": 15, "mix": 0.18, "tone": 0.5, "mode": 0}, "A little room around the clean notes."],
      ],
      tip: "The song is about the contrast: compare A (clean) with B (the heavy section).",
      whatIfs: [
        { id: "heavy", label: "Heavy section", note: "The Mesa/Boogie-style high gain of the second half, tightened by a Tube Screamer.",
          chain: [["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}], ["drive:ts9", {"drive": 2, "tone": 0.5, "level": 4, "mix": 1, "voicing": 1, "clipping": 0}], ["dist:heavy", {"gain": 34, "tone": 0.55, "level": -16, "weight": 90, "tight": 1, "bass": 2, "mid": -4, "treble": 2, "midFreq": 750}]] },
      ],
    },
    {
      id: "megadeth-tornado", group: 'Songs', title: "Megadeth · Tornado of Souls", short: "Tornado of Souls",
      summary: "Precise, cutting high gain for Marty Friedman’s solo: a tight boost into a hot amp, with a short echo.",
      source: {"kind": "lead", "tempo": 128, "noise": -55},
      play: "Play fast, exact phrases with clear vibrato. Friedman’s bends often slide between notes in unusual ways.",
      chain: [
        ["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}, "Keeps the gaps between heavy riffs quiet without a long release."],
        ["drive:ts9", {"drive": 2, "tone": 0.5, "level": 4, "mix": 1, "voicing": 1, "clipping": 0}, "A low-drive boost that tightens the amp and adds mid focus."],
        ["dist:heavy", {"gain": 36, "tone": 0.62, "level": -16, "weight": 100, "tight": 1, "bass": 0, "mid": 2, "treble": 1, "midFreq": 900}, "Stands in for the hot-rodded amps of the era: cutting gain with the mids kept in."],
        ["delay:dd3", {"time": 350, "feedback": 0.25, "mix": 0.14}, "A short, quiet echo gives the fast lines a little space."],
      ],
      tip: "Keep the echo low; fast phrases blur if the repeats get loud.",
      whatIfs: [
        { id: "no-boost", label: "No boost", note: "Without the boost the gain is looser and the attack less precise.",
          chain: [["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}], ["dist:heavy", {"gain": 36, "tone": 0.62, "level": -16, "weight": 100, "tight": 1, "bass": 0, "mid": 2, "treble": 1, "midFreq": 900}], ["delay:dd3", {"time": 350, "feedback": 0.25, "mix": 0.14}]] },
      ],
    },
    {
      id: "megadeth-holy-wars", group: 'Songs', title: "Megadeth · Holy Wars… The Punishment Due", short: "Holy Wars",
      summary: "Dry, articulate thrash: tight high gain, a firm low cut and no ambience, so every fast note stays distinct.",
      source: {"kind": "chug", "tempo": 160, "noise": -55},
      play: "Alternate-pick tight, precise riffs. Mute everything you are not playing.",
      chain: [
        ["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}, "Keeps the gaps between heavy riffs quiet without a long release."],
        ["dist:heavy", {"gain": 34, "tone": 0.6, "level": -16, "weight": 120, "tight": 1, "bass": 0, "mid": 1, "treble": 1, "midFreq": 800}, "Tight high gain with a strong low cut before the clipping, so fast riffs stay articulate."],
      ],
      tip: "No reverb or delay: the dryness is part of the sound.",
      whatIfs: [
        { id: "loose", label: "Full low end", note: "Without the low cut the same gain gets boomy and the fast notes run together.",
          chain: [["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}], ["dist:heavy", {"gain": 34, "tone": 0.6, "level": -16, "weight": 20, "tight": 0, "bass": 0, "mid": 1, "treble": 1, "midFreq": 800}]] },
      ],
    },
    {
      id: "moore-still-got-the-blues", group: 'Songs', title: "Gary Moore · Still Got the Blues", short: "Gary Moore",
      summary: "Thick, vocal blues sustain: a Les Paul into a Marshall Guv’nor and JTM45, with a subtle Roland Dimension widening.",
      source: {"kind": "lead", "tempo": 80, "noise": -60},
      play: "Use a neck humbucker, hold notes long and add slow, wide vibrato.",
      chain: [
        ["drive:ocd", {"drive": 22, "tone": 0.55, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Stands in for the Marshall Guv’nor, a JCM800-style drive, into a JTM45: thick, singing gain."],
        ["chorus:ce2w", {"rate": 0.5, "depth": 0.25, "mix": 0.3}, "Stands in for a Roland Dimension D: subtle widening, not an obvious wobble."],
        ["reverb:bigsky", {"decay": 0.55, "predelay": 25, "mix": 0.22, "tone": 0.5, "mode": 1}, "A hall lets the long notes bloom."],
      ],
      tip: "Let notes ring into feedback-like sustain, then release the bend slowly.",
      whatIfs: [
        { id: "no-dimension", label: "No Dimension chorus", note: "Without the widening the lead is narrower and more direct.",
          chain: [["drive:ocd", {"drive": 22, "tone": 0.55, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}], ["reverb:bigsky", {"decay": 0.55, "predelay": 25, "mix": 0.22, "tone": 0.5, "mode": 1}]] },
      ],
    },
    {
      id: "mj-beat-it", group: 'Songs', title: "Michael Jackson · Beat It", short: "Beat It",
      summary: "Eddie Van Halen’s punchy, high-gain tapping solo, with a short tape-style echo.",
      source: {"kind": "lead", "tempo": 139, "noise": -60},
      play: "Use a bridge humbucker; tap fast, clean triplets and mute the strings you are not using.",
      chain: [
        ["drive:ocd", {"drive": 28, "tone": 0.62, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Strong, bright saturation for a tapped solo. Accounts say he recorded it quickly through a borrowed amp."],
        ["delay:multi", {"time": 140, "feedback": 0.2, "mix": 0.12, "type": 2}, "A short tape-style echo, in the spirit of his Echoplex, gives the solo depth."],
      ],
      tip: "Steve Lukather played the main riff; this sound is for the solo.",
      whatIfs: [
        { id: "no-delay", label: "No delay", note: "Without the echo the tapping is drier and more exposed.",
          chain: [["drive:ocd", {"drive": 28, "tone": 0.62, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}]] },
      ],
    },
    {
      id: "funkadelic-maggot-brain", group: 'Songs', title: "Funkadelic · Maggot Brain", short: "Maggot Brain",
      summary: "Eddie Hazel’s raw, psychedelic fuzz through a parked wah, drenched in the dub-style echo added in the mix.",
      source: {"kind": "sustain", "tempo": 60, "noise": -58},
      play: "Play slow, aching bends and let every note hang. Leave long gaps for the echoes.",
      chain: [
        ["fuzz:fuzzface", {"fuzz": 30, "tone": 0.5, "level": -8, "type": 1}, "Stands in for the Maestro Fuzz-Tone often linked to Hazel: grainy, sputtering fuzz."],
        ["wah:crybaby", {"mode": 0, "position": 0.4}, "A Cry Baby parked or barely moved: the honking voice Hazel was known for."],
        ["delay:multi", {"time": 480, "feedback": 0.55, "mix": 0.4, "type": 2}, "Heavy, dub-style echo, which George Clinton added in the mixdown."],
        ["reverb:bigsky", {"decay": 0.75, "predelay": 25, "mix": 0.3, "tone": 0.5, "mode": 1}, "A long hall smears the echoes into a haze."],
      ],
      tip: "Most of the trippy echo came from the mix, not from Hazel’s pedals.",
      whatIfs: [
        { id: "dry", label: "Dry fuzz", note: "The fuzz and wah without the mix echo: raw and close, as Hazel played it in the room.",
          chain: [["fuzz:fuzzface", {"fuzz": 30, "tone": 0.5, "level": -8, "type": 1}], ["wah:crybaby", {"mode": 0, "position": 0.4}]] },
      ],
    },
    {
      id: "dale-misirlou", group: 'Songs', title: "Dick Dale · Misirlou", short: "Misirlou",
      summary: "Bright, loud surf guitar with heavy strings, fast tremolo picking and a splash of Fender spring reverb.",
      source: {"kind": "lead", "tempo": 170, "noise": -60},
      play: "Tremolo-pick single notes as fast and evenly as you can, sliding down the low strings.",
      chain: [
        ["eq:paraeq", {"bass": 2, "mid": 0, "treble": 3, "presence": 2, "level": -3}, "A bright, full clean, like heavy strings into a loud Fender Showman."],
        ["reverb:fender", {"dwell": 0.7, "mix": 0.35, "tone": 0.7}, "Fender spring reverb: the record is full of it, although Dale later said he didn’t use one yet."],
      ],
      tip: "Pick hard: the attack and the heavy strings are as important as the reverb.",
      whatIfs: [
        { id: "dry", label: "No reverb", note: "Dale claimed the session was dry. Without the spring the picking is sharper and more percussive.",
          chain: [["eq:paraeq", {"bass": 2, "mid": 0, "treble": 3, "presence": 2, "level": -3}]] },
      ],
    },
    {
      id: "skynyrd-free-bird", group: 'Songs', title: "Lynyrd Skynyrd · Free Bird", short: "Free Bird",
      summary: "A southern-rock lead straight into a loud amp, with very few effects and rising intensity.",
      source: {"kind": "lead", "tempo": 150, "noise": -60},
      play: "Use a bridge pickup and repeat fast bends and runs, building the energy phrase by phrase.",
      chain: [
        ["drive:ocd", {"drive": 18, "tone": 0.6, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Stands in for a loud amp: Allen Collins played the studio solo with very little in between."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.1, "tone": 0.5, "mode": 0}, "A short room keeps the lead immediate."],
      ],
      tip: "Let the energy come from your picking; the gain stays moderate.",
      whatIfs: [
        { id: "more-gain", label: "More gain", note: "More gain adds sustain but blurs the fast, repeated bends.",
          chain: [["drive:ocd", {"drive": 28, "tone": 0.6, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.1, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "hendrix-watchtower", group: 'Songs', title: "The Jimi Hendrix Experience · All Along the Watchtower", short: "Watchtower",
      summary: "Saturated fuzz shaped by a wah, with the echo-drenched feel of the slide section of the solo.",
      source: {"kind": "lead", "tempo": 113, "noise": -60},
      play: "The record is tuned down a half step. Rock the wah through each phrase and let notes ring into the echo.",
      chain: [
        ["wah:crybaby", {"mode": 2, "speed": 1.2, "resonance": 5}, "A Vox-style wah, sweeping by itself here in place of Hendrix’s foot. It goes before the fuzz, as in his rig."],
        ["fuzz:fuzzface", {"fuzz": 26, "tone": 0.55, "level": -8, "type": 1}, "Fuzz Face for the saturated, sustaining lead."],
        ["delay:multi", {"time": 300, "feedback": 0.3, "mix": 0.28, "type": 2}, "A tape-style echo stands in for the echo on the slide section."],
      ],
      tip: "The solo moves through sections: plain lead, slide with echo, then wah. Change one pedal at a time.",
      whatIfs: [
        { id: "held-wah", label: "Wah held still", note: "A parked wah gives one fixed, nasal voice instead of the moving sweep.",
          chain: [["wah:crybaby", {"mode": 0, "position": 0.6, "resonance": 5}], ["fuzz:fuzzface", {"fuzz": 26, "tone": 0.55, "level": -8, "type": 1}], ["delay:multi", {"time": 300, "feedback": 0.3, "mix": 0.28, "type": 2}]] },
      ],
    },
    {
      id: "hendrix-little-wing", group: 'Songs', title: "The Jimi Hendrix Experience · Little Wing", short: "Little Wing",
      summary: "Warm, glassy, lightly driven guitar with a swirling pulse from a Leslie rotating speaker.",
      source: {"kind": "arp-slow", "tempo": 70, "noise": -60},
      play: "Mix chords and melody with your thumb over the neck, and play softly so the Leslie swirl stays clear.",
      chain: [
        ["drive:klon", {"drive": 6, "tone": 0.8, "level": -2, "mix": 0.5}, "Light breakup, like an amp turned up just enough to round off the attack."],
        ["phaser:univibe", {"mode": 1, "rate": 1.5, "depth": 0.6, "level": 0}, "Stands in for the homemade Leslie speaker engineer Eddie Kramer used on the lead: a swirling, glassy pulse."],
        ["reverb:bigsky", {"decay": 0.4, "predelay": 15, "mix": 0.15, "tone": 0.5, "mode": 0}, "A little room around the gentle chords."],
      ],
      tip: "A Uni-Vibe was designed to imitate a Leslie, so it is the closest pedal here.",
      whatIfs: [
        { id: "no-leslie", label: "No Leslie", note: "Without the rotating speaker the chords stand still and lose their glassy shimmer.",
          chain: [["drive:klon", {"drive": 6, "tone": 0.8, "level": -2, "mix": 0.5}], ["reverb:bigsky", {"decay": 0.4, "predelay": 15, "mix": 0.15, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "beatles-gently-weeps", group: 'Songs', title: "The Beatles · While My Guitar Gently Weeps", short: "Gently Weeps",
      summary: "Eric Clapton’s smooth, lyrical lead on George Harrison’s Les Paul, with the wobble of heavy artificial double tracking.",
      source: {"kind": "lead", "tempo": 116, "noise": -60},
      play: "Play smooth, singing phrases with finger vibrato. The extra wobble on the record came from tape processing.",
      chain: [
        ["drive:ts9", {"drive": 9, "tone": 0.5, "level": -3, "mix": 1, "voicing": 1}, "Smooth, light overdrive under the lead."],
        ["chorus:ce2w", {"rate": 0.9, "depth": 0.6, "mix": 0.5}, "Stands in for the heavy artificial double tracking (ADT) applied to the solo: a second, wobbling copy of the guitar."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.14, "tone": 0.5, "mode": 0}, "A small room, like the studio around the lead."],
      ],
      tip: "ADT was a tape trick at Abbey Road; a chorus is the closest pedal.",
      whatIfs: [
        { id: "no-adt", label: "No ADT", note: "Without the double tracking the lead is steadier and plainer, without its peculiar wobble.",
          chain: [["drive:ts9", {"drive": 9, "tone": 0.5, "level": -3, "mix": 1, "voicing": 1}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.14, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "dominos-layla", group: 'Songs', title: "Derek and the Dominos · Layla", short: "Layla",
      summary: "Raw, vocal blues-rock from a tiny tweed Fender Champ turned all the way up.",
      source: {"kind": "lead", "tempo": 116, "noise": -60},
      play: "Play the riff hard and let the small amp compress it. Duane Allman’s slide adds the high, crying lines.",
      chain: [
        ["drive:ocd", {"drive": 20, "tone": 0.55, "mix": 1, "level": -6, "voicing": 3, "clipping": 1}, "Stands in for a 5-watt tweed Fender Champ turned all the way up: raw, compressed breakup."],
        ["eq:paraeq", {"bass": -4, "mid": 2, "midFreq": 900, "treble": 0, "level": 0}, "A small 8-inch speaker has little low end; this EQ trims the bass the way the Champ does."],
      ],
      tip: "A small amp at full volume sounds bigger on record than a big amp turned down.",
      whatIfs: [
        { id: "big-amp", label: "Bigger amp", note: "With the full low end of a bigger speaker, the riff gets heavier but less raw.",
          chain: [["drive:ocd", {"drive": 20, "tone": 0.55, "mix": 1, "level": -6, "voicing": 3, "clipping": 1}]] },
      ],
    },
    {
      id: "berry-johnny-b-goode", group: 'Songs', title: "Chuck Berry · Johnny B. Goode", short: "Johnny B. Goode",
      summary: "Bright, snappy rock ’n’ roll double-stops from a hollow-body Gibson pushing its amp into light distortion.",
      source: {"kind": "lead", "tempo": 168, "noise": -60},
      play: "Play double-stops on the top two strings and bend the lower one. Keep the rhythm driving and loose.",
      chain: [
        ["drive:klon", {"drive": 8, "tone": 0.8, "level": -2, "mix": 0.5}, "His Gibson ES-350T pushing the amp into light distortion: just enough edge for the double-stops."],
        ["reverb:bigsky", {"decay": 0.35, "predelay": 15, "mix": 0.15, "tone": 0.5, "mode": 0}, "A touch of room, like the Chess studio sound."],
      ],
      tip: "The snap comes from the pick attack; keep the drive light.",
      whatIfs: [
        { id: "clean", label: "Clean amp", note: "With the amp clean, the double-stops are rounder and lose their bite.",
          chain: [["reverb:bigsky", {"decay": 0.35, "predelay": 15, "mix": 0.15, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "cream-crossroads", group: 'Songs', title: "Cream · Crossroads", short: "Crossroads",
      summary: "Eric Clapton’s live Cream lead: a humbucker guitar into 100-watt Marshall stacks run full up.",
      source: {"kind": "lead", "tempo": 126, "noise": -60},
      play: "Play fast blues phrases and shape the tone from the guitar’s knobs, as Clapton did with the amp flat out.",
      chain: [
        ["drive:ocd", {"drive": 24, "tone": 0.5, "mix": 1, "level": -6, "voicing": 3, "clipping": 1}, "Stands in for 100-watt Marshall stacks turned all the way up: thick, compressed drive."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.12, "tone": 0.5, "mode": 0}, "A live room around the band."],
      ],
      tip: "Clapton set the amp full on and adjusted volume and tone on the guitar.",
      whatIfs: [
        { id: "tone-rolled", label: "Tone knob rolled back", note: "Rolling the guitar’s tone back darkens the same drive into a rounder, fuzzier lead.",
          chain: [["drive:ocd", {"drive": 24, "tone": 0.5, "mix": 1, "level": -6, "voicing": 3, "clipping": 1}], ["eq:paraeq", {"treble": -8, "presence": -6, "level": 0}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.12, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "srv-texas-flood", group: 'Songs', title: "Stevie Ray Vaughan · Texas Flood", short: "Texas Flood",
      summary: "A thick, dynamic slow blues: a Tube Screamer as a boost into a cranked Fender Vibroverb, with its spring reverb.",
      source: {"kind": "lead", "tempo": 60, "noise": -60},
      play: "Play slow, hard-hit phrases and leave space. Soft notes should stay clean and hard ones should bite.",
      chain: [
        ["drive:ts9", {"drive": 3, "tone": 0.6, "level": 6, "mix": 1, "voicing": 1, "clipping": 0}, "Drive almost off and Level all the way up: Vaughan used the Tube Screamer mostly as a mid-heavy boost that hits the amp harder."],
        ["drive:ocd", {"drive": 12, "tone": 0.55, "mix": 1, "level": -6, "voicing": 3, "clipping": 1}, "Stands in for his cranked Fender Vibroverb: most of the grit comes from the amp, not the pedal."],
        ["reverb:fender", {"dwell": 0.4, "mix": 0.2, "tone": 0.6}, "The Vibroverb’s own spring reverb."],
      ],
      tip: "The dynamics are the sound: let your picking decide how dirty each note gets.",
      whatIfs: [
        { id: "no-reverb", label: "No reverb", note: "Without the spring the slow blues is drier and closer.",
          chain: [["drive:ts9", {"drive": 3, "tone": 0.6, "level": 6, "mix": 1, "voicing": 1, "clipping": 0}], ["drive:ocd", {"drive": 12, "tone": 0.55, "mix": 1, "level": -6, "voicing": 3, "clipping": 1}]] },
      ],
    },
    {
      id: "srv-pride-and-joy", group: 'Songs', title: "Stevie Ray Vaughan · Pride and Joy", short: "Pride and Joy",
      summary: "A crisp, percussive shuffle: the amp just breaking up, with the Tube Screamer only adding a little push.",
      source: {"kind": "shuffle", "tempo": 119, "noise": -60},
      play: "Rake across muted strings before accents and keep the shuffle bouncing. Heavy strings help the snap.",
      chain: [
        ["drive:ts9", {"drive": 2, "tone": 0.6, "level": 3, "mix": 1, "voicing": 1, "clipping": 0}, "A Tube Screamer with Drive off and Level up a little: a gentle push for the rhythm."],
        ["drive:ocd", {"drive": 8, "tone": 0.6, "mix": 1, "level": -6, "voicing": 3, "clipping": 1}, "Stands in for the Vibroverb at the edge of breakup, so the shuffle stays crisp."],
        ["reverb:fender", {"dwell": 0.4, "mix": 0.2, "tone": 0.6}, "The Vibroverb’s own spring reverb."],
      ],
      tip: "Rhythm needs less gain than the solos; push the Tube Screamer level for the lead breaks.",
      whatIfs: [
        { id: "solo-push", label: "Solo push", note: "Level all the way up on the Tube Screamer: more grit and sustain for the solo breaks.",
          chain: [["drive:ts9", {"drive": 3, "tone": 0.6, "level": 6, "mix": 1, "voicing": 1, "clipping": 0}], ["drive:ocd", {"drive": 8, "tone": 0.6, "mix": 1, "level": -6, "voicing": 3, "clipping": 1}], ["reverb:fender", {"dwell": 0.4, "mix": 0.2, "tone": 0.6}]] },
      ],
    },
    {
      id: "johnson-cliffs-of-dover", group: 'Songs', title: "Eric Johnson · Cliffs of Dover", short: "Cliffs of Dover",
      summary: "A polished, bell-like lead: a Fuzz Face into a Marshall Plexi with an Echoplex-style echo and long sustain.",
      source: {"kind": "lead", "tempo": 132, "noise": -60},
      play: "Play fast, even pentatonic runs and let held notes bloom. Roll the guitar volume back slightly to smooth the fuzz.",
      chain: [
        ["fuzz:fuzzface", {"fuzz": 18, "tone": 0.6, "level": -10, "type": 1}, "A Fuzz Face at moderate gain, the singing core of Johnson’s lead tone."],
        ["drive:ocd", {"drive": 10, "tone": 0.6, "mix": 1, "level": -6, "voicing": 3, "clipping": 1}, "Stands in for the Marshall Plexi he used for leads."],
        ["delay:multi", {"time": 380, "feedback": 0.2, "mix": 0.15, "type": 2}, "A soft tape-style echo, in the spirit of his Echoplex."],
        ["reverb:bigsky", {"decay": 0.5, "predelay": 25, "mix": 0.18, "tone": 0.5, "mode": 1}, "A hall adds the polished, bell-like bloom."],
      ],
      tip: "Johnson is famously particular about every link; small gain changes matter.",
      whatIfs: [
        { id: "no-fuzz", label: "No Fuzz Face", note: "The amp alone is cleaner and less vocal: the bell-like sustain fades sooner.",
          chain: [["drive:ocd", {"drive": 10, "tone": 0.6, "mix": 1, "level": -6, "voicing": 3, "clipping": 1}], ["delay:multi", {"time": 380, "feedback": 0.2, "mix": 0.15, "type": 2}], ["reverb:bigsky", {"decay": 0.5, "predelay": 25, "mix": 0.18, "tone": 0.5, "mode": 1}]] },
      ],
    },
    {
      id: "santana-europa", group: 'Songs', title: "Santana · Europa", short: "Europa",
      summary: "A smooth, rounded lead with long, singing sustain from a cranked Mesa/Boogie Mark I.",
      source: {"kind": "sustain", "tempo": 60, "noise": -60},
      play: "Hold long notes and let them grow; use slow vibrato and a soft attack.",
      chain: [
        ["drive:ts9", {"drive": 20, "tone": 0.42, "level": -6, "mix": 1, "voicing": 1}, "Stands in for a cranked Mesa/Boogie Mark I: harmonically rich sustain rather than heavy distortion."],
        ["eq:paraeq", {"bass": -1, "mid": 3, "midFreq": 700, "treble": -2, "presence": -2, "level": 0}, "A warm middle and a softened top."],
        ["delay:dd3", {"time": 450, "feedback": 0.3, "mix": 0.16}, "A soft echo behind the long notes."],
        ["reverb:bigsky", {"decay": 0.6, "predelay": 25, "mix": 0.22, "tone": 0.5, "mode": 1}, "A hall gives the melody air."],
      ],
      tip: "Santana gets sustain from a loud amp and his fingers, not a compressor.",
      whatIfs: [
        { id: "less-gain", label: "Less gain", note: "With less drive the notes fade sooner and the lead loses its singing quality.",
          chain: [["drive:ts9", {"drive": 8, "tone": 0.42, "level": -6, "mix": 1, "voicing": 1}], ["eq:paraeq", {"bass": -1, "mid": 3, "midFreq": 700, "treble": -2, "presence": -2, "level": 0}], ["delay:dd3", {"time": 450, "feedback": 0.3, "mix": 0.16}], ["reverb:bigsky", {"decay": 0.6, "predelay": 25, "mix": 0.22, "tone": 0.5, "mode": 1}]] },
      ],
    },
    {
      id: "idol-rebel-yell", group: 'Songs', title: "Billy Idol · Rebel Yell", short: "Rebel Yell",
      summary: "Steve Stevens’ bright, cutting ’80s rock tone, thickened by the subtle harmonizer he kept on most tracks.",
      source: {"kind": "lead", "tempo": 168, "noise": -60},
      play: "Play bright, aggressive phrases with a hard pick attack.",
      chain: [
        ["drive:ocd", {"drive": 22, "tone": 0.68, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "A bright, saturated amp-style drive."],
        ["octave:whammy", {"interval": 0, "detune": 9, "treadle": 1, "shift": 0.4, "dry": 1, "sub": 0, "up": 0, "sub2": 0}, "Stands in for his harmonizer: a slightly detuned copy that thickens the guitar without sounding like an effect."],
        ["delay:dd3", {"time": 250, "feedback": 0.2, "mix": 0.14}, "A short echo for width."],
      ],
      tip: "The solo’s ray-gun noises came from toy ray guns held up to the pickups.",
      whatIfs: [
        { id: "no-harmonizer", label: "No harmonizer", note: "Without the detuned copy the guitar is thinner and more ordinary.",
          chain: [["drive:ocd", {"drive": 22, "tone": 0.68, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}], ["delay:dd3", {"time": 250, "feedback": 0.2, "mix": 0.14}]] },
      ],
    },
    {
      id: "europe-final-countdown", group: 'Songs', title: "Europe · The Final Countdown", short: "Final Countdown",
      summary: "A glossy, melodic arena-rock lead: a JCM800-style drive with chorus and an echo in the amp’s effects loop.",
      source: {"kind": "lead", "tempo": 118, "noise": -60},
      play: "Play a clear, singable melody with wide vibrato on the held notes.",
      chain: [
        ["drive:ocd", {"drive": 24, "tone": 0.62, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Stands in for John Norum’s Marshall JCM800."],
        ["chorus:ce2w", {"rate": 0.7, "depth": 0.3, "mix": 0.3}, "A light chorus for ’80s gloss."],
        ["delay:dd3", {"time": 380, "feedback": 0.3, "mix": 0.2}, "An echo after the drive, like a delay in the amp’s effects loop."],
        ["reverb:bigsky", {"decay": 0.55, "predelay": 25, "mix": 0.2, "tone": 0.5, "mode": 1}, "A hall for the arena-sized space."],
      ],
      tip: "Norum has said he improvised the solo; keep the effects polished, not loud.",
      whatIfs: [
        { id: "dry", label: "No chorus or delay", note: "The same drive without the gloss: rawer and more like a club band.",
          chain: [["drive:ocd", {"drive": 24, "tone": 0.62, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}], ["reverb:bigsky", {"decay": 0.55, "predelay": 25, "mix": 0.2, "tone": 0.5, "mode": 1}]] },
      ],
    },
    {
      id: "maiden-trooper", group: 'Songs', title: "Iron Maiden · The Trooper", short: "The Trooper",
      summary: "Bright, sharp twin-guitar harmony in thirds, with a punchy Marshall-style crunch.",
      source: {"kind": "lead", "tempo": 160, "noise": -60},
      play: "Play the galloping melody in E minor with clean, even picking.",
      chain: [
        ["drive:ocd", {"drive": 22, "tone": 0.65, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Stands in for the Marshall JCM800s often linked to Dave Murray and Adrian Smith: bright, moderate gain."],
        ["harm:ps6", {"mode": 2, "key": 4, "mix": 0.5, "steps1": 2, "steps2": 0}, "Stands in for the second guitar: a third above, inside E minor."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.12, "tone": 0.5, "mode": 0}, "A short room keeps the gallop tight."],
      ],
      tip: "On the record these harmonies are two guitarists; moderate gain keeps both lines clear.",
      whatIfs: [
        { id: "one-guitar", label: "One guitar", note: "A single line: the melody is still there, but the twin-guitar signature is gone.",
          chain: [["drive:ocd", {"drive": 22, "tone": 0.65, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.12, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "aerosmith-crazy", group: 'Songs', title: "Aerosmith · Crazy", short: "Crazy",
      summary: "An expressive, bluesy hard-rock lead: moderate overdrive into the amp, shaped mostly by the guitar’s volume knob.",
      source: {"kind": "lead", "tempo": 72, "noise": -60},
      play: "Play slow, bluesy bends and use the guitar’s volume knob to move between clean and crunch.",
      chain: [
        ["drive:ts9", {"drive": 10, "tone": 0.6, "level": -3, "mix": 1, "voicing": 1}, "Moderate overdrive into the amp; Joe Perry relies on his volume knob and pickups more than effects."],
        ["reverb:bigsky", {"decay": 0.5, "predelay": 25, "mix": 0.18, "tone": 0.5, "mode": 1}, "A hall suits the power-ballad space."],
      ],
      tip: "Roll the guitar volume back for the verses, then open it for the solo.",
      whatIfs: [
        { id: "volume-back", label: "Guitar volume rolled back", note: "Less drive, as when the guitar volume is turned down: cleaner and softer.",
          chain: [["drive:ts9", {"drive": 3, "tone": 0.6, "level": -3, "mix": 1, "voicing": 1}], ["reverb:bigsky", {"decay": 0.5, "predelay": 25, "mix": 0.18, "tone": 0.5, "mode": 1}]] },
      ],
    },
    {
      id: "vanhalen-panama", group: 'Songs', title: "Van Halen · Panama", short: "Panama",
      summary: "A punchy, saturated hard-rock lead from Eddie’s Frankenstein-style guitar with a single bridge humbucker into a cranked amp.",
      source: {"kind": "power", "tempo": 142, "noise": -60},
      play: "Play open chords with accents and add vibrato-bar dives on the held notes.",
      chain: [
        ["drive:ocd", {"drive": 27, "tone": 0.62, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Stands in for a cranked Marshall: punchy, saturated and bright."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.1, "tone": 0.5, "mode": 0}, "A short room keeps the riff punchy."],
      ],
      tip: "Most of the punch comes from the pick attack and a single, hot bridge pickup.",
      whatIfs: [
        { id: "less-gain", label: "Less gain", note: "Lower gain gives a cleaner, chunkier crunch with less sustain.",
          chain: [["drive:ocd", {"drive": 14, "tone": 0.62, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.1, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "audioslave-cochise", group: 'Songs', title: "Audioslave · Cochise", short: "Cochise",
      summary: "Tom Morello’s helicopter-like intro: a Whammy an octave down into a hard slapback echo with high feedback.",
      source: {"kind": "chug", "tempo": 108, "noise": -60},
      play: "Slap or strike muted strings rhythmically; on a real Whammy, open and close the treadle as you play.",
      chain: [
        ["octave:whammy", {"interval": -12, "treadle": 1, "shift": 1, "dry": 0, "sub": 0, "up": 0, "sub2": 0}, "A Whammy one octave down with the treadle at the toe."],
        ["drive:ocd", {"drive": 16, "tone": 0.55, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Stands in for Morello’s Marshall JCM800: his crunch comes from the amp, not from a distortion pedal."],
        ["delay:dd3", {"time": 70, "feedback": 0.6, "mix": 0.5, "range": 200}, "A hard slapback with high feedback: each note is instantly doubled into the stutter of the intro."],
      ],
      tip: "Morello describes the intro as a hard slapback, so every note is instantly doubled.",
      whatIfs: [
        { id: "no-whammy", label: "Whammy off", note: "Without the octave drop the stutter stays but loses its low, rotor-like weight.",
          chain: [["drive:ocd", {"drive": 16, "tone": 0.55, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}], ["delay:dd3", {"time": 70, "feedback": 0.6, "mix": 0.5, "range": 200}]] },
      ],
    },
    {
      id: "kravitz-go-my-way", group: 'Songs', title: "Lenny Kravitz · Are You Gonna Go My Way", short: "Go My Way",
      summary: "A fuzzy, vintage-flavored riff and lead from a Les Paul into a tiny combo turned up.",
      source: {"kind": "lead", "tempo": 120, "noise": -60},
      play: "Play the riff with a loose, swinging attack; Craig Ross reportedly came up with it in the last minutes of a session.",
      chain: [
        ["drive:ocd", {"drive": 22, "tone": 0.6, "mix": 1, "level": -6, "voicing": 3, "clipping": 1}, "Stands in for the small Gibson Skylark combo Kravitz has named, turned up into fuzzy breakup."],
        ["eq:paraeq", {"bass": -3, "mid": 2, "midFreq": 1000, "treble": 1, "level": 0}, "A small speaker’s lean lows and forward middle."],
      ],
      tip: "A small, loud amp gives the riff its compressed, vintage fuzz.",
      whatIfs: [
        { id: "big-amp", label: "Bigger amp", note: "With the full low end of a bigger speaker, the riff gets heavier but less vintage.",
          chain: [["drive:ocd", {"drive": 22, "tone": 0.6, "mix": 1, "level": -6, "voicing": 3, "clipping": 1}]] },
      ],
    },
    {
      id: "offspring-kids", group: 'Songs', title: "The Offspring · The Kids Aren’t Alright", short: "Kids Aren’t Alright",
      summary: "A bright, compact punk-rock tone: tight high gain from a Mesa/Boogie-style amp, with no ambience.",
      source: {"kind": "chug", "tempo": 100, "noise": -55},
      play: "Downpick tight eighth notes and keep the lead short and melodic.",
      chain: [
        ["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}, "Keeps the gaps between heavy riffs quiet without a long release."],
        ["dist:heavy", {"gain": 30, "tone": 0.62, "level": -16, "weight": 80, "tight": 1, "bass": 1, "mid": 1, "treble": 2, "midFreq": 900}, "Stands in for the Mesa/Boogie amps Noodles used in that era: tight, bright gain."],
      ],
      tip: "The record stacks several takes; one pedal chain gives the basic tone.",
      whatIfs: [
        { id: "scooped", label: "Scooped mids", note: "A metal-style mid scoop makes the punk riff hollow and less forward.",
          chain: [["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}], ["dist:heavy", {"gain": 30, "tone": 0.62, "level": -16, "weight": 80, "tight": 1, "bass": 1, "mid": -8, "treble": 2, "midFreq": 900}]] },
      ],
    },
    {
      id: "gnr-welcome-jungle", group: 'Songs', title: "Guns N’ Roses · Welcome to the Jungle", short: "Welcome to the Jungle",
      summary: "Sharp, aggressive hard rock with a repeating echo on the intro and a Marshall-style crunch underneath.",
      source: {"kind": "lead", "tempo": 123, "noise": -60},
      play: "Pick the intro phrase cleanly and let the echoes cascade, then dig in for the riff.",
      chain: [
        ["drive:ocd", {"drive": 22, "tone": 0.6, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Stands in for Slash’s Marshall: a saturated, singing lead from the amp."],
        ["delay:dd3", {"time": 390, "feedback": 0.45, "mix": 0.35}, "A repeating echo for the intro’s cascading phrase."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.1, "tone": 0.5, "mode": 0}, "A short room keeps the riff tight."],
      ],
      tip: "Turn the echo down or off once the main riff starts.",
      whatIfs: [
        { id: "no-delay", label: "No delay", note: "Without the echo the intro is a single, dry phrase; the riff is unchanged.",
          chain: [["drive:ocd", {"drive": 22, "tone": 0.6, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.1, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "metallica-sandman", group: 'Songs', title: "Metallica · Enter Sandman", short: "Enter Sandman",
      summary: "Thick, controlled heavy-metal gain from the Black Album rig, with Kirk Hammett’s Cry Baby on the solo.",
      source: {"kind": "chug", "tempo": 123, "noise": -55},
      play: "Palm-mute the riff firmly and let the open chords ring.",
      chain: [
        ["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}, "Keeps the gaps between heavy riffs quiet without a long release."],
        ["dist:heavy", {"gain": 32, "tone": 0.55, "level": -16, "weight": 80, "tight": 1, "bass": 3, "mid": -3, "treble": 1, "midFreq": 700}, "Stands in for the ADA MP-1 preamp and Mesa/Boogie power amp reported on the album: thick, controlled gain."],
      ],
      tip: "Hammett says he adds the wah after writing a solo, never while composing it.",
      whatIfs: [
        { id: "solo-wah", label: "Wah on the solo", note: "A Cry Baby sweeping by itself stands in for Hammett’s foot on the solo.",
          chain: [["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}], ["dist:heavy", {"gain": 32, "tone": 0.55, "level": -16, "weight": 80, "tight": 1, "bass": 3, "mid": -3, "treble": 1, "midFreq": 700}], ["wah:crybaby", {"mode": 2, "speed": 1.2, "resonance": 5}]] },
      ],
    },
    {
      id: "priest-painkiller", group: 'Songs', title: "Judas Priest · Painkiller", short: "Painkiller",
      summary: "Piercing, high-gain metal leads: very tight distortion with a bright edge and a short echo.",
      source: {"kind": "lead", "tempo": 206, "noise": -55},
      play: "Play fast, exact runs and wide vibrato; the two guitarists trade and harmonize leads.",
      chain: [
        ["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}, "Keeps the gaps between heavy riffs quiet without a long release."],
        ["dist:heavy", {"gain": 38, "tone": 0.68, "level": -17, "weight": 110, "tight": 1, "bass": 0, "mid": 2, "treble": 2, "midFreq": 1000}, "Very high, tight gain with a bright, piercing top."],
        ["delay:dd3", {"time": 300, "feedback": 0.2, "mix": 0.12}, "A short, quiet echo behind the fast runs."],
      ],
      tip: "If the top gets harsh, lower the distortion tone before you lower the gain.",
      whatIfs: [
        { id: "less-gain", label: "Less gain", note: "Less gain is clearer but loses the screaming sustain.",
          chain: [["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}], ["dist:heavy", {"gain": 24, "tone": 0.68, "level": -14, "weight": 110, "tight": 1, "bass": 0, "mid": 2, "treble": 2, "midFreq": 1000}], ["delay:dd3", {"time": 300, "feedback": 0.2, "mix": 0.12}]] },
      ],
    },
    {
      id: "heart-crazy-on-you", group: 'Songs', title: "Heart · Crazy on You", short: "Crazy on You",
      summary: "A bright, energetic classic-rock lead from an amp pushed into natural breakup.",
      source: {"kind": "lead", "tempo": 130, "noise": -60},
      play: "Play quick, bright phrases with a firm pick attack. The acoustic intro is a separate part.",
      chain: [
        ["drive:ocd", {"drive": 18, "tone": 0.66, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Stands in for an amp pushed into natural breakup: bright, with moderate gain."],
        ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.14, "tone": 0.5, "mode": 0}, "A small room around the band."],
      ],
      tip: "Keep the gain moderate so the fast lines stay bright and clear.",
      whatIfs: [
        { id: "darker", label: "Darker tone", note: "Turning the tone down makes the same lead warmer but less energetic.",
          chain: [["drive:ocd", {"drive": 18, "tone": 0.35, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}], ["reverb:bigsky", {"decay": 0.3, "predelay": 15, "mix": 0.14, "tone": 0.5, "mode": 0}]] },
      ],
    },
    {
      id: "rundmc-walk-this-way", group: 'Songs', title: "Run-DMC & Aerosmith · Walk This Way", short: "Walk This Way",
      summary: "Joe Perry’s crunchy riff in a rap-rock arrangement: moderate overdrive, dry and upfront.",
      source: {"kind": "funk", "tempo": 106, "noise": -60},
      play: "Play the syncopated riff with muted, percussive strokes between the notes.",
      chain: [
        ["drive:ts9", {"drive": 11, "tone": 0.62, "level": -3, "mix": 1, "voicing": 1}, "Moderate crunch: Perry recorded the original riffs mostly on Strats."],
        ["eq:paraeq", {"bass": -2, "mid": 2, "midFreq": 1100, "treble": 1, "level": 0}, "A little upper-mid lift keeps the riff upfront against the beat."],
      ],
      tip: "Keep it dry: in the rap arrangement the guitar sits right next to the drum machine.",
      whatIfs: [
        { id: "clean", label: "Clean", note: "Without the overdrive the riff is thin and funky, closer to a plain rhythm part.",
          chain: [["eq:paraeq", {"bass": -2, "mid": 2, "midFreq": 1100, "treble": 1, "level": 0}]] },
      ],
    },
    {
      id: "eminem-lose-yourself", group: 'Songs', title: "Eminem · Lose Yourself", short: "Lose Yourself",
      summary: "Jeff Bass’ repeating, palm-muted guitar figure: brittle and dark, with tight distortion.",
      source: {"kind": "chug", "tempo": 86, "noise": -58},
      play: "Palm-mute a repeating figure and keep every note the same length.",
      chain: [
        ["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}, "Keeps the gaps between heavy riffs quiet without a long release."],
        ["dist:ds1", {"gain": 24, "tone": 0.6, "level": -14}, "Tight distortion for a brittle, pulsing figure. Jeff Bass has said he was a Strat player in that era."],
        ["eq:paraeq", {"bass": -3, "mid": 3, "midFreq": 1500, "treble": -1, "level": 0}, "An upper-mid focus gives the figure its brittle, nervous edge."],
      ],
      tip: "The tension comes from repetition: keep the timing rigid.",
      whatIfs: [
        { id: "full-lows", label: "Fuller low end", note: "Without the bass cut the figure is heavier but less tense.",
          chain: [["gate:decimator", {"threshold": -46, "attack": 0.5, "hold": 25, "release": 85, "range": -80}], ["dist:ds1", {"gain": 24, "tone": 0.6, "level": -14}]] },
      ],
    },
    {
      id: "ratm-bulls-on-parade", group: 'Songs', title: "Rage Against the Machine · Bulls on Parade", short: "Bulls on Parade",
      summary: "Tom Morello’s DJ-style scratch: a wah pushed to an extreme position into a JCM800-style crunch.",
      source: {"kind": "funk", "tempo": 112, "noise": -60},
      play: "Rub the muted strings while flicking the pickup toggle switch on and off. Tonelab’s pattern can’t flick a toggle, so you hear the filtered tone.",
      chain: [
        ["wah:crybaby", {"mode": 0, "position": 1, "resonance": 6}, "The wah pushed all the way down to the toe: a fixed, piercing peak."],
        ["drive:ocd", {"drive": 16, "tone": 0.55, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}, "Stands in for Morello’s Marshall JCM800: his crunch comes from the amp, not from a distortion pedal."],
      ],
      tip: "The scratch is the toggle switch and your hand; the pedals only shape it.",
      whatIfs: [
        { id: "heel", label: "Wah at the heel", note: "At the heel the same scratch turns dark and muffled.",
          chain: [["wah:crybaby", {"mode": 0, "position": 0, "resonance": 6}], ["drive:ocd", {"drive": 16, "tone": 0.55, "mix": 1, "level": -6, "voicing": 0, "clipping": 1}]] },
      ],
    },
    {
      id: "zeppelin-black-dog", group: 'Songs', title: "Led Zeppelin · Black Dog", short: "Black Dog",
      summary: "Jimmy Page’s Les Paul with no amp: a DI into the console’s overdriven mic preamp, then two 1176 compressors in series.",
      source: {"kind": "lead", "tempo": 82, "noise": -60},
      play: "Play the riff tightly; Page triple-tracked the guitars on the record.",
      chain: [
        ["drive:klon", {"drive": 18, "tone": 0.9, "level": -4, "mix": 1}, "Stands in for the console’s overdriven mic preamp: the distortion came from driving the desk, not an amp."],
        ["comp:cali76", {"threshold": -36, "makeup": 10, "ratio": 8, "attack": 0.2, "release": 60, "blend": 1}, "The first of two 1176-style compressors in series, squeezing the drive into a thick, even wall."],
        ["comp:cali76", {"threshold": -36, "makeup": 10, "ratio": 8, "attack": 0.2, "release": 60, "blend": 1}, "The second compressor flattens it further, as engineer Andy Johns described."],
      ],
      tip: "No amp or cabinet was used: that’s why the riff sounds so direct and buzzy.",
      whatIfs: [
        { id: "one-comp", label: "One compressor", note: "With a single compressor the riff keeps more of its attack and feels less squashed.",
          chain: [["drive:klon", {"drive": 18, "tone": 0.9, "level": -4, "mix": 1}], ["comp:cali76", {"threshold": -36, "makeup": 10, "ratio": 8, "attack": 0.2, "release": 60, "blend": 1}]] },
      ],
    },
  ];
  I18n?.catalog(TONES);
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
  I18n?.catalog(ROLES);

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
    const entry = { id: 'my-last-board', name: tr('My last board'), spec: specOf(chain) };
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
    let text = tr('My board');
    if (s.kind === 'tone') text = toneById(s.tone).title;
    else if (s.kind === 'whatif') text = tr('What if: ') + whatIfOf(s).label;
    else if (s.kind === 'mine') text = s.mine === 'my-last-board' ? tr('My last board') : myTones.find(t => t.id === s.mine)?.name || tr('My sound');
    return text + (s.edited && s.kind !== 'custom' ? tr(' (edited)') : '');
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
    announce(label + tr(' loaded into ') + bank);
    offerUndo(label + tr(' loaded into ') + bank, () => applyBoard(before));
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
    heroSelect.replaceChildren(new Option(tr('Choose a sound…'), ''));
    for (const name of [tr('Songs'), tr('Techniques')]) heroSelect.appendChild(group(name, TONES.filter(t => t.group === name).map(t => [t.title, 'tone:' + t.id])));
    if (myTones.length) heroSelect.appendChild(group(tr('My sounds'), myTones.map(t => [t.id === 'my-last-board' ? tr('My last board') : t.name, 'mine:' + t.id])));
    const shown = toneOf(slots.A);
    heroSelect.value = shown ? 'tone:' + shown.id : slots.A.kind === 'mine' ? 'mine:' + slots.A.mine : '';
    syncCombo();
    const lesson = lessonTone();
    document.getElementById('tone-summary').textContent = lesson ? lesson.summary : tr('Pick a famous sound to see how it’s built, pedal by pedal. Or build your own on the board below.');

    for (const bank of ['A', 'B']) {
      const select = slotSelects[bank];
      const other = otherBank(bank);
      select.replaceChildren(new Option(slotLabel(slots[bank]), 'current'));
      const base = toneOf(slots[other]) || toneOf(slots[bank]);
      if (base) select.appendChild(group(tr('What if… (') + base.short + ')', base.whatIfs.map(w => [w.label, 'whatif:' + base.id + ':' + w.id]).concat([[tr('The original ') + base.short + tr(' sound'), 'tone:' + base.id]])));
      select.appendChild(group(tr('Copy'), [[tr('Same as ') + other, 'same']]));
      for (const name of [tr('Songs'), tr('Techniques')]) select.appendChild(group(name, TONES.filter(t => t.group === name).map(t => [t.title, 'tone:' + t.id])));
      if (myTones.length) select.appendChild(group(tr('My sounds'), myTones.map(t => [t.id === 'my-last-board' ? tr('My last board') : t.name, 'mine:' + t.id])));
      select.value = 'current';
      select.setAttribute('aria-label', tr('Sound in ') + bank);
    }
    document.getElementById('board-slot').textContent = tr('Editing ') + activeBank + ': ' + slotLabel(slots[activeBank]);
    renderJourney();
  }
  const newBoardDialog = document.getElementById('new-board-dialog');
  document.getElementById('new-board').onclick = () => newBoardDialog.showModal();
  document.getElementById('cancel-new-board').onclick = newBoardDialog.querySelector('.sheet-close').onclick = () => newBoardDialog.close();
  document.getElementById('confirm-new-board').onclick = () => {
    newBoardDialog.close();
    const before = boardState();
    applyBoard({ ...before, A: [], B: [], slots: { A: { kind: 'custom' }, B: { kind: 'custom' } }, active: 'A' });
    closeSettings();
    resetScopeHistory();
    scopeHistory.B.input.fill(0);
    scopeHistory.B.output.fill(0);
    offerUndo(tr('New pedalboard started'), () => applyBoard(before));
  };
  heroSelect.onchange = () => {
    const value = heroSelect.value;
    if (!value) return;
    const before = boardState();
    fillSlot('A', value);
    const tone = value.startsWith('tone:') && toneById(value.slice(5));
    if (tone?.whatIfs.length) fillSlot('B', 'whatif:' + tone.id + ':' + tone.whatIfs[0].id);
    if (activeBank !== 'A') switchBank('A');
    if (tone?.view) setView(tone.view);
    changed();
    refreshSlots();
    closeSettings();
    const label = tone ? tone.title : heroSelect.selectedOptions[0].textContent;
    announce(label + ' loaded');
    offerUndo(label + ' loaded', () => applyBoard(before));
    advanceQuickStart(0);
  };
  // Use the same A/B lesson, source selection and Undo as the main sound picker.
  for (const button of document.querySelectorAll('[data-starter]')) button.onclick = () => {
    heroSelect.value = 'tone:' + button.dataset.starter;
    heroSelect.dispatchEvent(new Event('change'));
    orderList.querySelector('.pedal-toggle')?.focus({ preventScroll: true });
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
        const title = document.createElement('span');
        title.textContent = item.label;
        li.append(title);
        const tone = item.value.startsWith('tone:') && toneById(item.value.slice(5));
        if (tone) {
          const tag = document.createElement('small');
          tag.textContent = [...new Set(tone.chain.map(([type]) => types[type.split(':')[0]].short))].slice(0, 3).join(' · ');
          li.append(tag);
        }
        li.onmousedown = e => { e.preventDefault(); choose(item.value); };
        list.appendChild(li);
      });
      if (!shown.length) {
        const empty = document.createElement('li');
        empty.className = 'combo-empty';
        empty.setAttribute('role', 'presentation');
        empty.textContent = tr('No sound matches “') + query.trim() + tr('”. Try another word.');
        list.appendChild(empty);
      }
      const current = shown.findIndex(item => item.value === heroSelect.value);
      setActive(shown.length ? (current >= 0 ? current : 0) : -1, false);
    }
    function show() { if (!open) { open = true; list.hidden = false; search.setAttribute('aria-expanded', 'true'); setActive(active, true); } }
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
  const saveForm = document.getElementById('save-sound-form');
  const soundName = document.getElementById('sound-name');
  const closeSave = () => { saveForm.hidden = true; document.getElementById('save-tone').focus({ preventScroll: true }); };
  document.getElementById('save-tone').onclick = () => {
    soundName.value = slots[activeBank].kind === 'custom' ? tr('My sound ') + (myTones.filter(t => t.id !== 'my-last-board').length + 1) : slotLabel(slots[activeBank]).replace(tr(' (edited)'), '') + tr(' (mine)');
    saveForm.hidden = false;
    soundName.focus();
    soundName.select();
  };
  document.getElementById('cancel-save').onclick = closeSave;
  soundName.addEventListener('input', () => soundName.setCustomValidity(''));
  saveForm.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeSave(); } });
  saveForm.onsubmit = e => {
    e.preventDefault();
    const name = soundName.value.trim();
    if (!name) { soundName.setCustomValidity(tr('Enter a name for your sound.')); soundName.reportValidity(); return; }
    const entry = { id: 'mine-' + Date.now().toString(36), name: name.slice(0, 60), spec: specOf(state.chain) };
    myTones = [entry, ...myTones];
    saveMyTones();
    slots[activeBank] = { kind: 'mine', mine: entry.id };
    saveBoard();
    refreshSlots();
    closeSave();
    announce(tr('Saved as “') + entry.name + tr('” in My sounds'));
  };

  /* Step by step: your guitar, then each pedal with what it does and the
   * signal after it (drawn live from the same chain you hear). */
  const journeyList = document.getElementById('journey-steps');
  const pedalKey = (chain, pedal) => pedal.type + '#' + chain.filter(p => p.type === pedal.type).indexOf(pedal);
  // What a pedal is doing here: the sound's own note when the pedal is set
  // as in the original sound, the what-if's note when that's the change.
  function noteFor(pedal, chain) {
    if (!pedal.enabled) return tr('Switched off: your signal passes straight through.');
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
    return ROLES[pedal.type] + (sameSettings ? '' : tr(' (Set differently from the original sound.)'));
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
      if (!twin) { result.set(pedal.id, tr('Not in ') + other); return; }
      const parts = [];
      if (twin.enabled !== pedal.enabled) parts.push(twin.enabled ? tr('on') : tr('switched off'));
      if (twin.model !== pedal.model) parts.push(tr('a ') + modelOf(twin).name);
      for (const c of controlsFor(twin, true)) {
        if (Math.abs(twin.params[c.key] - pedal.params[c.key]) > 1e-6) parts.push(c.label.toLowerCase() + ' ' + controlValue(twin, c));
      }
      if (shared.indexOf(key) !== otherShared.indexOf(key)) parts.push(tr('in a different order'));
      if (parts.length) result.set(pedal.id, tr('In ') + other + ': ' + parts.join(', '));
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
    document.getElementById('board-guide-tone').textContent = activeBank + ' · ' + slotLabel(s);
    const demoPattern = TL.PATTERNS[source.kind];
    const playsNote = demoPattern?.tempo
      ? tr(' The demo plays “') + demoPattern.label + tr('” at ') + Math.round(source.tempo) + tr(' BPM, a generic pattern in the spirit of the style, not the actual part. Change it with Playing and Speed.')
      : '';
    document.getElementById('journey-play').textContent = ((tone || lessonTone())?.play || tr('Your guitar, before any pedals.')) + playsNote;
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
        `<button type="button" class="journey-listen" data-pedal="${pedal.id}" data-monitor="wet" aria-label="${tr('Hear after the ')}${info.name.toLowerCase()}">${tr('▶ Hear after this')}</button></div></li>`);
    });
    journeyList.innerHTML = items.join('');
    // Notes are plain text: set them as text, not markup.
    journeyList.querySelectorAll('.journey-step').forEach((li, i) => { li.querySelector('.journey-note').textContent = noteFor(chain[i], chain); });
    journeyList.querySelectorAll('[data-edit]').forEach(button => {
      button.onclick = () => {
        boardGuideDialog.close();
        showGuide(false);
        openSettings(state.chain.find(p => p.id === button.dataset.edit), true);
      };
    });
    if (!chain.length) {
      const empty = document.createElement('li');
      empty.className = 'journey-empty';
      empty.textContent = tr('No pedals yet: you hear your guitar just as it is. Pick a sound above or add pedals below.');
      journeyList.append(empty);
    }
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
      title.textContent = tr('What ') + whatIfBank + tr(' changes: ') + whatIfOf(slots[whatIfBank]).label.toLowerCase();
      text.textContent = whatIfOf(slots[whatIfBank]).note;
    } else if (byPedal.size || missing.length) {
      title.textContent = tr('How ') + other + tr(' is different');
      text.textContent = [...[...byPedal.entries()].map(([id, d]) => pedalName(chain.find(p => p.id === id)) + ': ' + d.replace(/^(?:In|En) [AB]: /, '')),
        ...missing.map(p => tr('Only ') + other + tr(' has ') + types[p.type].name.toLowerCase())].join(' · ');
    } else {
      title.textContent = tr('A and B are the same');
      text.textContent = tr('Pick a “What if…” for B to hear what one change does.');
    }
    const dockWhatIf = document.getElementById('dock-whatif');
    dockWhatIf.textContent = whatIfBank ? whatIfBank + ': ' + whatIfOf(slots[whatIfBank]).label : (byPedal.size || missing.length ? tr('A and B differ') : tr('A and B are the same'));
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
    const button = document.getElementById('inspect-pedal');
    const playingPedal = listening && inspectId === selectedId && monitor === 'wet';
    const label = playingPedal ? tr('Stop listening') : tr('Hear this pedal');
    button.innerHTML = '<svg class="action-icon" aria-hidden="true"><use href="#icon-' + (playingPedal ? 'stop' : 'play') + '"/></svg>';
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(playingPedal));
    button.title = label;
    journeyList.querySelectorAll('.journey-listen').forEach(button => {
      const playing = active?.pedal === button.dataset.pedal && active?.monitor === button.dataset.monitor;
      button.textContent = playing ? tr('■ Stop') : tr('▶ Hear after this');
      button.setAttribute('aria-pressed', String(!!playing));
    });
    document.querySelectorAll('#whatif-box [data-hear]').forEach(button => {
      const playing = active?.bank === button.dataset.hear && active.pedal === '' && active.monitor === 'wet';
      button.textContent = (playing ? tr('■ Stop ') : tr('▶ Hear ')) + button.dataset.hear;
      button.setAttribute('aria-pressed', String(!!playing));
    });
  }
  function updateGuide(pedal) {
    const index = state.chain.findIndex(p => p.id === pedal.id);
    if (index < 0) return;
    document.getElementById('guide-position').textContent = (index + 1) + tr(' of ') + state.chain.length;
    document.getElementById('guide-note').textContent = noteFor(pedal, state.chain);
    document.getElementById('guide-values').textContent = modelOf(pedal).name + ' · ' + controlsFor(pedal).map(c => c.label + ' ' + controlValue(pedal, c)).join(' · ');
    const diff = differences(state.chain, banks[otherBank(activeBank)], otherBank(activeBank)).byPedal.get(pedal.id) || '';
    document.getElementById('guide-diff').textContent = diff ? tr('A/B difference · ') + diff : '';
    document.getElementById('guide-diff').hidden = !diff;
    const tone = toneOf(slots[activeBank]) || lessonTone();
    const intro = tone?.play || '';
    const tip = tone?.tip || '';
    document.getElementById('guide-intro').textContent = intro;
    document.getElementById('guide-intro').hidden = !intro;
    document.getElementById('guide-tip').textContent = tip;
    document.getElementById('guide-tip').hidden = !tip;
    document.getElementById('guide-playing').hidden = !intro && !tip;
    document.getElementById('guide-prev').disabled = index === 0;
    const last = index === state.chain.length - 1;
    const next = document.getElementById('guide-next');
    next.querySelector('span').textContent = last ? tr('Done') : tr('Next');
    next.querySelector('svg').toggleAttribute('hidden', last);
  }
  function showGuide(show) {
    if (show && !guideSelected) document.getElementById('guide-settings').open = true;
    guideSelected = show;
    document.getElementById('inspector-controls').hidden = show && !mobileEditor.matches;
    modelRow.hidden = show && !mobileEditor.matches;
    document.getElementById('tab-guide').setAttribute('aria-pressed', String(show));
    document.getElementById('tab-controls').setAttribute('aria-pressed', String(!show));
    if (mobileEditor.matches) {
      if (!show) { guideDialog.close(); guideContent.hidden = true; return; }
      if (selected()) updateGuide(selected());
      document.getElementById('pedal-guide-title').textContent = selected() ? pedalName(selected()) : tr('Pedal guide');
      guideContent.hidden = false;
      if (!guideDialog.open) guideDialog.showModal();
      document.body.classList.add('pedal-guide-open');
      return;
    }
    document.getElementById('inspector-guide').hidden = !show;
    if (selected()) updateGuide(selected());
  }
  document.getElementById('tab-guide').onclick = () => showGuide(true);
  document.getElementById('tab-controls').onclick = () => showGuide(false);
  document.getElementById('start-guide').onclick = () => {
    renderJourney();
    boardGuideDialog.showModal();
  };
  document.getElementById('guide-prev').onclick = () => {
    const index = state.chain.findIndex(p => p.id === selectedId);
    if (index > 0) { openSettings(state.chain[index - 1]); }
  };
  document.getElementById('guide-next').onclick = () => {
    const index = state.chain.findIndex(p => p.id === selectedId);
    if (index >= 0 && index < state.chain.length - 1) { openSettings(state.chain[index + 1]); }
    else if (index >= 0) {
      showGuide(false);
      if (!mobileEditor.matches) document.getElementById('tab-controls').focus();
    }
  };
  document.getElementById('print-guide').onclick = () => {
    document.body.classList.add('printing-guide');
    window.print();
  };
  window.addEventListener('afterprint', () => { document.body.classList.remove('printing-guide'); });
  journeyList.addEventListener('click', e => {
    const button = e.target.closest('.journey-listen');
    if (button) listenTo(button.dataset.pedal, button.dataset.monitor);
  });
  const quickStartSteps = [
    { target: '#tone-combo', title: 'Pick a sound', copy: 'Choose a song or technique. A gets the original sound; B gets a variation to explore.' },
    { target: '#listen', title: 'Press Play', copy: 'Listen to the demo guitar, then try another pattern or upload your own recording.' },
    { target: '#dock-bank', title: 'Compare Dry, A and B', copy: 'Dry is your guitar without pedals. A and B let you compare two versions at matched volume.' },
    { target: '#scope-plot', title: 'See what changes', copy: 'Switch between Dry and B. Listen to the difference and watch how the waveform changes.' },
    { target: '#effect-order li[data-effect]', title: 'Make it yours', copy: 'Tap a pedal to turn it on or off, or double-tap it to open it and change a control. Guide explains what to listen for and how to play it.', mobileBottom: true }
  ];
  I18n?.catalog(quickStartSteps);
  const quickStartTour = document.getElementById('quick-start-tour');
  const quickStartSeenKey = 'tonelab-quick-start-seen';
  let quickStartIndex = 0;
  function advanceQuickStart(expectedIndex) {
    if (quickStartTour.hidden || quickStartIndex !== expectedIndex) return;
    quickStartIndex += 1;
    if (quickStartIndex >= quickStartSteps.length) closeQuickStart();
    else renderQuickStart();
  }
  function positionQuickStart() {
    if (quickStartTour.hidden) return;
    const target = document.querySelector('.quick-start-target');
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const player = document.querySelector('.player-dock').getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportBottom = viewportTop + (viewport?.height ?? innerHeight);
    const maxBottom = (innerWidth <= 700 ? Math.min(player.top, viewportBottom) : viewportBottom) - 12;
    const minTop = innerWidth > 700 && rect.top > player.bottom ? Math.max(viewportTop + 12, player.bottom + 12) : viewportTop + 12;
    const mobileBottom = innerWidth <= 700 && quickStartSteps[quickStartIndex].mobileBottom;
    // Leave room above the last card for the entire pedal, even on short screens.
    quickStartTour.style.maxHeight = Math.max(0, maxBottom - minTop - (mobileBottom ? rect.height + 24 : 0)) + 'px';
    const card = quickStartTour.getBoundingClientRect();
    document.documentElement.style.setProperty('--quick-start-card-height', card.height + 'px');
    const below = rect.bottom + 12;
    const above = rect.top - card.height - 12;
    const top = mobileBottom ? maxBottom - card.height : below + card.height <= maxBottom ? below : above >= minTop ? above : Math.max(minTop, maxBottom - card.height);
    // An anchor inside the player must clear the whole dock, including its first row.
    quickStartTour.style.top = Math.max(minTop, Math.min(top, maxBottom - card.height)) + 'px';
    quickStartTour.style.left = Math.max(12, Math.min(innerWidth - card.width - 12, rect.left)) + 'px';
  }
  function revealQuickStartPedal() {
    if (quickStartTour.hidden || innerWidth > 700 || !quickStartSteps[quickStartIndex].mobileBottom) return;
    const target = document.querySelector('.quick-start-target');
    if (!target) return;
    // Reveal the pedal horizontally, then fit it above the bottom tutorial card.
    target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const rect = target.getBoundingClientRect();
    const top = (window.visualViewport?.offsetTop ?? 0) + 12;
    const bottom = quickStartTour.getBoundingClientRect().top - 12;
    const delta = rect.bottom > bottom ? rect.bottom - bottom : rect.top < top ? rect.top - top : 0;
    if (delta) window.scrollBy({ top: delta, behavior: 'instant' });
  }
  function renderQuickStart() {
    document.querySelectorAll('.quick-start-target').forEach(el => el.classList.remove('quick-start-target'));
    document.body.classList.toggle('quick-start-pedal-step', !quickStartTour.hidden && !!quickStartSteps[quickStartIndex]?.mobileBottom);
    if (quickStartTour.hidden) return;
    sizePlayer();
    const step = quickStartSteps[quickStartIndex];
    document.getElementById('quick-start-count').textContent = (quickStartIndex + 1) + tr(' of ') + quickStartSteps.length;
    document.getElementById('quick-start-title').textContent = step.title;
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    document.getElementById('quick-start-copy').textContent = step.copy + (quickStartIndex === 1 && ios ? tr(' On iPhone, turn Silent mode off if you cannot hear playback.') : '');
    document.getElementById('quick-start-progress-fill').style.width = ((quickStartIndex + 1) / quickStartSteps.length * 100) + '%';
    document.getElementById('quick-start-back').disabled = quickStartIndex === 0;
    document.getElementById('quick-start-next').textContent = quickStartIndex === quickStartSteps.length - 1 ? tr('Finish ✓') : tr('Next step →');
    const target = document.querySelector(step.target) || document.querySelector('.board-add-tile');
    if (target) {
      target.classList.add('quick-start-target');
      const rect = target.getBoundingClientRect();
      const bottom = innerWidth <= 700 ? document.querySelector('.player-dock').getBoundingClientRect().top : innerHeight;
      if (rect.top < 0 || rect.bottom > bottom) target.scrollIntoView({ block: 'center', inline: 'nearest' });
      positionQuickStart();
      revealQuickStartPedal();
    }
  }
  function closeQuickStart() {
    quickStartTour.hidden = true;
    document.body.classList.remove('quick-start-pedal-step');
    document.querySelectorAll('.quick-start-target').forEach(el => el.classList.remove('quick-start-target'));
  }
  function openQuickStart() {
    quickStartIndex = 0;
    quickStartTour.hidden = false;
    renderQuickStart();
    try { localStorage.setItem(quickStartSeenKey, '1'); } catch {}
  }
  document.getElementById('open-quick-start').onclick = openQuickStart;
  document.getElementById('close-quick-start').onclick = closeQuickStart;
  document.getElementById('quick-start-back').onclick = () => { quickStartIndex = Math.max(0, quickStartIndex - 1); renderQuickStart(); };
  const nextQuickStart = () => { quickStartIndex += 1; if (quickStartIndex >= quickStartSteps.length) closeQuickStart(); else renderQuickStart(); };
  document.getElementById('quick-start-skip').onclick = nextQuickStart;
  document.getElementById('quick-start-next').onclick = nextQuickStart;
  document.getElementById('listen').addEventListener('click', () => advanceQuickStart(1));
  document.getElementById('dock-bank').addEventListener('click', e => { if (e.target.closest('button')) advanceQuickStart(2); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !quickStartTour.hidden) closeQuickStart(); });
  const resizeQuickStart = () => { positionQuickStart(); revealQuickStartPedal(); };
  addEventListener('resize', resizeQuickStart);
  addEventListener('scroll', positionQuickStart, { passive: true });
  window.visualViewport?.addEventListener('resize', resizeQuickStart, { passive: true });
  window.visualViewport?.addEventListener('scroll', positionQuickStart, { passive: true });
  const quickStartLayout = new ResizeObserver(resizeQuickStart);
  quickStartLayout.observe(player);
  quickStartLayout.observe(quickStartTour);
  onBoardChange = () => { renderJourney(); renderQuickStart(); };
  refreshSlots();

  /* Loudness or Tone: what the scope and the step-by-step show. */
  function setView(view) {
    if (!document.querySelector('.scope-disclosure').classList.contains('scope-expanded')) view = 'level';
    state.view = view;
    try { localStorage.setItem('tonelab-view', view); } catch {}
    document.querySelectorAll('.view-toggle button').forEach(button => {
      button.classList.toggle('on', button.dataset.view === view);
      button.setAttribute('aria-pressed', String(button.dataset.view === view));
    });
    document.body.classList.toggle('tone-view', view === 'tone');
    document.getElementById('view-hint').textContent = view === 'tone'
      ? tr('Tone: bass on the left, treble on the right. Grey is before the pedal, black after.')
      : tr('Loudness over the last moments. Grey is before the pedal, black after.');
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
  I18n?.catalog(BANDS);
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
    dropArea.style.minHeight = Math.max(152, rows * (cardHeight + gap) - gap + 54) + 'px';
  }
  window.addEventListener('resize', reserveBoardHeight);
  // Pedal gestures: tap = on/off, double-tap = edit, hold (touch) or press-and-move = drag.
  const DOUBLE_TAP_MS = 300, HOLD_MS = 450;
  const touchScreen = window.matchMedia('(pointer: coarse)');
  const gesture = () => touchScreen.matches
    ? { hint: tr('Tap a pedal to turn it on or off · double-tap to edit · hold to move'), tip: tr('Tap: on/off · double-tap: edit · hold: move') }
    : { hint: tr('Click a pedal to turn it on or off · double-click to edit · drag to move'), tip: tr('Click: on/off · double-click: edit · drag: move') };
  function renderOrder() {
    document.getElementById('chain-hint').textContent = gesture().hint;
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
        // The whole pedal is one control: tap = on/off, double-tap = edit, hold = drag.
        // A visible Edit affordance and arrow keys provide alternatives to the gestures.
        item.innerHTML = artSvg(pedal, 'pedal-art') + '<div class="pedal-top"><span class="pedal-position"></span><span class="pedal-state" aria-hidden="true"></span></div><button type="button" class="pedal-toggle" aria-describedby="chain-hint"><span class="pedal-label"><span class="pedal-name"></span><span class="pedal-status"></span></span></button><span class="pedal-grip" aria-hidden="true"><svg focusable="false" width="12" height="16" viewBox="0 0 12 16" fill="currentColor"><circle cx="4" cy="4" r="1"/><circle cx="8" cy="4" r="1"/><circle cx="4" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="8" cy="12" r="1"/></svg></span><button type="button" class="pedal-edit"></button>';
        const toggle = item.querySelector('.pedal-toggle');
        item.querySelector('.pedal-edit').onclick = () => { openSettings(pedal, true); advanceQuickStart(4); };
        // A tap turns the pedal on or off at once, so comparing stays instant. A second
        // tap within DOUBLE_TAP_MS puts back what the first one did and opens settings.
        let lastTap = null, suppressClick = false;
        toggle.onclick = e => {
          const keyboard = e.detail === 0;
          if (suppressClick && !keyboard) { suppressClick = false; return; }
          const now = performance.now();
          if (!keyboard && lastTap && now - lastTap.time < DOUBLE_TAP_MS) {
            const restored = lastTap.was !== pedal.enabled;
            pedal.enabled = lastTap.was;
            lastTap = null;
            if (restored) edited();
            openSettings(pedal, true);
            advanceQuickStart(4);
            return;
          }
          lastTap = keyboard ? null : { time: now, was: pedal.enabled };
          pedal.enabled = !pedal.enabled;
          edited();
          announce(pedalName(pedal) + (pedal.enabled ? tr(' enabled') : tr(' bypassed')));
        };
        toggle.onkeydown = e => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
          e.preventDefault();
          const earlier = ['ArrowLeft', 'ArrowUp'].includes(e.key);
          moveEffect(id, state.chain.indexOf(pedal) + (earlier ? -1 : 1));
          toggle.focus();
        };
        // Dragging: a copy of the pedal follows the pointer. Outside the
        // dashed board it turns red with an ✕, and letting go removes it.
        // Touch: hold still for HOLD_MS, and the pedal tilts and follows your finger;
        // moving first just scrolls the board. Mouse and pen: press and move.
        let drag = null, holdTimer = null, pendingDrag = null;
        const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; pendingDrag = null; };
        const outsideBoard = e => {
          const r = dropArea.getBoundingClientRect();
          return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        };
        const beginDrag = (e, held) => {
          cancelHold();
          window.getSelection()?.removeAllRanges();
          document.body.classList.add('pedal-drag-active');
          toggle.setPointerCapture(e.pointerId);
          const r = item.getBoundingClientRect();
          drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, width: r.width, ghost: null };
          if (held) { item.classList.add('drag-ready'); suppressClick = true; navigator.vibrate?.(8); }
        };
        toggle.onpointerdown = e => {
          if (e.button !== 0) return;
          cancelHold();
          suppressClick = false;
          if (e.pointerType === 'touch') {
            pendingDrag = { x: e.clientX, y: e.clientY };
            holdTimer = setTimeout(() => beginDrag(e, true), HOLD_MS);
          } else beginDrag(e, false);
        };
        toggle.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });
        toggle.oncontextmenu = e => e.preventDefault();
        const clearDrag = () => {
          cancelHold();
          drag?.ghost?.remove();
          drag = null;
          document.body.classList.remove('pedal-drag-active');
          item.classList.remove('dragging', 'drag-ready');
          dropArea.classList.remove('drag-over', 'drag-out');
          orderList.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        };
        toggle.onpointermove = e => {
          if (pendingDrag && Math.hypot(e.clientX - pendingDrag.x, e.clientY - pendingDrag.y) > 8) cancelHold();
          if (!drag || !toggle.hasPointerCapture(e.pointerId)) return;
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          if (!drag.ghost) {
            if (Math.hypot(dx, dy) < 4) return; // a click or tiny wobble isn't a drag
            // The pedal tilts as soon as it starts following the pointer, however it was grabbed.
            item.classList.add('drag-ready');
            suppressClick = true;
            const ghost = item.cloneNode(true);
            ghost.classList.remove('drag-ready');
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
        toggle.onpointerup = e => {
          cancelHold();
          if (!drag || !toggle.hasPointerCapture(e.pointerId)) return;
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
        toggle.onpointercancel = clearDrag;
        toggle.onlostpointercapture = clearDrag;
      }
      item.classList.toggle('off', !pedal.enabled);
      item.classList.toggle('selected-pedal', pedal.id === selectedId);
      item.querySelector('.pedal-art').innerHTML = pedalArt(pedal);
      item.querySelector('.pedal-position').textContent = index + 1;
      item.querySelector('.pedal-name').textContent = shortName(pedal) + ' ' + pedal.number;
      item.dataset.shape = modelOf(pedal).shape;
      const toggle = item.querySelector('.pedal-toggle');
      toggle.setAttribute('aria-label', (pedal.enabled ? tr('Bypass ') : tr('Enable ')) + pedalName(pedal));
      toggle.setAttribute('aria-pressed', String(pedal.enabled));
      toggle.title = gesture().tip;
      item.querySelector('.pedal-state').textContent = pedal.enabled ? 'On' : 'Off';
      const edit = item.querySelector('.pedal-edit');
      edit.textContent = tr('Edit');
      edit.setAttribute('aria-label', tr('Edit ') + pedalName(pedal));
      item.querySelector('.pedal-status').textContent = '';
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
      addTile.querySelector('.add-tile-label').textContent = state.chain.length ? tr('Add next pedal') : tr('Add a pedal here');
      addTile.querySelector('button').onclick = () => library.showModal();
    }
    addTile.querySelector('.add-tile-label').textContent = state.chain.length ? tr('Add next pedal') : tr('Add a pedal here');
    orderList.appendChild(addTile);
    if (previousList) previousList.replaceWith(orderList);
    document.getElementById('empty-chain').hidden = true;
    document.getElementById('empty-board-starts').hidden = state.chain.length > 0;
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
      button.title = tr('Listen here: ') + dotPoint(i).label;
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
      legend.lastChild.textContent = pedal ? pedalName(pedal) + tr(' threshold') : '';
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
    text = tr(text);
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

  function updateSignalMetrics() {
    const samples = monitor === 'dry' ? scopeInput : scopeOutput;
    let peak = 0, energy = 0;
    for (let i = PRE; i < samples.length; i++) { peak = Math.max(peak, Math.abs(samples[i])); energy += samples[i] * samples[i]; }
    const peakDb = linToDb(peak);
    const rmsDb = linToDb(Math.sqrt(energy / VIEW));
    document.getElementById('signal-peak').textContent = tr('Peak ') + fmtDb(peakDb);
    document.getElementById('signal-rms').textContent = 'RMS ' + fmtDb(rmsDb);
    const headroom = document.getElementById('signal-headroom');
    headroom.textContent = peak >= 1 ? tr('Clipping · lower output') : peak > 0 ? fmt(Math.max(0, -peakDb), 1) + tr(' dB headroom') : tr('No signal');
    headroom.classList.toggle('clipping', peak >= 1);
  }

  function drawScope() {
    const { ctx, w, h, dpr } = fit(scopeEl);
    ctx.clearRect(0, 0, w, h);
    updateSignalMetrics();
    if (state.view === 'tone') {
      drawSpectrum(ctx, w, h, scopeInput, scopeOutput, 'scope', true);
      return;
    }
    const mid = h / 2;
    const half = (h / 2) * 0.88;
    const y = (v) => mid - amp(v) * half;

    timeLines(ctx, w, h, h >= 60);

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
      if (h >= 60) label(ctx, text, 6, Math.round(y(v)) - 3, C.ink3);
    }
    ctx.strokeStyle = C.rule;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(w, Math.round(mid) + 0.5);
    ctx.stroke();

    // Waveforms
    const cols = Math.max(1, Math.floor(w * dpr));
    const step = w / cols;
    ctx.globalAlpha = 0.16;
    fillWave(ctx, columns(scopeInput, cols), cols, step, y, C.ink3);
    ctx.globalAlpha = 0.42;
    fillWave(ctx, columns(monitor === 'dry' ? scopeInput : scopeOutput, cols), cols, step, y, C.gate);
    ctx.globalAlpha = 1;

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
      if (h < 60) continue;
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
      (observed('gate') ? pedalName(observed('gate')) : 'Gate') + tr(' · gain'));
    const GR_RANGE = 24;
    lane(rowH, state.compOn, compGR, (gr) => rowH + pad + Math.min(1, -gr / GR_RANGE) * (rowH - pad * 2), C.comp,
      C.compSoft, true, (observed('comp') ? pedalName(observed('comp')) : 'Compressor') + tr(' · reduction (dB)'));
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

    label(ctx, tr('in →'), padL + pw, padT + ph - 5, C.ink3, 'right');
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
    badgeEl.textContent = !pedal.enabled ? tr('Bypassed') : isGate ? tr(entry.processor.state()) : gr < -0.5 ? tr('Compressing') : tr('Idle');
    readEl.textContent = (isGate ? tr('gain ') : 'GR ') + fmtDb(gr);
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
        listening = state.playing = false;
        sendAudioState();
        await audioContext.suspend();
      } else {
        input.fill(0);
        for (const history of Object.values(scopeHistory)) { history.input.fill(0); history.output.fill(0); }
        // MessagePort copies this state, so set playing before sending it.
        listening = state.playing = true;
        sendAudioState();
        await audioContext.resume();
      }
      listen.setAttribute('aria-label', listening ? tr('Pause') : tr('Play'));
      listen.setAttribute('aria-pressed', String(listening));
      listen.classList.toggle('playing', listening);
      audioStatus.textContent = listening ? tr('Listening · tap a dot on the chain to hear that point') : source.kind === 'recording' ? tr('Recording paused') : tr('Synthesized guitar');
      if (!listening) audition = null;
      updateAuditionButtons();
    } catch (error) {
      listening = state.playing = false;
      if (audioContext) await audioContext.close().catch(() => {});
      audioContext = audioNode = null;
      audioStatus.textContent = tr('Audio could not start. Tap Play to try again in Safari or Chrome.');
      announce(audioStatus.textContent);
    } finally { audioStarting = false; listen.disabled = false; }
  };

  /* --------------------------------------------------------------- loop */

  let last = performance.now();
  let carry = 0;
  let lastDraw = 0;

  // While recording, the scope follows the microphone: take the samples that
  // arrived since the last frame from the level meter's analyser, average them
  // down to the engine's sample rate and slide them into the scope's input, so
  // the waveform (and the pedals' effect on it) updates as you play.
  function feedScopeFromMic(dt) {
    const rate = mic.ctx.sampleRate, ratio = rate / SR;
    mic.analyser.getFloatTimeDomainData(mic.buffer);
    const available = Math.min(mic.buffer.length, Math.round(dt * rate));
    const count = Math.min(N, Math.floor(available / ratio));
    if (count < 1) return;
    const first = mic.buffer.length - Math.round(count * ratio);
    input.copyWithin(0, count);
    for (let i = 0; i < count; i++) {
      const lo = first + Math.floor(i * ratio), hi = Math.max(lo + 1, first + Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = lo; j < hi; j++) sum += mic.buffer[j];
      input[N - count + i] = sum / (hi - lo);
    }
    total += count;
    state.dirty = true;
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (riffPhase === 'recording' && mic) feedScopeFromMic(dt);
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

  function updateLanguageButton() {
    const spanish = I18n.language === 'es';
    const button = document.getElementById('switch-language');
    const action = tr(spanish ? 'Switch to English' : 'Switch to Spanish');
    button.setAttribute('aria-label', action);
    button.title = tr('Language') + ': ' + (spanish ? 'Español' : 'English') + ' · ' + action;
    document.getElementById('language-code').textContent = spanish ? 'ES' : 'EN';
  }
  if (I18n) {
    updateLanguageButton();
    document.getElementById('switch-language').onclick = () => I18n.setLanguage(I18n.language === 'en' ? 'es' : 'en');
    I18n.onChange(() => {
      updateLanguageButton();
      // Refresh the UI in place: recordings, playback, edits and tour progress stay live.
      for (const group of patternSelect.querySelectorAll('optgroup')) {
        if (group === recordingGroup) { group.label = tr('Your sound'); continue; }
        const pattern = TL.PATTERNS[group.querySelector('option')?.value];
        if (pattern) group.label = pattern.group;
        for (const option of group.children) option.textContent = TL.PATTERNS[option.value].label;
      }
      if (localRecording) recordingGroup.querySelector('option').textContent = tr('Your recording · ') + localRecording.name;
      renderLibrary();
      renderOrder();
      refreshSlots();
      refreshInspect();
      setScopeExpanded(document.querySelector('.scope-disclosure').classList.contains('scope-expanded'));
      setView(state.view);
      if (!settings.hidden && selected()) {
        const guide = guideSelected;
        openSettings(selected());
        showGuide(guide);
      }
      if (guideDialog.open && selected()) document.getElementById('pedal-guide-title').textContent = pedalName(selected());
      updateAuditionButtons();
      syncPattern();
      listen.setAttribute('aria-label', listening ? tr('Pause') : tr('Play'));
      audioStatus.textContent = listening ? tr('Listening · tap a dot on the chain to hear that point') : source.kind === 'recording' ? tr('Recording paused') : tr('Synthesized guitar');
      renderQuickStart();
      state.dirty = true;
    });
  }

  closeSettings();
  setScopeExpanded(scopePreferences[roomyLayout.matches ? 'roomy' : 'compact']);
  document.getElementById('save-status').textContent = restoreMessage || (storageAvailable ? tr('Autosave enabled') : tr('Local saving unavailable · use Share'));
  saveBoard();
  // Wait until the board and responsive layout are ready before anchoring the tour.
  let quickStartSeen = false;
  try { quickStartSeen = localStorage.getItem(quickStartSeenKey) === '1'; } catch {}
  if (!quickStartSeen) requestAnimationFrame(openQuickStart);
  requestAnimationFrame(frame);
})(window.TL);
