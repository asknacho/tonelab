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
  const JOURNEY_VIEW = Math.round(1.5 * SR);  // the step-by-step waveforms show the last 1.5 s

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
    { key: 'character', label: 'Character', min: 0, max: 1, step: 0.01, value: 0, format: v => v < 0.03 ? 'Clean (digital)' : v > 0.97 ? 'Dark (analog)' : Math.round(v * 100) + '% darker',
      hint: 'Clean, exact repeats (digital) to darker, grittier repeats that fade like an analog delay.' },
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
  const fmtSigned = v => (v > 0 ? '+' : '') + fmt(v, 1) + ' dB';
  const fmtHz = v => (v >= 1000 ? fmt(v / 1000, 1) + ' kHz' : v >= 10 ? fmt(v, 0) + ' Hz' : fmt(v, 1) + ' Hz');
  const BOOST_PARAMS = [
    { key: 'boost', label: 'Boost', min: 0, max: 20, step: 0.5, value: 10, format: v => '+' + fmt(v, 1) + ' dB', hint: 'Clean extra volume. Before a drive it means more distortion; after it, just louder.' },
  ];
  const DIST_PARAMS = [
    { key: 'gain', label: 'Distortion', min: 0, max: 45, step: 0.5, value: 30, format: fmtDb, hint: 'How hard the signal hits the clipper. More gain, flatter tops.' },
    { key: 'tone', label: 'Tone', min: 0, max: 1, step: 0.01, value: 0.5, format: v => Math.round(v * 100) + '%', hint: 'Dark to bright.' },
    { key: 'level', label: 'Level', min: -30, max: 0, step: 0.5, value: -10, format: fmtDb, hint: 'Output volume.' },
  ];
  const EQ_PARAMS = [
    { key: 'bass', label: 'Bass', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Lows: body and thump.' },
    { key: 'mid', label: 'Mids', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'The middle: what makes a guitar cut through a band.' },
    { key: 'midFreq', label: 'Mid point', min: 250, max: 3000, value: 800, log: true, format: fmtHz, hint: 'Which part of the middle the Mids knob changes.' },
    { key: 'treble', label: 'Treble', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Highs: sparkle and bite.' },
    { key: 'level', label: 'Level', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Overall volume.' },
  ];
  const WAH_MODES = ['Held still', 'Follows your picking', 'Rocks by itself'];
  const WAH_PARAMS = [
    { key: 'mode', label: 'Mode', min: 0, max: 2, step: 1, value: 1, format: v => WAH_MODES[Math.round(v)],
      hint: 'Held still: a parked (“cocked”) wah. Follows your picking: harder picks open it (an envelope filter, or auto-wah). Rocks by itself: an automatic sweep.' },
    { key: 'position', label: 'Pedal position', min: 0, max: 1, step: 0.01, value: 0.5, format: v => (v < 0.34 ? 'Heel (dark)' : v > 0.66 ? 'Toe (bright)' : 'Middle') + ' · ' + Math.round(v * 100) + '%', hint: 'Where the pedal is held (Held still mode).' },
    { key: 'sensitivity', label: 'Sensitivity', min: 0, max: 30, step: 1, value: 14, format: v => '+' + fmt(v, 0) + ' dB', hint: 'How far your picking opens it (Follows your picking mode).' },
    { key: 'speed', label: 'Speed', min: 0.2, max: 6, value: 1.5, log: true, format: fmtHz, hint: 'How fast it rocks (Rocks by itself mode).' },
    { key: 'resonance', label: 'Resonance', min: 2, max: 10, step: 0.1, value: 5, format: v => fmt(v, 1), hint: 'How sharp and vocal the peak is.' },
  ];
  const CHORUS_PARAMS = [
    { key: 'rate', label: 'Speed', min: 0.1, max: 5, value: 0.8, log: true, format: fmtHz, hint: 'How fast the copy wobbles.' },
    { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, value: 0.5, format: v => Math.round(v * 100) + '%', hint: 'How far its pitch wobbles.' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0.6, format: v => Math.round(v * 100) + '%', hint: 'How much of the wobbling copy you hear.' },
  ];
  const PHASER_PARAMS = [
    { key: 'rate', label: 'Speed', min: 0.1, max: 6, value: 0.5, log: true, format: fmtHz, hint: 'How fast it sweeps.' },
    { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, value: 0.7, format: v => Math.round(v * 100) + '%', hint: 'How wide the sweep goes.' },
    { key: 'feedback', label: 'Intensity', min: 0, max: 0.9, step: 0.01, value: 0.4, format: v => Math.round(v * 100) + '%', hint: 'A sharper, more dramatic swoosh.' },
  ];
  const TREM_PARAMS = [
    { key: 'rate', label: 'Speed', min: 1, max: 12, step: 0.1, value: 5, format: fmtHz, hint: 'Pulses per second.' },
    { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, value: 0.6, format: v => Math.round(v * 100) + '%', hint: 'How far the volume dips.' },
    { key: 'shape', label: 'Shape', min: 0, max: 1, step: 0.01, value: 0.2, format: v => (v < 0.34 ? 'Smooth' : v > 0.66 ? 'Choppy' : 'In between') + ' · ' + Math.round(v * 100) + '%', hint: 'Smooth waves to hard, choppy on-off pulses.' },
  ];
  const SWELL_PARAMS = [
    { key: 'rise', label: 'Fade-in time', min: 50, max: 2000, value: 350, log: true, format: fmtMs, hint: 'How long each note takes to fade in.' },
    { key: 'sensitivity', label: 'Sensitivity', min: -60, max: -10, step: 1, value: -40, format: fmtDb, hint: 'How hard you need to pick to start a new swell.' },
  ];
  const REVERB_PARAMS = [
    { key: 'decay', label: 'Decay', min: 0, max: 1, step: 0.01, value: 0.6, format: v => Math.round(v * 100) + '%', hint: 'How long the room rings.' },
    { key: 'tone', label: 'Tone', min: 0, max: 1, step: 0.01, value: 0.5, format: v => Math.round(v * 100) + '%', hint: 'Dark to bright reflections.' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0.35, format: v => Math.round(v * 100) + '%', hint: 'How much reverb you hear.' },
  ];
  // `model` names the classic pedal whose outline each card borrows. The
  // order here is the order in the "Add an effect" list.
  const types = {
    gate: { name: 'Noise gate', short: 'Gate', model: 'ISP Decimator', specs: GATE_PARAMS, explanation: 'Silences the quiet parts. Attack opens the gate; hold and release preserve the tails. Try a gate after delay to cut off the echoes.' },
    comp: { name: 'Compressor', short: 'Comp', model: 'MXR Dyna Comp', specs: COMP_PARAMS, explanation: 'Controls peaks above the threshold. Two compressors can share the work: use the first for gentle leveling and the second to catch the remaining peaks.' },
    boost: { name: 'Boost', short: 'Boost', model: 'Xotic EP Booster', specs: BOOST_PARAMS, explanation: 'Clean extra volume. In front of an overdrive it pushes it harder for more crunch; at the end of the board it just makes everything louder.' },
    drive: { name: 'Overdrive', short: 'Drive', model: 'Ibanez Tube Screamer', specs: DRIVE_PARAMS, explanation: 'Adds harmonics by rounding off peaks. Try compression before drive for a more even distortion, or after it to tame the result.' },
    dist: { name: 'Distortion', short: 'Dist', model: 'ProCo RAT', specs: DIST_PARAMS, explanation: 'Clips the wave hard, so its tops go flat: heavier and more even than overdrive. Overdrive rounds the peaks, distortion flattens them, fuzz squares the whole wave off.' },
    fuzz: { name: 'Fuzz', short: 'Fuzz', model: 'Dallas Arbiter Fuzz Face', specs: FUZZ_PARAMS, explanation: 'Clips so hard the wave turns almost square, and the two halves clip unevenly for a sputtery edge. Compare it with overdrive, which only rounds the peaks.' },
    eq: { name: 'EQ', short: 'EQ', model: 'Boss GE-7', specs: EQ_PARAMS, explanation: 'Turns bass, mids and treble up or down. Switch the view to Tone to see exactly what it changes.' },
    wah: { name: 'Wah', short: 'Wah', model: 'Dunlop Cry Baby', specs: WAH_PARAMS, explanation: 'A peak in the sound that moves from dark (heel) to bright (toe), like a voice saying “wah”. It can be held still, follow your picking (an auto-wah), or rock by itself.' },
    octave: { name: 'Octave', short: 'Octave', model: 'Electro-Harmonix POG', specs: OCTAVE_PARAMS, explanation: 'Adds notes an octave below and above. It tracks single notes best; chords confuse it, much like an analog octave pedal. Watch the octave down turn the wave into wide square steps.' },
    harm: { name: 'Harmonizer', short: 'Harmony', model: 'DigiTech Whammy', specs: HARM_PARAMS, explanation: 'Adds pitch-shifted copies of your playing to build harmonies. Each voice replays the last few milliseconds faster (higher) or slower (lower). Put it before drive for a thicker sound, or after for clearer voices.' },
    chorus: { name: 'Chorus', short: 'Chorus', model: 'Electro-Harmonix Small Clone', specs: CHORUS_PARAMS, explanation: 'Blends in a copy of your playing whose pitch wobbles slightly, like two guitars playing together. Subtle settings shimmer; extreme ones warble.' },
    phaser: { name: 'Phaser', short: 'Phaser', model: 'MXR Phase 90', specs: PHASER_PARAMS, explanation: 'Cuts moving notches into the sound for a swirling “whoosh”. In the Tone view you can see the dips slide back and forth.' },
    trem: { name: 'Tremolo', short: 'Trem', model: 'Boss TR-2', specs: TREM_PARAMS, explanation: 'Turns the volume up and down in a steady pulse. Watch the waveform throb.' },
    swell: { name: 'Volume swell', short: 'Swell', model: 'Ernie Ball volume pedal', specs: SWELL_PARAMS, explanation: 'Fades every new note in, as if you rolled a volume pedal up after each pick. It hides the pick attack for soft, violin-like notes.' },
    delay: { name: 'Delay', short: 'Delay', model: 'Boss DD-3', specs: DELAY_PARAMS, explanation: 'Time sets the spacing of echoes; feedback controls their decay. Character goes from clean digital repeats to darker analog-style ones.' },
    reverb: { name: 'Reverb', short: 'Reverb', model: 'Electro-Harmonix Holy Grail', specs: REVERB_PARAMS, explanation: 'The sound of a room: thousands of tiny reflections that ring on after each note. Decay sets how big the room sounds.' },
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
    fuzz: { inset: 1.5, jack: 66, led: [38, 47], draw: p => `<circle class="art-body" cx="38" cy="70" r="36.5"/>${knob(26, 46, 6, level(p, 'fuzz'))}${knob(50, 46, 6, level(p, 'level'))}${stomp(38, 95, 5)}` },
    octave: { inset: 3, jack: 66, led: [64, 36], draw: p => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="4"/>` +
      ['dry', 'sub', 'up'].map((key, i) => {
        const x = 22 + i * 16, y = 44 - level(p, key) * 16;
        return `<line class="art-line" x1="${x}" y1="25" x2="${x}" y2="46"/><rect class="art-knob" x="${x - 4.5}" y="${y - 2.5}" width="9" height="5" rx="1"/>`;
      }).join('') + stomp(38, 98) },
    harm: { inset: 1, jack: 66, led: [45, 33], draw: p => `<rect class="art-body" x="1" y="1" width="74" height="138" rx="10"/>${knob(22, 33, 8, level(p, 'voice1'))}<rect class="art-line" x="38" y="27" width="28" height="12" rx="2"/><rect class="art-switch" x="7" y="50" width="62" height="84" rx="7"/>${ridges([88, 94, 100, 106, 112], 15, 61)}` },
    delay: { inset: 3, jack: 66, led: [38, 19], draw: p => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="4"/>${knob(14, 36, 5.5, level(p, 'mix'))}${knob(30, 36, 5.5, level(p, 'feedback'))}${knob(46, 36, 5.5, level(p, 'time'))}${knob(62, 36, 5.5, level(p, 'character'))}<path class="art-switch" d="M10 80 H66 L70 86 V134 Q70 137 67 137 H9 Q6 137 6 134 V86 Z"/>${ridges([93, 98, 103, 108], 16, 60)}` },
    boost: { inset: 14, jack: 66, led: [54, 33], draw: p => `<rect class="art-body" x="14" y="24" width="48" height="115" rx="4"/>${knob(32, 36, 7, level(p, 'boost'))}${stomp(38, 108, 5)}` },
    dist: { inset: 3, jack: 66, led: [62, 86], draw: p => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="3"/><line class="art-line" x1="3" y1="46" x2="73" y2="46"/>${knob(19, 32, 7, level(p, 'gain'))}${knob(38, 32, 7, level(p, 'tone'))}${knob(57, 32, 7, level(p, 'level'))}${stomp(38, 100)}` },
    eq: { inset: 3, jack: 66, led: [38, 14], draw: p => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="4"/>` +
      [100, 200, 400, 800, 1600, 3200, 6400].map((f, i) => {
        const x = (12 + i * 8.67).toFixed(1), y = (35 - Math.max(-12, Math.min(12, TL.eqResponse(p.params, f))) / 12 * 9).toFixed(1);
        return `<line class="art-line" x1="${x}" y1="24" x2="${x}" y2="46"/><rect class="art-knob" x="${x - 3}" y="${y - 2}" width="6" height="4" rx="1"/>`;
      }).join('') + `<path class="art-switch" d="M10 80 H66 L70 86 V134 Q70 137 67 137 H9 Q6 137 6 134 V86 Z"/>${ridges([93, 98, 103, 108], 16, 60)}` },
    wah: { inset: 3, jack: 66, led: [38, 14], draw: () => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="12"/><rect class="art-switch" x="9" y="24" width="58" height="108" rx="8"/>${ridges([86, 92, 98, 104, 110, 116], 17, 59)}` },
    chorus: { inset: 6, jack: 66, led: [60, 86], draw: p => `<rect class="art-body" x="6" y="1" width="64" height="138" rx="5"/>${knob(28, 36, 8, level(p, 'rate'))}<rect class="art-line" x="50" y="29" width="7" height="14" rx="2"/>${stomp(38, 100)}` },
    phaser: { inset: 9, jack: 66, led: [57, 46], draw: p => `<rect class="art-body" x="9" y="1" width="58" height="138" rx="3"/>` +
      [[14, 6], [62, 6], [14, 134], [62, 134]].map(([x, y]) => `<circle class="art-line" cx="${x}" cy="${y}" r="1.4"/>`).join('') + `${knob(38, 36, 10, level(p, 'rate'))}${stomp(38, 100)}` },
    trem: { inset: 3, jack: 66, led: [38, 19], draw: p => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="4"/>${knob(19, 36, 6, level(p, 'rate'))}${knob(38, 36, 6, level(p, 'depth'))}${knob(57, 36, 6, level(p, 'shape'))}<path class="art-switch" d="M10 80 H66 L70 86 V134 Q70 137 67 137 H9 Q6 137 6 134 V86 Z"/>${ridges([93, 98, 103, 108], 16, 60)}` },
    swell: { inset: 9, jack: 66, led: [38, 30], draw: () => `<path class="art-body" d="M17 1 H59 Q62 1 62.5 4 L73 134 Q73 139 68 139 H8 Q3 139 3 134 L13.5 4 Q14 1 17 1 Z"/>${ridges([38, 44, 88, 96, 104, 112, 120], 16, 60)}` },
    reverb: { inset: 3, jack: 66, led: [62, 86], draw: p => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="6"/>${knob(38, 37, 11, level(p, 'mix'))}<rect class="art-line" x="61" y="29" width="6" height="14" rx="2"/>${stomp(38, 100)}` },
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
  let savedView = 'level';
  try { savedView = localStorage.getItem('tonelab-view') === 'tone' ? 'tone' : 'level'; } catch {}
  const state = { view: savedView, playing: true, speed: 1, scale: 'db', chain: ['gate', 'comp', 'drive', 'delay'].map(type => createPedal(type)), dirty: true };
  const clone = value => JSON.parse(JSON.stringify(value));
  const PATTERNS = ['guitar', 'eighths'];
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
    return { version: 1, active: activeBank, banks, noise: source.noiseDb, matchVolume, source: { kind: source.kind, tempo: source.tempo }, slots };
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
  source.setKind(restoredSource.kind);
  source.tempo = restoredSource.tempo;

  // What the synthesized guitar plays: free picking or steady eighth notes.
  const patternSelect = document.getElementById('pattern');
  function syncPattern() {
    patternSelect.querySelector('[value="eighths"]').textContent = 'Steady eighths · ' + Math.round(source.tempo) + ' BPM';
    patternSelect.value = source.kind;
  }
  patternSelect.onchange = () => {
    source.setKind(patternSelect.value);
    state.dirty = true;
    saveBoard();
  };
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
      markEdited();
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
    edited();
    announce(pedalName(pedal) + ' added at position ' + state.chain.length);
    return pedal;
  }
  function removePedal(id) {
    const index = state.chain.findIndex(p => p.id === id);
    if (index < 0) return;
    const [pedal] = state.chain.splice(index, 1);
    selectedId = null;
    settings.close();
    edited();
    document.getElementById('add-effect').focus({ preventScroll: true });
    announce(pedalName(pedal) + ' removed');
    const bank = activeBank;
    offerUndo(pedalName(pedal) + ' removed', () => {
      // Put it back on the board it came from, even if A/B was switched since.
      if (activeBank !== bank) document.querySelector('#compare-bank [data-bank="' + bank + '"]').click();
      state.chain.splice(Math.min(index, state.chain.length), 0, pedal);
      edited();
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
  function offerUndo(text, restore) {
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
    removePedal(pedal.id);
  };
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
  document.getElementById('compare-bank').onclick = e => switchBank(e.target.closest('[data-bank]')?.dataset.bank);
  function switchBank(bank) {
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
    refreshSlots();
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
      source: { kind: 'guitar', noise: -60 },
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
      source: { kind: 'guitar', noise: -60 },
      play: 'Play slow single notes and let each one ring as long as it can.',
      chain: [
        ['comp', { threshold: -24, ratio: 3, attack: 20, release: 300, knee: 6, makeup: 4 }, 'Holds each note up as it fades, so long notes keep singing.'],
        ['fuzz', { fuzz: 26, tone: 0.45, level: -8 }, 'Plenty of gain with the tone turned a little dark: smooth sustain instead of a harsh buzz.'],
        ['delay', { time: 440, feedback: 0.35, mix: 0.3 }, 'A soft echo, low in the mix, that fills the space behind long notes.'],
      ],
      tip: 'Too harsh? Turn the fuzz’s tone down. Too muddy? Lower the delay mix.',
      whatIfs: [
        { id: 'bright', label: 'Brighter fuzz', note: 'With the tone turned all the way up, the same fuzz gets fizzy and harsh. The smoothness comes from the darker tone setting.',
          chain: [['comp', { threshold: -24, ratio: 3, attack: 20, release: 300, knee: 6, makeup: 4 }], ['fuzz', { fuzz: 26, tone: 1, level: -8 }], ['delay', { time: 440, feedback: 0.35, mix: 0.3 }]] },
        { id: 'no-delay', label: 'No delay', note: 'Without the echo the sound gets dry and close, and the gaps between notes feel empty.',
          chain: [['comp', { threshold: -24, ratio: 3, attack: 20, release: 300, knee: 6, makeup: 4 }], ['fuzz', { fuzz: 26, tone: 0.45, level: -8 }]] },
      ],
    },
    {
      id: 'endless-echo', group: 'Techniques', title: 'Endless, clean echo', short: 'Clean echo',
      summary: 'Long echoes that keep ringing, with no hiss building up between notes. It also answers a classic question: noise gate or compressor first?',
      source: { kind: 'guitar', noise: -40 },
      play: 'Play a few notes and let them ring. The demo guitar has a noisy pickup, so you can hear the hiss this sound has to deal with.',
      chain: [
        ['gate', { threshold: -32, attack: 1, hold: 60, release: 250, range: -80 }, 'Goes first. It mutes the hiss between notes before anything else can make it louder. Its threshold sits just above the hiss.'],
        ['comp', { threshold: -30, ratio: 6, attack: 15, release: 400, knee: 6, makeup: 10 }, 'Keeps each note loud for longer as it fades, so every echo starts strong. It also turns everything up, hiss included.'],
        ['delay', { time: 520, feedback: 0.62, mix: 0.4 }, 'Long echoes with lots of feedback, so they keep repeating. Whatever reaches this pedal gets repeated, hiss included.'],
      ],
      tip: 'Watch the gaps between notes: with the gate first they go flat and silent.',
      whatIfs: [
        { id: 'comp-first', label: 'Compressor before the gate', note: 'The compressor turns everything up, hiss included. Now the hiss is louder than the gate’s threshold, so the gate never closes and the delay repeats the hiss over and over.',
          chain: [['comp', { threshold: -30, ratio: 6, attack: 15, release: 400, knee: 6, makeup: 10 }], ['gate', { threshold: -32, attack: 1, hold: 60, release: 250, range: -80 }], ['delay', { time: 520, feedback: 0.62, mix: 0.4 }]] },
        { id: 'no-gate', label: 'No noise gate', note: 'Without the gate, the compressor lifts the hiss and the delay keeps repeating it. Listen to the gaps between notes.',
          chain: [['comp', { threshold: -30, ratio: 6, attack: 15, release: 400, knee: 6, makeup: 10 }], ['delay', { time: 520, feedback: 0.62, mix: 0.4 }]] },
      ],
    },
    {
      id: 'boost-drive', group: 'Techniques', title: 'Boost into overdrive', short: 'Boost + drive',
      summary: 'Why guitarists put a clean boost in front of an overdrive: more crunch and sustain from the same pedal. It also shows why the order matters.',
      source: { kind: 'guitar', noise: -60 },
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
      source: { kind: 'guitar', noise: -55 },
      play: 'Play short, heavy notes with rests in between, and listen to the silence in the rests.',
      chain: [
        ['gate', { threshold: -45, attack: 0.5, hold: 20, release: 60, range: -80 }, 'First in line, it shuts off the hiss and hum between notes, so the rests are silent.'],
        ['dist', { gain: 36, tone: 0.55, level: -12 }, 'Lots of gain, clipped hard. It turns every note into a wall of sound, and it would turn the hiss into a wall of noise too.'],
        ['eq', { bass: 4, mid: -8, midFreq: 700, treble: 3, level: 0 }, 'Cuts the mids and lifts bass and treble: the “scooped” sound. Switch to the Tone view to see the dip in the middle.'],
      ],
      tip: 'Scooped mids sound huge on their own, but in a band they can make your guitar disappear. Try bringing the mids back up when playing with others.',
      whatIfs: [
        { id: 'no-gate', label: 'No noise gate', note: 'Without the gate, the distortion turns the hiss into loud noise between notes. Look at the gaps in the waveform.',
          chain: [['dist', { gain: 36, tone: 0.55, level: -12 }], ['eq', { bass: 4, mid: -8, midFreq: 700, treble: 3, level: 0 }]] },
        { id: 'mids-back', label: 'Mids put back', note: 'With the EQ flat, the mids come back: less “huge” on its own, but more solid and easier to hear in a band. Compare them in the Tone view.',
          chain: [['gate', { threshold: -45, attack: 0.5, hold: 20, release: 60, range: -80 }], ['dist', { gain: 36, tone: 0.55, level: -12 }], ['eq', { bass: 0, mid: 0, midFreq: 700, treble: 0, level: 0 }]] },
      ],
    },
    {
      id: 'surf', group: 'Techniques', title: 'Surf tremolo and reverb', short: 'Surf',
      summary: 'Pulsing volume into a bright, splashy reverb: the sound of 60s surf and twang.',
      source: { kind: 'guitar', noise: -60 },
      play: 'Let notes and chords ring, and listen to them pulse.',
      chain: [
        ['trem', { rate: 6, depth: 0.7, shape: 0.3 }, 'Turns the volume up and down six times a second. Watch the waveform throb.'],
        ['reverb', { decay: 0.75, tone: 0.75, mix: 0.45 }, 'A bright, splashy reverb that rings on after each note, a bit like an amp’s spring reverb. Coming after the tremolo, it softens the pulses slightly.'],
      ],
      tip: 'Set the tremolo speed to the song’s tempo so the pulses lock in with the band.',
      whatIfs: [
        { id: 'reverb-first', label: 'Reverb before the tremolo', note: 'Now the tremolo chops the reverb as well, so the pulses go deeper and the reverb tail throbs too. With the tremolo first, the reverb smooths the pulses a little.',
          chain: [['reverb', { decay: 0.75, tone: 0.75, mix: 0.45 }], ['trem', { rate: 6, depth: 0.7, shape: 0.3 }]] },
        { id: 'no-trem', label: 'No tremolo', note: 'Just the reverb: the ringing stays, the pulse is gone.',
          chain: [['reverb', { decay: 0.75, tone: 0.75, mix: 0.45 }]] },
      ],
    },
    {
      id: 'ambient', group: 'Techniques', title: 'Ambient swells', short: 'Swells',
      summary: 'Notes that fade in with no pick attack, into long echoes and a big reverb: the soft, violin-like pad of ambient guitar.',
      source: { kind: 'guitar', noise: -60 },
      play: 'Play slow single notes or chords and let them ring. The swell hides the pick.',
      chain: [
        ['swell', { rise: 400, sensitivity: -40 }, 'Fades every new note in, as if you rolled a volume pedal up by foot after each pick.'],
        ['delay', { time: 450, feedback: 0.5, mix: 0.4, character: 0.6 }, 'Long echoes that overlap into a pad. The Character knob makes each repeat a little darker than the last.'],
        ['reverb', { decay: 0.85, tone: 0.4, mix: 0.5 }, 'A big, dark room that smears everything into one long wash.'],
      ],
      tip: 'Turn Match volume on: swells are quieter than picked notes, and you want to compare the sound, not the level.',
      whatIfs: [
        { id: 'no-swell', label: 'No swell', note: 'Every note now starts with the click of the pick. Look at the start of each note: in A it ramps up, in B it jumps.',
          chain: [['delay', { time: 450, feedback: 0.5, mix: 0.4, character: 0.6 }], ['reverb', { decay: 0.85, tone: 0.4, mix: 0.5 }]] },
        { id: 'clean-echoes', label: 'Clean echoes', note: 'The same echoes with Character at zero: every repeat stays bright and exact instead of getting darker. Switch to the Tone view to see the extra treble.',
          chain: [['swell', { rise: 400, sensitivity: -40 }], ['delay', { time: 450, feedback: 0.5, mix: 0.4, character: 0 }], ['reverb', { decay: 0.85, tone: 0.4, mix: 0.5 }]] },
      ],
    },
    {
      id: 'eighties', group: 'Techniques', title: 'Lush 80s clean', short: '80s clean',
      summary: 'A shimmering clean sound: chorus for width, a short echo and a little reverb.',
      source: { kind: 'guitar', noise: -60 },
      play: 'Play clean chords or arpeggios and let them ring.',
      chain: [
        ['comp', { threshold: -24, ratio: 3, attack: 15, release: 200, knee: 6, makeup: 3 }, 'Keeps the clean notes even and helps them ring.'],
        ['chorus', { rate: 0.8, depth: 0.5, mix: 0.6 }, 'Adds a slightly detuned, slowly wobbling copy of your playing, like two guitars at once. That’s the shimmer.'],
        ['delay', { time: 380, feedback: 0.25, mix: 0.25 }, 'One or two soft echoes that add depth.'],
        ['reverb', { decay: 0.5, tone: 0.6, mix: 0.25 }, 'A little room around the sound.'],
      ],
      tip: 'Chorus sounds best on clean sounds. In front of heavy distortion it can get wobbly and messy.',
      whatIfs: [
        { id: 'no-chorus', label: 'No chorus', note: 'Same echo and reverb without the chorus: a single, narrower guitar.',
          chain: [['comp', { threshold: -24, ratio: 3, attack: 15, release: 200, knee: 6, makeup: 3 }], ['delay', { time: 380, feedback: 0.25, mix: 0.25 }], ['reverb', { decay: 0.5, tone: 0.6, mix: 0.25 }]] },
        { id: 'fast-chorus', label: 'Fast, deep chorus', note: 'Turned up fast and deep, the chorus becomes a seasick warble. Subtle settings are what make it lush.',
          chain: [['comp', { threshold: -24, ratio: 3, attack: 15, release: 200, knee: 6, makeup: 3 }], ['chorus', { rate: 4, depth: 1, mix: 0.6 }], ['delay', { time: 380, feedback: 0.25, mix: 0.25 }], ['reverb', { decay: 0.5, tone: 0.6, mix: 0.25 }]] },
      ],
    },
    {
      id: 'auto-wah', group: 'Techniques', title: 'Funky auto-wah', short: 'Auto-wah', view: 'tone',
      summary: 'The quacky funk sound: an envelope filter (auto-wah) that opens each time you pick, so every note goes “wow”.',
      source: { kind: 'guitar', noise: -60 },
      play: 'Pick short notes. Picking harder opens the wah wider.',
      chain: [
        ['comp', { threshold: -28, ratio: 4, attack: 8, release: 120, knee: 6, makeup: 6 }, 'Evens out your picking, so the wah opens about the same amount on every note.'],
        ['wah', { mode: 1, position: 0.5, sensitivity: 16, speed: 1.5, resonance: 6 }, 'Follows your picking: each pick opens the filter and it closes as the note fades. That sweep is the “quack”. In the Tone view, watch the peak jump right on each pick.'],
      ],
      tip: 'For a classic rocking wah instead, set Mode to “Rocks by itself” and slow the speed down.',
      whatIfs: [
        { id: 'held', label: 'Wah held still', note: 'The same filter parked in one spot: a nasal, honky sound with no movement. Players call this a “cocked wah”.',
          chain: [['comp', { threshold: -28, ratio: 4, attack: 8, release: 120, knee: 6, makeup: 6 }], ['wah', { mode: 0, position: 0.55, sensitivity: 16, speed: 1.5, resonance: 6 }]] },
        { id: 'no-comp', label: 'No compressor', note: 'Without the compressor, loud picks open the wah wide and soft ones barely move it, so the quack comes and goes.',
          chain: [['wah', { mode: 1, position: 0.5, sensitivity: 16, speed: 1.5, resonance: 6 }]] },
      ],
    },
    {
      id: 'phaser', group: 'Techniques', title: 'Slow phaser swirl', short: 'Phaser', view: 'tone',
      summary: 'A slow, swirling sweep that makes a simple part move: a classic 70s texture.',
      source: { kind: 'guitar', noise: -60 },
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
  const specOf = chain => chain.map(p => [p.type, { ...p.params }, null, p.enabled]);
  function rememberMyBoard(chain) {
    if (!chain.length) return;
    const entry = { id: 'my-last-board', name: 'My last board', spec: specOf(chain) };
    myTones = [entry, ...myTones.filter(t => t.id !== entry.id)];
    saveMyTones();
  }

  function buildChain(spec) {
    const seen = {};
    return validateChain(spec.filter(([type]) => types[type]).map(([type, params, , enabled]) => {
      const number = (seen[type] = (seen[type] || 0) + 1);
      counts[type] = Math.max(counts[type], number);
      return { id: 'pedal-' + (++nextId), type, number, enabled: enabled !== false, params: { ...params } };
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
    if (kind && source.kind !== kind) source.setKind(kind);
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
    const label = tone ? tone.title : heroSelect.selectedOptions[0].textContent;
    announce(label + ' loaded');
    offerUndo(label + ' loaded', () => applyBoard(before));
  };
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
    const toneKeys = tone.chain.map(([type]) => type + '#' + ((seen[type] = (seen[type] ?? -1) + 1)));
    const i = toneKeys.indexOf(key);
    if (i < 0) return ROLES[pedal.type];
    const [type, params, note] = tone.chain[i];
    // Same settings and same place (relative to the pedals both share)?
    const chainKeys = chain.map(p => pedalKey(chain, p));
    const shared = k => k.filter(x => chainKeys.includes(x) && toneKeys.includes(x));
    const samePlace = shared(chainKeys).indexOf(key) === shared(toneKeys).indexOf(key);
    const sameSettings = types[type].specs.every(spec => Math.abs((params[spec.key] ?? spec.value) - pedal.params[spec.key]) < 1e-6);
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
    const params = tone.chain[i][1];
    return shared(chainKeys).indexOf(key) !== shared(toneKeys).indexOf(key) ||
      !types[pedal.type].specs.every(spec => Math.abs((params[spec.key] ?? spec.value) - pedal.params[spec.key]) < 1e-6);
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
      for (const spec of types[pedal.type].specs) {
        if (Math.abs(twin.params[spec.key] - pedal.params[spec.key]) > 1e-6) parts.push(spec.label.toLowerCase() + ' ' + spec.format(twin.params[spec.key]));
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
    document.getElementById('journey-play').textContent = (tone || lessonTone())?.play || 'Your guitar, before any pedals.';
    const items = [];
    const wave = (stage, label, big) => `<li class="journey-wave${big ? ' journey-out' : ''}"><span class="journey-wave-label">${label}</span><canvas data-stage="${stage}" aria-label="${label} waveform" role="img"></canvas></li>`;
    items.push(wave('input', 'Your guitar', chain.length === 0));
    chain.forEach((pedal, i) => {
      const info = types[pedal.type];
      const chips = info.specs.slice(0, 3).map(spec => `<span>${spec.label} ${spec.format(pedal.params[spec.key])}</span>`).join('');
      const diff = byPedal.get(pedal.id);
      items.push(`<li class="journey-step${pedal.enabled ? '' : ' off'}${diff ? ' differs' : ''}" data-type="${pedal.type}">` +
        artSvg(pedal, 'journey-art') +
        `<div><button class="journey-name" data-edit="${pedal.id}">${i + 1} · ${info.name}</button><div class="journey-chips">${chips}</div>` +
        `<p class="journey-note"></p>${diff ? `<p class="journey-diff">${diff}</p>` : ''}</div></li>`);
      items.push(wave(pedal.id, i === chain.length - 1 ? 'What you hear' : 'After the ' + info.name.toLowerCase(), i === chain.length - 1));
    });
    journeyList.innerHTML = items.join('');
    // Notes are plain text: set them as text, not markup.
    journeyList.querySelectorAll('.journey-step').forEach((li, i) => { li.querySelector('.journey-note').textContent = noteFor(chain[i], chain); });
    journeyList.querySelectorAll('[data-edit]').forEach(button => {
      button.onclick = () => openSettings(state.chain.find(p => p.id === button.dataset.edit));
    });
    if (!chain.length) journeyList.insertAdjacentHTML('beforeend', '<li class="journey-empty">No pedals yet: you hear your guitar just as it is. Pick a sound above or add pedals below.</li>');

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
    document.getElementById('journey-tip').textContent = (tone || lessonTone())?.tip || '';
    document.getElementById('journey-tip').hidden = !(tone || lessonTone())?.tip;
    box.querySelectorAll('[data-hear]').forEach(button => button.classList.toggle('on', button.dataset.hear === activeBank));
  }
  document.querySelectorAll('#whatif-box [data-hear]').forEach(button => button.onclick = () => {
    switchBank(button.dataset.hear);
    if (!listening) listen.click();
  });
  function drawJourney() {
    const box = journeyList.getBoundingClientRect();
    if (box.bottom < 0 || box.top > innerHeight) return; // off screen
    const chain = visualChains[activeBank];
    for (const canvas of journeyList.querySelectorAll('canvas')) {
      const id = canvas.dataset.stage;
      let before = null, after = input;
      if (id !== 'input') {
        const entry = chain.instances.get(id);
        const pedal = state.chain.find(p => p.id === id);
        if (!entry || !pedal || !entry.input) continue;
        before = entry.input;
        after = pedal.enabled ? entry.out : entry.input;
      }
      const { ctx, w, h } = fit(canvas);
      ctx.clearRect(0, 0, w, h);
      if (state.view === 'tone') {
        drawSpectrum(ctx, w, h, before, after, 'journey:' + id, false);
        continue;
      }
      const cols = Math.max(1, Math.min(220, Math.floor(w)));
      const step = w / cols;
      // Square-root scale: notes read as separate notes, while quiet echo
      // tails and hiss still show.
      const y = v => h / 2 - Math.sign(v) * Math.sqrt(Math.abs(v)) * (h / 2) * 0.9;
      // The last 1.5 s, zoomed in so single notes and echoes are visible.
      const from = N - JOURNEY_VIEW, length = JOURNEY_VIEW - ENV_HALF;
      if (before) fillWave(ctx, columns(before, cols, from, length), cols, step, y, C.ghost);
      fillWave(ctx, columns(after, cols, from, length), cols, step, y, C.ink);
    }
  }
  onBoardChange = renderJourney;
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
    if (before) area(smoothedSpectrum(key + ':in', before), C.ghost);
    ctx.globalAlpha = 0.85;
    area(smoothedSpectrum(key + ':out', after), C.ink);
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
          handle.setPointerCapture(e.pointerId);
          const r = item.getBoundingClientRect();
          drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, width: r.width, ghost: null };
        };
        const clearDrag = () => {
          drag?.ghost?.remove();
          drag = null;
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
          else if (target && target !== item && orderList.contains(target)) moveEffect(id, state.chain.findIndex(p => p.id === target.dataset.effect));
          else if (!target) moveEffect(id, state.chain.length - 1);
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
    const endpoints = [...signalPath.querySelectorAll('.endpoint')];
    const items = [...orderList.children];
    const single = new Set(items.map(item => Math.round(item.offsetTop))).size <= 1;
    signalPath.classList.toggle('single-row', single);
    if (single) {
      // One row: line Input and Output up with the jacks and run one straight
      // cable behind the pedals.
      const first = items[0] ? box(items[0]) : null;
      const lineY = first ? first.top + ART[items[0].dataset.type].jack * first.width / ART_W : box(dropArea).top + box(dropArea).height / 2;
      for (const endpoint of endpoints) {
        const dot = box(endpoint.querySelector('i'));
        const shift = lineY - (dot.top + dot.height / 2);
        if (Math.abs(shift) > 0.5) endpoint.style.paddingTop = Math.max(0, parseFloat(getComputedStyle(endpoint).paddingTop) + shift) + 'px';
      }
      const a = box(endpoints[0].querySelector('i')), b = box(endpoints[1].querySelector('i'));
      const y = a.top + a.height / 2;
      cables.innerHTML = `<path d="M${a.right.toFixed(1)},${y.toFixed(1)} H${b.left.toFixed(1)}"/>`;
      return;
    }
    for (const endpoint of endpoints) endpoint.style.paddingTop = '';
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
      paths += `<path d="${roundedPath(pts)}"/>`;
    }
    cables.innerHTML = paths;
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
    audioNode?.port.postMessage({ type: 'settings', state: { playing: state.playing, speed: state.speed, chain: state.chain }, kind: source.kind, tempo: source.tempo,
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
    drawJourney();
    drawLanes();
    drawCurves();
    requestAnimationFrame(frame);
  }

  document.getElementById('save-status').textContent = restoreMessage || (storageAvailable ? 'Autosave enabled' : 'Local saving unavailable · use Share');
  saveBoard();
  requestAnimationFrame(frame);
})(window.TL);
