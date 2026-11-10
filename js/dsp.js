/*
 * Tonelab DSP: shared synthesis and effects for the scope and audio worklet.
 * A 24 kHz internal sample rate preserves guitar harmonics; the
 * worklet resamples it for playback.
 */
(function (TL) {
  'use strict';

  const SR = 24000;
  const TAU = Math.PI * 2;

  const dbToLin = (db) => Math.pow(10, db / 20);
  const linToDb = (x) => 20 * Math.log10(Math.max(Math.abs(x), 1e-7));
  // One-pole smoothing coefficient for a time constant in milliseconds.
  const timeCoef = (ms) => (ms <= 0 ? 0 : Math.exp(-1 / (ms * 0.001 * SR)));

  // Small seeded PRNG (mulberry32) so the signal is varied but reproducible.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------------------------------------------- voices */

  function pluck(freq, amp, decay) {
    // Karplus–Strong: a short noise burst circulates through a damped string.
    const length = Math.max(2, Math.round(SR / freq - 0.5));
    const string = new Float32Array(length);
    const random = rng(Math.round(freq * 100 + amp * 10000));
    for (let i = 0; i < length; i++) string[i] = random() * 2 - 1;
    let t = 0, pos = 0;
    const damping = Math.pow(0.001, 1 / (decay * 12 * freq));
    return {
      done: false,
      tick() {
        const sample = string[pos];
        string[pos] = damping * 0.5 * (sample + string[(pos + 1) % length]);
        pos = (pos + 1) % length;
        if (++t > decay * 12 * SR) this.done = true;
        return sample * amp * Math.min(1, t / 12);
      },
    };
  }

  function kick(amp) {
    let t = 0, ph = 0;
    return {
      done: false,
      tick() {
        const sec = t / SR;
        const f = 48 + 110 * Math.exp(-sec / 0.03);
        ph += (TAU * f) / SR;
        const env = amp * Math.min(1, t / 8) * Math.exp(-sec / 0.16);
        if (++t > 1.5 * SR) this.done = true;
        return env * Math.sin(ph);
      },
    };
  }

  function snare(amp, rand) {
    let t = 0;
    return {
      done: false,
      tick() {
        const sec = t / SR;
        const noise = (rand() * 2 - 1) * Math.exp(-sec / 0.09);
        const body = Math.sin(TAU * 185 * sec) * Math.exp(-sec / 0.05);
        if (++t > 0.9 * SR) this.done = true;
        return amp * Math.min(1, t / 6) * (0.65 * noise + 0.45 * body);
      },
    };
  }

  function hat(amp, rand) {
    let t = 0, prev = 0;
    return {
      done: false,
      tick() {
        const n = rand() * 2 - 1;
        const hp = n - prev; // crude high-pass
        prev = n;
        const env = amp * Math.exp(-t / (0.022 * SR));
        if (++t > 0.25 * SR) this.done = true;
        return 0.5 * hp * env;
      },
    };
  }

  function syllable(amp, pitch, dur, rand) {
    const n = dur * SR;
    let t = 0, ph = 0;
    const glide = (rand() - 0.5) * 0.25;
    return {
      done: false,
      tick() {
        const p = t / n;
        const f = pitch * (1 + glide * p) * (1 + 0.012 * Math.sin((TAU * 5.5 * t) / SR));
        ph += (TAU * f) / SR;
        const env = amp * Math.pow(Math.sin(Math.PI * Math.min(1, p)), 0.6);
        const voiced =
          (Math.sin(ph) + 0.7 * Math.sin(2 * ph) + 0.45 * Math.sin(3 * ph) + 0.25 * Math.sin(4 * ph)) / 2.2;
        const consonant = (rand() * 2 - 1) * Math.exp(-t / (0.015 * SR)) * 0.5;
        if (++t >= n) this.done = true;
        return env * (voiced + consonant);
      },
    };
  }

  /* ---------------------------------------------------------------- source */

  const SCALE = [110, 123.5, 146.8, 164.8, 196, 220, 246.9, 293.7, 329.6];
  const ARPEGGIO = [146.8, 220, 293.7, 220, 146.8, 220, 329.6, 220]; // a generic D-based pattern

  class Source {
    constructor(kind) {
      this.kind = kind;
      this.noiseDb = -48;
      this.tempo = 126; // used by the steady-eighths pattern
      this.reset();
    }

    reset() {
      this.rand = rng(1234);
      this.n = 0;
      this.voices = [];
      this.nextEvent = Math.round(0.1 * SR);
      this.step = 0;
      this.phrasePitch = 140;
    }

    setKind(kind) {
      this.kind = kind;
      this.voices = [];
      this.nextEvent = this.n + Math.round(0.05 * SR);
      this.step = 0;
    }

    schedule() {
      const r = this.rand;
      if (this.kind === 'eighths') {
        // Steady eighth notes on a repeating arpeggio, evenly picked.
        const notes = ARPEGGIO[this.step++ % ARPEGGIO.length];
        this.voices.push(pluck(notes, dbToLin(-7 + 1.5 * r()), 0.035)); // short, choppy picks
        this.nextEvent = this.n + Math.round(SR * 30 / this.tempo);
      } else if (this.kind === 'guitar') {
        const amp = 1.4 * dbToLin(-18 + 18 * r());
        const decay = 0.08 + 0.22 * r(); // time constant of the exponential decay
        const notes = r() < 0.3 ? 2 : 1;
        for (let i = 0; i < notes; i++) {
          this.voices.push(pluck(SCALE[Math.floor(r() * SCALE.length)], amp / Math.sqrt(notes), decay));
        }
        // Mostly steady picking, with the odd rest so the signal falls back to the noise floor.
        this.nextEvent = this.n + Math.round(SR * (r() < 0.2 ? 1.1 + r() * 0.8 : 0.3 + r() * 0.5));
      } else if (this.kind === 'drums') {
        const s = this.step % 8;
        if (s === 0 || s === 4 || (s === 5 && r() < 0.4)) this.voices.push(kick(dbToLin(-4 + 4 * r())));
        if (s === 2 || s === 6) this.voices.push(snare(dbToLin(-12 + 10 * r()), r));
        else if (r() < 0.15) this.voices.push(snare(dbToLin(-26 + 4 * r()), r)); // ghost note
        if (r() < 0.85) this.voices.push(hat(dbToLin(-20 + 6 * r()), r));
        this.step++;
        this.nextEvent = this.n + Math.round(SR * 0.3); // eighth notes at 100 BPM
      } else {
        // "voice": syllables in phrases with pauses between them
        const dur = 0.1 + 0.25 * r();
        this.voices.push(syllable(dbToLin(-20 + 20 * r()), this.phrasePitch, dur, r));
        let gap = 0.03 + 0.1 * r();
        if (r() < 0.18) {
          gap = 0.45 + 0.6 * r();
          this.phrasePitch = 110 + 90 * r();
        }
        this.nextEvent = this.n + Math.round(SR * (dur + gap));
      }
    }

    // Write `count` new samples into `out` starting at `offset`.
    generate(out, offset, count) {
      const nl = dbToLin(this.noiseDb);
      const r = this.rand;
      for (let i = 0; i < count; i++) {
        if (this.n >= this.nextEvent) this.schedule();
        let s = 0;
        for (let v = this.voices.length - 1; v >= 0; v--) {
          const voice = this.voices[v];
          s += voice.tick();
          if (voice.done) this.voices.splice(v, 1);
        }
        // Noise floor: hiss plus mains hum, like a real pickup or mic.
        const sec = this.n / SR;
        const floor = nl * (0.7 * (r() * 2 - 1) + 0.45 * Math.sin(TAU * 60 * sec) + 0.2 * Math.sin(TAU * 180 * sec));
        out[offset + i] = Math.tanh(s + floor);
        this.n++;
      }
    }
  }

  /* --------------------------------------------------------------- effects */

  // Every effect reads the full set of controls for its family (see the
  // pedal models in app.js). A control a pedal doesn't show keeps its
  // default, and every default reproduces the effect's original sound.
  const opt = (v, d) => (v === undefined || v === null || Number.isNaN(v) ? d : v);
  const onePole = f => 1 - Math.exp(-TAU * Math.min(Math.max(f, 1), SR * 0.45) / SR);

  // RBJ-cookbook biquads: peak, low/high shelf (slope 1), low/high pass.
  function biquad(kind, f, gainDb = 0, q = 0.707) {
    f = Math.min(Math.max(f, 10), SR * 0.45);
    const A = Math.pow(10, gainDb / 40), w = TAU * f / SR, cw = Math.cos(w), sw = Math.sin(w);
    let b0, b1, b2, a0, a1, a2;
    if (kind === 'peak') {
      const alpha = sw / (2 * q);
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
    } else if (kind === 'low' || kind === 'high') {
      const s = 2 * Math.sqrt(A) * (sw / 2) * Math.SQRT2, sign = kind === 'low' ? 1 : -1;
      b0 = A * ((A + 1) - sign * (A - 1) * cw + s);
      b1 = sign * 2 * A * ((A - 1) - sign * (A + 1) * cw);
      b2 = A * ((A + 1) - sign * (A - 1) * cw - s);
      a0 = (A + 1) + sign * (A - 1) * cw + s;
      a1 = -sign * 2 * ((A - 1) + sign * (A + 1) * cw);
      a2 = (A + 1) + sign * (A - 1) * cw - s;
    } else {
      const alpha = sw / (2 * q);
      if (kind === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
      else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  class Filter {
    constructor() { this.z1 = 0; this.z2 = 0; }
    run(c, x) {
      const y = c[0] * x + this.z1;
      this.z1 = c[1] * x - c[3] * y + this.z2;
      this.z2 = c[2] * x - c[4] * y;
      return y;
    }
  }
  const IDENTITY = [1, 0, 0, 0, 0];
  // Bass and treble shelves around a pedal's clipper or output (0 dB = off).
  const shelves = (bass, treble) => [bass ? biquad('low', 120, bass) : IDENTITY, treble ? biquad('high', 3000, treble) : IDENTITY];

  /* Noise gate. Modes: 0 Mute (a full gate), 1 Reduce (a gentle downward
   * expander), 2 Multiband (gates only the highs above Tone, where hiss lives). */
  const GATE_HYSTERESIS_DB = 3;
  class NoiseGate {
    reset() { this.env = 0; this.gain = 0; this.hold = 0; this.open = false; this.split = [new Filter(), new Filter()]; }
    process(inp, out, gainOut, p, n, reset = true) {
      if (reset) this.reset();
      const thrOpen = dbToLin(p.threshold), thrClose = dbToLin(p.threshold - GATE_HYSTERESIS_DB);
      const mode = Math.round(opt(p.mode, 0));
      const floor = dbToLin(mode === 1 ? Math.max(p.range, -20) : p.range);
      const aC = timeCoef(p.attack), rC = timeCoef(p.release), dC = timeCoef(30);
      const holdN = Math.round(p.hold * 0.001 * SR);
      const splitC = biquad('lp', opt(p.tone, 3000), 0, 0.707);
      let { env, gain, hold, open } = this;
      for (let i = 0; i < n; i++) {
        const x = inp[i], a = Math.abs(x);
        env = a > env ? a : env * dC;
        if (!open && env >= thrOpen) open = true;
        else if (open && env < thrClose) open = false;
        let target;
        if (open) { hold = holdN; target = 1; }
        else if (hold > 0) { hold--; target = 1; }
        else target = mode === 1 ? Math.max(floor, Math.min(1, Math.pow(env / thrOpen, 1.5))) : floor;
        gain = target + (gain - target) * (target > gain ? aC : rC);
        if (mode === 2) {
          // Steep split: the gate only touches what's above Tone.
          const lp = this.split[1].run(splitC, this.split[0].run(splitC, x));
          out[i] = lp + (x - lp) * gain;
        } else out[i] = x * gain;
        gainOut[i] = gain;
      }
      Object.assign(this, { env, gain, hold, open });
    }
    state() {
      if (this.open) return 'open';
      if (this.hold > 0) return 'hold';
      return this.gain > 0.5 ? 'closing' : 'closed';
    }
  }

  // Static curve of a compressor: input level (dB) -> output level (dB), soft knee.
  function compCurve(x, p) {
    const T = p.threshold, R = p.ratio, W = p.knee;
    const d = x - T;
    if (2 * d < -W) return x;
    if (W > 0 && 2 * Math.abs(d) <= W) return x + ((1 / R - 1) * (d + W / 2) * (d + W / 2)) / (2 * W);
    return T + d / R;
  }

  /* Compressor, plus Input (a pickup trim before it), Tone (a treble tilt
   * after it) and Blend (mixes the uncompressed signal back in). */
  class Compressor {
    reset() { this.gr = 0; this.tone = new Filter(); }
    process(inp, out, grOut, p, n, reset = true) {
      if (reset) this.reset();
      const aC = timeCoef(p.attack), rC = timeCoef(p.release), makeup = dbToLin(p.makeup);
      const input = dbToLin(opt(p.input, 0)), blend = opt(p.blend, 1), tilt = (opt(p.tone, 0.5) - 0.5) * 16;
      const toneC = tilt ? biquad('high', 2000, tilt) : IDENTITY;
      let gr = this.gr;
      for (let i = 0; i < n; i++) {
        const x = inp[i] * input;
        const xdB = linToDb(x);
        const g = compCurve(xdB, p) - xdB;
        gr = g < gr ? aC * gr + (1 - aC) * g : rC * gr + (1 - rC) * g;
        const wet = this.tone.run(toneC, x * dbToLin(gr) * makeup);
        out[i] = x * (1 - blend) + wet * blend;
        grOut[i] = gr;
      }
      this.gr = gr;
    }
  }

  /* EQ: Bass, Mids and Treble bands (each with its own frequency and width:
   * wide bass/treble are shelves, narrow ones peaks), Presence, a 7-band
   * graphic section and an output Level. 0 dB bands do nothing. */
  const GRAPHIC = [100, 200, 400, 800, 1600, 3200, 6400];
  function eqFilters(p) {
    const band = (kind, f, g, q) => (q > 1 ? biquad('peak', f, g, q) : biquad(kind, f, g));
    return [
      band('low', opt(p.bassFreq, 120), opt(p.bass, 0), opt(p.bassQ, 0.7)),
      biquad('peak', opt(p.midFreq, 800), opt(p.mid, 0), opt(p.midQ, 1)),
      band('high', opt(p.trebleFreq, 3000), opt(p.treble, 0), opt(p.trebleQ, 0.7)),
      biquad('high', 5000, opt(p.presence, 0)),
      ...GRAPHIC.map(f => biquad('peak', f, opt(p['g' + f], 0), 1.4)),
    ];
  }
  // The EQ's boost or cut at one frequency, in dB (used to draw its sliders).
  function eqResponse(p, f) {
    const w = TAU * f / SR;
    let db = opt(p.level, 0);
    for (const [b0, b1, b2, a1, a2] of eqFilters(p)) {
      const re = (c0, c1, c2) => c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w);
      const im = (c1, c2) => -c1 * Math.sin(w) - c2 * Math.sin(2 * w);
      db += 20 * Math.log10(Math.hypot(re(b0, b1, b2), im(b1, b2)) / Math.hypot(re(1, a1, a2), im(a1, a2)));
    }
    return db;
  }
  class Equalizer {
    reset() { this.f = Array.from({ length: 4 + GRAPHIC.length }, () => new Filter()); }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const filters = eqFilters(p), g = dbToLin(opt(p.level, 0));
      for (let i = 0; i < n; i++) {
        let x = inp[i];
        for (let k = 0; k < filters.length; k++) x = this.f[k].run(filters[k], x);
        out[i] = x * g;
      }
    }
  }

  /* Boost: clean gain, then Bass/Treble and a Voicing (0 Clean, 1 Fat: more
   * low mids, 2 Mid: a mid push), and an output Level. */
  class Boost {
    reset() { this.f = [new Filter(), new Filter(), new Filter()]; }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const g = dbToLin(p.boost) * dbToLin(opt(p.level, 0));
      const voicing = Math.round(opt(p.voicing, 0));
      const [bassC, trebleC] = shelves(opt(p.bass, 0), opt(p.treble, 0));
      const voiceC = voicing === 1 ? biquad('low', 250, 5) : voicing === 2 ? biquad('peak', 800, 5, 0.8) : IDENTITY;
      for (let i = 0; i < n; i++) out[i] = this.f[2].run(voiceC, this.f[1].run(trebleC, this.f[0].run(bassC, inp[i] * g)));
    }
  }

  /* Overdrive: soft clipping. Clipping 0 Symmetrical, 1 Asymmetrical, 2 LED
   * (harder, more headroom). Voicing 0 Flat, 1 Mid hump (Tube Screamer-style:
   * lows cut before the clipper), 2 HP (brighter, tighter), 3 LP (smoother).
   * Tone is a treble roll-off after it; Bass/Treble shelves; Level; Mix. */
  function softClip(x, kind) {
    if (kind === 1) return x > 0 ? Math.tanh(x) : Math.tanh(0.6 * x) / 0.75;
    if (kind === 2) return x / Math.pow(1 + Math.pow(Math.abs(x), 4), 0.25);
    return Math.tanh(x);
  }
  class Overdrive {
    reset() { this.pre = 0; this.post = new Filter(); this.f = [new Filter(), new Filter()]; }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const drive = dbToLin(p.drive), clip = Math.round(opt(p.clipping, 0)), voicing = Math.round(opt(p.voicing, 0));
      const norm = 1 / softClip(drive, clip);
      const preCut = voicing === 1 ? onePole(720) : voicing === 2 ? onePole(300) : 0;
      const tone = opt(p.tone, 1);
      let cutoff = tone >= 0.999 ? 0 : 700 * Math.pow(14, tone);
      if (voicing === 3) cutoff = Math.min(cutoff || 3000, 3000);
      const postC = cutoff ? biquad('lp', cutoff, 0, 0.707) : IDENTITY;
      const [bassC, trebleC] = shelves(opt(p.bass, 0), opt(p.treble, 0));
      const level = dbToLin(opt(p.level, 0)), mix = p.mix;
      let pre = this.pre;
      for (let i = 0; i < n; i++) {
        const x = inp[i];
        let driven = x;
        if (preCut) { pre += (x - pre) * preCut; driven = x - 0.8 * pre; }
        let wet = this.post.run(postC, softClip(driven * drive, clip) * norm);
        wet = this.f[1].run(trebleC, this.f[0].run(bassC, wet));
        out[i] = (x * (1 - mix) + wet * mix) * level;
      }
      this.pre = pre;
    }
  }

  /* Distortion: hard clipping. Weight cuts lows before the clipper and Tight
   * cuts them harder (tighter palm mutes); Tone, Bass/Mid/Treble after it. */
  class Distortion {
    reset() { this.lp1 = 0; this.lp2 = 0; this.pre = [new Filter(), new Filter()]; this.post = [new Filter(), new Filter(), new Filter()]; }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const g = dbToLin(p.gain), level = dbToLin(p.level);
      const c = onePole(600 * Math.pow(12, p.tone));
      const weight = opt(p.weight, 20), tight = Math.round(opt(p.tight, 0));
      const weightC = weight > 25 ? biquad('hp', weight, 0, 0.707) : IDENTITY;
      const tightC = tight ? biquad('hp', 180, 0, 0.9) : IDENTITY;
      const [bassC, trebleC] = shelves(opt(p.bass, 0), opt(p.treble, 0));
      const midC = opt(p.mid, 0) ? biquad('peak', opt(p.midFreq, 800), p.mid, 0.9) : IDENTITY;
      let { lp1, lp2 } = this;
      for (let i = 0; i < n; i++) {
        const x = Math.max(-1, Math.min(1, this.pre[1].run(tightC, this.pre[0].run(weightC, inp[i])) * g));
        lp1 += (x - lp1) * c;
        lp2 += (lp1 - lp2) * c;
        out[i] = this.post[2].run(trebleC, this.post[1].run(midC, this.post[0].run(bassC, lp2))) * level;
      }
      Object.assign(this, { lp1, lp2 });
    }
  }

  /* Fuzz: huge gain into asymmetric clipping. Type 0 Silicon (bright, tight)
   * or 1 Germanium (warmer, softer). Bias moves where it clips (low bias
   * sputters); Gate starves quiet notes; Compress adds sustain; low
   * Stability lets it squeal. */
  class Fuzz {
    reset() { this.dcX = 0; this.dcY = 0; this.lp = 0; this.env = 0; this.ph = 0; }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const germanium = Math.round(opt(p.type, 0)) === 1;
      const gain = dbToLin(p.fuzz - (germanium ? 6 : 0)), level = dbToLin(p.level);
      const lpC = onePole(500 * Math.pow(14, p.tone) * (germanium ? 0.6 : 1));
      const dcC = Math.exp(-TAU * 15 / SR);
      const bias = 0.12 + (opt(p.bias, 0.5) - 0.5) * 0.8;
      const gateThr = opt(p.gate, 0) > 0 ? dbToLin(-60 + 45 * p.gate) : 0;
      const compress = opt(p.compress, 0), squeal = 1 - opt(p.stability, 1);
      const envC = timeCoef(40);
      let { dcX, dcY, lp, env, ph } = this;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(inp[i]);
        env = a > env ? a : env * envC;
        let x = inp[i] * gain * (1 + compress * 4 * Math.max(0, 1 - env * 6));
        if (squeal > 0) { ph += 1400 / SR; if (ph >= 1) ph -= 1; x += squeal * 0.8 * Math.sin(TAU * ph) * Math.min(1, env * 20); }
        x += bias;
        let clipped = germanium ? (x > 0 ? Math.tanh(0.9 * x) : Math.tanh(0.6 * x) * 0.85)
          : x > 0 ? Math.min(1, Math.tanh(1.2 * x)) : Math.max(-0.75, Math.tanh(0.8 * x));
        if (gateThr && env < gateThr) clipped *= env / gateThr;
        dcY = clipped - dcX + dcC * dcY;
        dcX = clipped;
        lp += (dcY - lp) * lpC;
        out[i] = lp * level;
      }
      Object.assign(this, { dcX, dcY, lp, env, ph });
    }
  }

  /* Wah: a resonant filter swept from heel (dark) to toe (bright). Mode
   * 0 held still, 1 follows your picking (envelope filter / auto-wah),
   * 2 rocks by itself. Filter 0 band-pass, 1 low-pass, 2 high-pass;
   * Direction 0 up / 1 down (for the envelope); Range (Contour) shifts the
   * sweep; Level. */
  class Wah {
    reset() { this.ic1 = 0; this.ic2 = 0; this.env = 0; this.phase = 0; this.f = 0; }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const mode = Math.round(p.mode), k = 1 / p.resonance, sens = dbToLin(p.sensitivity);
      const type = Math.round(opt(p.filter, 0)), down = Math.round(opt(p.direction, 0)) === 1;
      const shift = Math.pow(2, (opt(p.range, 0.5) - 0.5) * 2), lo = 350 * shift, hi = 2200 * shift;
      const level = dbToLin(opt(p.level, 0));
      const envA = timeCoef(3), envR = timeCoef(150), smooth = 1 - Math.exp(-1 / (0.004 * SR));
      if (!this.f) this.f = lo * Math.pow(hi / lo, p.position);
      for (let i = 0; i < n; i++) {
        const x = inp[i], a = Math.abs(x);
        this.env = a > this.env ? envA * this.env + (1 - envA) * a : envR * this.env + (1 - envR) * a;
        let t = p.position;
        if (mode === 1) { t = Math.min(1, this.env * sens * 1.5); if (down) t = 1 - t; }
        else if (mode === 2) { t = 0.5 - 0.5 * Math.cos(TAU * this.phase); this.phase += p.speed / SR; if (this.phase >= 1) this.phase -= 1; }
        this.f += (lo * Math.pow(hi / lo, t) - this.f) * smooth;
        const g = Math.tan(Math.PI * Math.min(this.f, SR * 0.45) / SR);
        const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
        const v3 = x - this.ic2, v1 = a1 * this.ic1 + a2 * v3, v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
        this.ic1 = 2 * v1 - this.ic1;
        this.ic2 = 2 * v2 - this.ic2;
        const y = type === 1 ? v2 : type === 2 ? x - k * v1 - v2 : 1.6 * k * v1 + 0.1 * v2;
        out[i] = y * level;
      }
    }
  }

  /* Harmonizer: each voice plays the recent signal back from a delay line.
   * Reading faster or slower than it was written shifts the pitch. When the
   * read head runs out of room it jumps back by roughly one window, to the
   * spot whose waveform best matches what it just played, and crossfades.
   * Mode 0 Fixed (Voice 1/2 in semitones); 1 Major, 2 Minor: the voices are
   * Harmony 1/2 steps in the Key's scale, so the interval follows the note
   * you play (a third above might be 3 or 4 semitones). */
  const HARM_MIN_DELAY = 4;
  const HARM_FADE = Math.round(0.008 * SR);
  const HARM_MATCH = Math.round(0.006 * SR);
  const SCALES = { 1: [0, 2, 4, 5, 7, 9, 11], 2: [0, 2, 3, 5, 7, 8, 10] };
  // Semitones from `midi` to the note `steps` scale steps away in key/scale.
  function diatonicShift(midi, key, scale, steps) {
    const rel = ((midi - key) % 12 + 12) % 12;
    let degree = 0;
    for (let d = 0; d < 7; d++) if (Math.abs(scale[d] - rel) < Math.abs(scale[degree] - rel)) degree = d;
    const target = degree + steps;
    const octave = Math.floor(target / 7);
    return scale[((target % 7) + 7) % 7] + 12 * octave - rel;
  }
  class Harmonizer {
    reset() {
      this.buffer = new Float32Array(Math.round(SR * 0.4));
      this.pos = 0;
      this.voices = [0, 1].map(() => ({ d: -1, old: 0, fade: 0 }));
      this.track = { lp1: 0, lp2: 0, armed: true, since: 0, midi: 0, env: 0 };
    }
    read(d) {
      const buf = this.buffer, L = buf.length;
      const at = this.pos - d;
      let i0 = Math.floor(at);
      const frac = at - i0;
      if (i0 < 0) i0 += L;
      const i1 = i0 + 1 === L ? 0 : i0 + 1;
      return buf[i0] + (buf[i1] - buf[i0]) * frac;
    }
    bestDelay(d, lo, hi, ratio) {
      const buf = this.buffer, L = buf.length;
      const count = HARM_MATCH >> 1;
      const offsets = new Int32Array(count);
      const ref = new Float32Array(count);
      for (let k = 0; k < count; k++) {
        offsets[k] = Math.round(2 * k * ratio);
        let idx = Math.round(this.pos - d) - offsets[k];
        idx %= L; if (idx < 0) idx += L;
        ref[k] = buf[idx];
      }
      let best = (lo + hi) / 2, bestScore = -Infinity;
      for (let c = Math.round(lo); c <= hi; c += 2) {
        let start = (this.pos - c) % L;
        if (start < 0) start += L;
        let dot = 0, energy = 1e-9;
        for (let k = 0; k < count; k++) {
          let idx = start - offsets[k];
          if (idx < 0) idx += L;
          const b = buf[idx];
          dot += ref[k] * b;
          energy += b * b;
        }
        const score = dot / Math.sqrt(energy);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      return best;
    }
    // Cheap pitch tracking: time between rising zero crossings of the low-passed signal.
    trackPitch(x) {
      const t = this.track, c = 1 - Math.exp(-TAU * 500 / SR);
      t.lp1 += (x - t.lp1) * c;
      t.lp2 += (t.lp1 - t.lp2) * c;
      t.env = Math.max(Math.abs(t.lp2), t.env * 0.999);
      t.since++;
      const h = 0.2 * t.env;
      if (t.armed && t.lp2 > h) {
        t.armed = false;
        const f = SR / t.since;
        if (f > 70 && f < 1200 && t.env > 1e-3) t.midi = Math.round(69 + 12 * Math.log2(f / 440));
        t.since = 0;
      } else if (t.lp2 < -h) t.armed = true;
    }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const W = Math.max(HARM_FADE * 2, Math.round(p.window * 0.001 * SR));
      const mode = Math.round(opt(p.mode, 0)), scale = SCALES[mode], key = Math.round(opt(p.key, 0));
      const levels = [opt(p.level1, 1), opt(p.level2, 1)];
      const fixed = p.voice2 !== 0 ? [p.voice1, p.voice2] : [p.voice1];
      const steps = [opt(p.steps1, 2), opt(p.steps2, 4)];
      const count = scale ? (steps[1] !== 0 ? 2 : 1) : fixed.length;
      const F = HARM_FADE;
      let ratios = fixed.map(st => Math.pow(2, st / 12)), lastMidi = -1;
      for (let i = 0; i < n; i++) {
        this.buffer[this.pos] = inp[i];
        if (scale) {
          this.trackPitch(inp[i]);
          if (this.track.midi !== lastMidi) {
            lastMidi = this.track.midi;
            ratios = steps.slice(0, count).map(s => Math.pow(2, diatonicShift(lastMidi, key, scale, s) / 12));
          }
        }
        let wet = 0;
        for (let v = 0; v < count; v++) {
          const ratio = ratios[v], step = 1 - ratio, voice = this.voices[v];
          if (voice.d < 0) voice.d = HARM_MIN_DELAY + W / 2;
          voice.d += step;
          let y = this.read(voice.d);
          if (voice.fade > 0) {
            voice.old += step;
            const t = 1 - voice.fade / F;
            y = y * t + this.read(voice.old) * (1 - t);
            voice.fade--;
          } else if (step < 0 && voice.d < HARM_MIN_DELAY + F * -step + 1) {
            voice.old = voice.d;
            voice.d = this.bestDelay(voice.d, voice.d + W / 2, voice.d + W, ratio);
            voice.fade = F;
          } else if (step > 0 && voice.d > HARM_MIN_DELAY + W * 1.5 - F * step - 1) {
            voice.old = voice.d;
            voice.d = this.bestDelay(voice.d, Math.max(HARM_MIN_DELAY + 1, voice.d - W), voice.d - W / 2, ratio);
            voice.fade = F;
          }
          wet += y * levels[v];
        }
        out[i] = inp[i] * (1 - p.mix) + (wet / count) * p.mix;
        if (++this.pos === this.buffer.length) this.pos = 0;
      }
    }
  }

  /* Octave: analog-style octave down (flip-flop), a second octave down
   * (Sub 2) and octave up (rectifier), with Range for higher notes. It can
   * also add a pitch-shifted voice (Whammy-style): Interval × Treadle, plus
   * Detune in cents, at the Shift level. */
  class Octave {
    reset() {
      Object.assign(this, { lp1: 0, lp2: 0, env: 0, flip: 1, flip2: 1, armed: true, sub: 0, sub2: 0, rectX: 0, rectY: 0 });
      this.shifter = new Harmonizer();
      this.shifter.reset();
      this.tmp = null;
    }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const lpC = onePole(Math.round(opt(p.range, 0)) === 1 ? 900 : 450), subC = onePole(1200);
      const dcC = Math.exp(-TAU * 30 / SR), envA = timeCoef(1), envR = timeCoef(80);
      const sub2Level = opt(p.sub2, 0), shiftLevel = opt(p.shift, 0);
      let shifted = null;
      if (shiftLevel > 0) {
        if (!this.tmp || this.tmp.length < n) this.tmp = new Float32Array(n);
        const st = opt(p.interval, 12) * opt(p.treadle, 1) + opt(p.detune, 0) / 100;
        this.shifter.process(inp, this.tmp, null, { voice1: st, voice2: 0, mix: 1, window: 50 }, n, false);
        shifted = this.tmp;
      }
      let { lp1, lp2, env, flip, flip2, armed, sub, sub2, rectX, rectY } = this;
      for (let i = 0; i < n; i++) {
        const x = inp[i];
        lp1 += (x - lp1) * lpC;
        lp2 += (lp1 - lp2) * lpC;
        const a = Math.abs(lp2);
        env = a > env ? envA * env + (1 - envA) * a : envR * env + (1 - envR) * a;
        const h = 0.25 * env;
        if (armed && lp2 > h) { flip = -flip; if (flip > 0) flip2 = -flip2; armed = false; }
        else if (lp2 < -h) armed = true;
        sub += (flip * env * 1.6 - sub) * subC;
        sub2 += (flip2 * env * 1.6 - sub2) * subC;
        const rect = Math.abs(x);
        rectY = rect - rectX + dcC * rectY;
        rectX = rect;
        out[i] = x * p.dry + sub * p.sub + sub2 * sub2Level + rectY * 1.4 * p.up + (shifted ? shifted[i] * shiftLevel : 0);
      }
      Object.assign(this, { lp1, lp2, env, flip, flip2, armed, sub, sub2, rectX, rectY });
    }
  }

  /* Chorus and flanger: a copy whose delay (and so pitch) wobbles. Manual
   * sets the base delay (short = flanger), Feedback adds resonance, Wave is
   * sine or triangle, Voice 0 Standard, 1 Vintage (warmer, CE-1 style),
   * 2 Vibrato (the wobbling copy only). */
  class Chorus {
    reset() { this.buf = new Float32Array(Math.round(SR * 0.04)); this.pos = 0; this.phase = 0; this.lp = 0; this.last = 0; }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const L = this.buf.length, base = opt(p.manual, 12) * 0.001 * SR, depth = p.depth * 0.004 * SR, inc = p.rate / SR;
      const fb = opt(p.feedback, 0), tri = Math.round(opt(p.wave, 0)) === 1, voice = Math.round(opt(p.voice, 0));
      const warm = onePole(4000);
      for (let i = 0; i < n; i++) {
        this.buf[this.pos] = inp[i] + this.last * fb;
        const lfo = tri ? 1 - 4 * Math.abs(this.phase - 0.5) : Math.sin(TAU * this.phase);
        const at = this.pos - Math.max(1, base + depth * (0.5 + 0.5 * lfo));
        let i0 = Math.floor(at);
        const frac = at - i0;
        if (i0 < 0) i0 += L;
        const i1 = i0 + 1 === L ? 0 : i0 + 1;
        let wet = this.buf[i0] + (this.buf[i1] - this.buf[i0]) * frac;
        this.last = wet;
        if (voice === 1) { this.lp += (Math.tanh(1.5 * wet) / 1.5 - this.lp) * warm; wet = this.lp; }
        out[i] = voice === 2 ? wet : inp[i] * (1 - 0.5 * p.mix) + wet * 0.5 * p.mix;
        if (++this.pos === L) this.pos = 0;
        this.phase += inc;
        if (this.phase >= 1) this.phase -= 1;
      }
    }
  }

  /* Phaser and Uni-Vibe: sweeping allpass stages (4 or 8) mixed with the dry
   * signal. Mode 0 Phaser, 1 Vibe chorus (staggered stages, throbbing
   * sweep), 2 Vibe vibrato (the swept signal only). */
  const VIBE_SPREAD = [1, 2.2, 4.6, 9.5, 1.4, 3.1, 6.3, 12];
  class Phaser {
    reset() { this.x1 = new Float64Array(8); this.y1 = new Float64Array(8); this.phase = 0; this.last = 0; this.tick = 0; this.coefs = new Float64Array(8); }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const inc = p.rate / SR, span = 1 + 3 * p.depth, fb = p.feedback * 0.7;
      const stages = Math.round(opt(p.stages, 4)) === 8 ? 8 : 4, mode = Math.round(opt(p.mode, 0));
      const level = dbToLin(opt(p.level, 0)), coefs = this.coefs;
      for (let i = 0; i < n; i++) {
        let lfo = 0.5 - 0.5 * Math.cos(TAU * this.phase);
        if (mode) lfo = Math.pow(lfo, 1.7);
        // The sweep is slow: the new modes refresh their stages every 8 samples.
        if (!(stages === 8 || mode) || (this.tick = (this.tick + 1) & 7) === 0 || !coefs[0]) {
          const f = (mode ? 120 : 250) * Math.pow(2, span * lfo);
          for (let k = 0; k < stages; k++) {
            const t = Math.tan(Math.PI * Math.min(f * (mode ? VIBE_SPREAD[k] : 1), SR * 0.45) / SR);
            coefs[k] = (t - 1) / (t + 1);
          }
        }
        let s = inp[i] + this.last * (mode ? 0 : fb);
        for (let k = 0; k < stages; k++) {
          const a = coefs[k], y = a * s + this.x1[k] - a * this.y1[k];
          this.x1[k] = s;
          this.y1[k] = y;
          s = y;
        }
        this.last = s;
        out[i] = (mode === 2 ? s : 0.5 * (inp[i] + s)) * level;
        this.phase += inc;
        if (this.phase >= 1) this.phase -= 1;
      }
    }
  }

  /* Tremolo: Wave 0 smooth-to-choppy (Shape), 1 Square, 2 Ramp; Mode
   * 0 Standard (tube bias), 1 Harmonic (lows and highs pulse in turn),
   * 2 Photo (an optical cell's softer, lopsided pulse); Level. */
  class Tremolo {
    reset() { this.phase = 0; this.lp = 0; }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const inc = p.rate / SR, wave = Math.round(opt(p.wave, 0)), mode = Math.round(opt(p.mode, 0));
      const hard = wave === 1 ? 40 : 1 + 30 * p.shape * p.shape, level = dbToLin(opt(p.level, 0)), split = onePole(600);
      for (let i = 0; i < n; i++) {
        let s = wave === 2 ? 1 - 2 * this.phase : Math.tanh(hard * Math.sin(TAU * this.phase)) / Math.tanh(hard);
        if (mode === 2) s = 2 * Math.pow(0.5 + 0.5 * s, 2.2) - 1;
        const g = 1 - p.depth * (0.5 - 0.5 * s);
        const x = inp[i];
        if (mode === 1) {
          this.lp += (x - this.lp) * split;
          out[i] = (this.lp * g + (x - this.lp) * (1 - p.depth * (0.5 + 0.5 * s))) * level;
        } else out[i] = x * g * level;
        this.phase += inc;
        if (this.phase >= 1) this.phase -= 1;
      }
    }
  }

  /* Volume swell: each new pick drops the volume to zero and fades it back
   * in. Curve 0 Smooth (slow start), 1 Linear; Level. */
  class Swell {
    reset() { this.fast = 0; this.slow = 0; this.gain = 1; this.armed = true; }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const thr = dbToLin(p.sensitivity), riseInc = 1 / Math.max(1, p.rise * 0.001 * SR);
      const fastC = timeCoef(3), slowC = timeCoef(60), linear = Math.round(opt(p.curve, 0)) === 1, level = dbToLin(opt(p.level, 0));
      let { fast, slow, gain, armed } = this;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(inp[i]);
        fast = Math.max(a, fast * fastC);
        slow = slowC * slow + (1 - slowC) * fast;
        if (armed && fast > thr && fast > 2.5 * slow) { gain = 0; armed = false; }
        else if (!armed && fast < 1.5 * slow) armed = true;
        gain = Math.min(1, gain + riseInc);
        out[i] = inp[i] * (linear ? gain : gain * gain) * level;
      }
      Object.assign(this, { fast, slow, gain, armed });
    }
  }

  /* Delay. Type 0 Digital, 1 Analog (darker, saturated repeats), 2 Tape
   * (wobbling, warm), 3 Reverse (each slice plays backwards). Character
   * darkens every repeat; Subdivision scales Time (quarter, eighth, dotted
   * eighth, triplet); Range caps Time; Mod Speed/Depth wobble the repeats. */
  const SUBDIVISIONS = [1, 0.5, 0.75, 2 / 3];
  class Delay {
    reset() { this.buffer = new Float32Array(Math.round(SR * 2.1)); this.pos = 0; this.lp = 0; this.mod = 0; this.chunk = 0; }
    readAt(d) {
      const L = this.buffer.length, at = this.pos - d;
      let i0 = Math.floor(at);
      const frac = at - i0;
      i0 = ((i0 % L) + L) % L;
      const i1 = i0 + 1 === L ? 0 : i0 + 1;
      return this.buffer[i0] + (this.buffer[i1] - this.buffer[i0]) * frac;
    }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const type = Math.round(opt(p.type, 0));
      const time = Math.min(p.time, opt(p.range, 2000)) * SUBDIVISIONS[Math.round(opt(p.subdivision, 0))] || p.time;
      const lag = Math.max(1, time * SR / 1000);
      let character = opt(p.character, 0);
      if (type === 1) character = Math.max(character, 0.55);
      if (type === 2) character = Math.max(character, 0.3);
      const lpC = onePole(11000 * Math.pow(1500 / 11000, character));
      const drive = 1 + 2 * character;
      let modDepth = opt(p.modDepth, 0) * 0.003 * SR, modRate = opt(p.modRate, 0.8);
      if (type === 2) { modDepth = Math.max(modDepth, 0.0012 * SR); modRate = 0.7; }
      const chunkLen = Math.round(lag);
      for (let i = 0; i < n; i++) {
        let echo;
        if (type === 3) {
          // Reverse: play the previous slice backwards, faded at both ends.
          const c = this.chunk;
          echo = this.readAt(2 * c + 1) * Math.sin(Math.PI * c / chunkLen);
          if (++this.chunk >= chunkLen) this.chunk = 0;
        } else {
          const wobble = modDepth ? modDepth * (0.5 + 0.5 * Math.sin(TAU * this.mod)) : 0;
          echo = modDepth ? this.readAt(lag + wobble) : this.buffer[(this.pos - Math.round(lag) + this.buffer.length) % this.buffer.length];
          this.mod += modRate / SR;
          if (this.mod >= 1) this.mod -= 1;
        }
        if (character > 0) {
          this.lp += (echo - this.lp) * lpC;
          echo = Math.tanh(this.lp * drive) / drive;
        }
        this.buffer[this.pos] = inp[i] + echo * p.feedback;
        out[i] = inp[i] * (1 - p.mix) + echo * p.mix;
        this.pos = (this.pos + 1) % this.buffer.length;
      }
    }
  }

  /* Reverb: damped comb filters into allpass diffusers. Mode 0 Room,
   * 1 Hall (longer, denser), 2 Plate (bright, extra diffusion), 3 Spring
   * (short, boingy, with a dispersive "drip"), 4 Shimmer (a hall whose
   * reflections are shifted up an octave). Pre-delay, Low cut and Dwell
   * (how hard the signal hits it). */
  const COMBS = [607, 646, 695, 738, 774, 811];
  const ALLPASSES = [302, 240, 186, 122];
  const SPRING = [37, 53, 71, 89, 113, 131];
  const ROOM_SCALE = [1, 1.5, 0.8, 0.5, 1.5];
  class Reverb {
    reset() {
      this.combs = COMBS.map(len => ({ buf: new Float32Array(Math.ceil(len * 1.5)), i: 0, lp: 0 }));
      this.aps = ALLPASSES.map(len => ({ buf: new Float32Array(Math.ceil(len * 1.5)), i: 0 }));
      this.springs = SPRING.map(len => ({ buf: new Float32Array(len), i: 0 }));
      this.pre = new Float32Array(Math.round(SR * 0.21));
      this.preI = 0;
      this.low = new Filter();
      this.shimmer = null;
    }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const mode = Math.round(opt(p.mode, 0)), scale = ROOM_SCALE[mode];
      const fb = Math.min(0.97, 0.7 + 0.23 * p.decay + (mode === 1 || mode === 4 ? 0.03 : 0));
      const damp = (0.05 + 0.55 * (1 - p.tone)) * (mode === 2 ? 0.5 : 1);
      const dwell = 0.1 * dbToLin((opt(p.dwell, 0.5) - 0.5) * 24);
      const preN = Math.round(opt(p.predelay, 0) * 0.001 * SR);
      const lowCut = opt(p.lowCut, 20), lowC = lowCut > 25 ? biquad('hp', lowCut) : IDENTITY;
      const lens = this.combs.map((c, k) => Math.max(8, Math.round(COMBS[k] * scale)));
      const apLens = this.aps.map((a, k) => Math.max(8, Math.round(ALLPASSES[k] * (mode === 2 ? 1.3 : scale > 1 ? 1.2 : 1))));
      if (mode === 4 && !this.shimmer) {
        this.shimmer = { pitch: new Harmonizer(), inBuf: new Float32Array(128), outBuf: new Float32Array(128), fill: 0 };
        this.shimmer.pitch.reset();
      }
      for (let i = 0; i < n; i++) {
        let x = inp[i];
        if (preN) {
          const L = this.pre.length;
          this.pre[this.preI] = x;
          x = this.pre[(this.preI - preN + L) % L];
          this.preI = (this.preI + 1) % L;
        }
        x *= dwell;
        if (dwell > 0.11) x = Math.tanh(x * 4) / 4;
        if (mode === 4) x += this.shimmer.outBuf[this.shimmer.fill] * 0.35;
        let s = 0;
        for (let k = 0; k < this.combs.length; k++) {
          const c = this.combs[k];
          if (c.i >= lens[k]) c.i = 0;
          const y = c.buf[c.i];
          c.lp = y * (1 - damp) + c.lp * damp;
          c.buf[c.i] = x + c.lp * fb;
          if (++c.i >= lens[k]) c.i = 0;
          s += y;
        }
        for (let k = 0; k < this.aps.length; k++) {
          const a = this.aps[k];
          if (a.i >= apLens[k]) a.i = 0;
          const b = a.buf[a.i];
          a.buf[a.i] = s + b * 0.5;
          if (++a.i >= apLens[k]) a.i = 0;
          s = b - s;
        }
        if (mode === 3) {
          for (const a of this.springs) {
            const b = a.buf[a.i];
            a.buf[a.i] = s + b * 0.65;
            if (++a.i === a.buf.length) a.i = 0;
            s = b - 0.65 * s;
          }
        }
        if (mode === 4) {
          // Collect the reverb, shift it up an octave in small blocks, feed it back.
          const sh = this.shimmer;
          sh.inBuf[sh.fill] = s;
          if (++sh.fill === 128) {
            sh.pitch.process(sh.inBuf, sh.outBuf, null, { voice1: 12, voice2: 0, mix: 1, window: 60 }, 128, false);
            sh.fill = 0;
          }
        }
        const wet = this.low.run(lowC, s);
        out[i] = inp[i] * (1 - 0.4 * p.mix) + wet * p.mix;
      }
    }
  }

  // One processor and buffer per pedal, even when types repeat.
  class EffectChain {
    constructor(size) { this.size = size; this.instances = new Map(); }
    process(input, pedals, reset = true) {
      const constructors = { gate: NoiseGate, comp: Compressor, boost: Boost, drive: Overdrive, dist: Distortion, fuzz: Fuzz, eq: Equalizer, wah: Wah,
        octave: Octave, harm: Harmonizer, chorus: Chorus, phaser: Phaser, trem: Tremolo, swell: Swell, delay: Delay, reverb: Reverb };
      const alive = new Set(pedals.map(pedal => pedal.id));
      for (const id of this.instances.keys()) if (!alive.has(id)) this.instances.delete(id);
      let signal = input;
      for (const pedal of pedals) {
        let entry = this.instances.get(pedal.id);
        if (!entry || entry.type !== pedal.type) {
          const processor = new constructors[pedal.type]();
          processor.reset?.();
          entry = { type: pedal.type, processor, out: new Float32Array(this.size), meter: new Float32Array(this.size) };
          this.instances.set(pedal.id, entry);
        }
        entry.input = signal;
        if (pedal.enabled) {
          entry.processor.process(signal, entry.out, entry.meter, pedal.params, this.size, reset);
          signal = entry.out;
        } else entry.meter.fill(pedal.type === 'gate' ? 1 : 0);
      }
      return signal;
    }
  }

  Object.assign(TL, { SR, dbToLin, linToDb, Source, NoiseGate, Compressor, Overdrive, Fuzz, Octave, Harmonizer, Delay, EffectChain, compCurve,
    Boost, Distortion, Tremolo, Swell, Reverb, Chorus, Phaser, Wah, Equalizer, eqResponse, diatonicShift, GRAPHIC });
})((globalThis.TL = globalThis.TL || {}));
