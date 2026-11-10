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

  // Noise gate: lets the signal through only while it is louder than the threshold.
  const GATE_HYSTERESIS_DB = 3;

  class NoiseGate {
    reset() {
      this.env = 0;
      this.gain = 0;
      this.hold = 0;
      this.open = false;
    }

    // gainOut receives the linear gain applied to each sample (0..1).
    process(inp, out, gainOut, p, n, reset = true) {
      if (reset) this.reset();
      const thrOpen = dbToLin(p.threshold);
      const thrClose = dbToLin(p.threshold - GATE_HYSTERESIS_DB);
      const floor = dbToLin(p.range);
      const aC = timeCoef(p.attack);
      const rC = timeCoef(p.release);
      const dC = timeCoef(30); // detector release so it doesn't flutter between waveform peaks
      const holdN = Math.round(p.hold * 0.001 * SR);
      let { env, gain, hold, open } = this;

      for (let i = 0; i < n; i++) {
        const a = Math.abs(inp[i]);
        env = a > env ? a : env * dC;

        if (!open && env >= thrOpen) open = true;
        else if (open && env < thrClose) open = false;

        let target;
        if (open) {
          hold = holdN;
          target = 1;
        } else if (hold > 0) {
          hold--;
          target = 1;
        } else {
          target = floor;
        }
        const c = target > gain ? aC : rC;
        gain = target + (gain - target) * c;

        out[i] = inp[i] * gain;
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

  // Compressor: turns down the parts of the signal that go over the threshold.
  class Compressor {
    reset() {
      this.gr = 0;
    }

    // grOut receives gain reduction in dB (0 or negative), makeup not included.
    process(inp, out, grOut, p, n, reset = true) {
      if (reset) this.reset();
      const aC = timeCoef(p.attack);
      const rC = timeCoef(p.release);
      const makeup = dbToLin(p.makeup);
      let gr = this.gr;

      for (let i = 0; i < n; i++) {
        const xdB = linToDb(inp[i]);
        const g = compCurve(xdB, p) - xdB; // how much the curve wants to turn it down
        gr = g < gr ? aC * gr + (1 - aC) * g : rC * gr + (1 - rC) * g;
        out[i] = inp[i] * dbToLin(gr) * makeup;
        grOut[i] = gr;
      }
      this.gr = gr;
    }
  }

  class Overdrive {
    process(inp, out, unused, p, n) {
      const drive = dbToLin(p.drive);
      for (let i = 0; i < n; i++) {
        const wet = Math.tanh(inp[i] * drive) / Math.tanh(drive);
        out[i] = inp[i] * (1 - p.mix) + wet * p.mix;
      }
    }
  }

  class Delay {
    reset() { this.buffer = new Float32Array(SR * 2); this.pos = 0; }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const lag = Math.round(p.time * SR / 1000);
      for (let i = 0; i < n; i++) {
        const echo = this.buffer[(this.pos - lag + this.buffer.length) % this.buffer.length];
        this.buffer[this.pos] = inp[i] + echo * p.feedback;
        out[i] = inp[i] * (1 - p.mix) + echo * p.mix;
        this.pos = (this.pos + 1) % this.buffer.length;
      }
    }
  }

  // Fuzz: huge gain into asymmetric clipping turns the wave almost square.
  class Fuzz {
    reset() { this.dcX = 0; this.dcY = 0; this.lp = 0; }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const gain = dbToLin(p.fuzz);
      const level = dbToLin(p.level);
      const cutoff = 500 * Math.pow(14, p.tone); // 500 Hz (dark) to 7 kHz (bright)
      const lpC = 1 - Math.exp(-TAU * cutoff / SR);
      const dcC = Math.exp(-TAU * 15 / SR);
      let { dcX, dcY, lp } = this;
      for (let i = 0; i < n; i++) {
        const x = inp[i] * gain + 0.12; // bias makes the two halves clip differently
        const clipped = x > 0 ? Math.min(1, Math.tanh(1.2 * x)) : Math.max(-0.75, Math.tanh(0.8 * x));
        dcY = clipped - dcX + dcC * dcY; // remove the offset the bias leaves behind
        dcX = clipped;
        lp += (dcY - lp) * lpC;
        out[i] = lp * level;
      }
      Object.assign(this, { dcX, dcY, lp });
    }
  }

  // Analog-style octave: a flip-flop divider makes a square wave one octave
  // down, and full-wave rectification folds the wave to sound one octave up.
  class Octave {
    reset() {
      Object.assign(this, { lp1: 0, lp2: 0, env: 0, flip: 1, armed: true, sub: 0, rectX: 0, rectY: 0 });
    }
    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const lpC = 1 - Math.exp(-TAU * 450 / SR);   // isolate the fundamental for tracking
      const subC = 1 - Math.exp(-TAU * 1200 / SR); // soften the square's edges
      const dcC = Math.exp(-TAU * 30 / SR);
      const envA = timeCoef(1), envR = timeCoef(80);
      let { lp1, lp2, env, flip, armed, sub, rectX, rectY } = this;
      for (let i = 0; i < n; i++) {
        const x = inp[i];
        lp1 += (x - lp1) * lpC;
        lp2 += (lp1 - lp2) * lpC;
        const a = Math.abs(lp2);
        env = a > env ? envA * env + (1 - envA) * a : envR * env + (1 - envR) * a;
        // Toggle once per cycle, with hysteresis so noise doesn't retrigger it.
        const h = 0.25 * env;
        if (armed && lp2 > h) { flip = -flip; armed = false; }
        else if (lp2 < -h) armed = true;
        sub += (flip * env * 1.6 - sub) * subC;
        const rect = Math.abs(x);
        rectY = rect - rectX + dcC * rectY;
        rectX = rect;
        out[i] = x * p.dry + sub * p.sub + rectY * 1.4 * p.up;
      }
      Object.assign(this, { lp1, lp2, env, flip, armed, sub, rectX, rectY });
    }
  }

  // Harmonizer: each voice plays the recent signal back from a delay line.
  // Reading faster or slower than it was written shifts the pitch. When the
  // read head runs out of room it jumps back by roughly one window, to the
  // spot whose waveform best matches what it just played, and crossfades
  // there so the jump isn't heard.
  const HARM_MIN_DELAY = 4;
  const HARM_FADE = Math.round(0.008 * SR);
  const HARM_MATCH = Math.round(0.006 * SR);

  class Harmonizer {
    reset() {
      this.buffer = new Float32Array(Math.round(SR * 0.4));
      this.pos = 0;
      this.voices = [0, 1].map(() => ({ d: -1, old: 0, fade: 0 }));
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

    // Best new delay in [lo, hi]: the one whose recent past (played at this
    // voice's speed) correlates most with what the current head just played.
    bestDelay(d, lo, hi, ratio) {
      const buf = this.buffer, L = buf.length;
      // What the current head just played, sampled every other output sample.
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

    process(inp, out, unused, p, n, reset = true) {
      if (reset) this.reset();
      const W = Math.max(HARM_FADE * 2, Math.round(p.window * 0.001 * SR));
      const intervals = p.voice2 !== 0 ? [p.voice1, p.voice2] : [p.voice1];
      const ratios = intervals.map(st => Math.pow(2, st / 12));
      const F = HARM_FADE;
      for (let i = 0; i < n; i++) {
        this.buffer[this.pos] = inp[i];
        let wet = 0;
        for (let v = 0; v < intervals.length; v++) {
          const ratio = ratios[v];
          const step = 1 - ratio; // how the delay changes per sample
          const voice = this.voices[v];
          if (voice.d < 0) voice.d = HARM_MIN_DELAY + W / 2;
          voice.d += step;
          let y = this.read(voice.d);
          if (voice.fade > 0) {
            voice.old += step;
            const t = 1 - voice.fade / F;
            y = y * t + this.read(voice.old) * (1 - t);
            voice.fade--;
          } else if (step < 0 && voice.d < HARM_MIN_DELAY + F * -step + 1) {
            // Pitching up: the head caught up with the newest audio.
            voice.old = voice.d;
            voice.d = this.bestDelay(voice.d, voice.d + W / 2, voice.d + W, ratio);
            voice.fade = F;
          } else if (step > 0 && voice.d > HARM_MIN_DELAY + W * 1.5 - F * step - 1) {
            // Pitching down: the head fell too far behind.
            voice.old = voice.d;
            voice.d = this.bestDelay(voice.d, Math.max(HARM_MIN_DELAY + 1, voice.d - W), voice.d - W / 2, ratio);
            voice.fade = F;
          }
          wet += y;
        }
        out[i] = inp[i] * (1 - p.mix) + (wet / intervals.length) * p.mix;
        if (++this.pos === this.buffer.length) this.pos = 0;
      }
    }
  }

  // One processor and buffer per pedal, even when types repeat.
  class EffectChain {
    constructor(size) { this.size = size; this.instances = new Map(); }
    process(input, pedals, reset = true) {
      const constructors = { gate: NoiseGate, comp: Compressor, drive: Overdrive, fuzz: Fuzz, octave: Octave, harm: Harmonizer, delay: Delay };
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

  Object.assign(TL, { SR, dbToLin, linToDb, Source, NoiseGate, Compressor, Overdrive, Fuzz, Octave, Harmonizer, Delay, EffectChain, compCurve });
})((globalThis.TL = globalThis.TL || {}));
