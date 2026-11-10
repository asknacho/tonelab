import './dsp.js';

const { SR, Source, EffectChain } = globalThis.TL;
const BLOCK_SIZE = 256;

class TonelabAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.source = new Source('guitar');
    this.chains = { A: new EffectChain(BLOCK_SIZE), B: new EffectChain(BLOCK_SIZE) };
    this.powers = { A: { input: 0, output: 0 }, B: { input: 0, output: 0 } };
    this.dry = new Float32Array(BLOCK_SIZE);
    this.position = BLOCK_SIZE;
    this.fraction = 0;
    this.current = 0;
    this.next = 0;
    this.gain = 0;
    this.matchGain = 1;
    this.previousTap = '';
    this.port.onmessage = ({ data }) => {
      if (data.type !== 'settings') return;
      if (data.kind !== this.source.kind) this.source.setKind(data.kind);
      this.source.noiseDb = data.noiseDb;
      this.settings = data;
    };
  }

  renderBlock() {
    const settings = this.settings;
    this.source.generate(this.dry, 0, BLOCK_SIZE);
    const active = settings.activeBank || 'A';
    const banks = settings.banks || { A: settings.state.chain, B: settings.state.chain };
    const tap = settings.inspectId || '';
    if (tap !== this.previousTap) {
      this.powers = { A: { input: 0, output: 0 }, B: { input: 0, output: 0 } };
      this.previousTap = tap;
    }
    let activeInput;
    let activeOutput;
    for (const bank of ['A', 'B']) {
      const pedals = banks[bank];
      const output = this.chains[bank].process(this.dry, pedals, false);
      const pedal = pedals.find(p => p.id === tap);
      const entry = pedal && this.chains[bank].instances.get(pedal.id);
      const tapInput = entry ? entry.input : this.dry;
      const tapOutput = entry ? (pedal.enabled ? entry.out : entry.input) : output;
      let inputPower = 0;
      let outputPower = 0;
      for (let i = 0; i < BLOCK_SIZE; i++) {
        inputPower += tapInput[i] ** 2;
        outputPower += tapOutput[i] ** 2;
      }
      // Both configurations hear the same source continuously. A two-second
      // RMS window estimates their levels even while one bank is inaudible.
      const alpha = 1 - Math.exp(-BLOCK_SIZE / (SR * 2));
      const powers = this.powers[bank];
      powers.input += alpha * (inputPower / BLOCK_SIZE - powers.input);
      powers.output += alpha * (outputPower / BLOCK_SIZE - powers.output);
      if (bank === active) {
        activeInput = tapInput;
        activeOutput = tapOutput;
      }
    }
    const power = this.powers[active];
    this.targetMatch = settings.matchVolume && power.output > 1e-9
      ? Math.max(0.05, Math.min(8, Math.sqrt(power.input / power.output))) : 1;
    this.tapInput = activeInput;
    this.tapOutput = activeOutput;
    this.port.postMessage({
      samples: this.dry.slice(),
      tapInput: activeInput.slice(),
      tapOutput: activeOutput.slice(),
    });
    this.position = 0;
  }

  tick() {
    if (this.position >= BLOCK_SIZE) this.renderBlock();
    const index = this.position++;
    const wet = this.settings.monitor !== 'dry';
    const target = wet ? this.targetMatch : 1;
    this.matchGain += (target - this.matchGain) * (1 - Math.exp(-1 / (SR * 0.05)));
    return (wet ? this.tapOutput[index] : this.tapInput[index]) * this.matchGain;
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!this.settings?.state.playing) {
      out.fill(0);
      return true;
    }
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
      out[i] = Math.max(-1, Math.min(1, sample * this.gain));
    }
    return true;
  }
}
registerProcessor('tonelab-audio', TonelabAudio);
