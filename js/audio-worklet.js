import './dsp.js';

const { SR, Source, NoiseGate, Compressor, Overdrive, Delay } = globalThis.TL;
class TonelabAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.source = new Source('guitar');
    this.effects = { gate: new NoiseGate(), comp: new Compressor(), drive: new Overdrive(), delay: new Delay() };
    Object.values(this.effects).forEach(effect => effect.reset?.());
    this.dry = new Float32Array(128);
    this.buffers = Array.from({ length: 4 }, () => new Float32Array(128));
    this.meter = new Float32Array(128);
    this.position = 128;
    this.fraction = 0;
    this.current = this.next = this.gain = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type !== 'settings') return;
      if (data.kind !== this.source.kind) this.source.setKind(data.kind);
      this.source.noiseDb = data.noiseDb;
      this.settings = data;
    };
  }
  tick() {
    if (this.position >= 128) {
      this.source.generate(this.dry, 0, 128);
      let signal = this.dry;
      this.settings.state.order.forEach((id, index) => {
        if (!this.settings.state[id + 'On']) return;
        const out = this.buffers[index];
        this.effects[id].process(signal, out, this.meter, this.settings.state[id], 128, false);
        signal = out;
      });
      this.wet = signal;
      this.port.postMessage({ samples: this.dry.slice() });
      this.position = 0;
    }
    const index = this.position++;
    return this.settings.monitor === 'dry' ? this.dry[index] : this.wet[index];
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!this.settings?.state.playing) { out.fill(0); return true; }
    const step = SR / sampleRate * this.settings.state.speed;
    for (let i = 0; i < out.length; i++) {
      this.fraction += step;
      while (this.fraction >= 1) {
        this.current = this.next;
        this.next = this.tick();
        this.fraction--;
      }
      this.gain += (this.settings.volume - this.gain) * 0.003;
      const sample = this.current + (this.next - this.current) * this.fraction;
      // Limit only peaks above full scale; preserve the dry signal below it.
      out[i] = Math.max(-1, Math.min(1, sample * this.gain));
    }
    return true;
  }
}
registerProcessor('tonelab-audio', TonelabAudio);
