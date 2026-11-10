/*
 * Tonelab UI: builds the controls, runs the signal through the effect chain
 * every frame and draws the scope, the gain lanes and the transfer curves.
 */
(function (TL) {
  'use strict';

  const { SR, dbToLin, linToDb, Source, NoiseGate, Compressor, Overdrive, Delay, compCurve } = TL;

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

  const state = {
    playing: true,
    speed: 1,
    scale: 'db',
    gateOn: true,
    compOn: true,
    gate: {},
    comp: {},
    driveOn: true, delayOn: true, drive: {}, delay: {},
    order: ['gate', 'comp', 'drive', 'delay'],
    dirty: true,
  };

  function buildParams(container, specs, target) {
    for (const p of specs) {
      target[p.key] = p.value;
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
        input.value = Math.round((Math.log(p.value / p.min) / span) * 1000);
        input.addEventListener('input', () => {
          target[p.key] = p.min * Math.exp((input.value / 1000) * span);
          update();
        });
      } else {
        Object.assign(input, { min: p.min, max: p.max, step: p.step, value: p.value });
        input.addEventListener('input', () => {
          target[p.key] = Number(input.value);
          update();
        });
      }
      const update = () => {
        out.textContent = p.format(target[p.key]);
        state.dirty = true;
      };
      out.textContent = p.format(p.value);
      container.appendChild(row);
    }
  }

  buildParams(document.getElementById('gate-params'), GATE_PARAMS, state.gate);
  buildParams(document.getElementById('comp-params'), COMP_PARAMS, state.comp);

  buildParams(document.getElementById('drive-params'), [
    { key: 'drive', label: 'Drive', min: 0, max: 30, step: 0.5, value: 8, format: fmtDb, hint: 'Gain pushed into the soft clipping stage.' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0.4, format: v => Math.round(v * 100) + '%', hint: 'Blend the distorted sound with the original.' },
  ], state.drive);
  buildParams(document.getElementById('delay-params'), [
    { key: 'time', label: 'Time', min: 60, max: 700, step: 1, value: 300, format: fmtMs, hint: 'Time between repeats.' },
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.75, step: 0.01, value: 0.35, format: v => Math.round(v * 100) + '%', hint: 'How much of each echo feeds the next.' },
    { key: 'mix', label: 'Mix', min: 0, max: 0.8, step: 0.01, value: 0.3, format: v => Math.round(v * 100) + '%', hint: 'Balance between the incoming signal and its echoes.' },
  ], state.delay);

  /* ------------------------------------------------------------- toolbar */

  const source = new Source('guitar');

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

  segmented('source', (v) => source.setKind(v));
  segmented('scale', (v) => (state.scale = v));
  segmented('speed', (v) => (state.speed = Number(v)));

  const noise = document.getElementById('noise');
  const noiseOut = document.getElementById('noise-out');
  noise.addEventListener('input', () => {
    source.noiseDb = Number(noise.value);
    state.dirty = true;
    noiseOut.textContent = fmtDb(source.noiseDb);
  });

  const playBtn = document.getElementById('play');
  function setPlaying(on) {
    state.playing = on;
    playBtn.textContent = on ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    state.dirty = true;
  }
  playBtn.addEventListener('click', () => setPlaying(!state.playing));
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    setPlaying(!state.playing);
  });

  function bindSwitch(id, key, fx) {
    const input = document.getElementById(id);
    const sync = () => {
      state[key] = input.checked;
      document.getElementById('fx-' + fx).classList.toggle('off', !input.checked);
      document.querySelector('.chain [data-fx="' + fx + '"]').classList.toggle('off', !input.checked);
      document.querySelector('.lg-' + fx)?.classList.toggle('hidden', !input.checked);
      state.dirty = true;
    };
    input.addEventListener('change', sync);
    sync();
  }
  bindSwitch('gate-on', 'gateOn', 'gate');
  bindSwitch('comp-on', 'compOn', 'comp');
  for (const id of ['drive', 'delay']) {
    const chip = document.createElement('li');
    chip.dataset.fx = id;
    chip.textContent = id === 'drive' ? 'Overdrive' : 'Delay';
    document.querySelector('.chain').insertBefore(chip, document.querySelector('.chain li:last-child'));
    bindSwitch(id + '-on', id + 'On', id);
  }

  const names = { gate: 'Noise gate', comp: 'Compressor', drive: 'Overdrive', delay: 'Delay' };
  const orderList = document.getElementById('effect-order');
  function moveEffect(id, to) {
    const from = state.order.indexOf(id);
    to = Math.max(0, Math.min(state.order.length - 1, to));
    if (from === to) return;
    state.order.splice(from, 1);
    state.order.splice(to, 0, id);
    renderOrder();
    state.dirty = true;
    document.getElementById('order-status').textContent = state.order.map(id => names[id]).join(' → ');
  }
  function renderOrder() {
    state.order.forEach((id, index) => {
      let item = orderList.querySelector('[data-effect="' + id + '"]');
      if (!item) {
        item = document.createElement('li');
        item.dataset.effect = id;
        item.innerHTML = `<button class="drag-handle" aria-label="Drag ${names[id]} or use left and right arrow keys">⠿</button><span>${names[id]}</span><button class="move-before" aria-label="Move ${names[id]} earlier">←</button><button class="move-after" aria-label="Move ${names[id]} later">→</button>`;
        item.querySelector('.move-before').onclick = () => moveEffect(id, state.order.indexOf(id) - 1);
        item.querySelector('.move-after').onclick = () => moveEffect(id, state.order.indexOf(id) + 1);
        const handle = item.querySelector('.drag-handle');
        handle.onkeydown = e => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          moveEffect(id, state.order.indexOf(id) + (e.key === 'ArrowLeft' ? -1 : 1));
          handle.focus();
        };
        handle.onpointerdown = e => {
          if (e.button !== 0) return;
          handle.setPointerCapture(e.pointerId);
          item.classList.add('dragging');
        };
        handle.onpointermove = e => {
          if (!handle.hasPointerCapture(e.pointerId)) return;
          const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-effect]');
          orderList.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
          if (target && target !== item) target.classList.add('drop-target');
        };
        handle.onpointerup = e => {
          const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-effect]');
          if (target && target !== item) moveEffect(id, state.order.indexOf(target.dataset.effect));
          item.classList.remove('dragging');
          orderList.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        };
        handle.onpointercancel = () => {
          item.classList.remove('dragging');
          orderList.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        };
      }
      item.querySelector('.move-before').disabled = index === 0;
      item.querySelector('.move-after').disabled = index === state.order.length - 1;
      orderList.appendChild(item);
      document.querySelector('.effects').appendChild(document.getElementById('fx-' + id));
      const chain = document.querySelector('.chain');
      chain.insertBefore(chain.querySelector('[data-fx="' + id + '"]'), chain.lastElementChild);
    });
  }
  renderOrder();

  /* ------------------------------------------------------------ buffers */

  const input = new Float32Array(N);
  const gateOut = new Float32Array(N);
  const gateGain = new Float32Array(N);
  const compOut = new Float32Array(N);
  const compGR = new Float32Array(N);
  const gate = new NoiseGate();
  const comp = new Compressor();
  const processors = { gate, comp, drive: new Overdrive(), delay: new Delay() };
  const effectOut = { gate: gateOut, comp: new Float32Array(N), drive: new Float32Array(N), delay: new Float32Array(N) };
  const effectIn = {};

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
    let signal = input;
    for (const id of state.order) {
      effectIn[id] = signal;
      const out = effectOut[id];
      const meter = id === 'gate' ? gateGain : id === 'comp' ? compGR : null;
      if (state[id + 'On']) processors[id].process(signal, out, meter, state[id], N);
      else { out.set(signal); if (meter) meter.fill(id === 'gate' ? 1 : 0); }
      signal = out;
    }
    compOut.set(signal);
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
    fillWave(ctx, columns(input, cols), cols, step, y, C.ghost);
    fillWave(ctx, columns(compOut, cols), cols, step, y, C.ink);

    // Thresholds
    const thresholds = [];
    if (state.gateOn) thresholds.push([state.gate.threshold, C.gate, 'GATE', 'left']);
    if (state.compOn) thresholds.push([state.comp.threshold, C.comp, 'COMP', 'right']);
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
      'GATE GAIN  (open ↑ / closed ↓)');
    const GR_RANGE = 24;
    lane(rowH, state.compOn, compGR, (gr) => rowH + pad + Math.min(1, -gr / GR_RANGE) * (rowH - pad * 2), C.comp,
      C.compSoft, true, 'COMP GAIN REDUCTION  (0 to −24 dB ↓)');
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

  const gateCurveEl = document.getElementById('gate-curve');
  const compCurveEl = document.getElementById('comp-curve');
  const gateStateEl = document.getElementById('gate-state');
  const gateReadEl = document.getElementById('gate-readout');
  const compStateEl = document.getElementById('comp-state');
  const compReadEl = document.getElementById('comp-readout');

  function setBadge(el, text, kind) {
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('active', kind === 'active');
    el.classList.toggle('mid', kind === 'mid');
  }

  function drawCurves() {
    // Gate
    const g = state.gate;
    const gIn = peakDb(effectIn.gate || input);
    const gGainDb = linToDb(gateGain[N - 1]);
    drawCurve(gateCurveEl, (x) => (x >= g.threshold ? x : x + g.range), g.threshold, state.gateOn, C.gate,
      [gIn, gIn + gGainDb], trails.gate);
    if (!state.gateOn) setBadge(gateStateEl, 'Bypassed', '');
    else {
      const s = gate.state();
      setBadge(gateStateEl, s, s === 'open' ? 'active' : s === 'closed' ? '' : 'mid');
    }
    gateReadEl.textContent = 'gain ' + (state.gateOn ? fmtDb(Math.max(-80, gGainDb)) : '0 dB');

    // Compressor
    const c = state.comp;
    const cIn = peakDb(effectIn.comp || input);
    const gr = compGR[N - 1];
    const makeup = state.compOn ? c.makeup : 0;
    drawCurve(compCurveEl, (x) => compCurve(x, c) + c.makeup, c.threshold, state.compOn, C.comp,
      [cIn, cIn + gr + makeup], trails.comp);
    if (!state.compOn) setBadge(compStateEl, 'Bypassed', '');
    else setBadge(compStateEl, gr < -0.5 ? 'Compressing' : 'Idle', gr < -0.5 ? 'active' : '');
    compReadEl.textContent = 'GR ' + fmt(gr, 1) + ' dB';
  }

  // Audio runs off the main thread. Its source samples also drive the scope.
  let audioContext, audioNode, listening = false, monitor = 'wet';
  let audioStarting = false;
  const listen = document.getElementById('listen');
  const audioStatus = document.getElementById('audio-status');
  function sendAudioState() {
    audioNode?.port.postMessage({ type: 'settings', state, kind: source.kind,
      noiseDb: source.noiseDb, monitor, volume: Number(document.getElementById('volume').value) });
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
        listening = true;
        sendAudioState();
        await audioContext.resume();
      }
      listen.textContent = listening ? 'Stop listening' : 'Listen';
      listen.setAttribute('aria-pressed', String(listening));
      audioStatus.textContent = listening ? 'Listening · switch between dry input and effects' : 'Sound off · tap Listen to hear the signal';
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
    if (state.dirty) {
      processChain();
      state.dirty = false;
    }
    drawScope();
    drawLanes();
    drawCurves();
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})(window.TL);
