/*
 * Tonelab pedals: every control each effect understands (its "superset"),
 * the classic pedal models built from them, and their outlines.
 *
 * - `specs` lists every control the effect's sound engine reads (dsp.js).
 * - A model shows only some of them, often under the pedal's own names
 *   (an MXR Dyna Comp calls the threshold "Sensitivity"), and can set
 *   characteristic values (`defaults`) when you pick it.
 * - "Show all controls" in the settings sheet reveals the rest.
 */
(function (TL) {
  'use strict';

  const tr = TL.I18n?.t || (value => value);

  /* ---------------------------------------------------------- formatting */
  const fmt = (v, d = 1) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d).replace('-', '−');
  const fmtMs = v => (v < 10 ? fmt(v, 1) : fmt(v, 0)) + ' ms';
  const fmtDb = v => (v <= -79.5 ? '−∞' : fmt(v, 0)) + ' dB';
  const fmtSigned = v => (v > 0 ? '+' : '') + fmt(v, 1) + ' dB';
  const fmtHz = v => (v >= 1000 ? fmt(v / 1000, 1) + ' kHz' : v >= 10 ? fmt(v, 0) + ' Hz' : fmt(v, 1) + ' Hz');
  const pct = v => Math.round(v * 100) + '%';
  const INTERVALS = ['unison', 'minor 2nd', 'major 2nd', 'minor 3rd', 'major 3rd', '4th', 'tritone', '5th', 'minor 6th', 'major 6th', 'minor 7th', 'major 7th', 'octave'];
  const fmtInterval = v => {
    if (v === 0) return 'Unison';
    const a = Math.abs(v), name = a === 24 ? '2 octaves' : a > 12 ? 'octave + ' + INTERVALS[a - 12] : INTERVALS[a];
    return (v > 0 ? '+' : '−') + a + ' · ' + name + (v > 0 ? ' up' : ' down');
  };
  const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const STEP_NAMES = ['unison', '2nd', '3rd', '4th', '5th', '6th', '7th', 'octave'];
  const fmtSteps = v => (v === 0 ? 'Off / unison' : 'A ' + STEP_NAMES[Math.abs(v)] + (v > 0 ? ' up' : ' down'));
  const choose = options => v => (options.find(([value]) => value === v) || options.reduce((a, b) => (Math.abs(b[0] - v) < Math.abs(a[0] - v) ? b : a)))[1];

  // A switch: a control with a few named positions.
  function sw(key, label, options, value, hint) {
    const values = options.map(([v]) => v);
    return { key, label, options, value, hint, min: Math.min(...values), max: Math.max(...values), step: 1e-9, format: choose(options) };
  }

  /* ------------------------------------------------------- control specs */
  const GATE = [
    { key: 'threshold', label: 'Threshold', min: -70, max: 0, step: 1, value: -36, format: fmtDb, hint: 'Level the input has to reach to open the gate.' },
    { key: 'attack', label: 'Attack', min: 0.1, max: 50, value: 1, log: true, format: fmtMs, hint: 'How quickly it opens.' },
    { key: 'hold', label: 'Hold', min: 0, max: 500, step: 1, value: 40, format: fmtMs, hint: 'How long it stays open after the level drops.' },
    { key: 'release', label: 'Release', min: 5, max: 1500, value: 120, log: true, format: fmtMs, hint: 'How slowly it closes.' },
    { key: 'range', label: 'Range', min: -80, max: 0, step: 1, value: -80, format: fmtDb, hint: 'How much quieter the signal gets when closed.' },
    sw('mode', 'Mode', [[0, 'Mute'], [1, 'Reduce'], [2, 'Multiband']], 0, 'Mute shuts the signal off; Reduce turns it down gently; Multiband only gates the highs, where hiss lives.'),
    { key: 'tone', label: 'Tone', min: 1000, max: 8000, value: 3000, log: true, format: fmtHz, hint: 'Multiband mode: only sound above this is gated.' },
  ];
  const COMP = [
    { key: 'threshold', label: 'Threshold', min: -60, max: 0, step: 1, value: -22, format: fmtDb, hint: 'Level above which it starts turning down.' },
    { key: 'ratio', label: 'Ratio', min: 1, max: 20, value: 4, log: true, format: v => fmt(v, 1) + ':1', hint: 'How hard it turns down above the threshold.' },
    { key: 'attack', label: 'Attack', min: 0.1, max: 200, value: 8, log: true, format: fmtMs, hint: 'How quickly it clamps down on a peak.' },
    { key: 'release', label: 'Release', min: 10, max: 1500, value: 180, log: true, format: fmtMs, hint: 'How quickly it lets go afterwards.' },
    { key: 'knee', label: 'Knee', min: 0, max: 24, step: 1, value: 6, format: v => fmt(v, 0) + ' dB', hint: 'Width of the soft transition around the threshold.' },
    { key: 'makeup', label: 'Makeup', min: 0, max: 24, step: 0.5, value: 0, format: v => '+' + fmt(v, 1) + ' dB', hint: 'Gain added after compression.' },
    { key: 'tone', label: 'Tone', min: 0, max: 1, step: 0.01, value: 0.5, format: v => (v < 0.47 ? 'Darker' : v > 0.53 ? 'Brighter' : 'Flat') + ' · ' + pct(v), hint: 'Tilts the treble after compression.' },
    { key: 'blend', label: 'Blend', min: 0, max: 1, step: 0.01, value: 1, format: v => pct(v) + ' compressed', hint: 'Mixes your uncompressed signal back in, keeping the pick attack.' },
    { key: 'input', label: 'Input', min: -6, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Level going in: hotter for weak single coils, less for hot humbuckers.' },
  ];
  const BOOST = [
    { key: 'boost', label: 'Boost', min: 0, max: 20, step: 0.5, value: 10, format: v => '+' + fmt(v, 1) + ' dB', hint: 'Clean extra volume. Before a drive it means more distortion; after it, just louder.' },
    { key: 'level', label: 'Level', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Output volume.' },
    { key: 'bass', label: 'Bass', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Lows.' },
    { key: 'treble', label: 'Treble', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Highs.' },
    sw('voicing', 'Voicing', [[0, 'Clean'], [1, 'Fat'], [2, 'Mid']], 0, 'Clean is flat; Fat adds low mids; Mid pushes the middle.'),
  ];
  const DRIVE = [
    { key: 'drive', label: 'Drive', min: 0, max: 30, step: 0.5, value: 8, format: fmtDb, hint: 'Gain pushed into soft clipping.' },
    { key: 'tone', label: 'Tone', min: 0, max: 1, step: 0.01, value: 1, format: pct, hint: 'Dark to bright (100% leaves the highs alone).' },
    { key: 'level', label: 'Level', min: -20, max: 6, step: 0.5, value: 0, format: fmtSigned, hint: 'Output volume.' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0.4, format: pct, hint: 'Blend the distorted sound with the incoming signal.' },
    { key: 'bass', label: 'Bass', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Lows after the clipping.' },
    { key: 'treble', label: 'Treble', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Highs after the clipping.' },
    sw('clipping', 'Clipping', [[0, 'Symmetrical'], [1, 'Asymmetrical'], [2, 'LED']], 0, 'Symmetrical is smooth; asymmetrical adds warmer even harmonics; LED clips later and harder.'),
    sw('voicing', 'Voicing', [[0, 'Flat'], [1, 'Mid hump'], [2, 'HP'], [3, 'LP']], 0, 'Mid hump cuts lows before the clipping (Tube Screamer-style); HP is brighter and tighter; LP is smoother.'),
  ];
  const DIST = [
    { key: 'gain', label: 'Distortion', min: 0, max: 45, step: 0.5, value: 30, format: fmtDb, hint: 'How hard the signal hits the clipper. More gain, flatter tops.' },
    { key: 'tone', label: 'Tone', min: 0, max: 1, step: 0.01, value: 0.5, format: pct, hint: 'Dark to bright.' },
    { key: 'level', label: 'Level', min: -30, max: 0, step: 0.5, value: -10, format: fmtDb, hint: 'Output volume.' },
    { key: 'bass', label: 'Bass', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Lows after the clipping.' },
    { key: 'mid', label: 'Mids', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'The middle, after the clipping.' },
    { key: 'midFreq', label: 'Mid point', min: 250, max: 3000, value: 800, log: true, format: fmtHz, hint: 'Which part of the middle the Mids control changes.' },
    { key: 'treble', label: 'Treble', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Highs after the clipping.' },
    { key: 'weight', label: 'Weight', min: 20, max: 400, value: 20, log: true, format: v => (v < 25 ? 'Full' : 'Low cut ' + fmtHz(v)), hint: 'Cuts lows before the clipping, for a tighter low end.' },
    sw('tight', 'Tight', [[0, 'Off'], [1, 'On']], 0, 'A stronger low cut before the clipping, for tight palm mutes.'),
  ];
  const FUZZ = [
    { key: 'fuzz', label: 'Fuzz', min: 0, max: 45, step: 0.5, value: 30, format: fmtDb, hint: 'Gain into the clipper. Turn it up and the wave becomes a square.' },
    { key: 'tone', label: 'Tone', min: 0, max: 1, step: 0.01, value: 0.5, format: pct, hint: 'Dark to bright.' },
    { key: 'level', label: 'Level', min: -30, max: 0, step: 0.5, value: -8, format: fmtDb, hint: 'Output volume.' },
    { key: 'bias', label: 'Bias', min: 0, max: 1, step: 0.01, value: 0.5, format: pct, hint: 'Where the transistor clips. Off-center settings sputter and break up.' },
    { key: 'gate', label: 'Gate', min: 0, max: 1, step: 0.01, value: 0, format: v => (v < 0.01 ? 'Off' : pct(v)), hint: 'Starves quiet notes, for a sputtery, gated fuzz.' },
    { key: 'compress', label: 'Compress', min: 0, max: 1, step: 0.01, value: 0, format: pct, hint: 'Lifts fading notes for more sustain.' },
    { key: 'stability', label: 'Stability', min: 0, max: 1, step: 0.01, value: 1, format: pct, hint: 'Lower settings let it squeal and oscillate.' },
    sw('type', 'Transistor', [[0, 'Silicon'], [1, 'Germanium']], 0, 'Silicon is brighter and tighter; germanium is warmer and softer.'),
  ];
  const GRAPHIC = TL.GRAPHIC || [100, 200, 400, 800, 1600, 3200, 6400];
  const qFormat = v => (v <= 1 ? 'Wide' : 'Narrow') + ' · Q ' + fmt(v, 1);
  const EQ = [
    { key: 'bass', label: 'Bass', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Lows: body and thump.' },
    { key: 'bassFreq', label: 'Bass point', min: 40, max: 400, value: 120, log: true, format: fmtHz, hint: 'Where the bass band sits.' },
    { key: 'bassQ', label: 'Bass width', min: 0.5, max: 4, step: 0.1, value: 0.7, format: qFormat, hint: 'Wide is a gentle shelf; narrow is a focused peak.' },
    { key: 'mid', label: 'Mids', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'The middle: what makes a guitar cut through a band.' },
    { key: 'midFreq', label: 'Mid point', min: 250, max: 3000, value: 800, log: true, format: fmtHz, hint: 'Which part of the middle the Mids control changes.' },
    { key: 'midQ', label: 'Mid width', min: 0.5, max: 4, step: 0.1, value: 1, format: qFormat, hint: 'How wide a range the Mids control covers.' },
    { key: 'treble', label: 'Treble', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Highs: sparkle and bite.' },
    { key: 'trebleFreq', label: 'Treble point', min: 1500, max: 8000, value: 3000, log: true, format: fmtHz, hint: 'Where the treble band sits.' },
    { key: 'trebleQ', label: 'Treble width', min: 0.5, max: 4, step: 0.1, value: 0.7, format: qFormat, hint: 'Wide is a gentle shelf; narrow is a focused peak.' },
    { key: 'presence', label: 'Presence', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'The very top: air and edge.' },
    ...GRAPHIC.map(f => ({ key: 'g' + f, label: fmtHz(f), min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Graphic EQ band at ' + fmtHz(f) + '.' })),
    { key: 'level', label: 'Level', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Overall volume.' },
  ];
  const WAH = [
    sw('mode', 'Mode', [[0, 'Held still'], [1, 'Follows picking'], [2, 'Rocks by itself']], 1, 'Held still: a parked (“cocked”) wah. Follows picking: harder picks open it (an envelope filter, or auto-wah). Rocks by itself: an automatic sweep.'),
    { key: 'position', label: 'Pedal position', min: 0, max: 1, step: 0.01, value: 0.5, format: v => (v < 0.34 ? 'Heel (dark)' : v > 0.66 ? 'Toe (bright)' : 'Middle') + ' · ' + pct(v), hint: 'Where the pedal is held (Held still mode).' },
    { key: 'sensitivity', label: 'Sensitivity', min: 0, max: 30, step: 1, value: 14, format: v => '+' + fmt(v, 0) + ' dB', hint: 'How far your picking opens it (Follows picking mode).' },
    { key: 'speed', label: 'Speed', min: 0.2, max: 6, value: 1.5, log: true, format: fmtHz, hint: 'How fast it rocks (Rocks by itself mode).' },
    { key: 'resonance', label: 'Resonance', min: 2, max: 10, step: 0.1, value: 5, format: v => fmt(v, 1), hint: 'How sharp and vocal the peak is.' },
    sw('filter', 'Filter', [[0, 'Band-pass'], [1, 'Low-pass'], [2, 'High-pass']], 0, 'Band-pass is the classic wah; low-pass is fatter; high-pass is thinner.'),
    sw('direction', 'Sweep', [[0, 'Up'], [1, 'Down']], 0, 'Which way picking moves it (Follows picking mode).'),
    { key: 'range', label: 'Contour', min: 0, max: 1, step: 0.01, value: 0.5, format: pct, hint: 'Shifts the whole sweep lower or higher.' },
    { key: 'level', label: 'Level', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Output volume.' },
  ];
  const OCTAVE = [
    { key: 'dry', label: 'Dry', min: 0, max: 1, step: 0.01, value: 0.7, format: pct, hint: 'Your original note.' },
    { key: 'sub', label: 'Octave down', min: 0, max: 1, step: 0.01, value: 0.6, format: pct, hint: 'A switch flips once per cycle, making a square wave at half the frequency.' },
    { key: 'up', label: 'Octave up', min: 0, max: 1, step: 0.01, value: 0.3, format: pct, hint: 'Folding the bottom half of the wave up doubles its frequency.' },
    { key: 'sub2', label: 'Two octaves down', min: 0, max: 1, step: 0.01, value: 0, format: pct, hint: 'A second divider, a quarter of the frequency.' },
    sw('range', 'Range', [[0, 'Normal'], [1, 'High']], 0, 'High tracks notes higher up the neck.'),
    { key: 'shift', label: 'Shifted voice', min: 0, max: 1, step: 0.01, value: 0, format: pct, hint: 'Level of a pitch-shifted copy (Whammy-style).' },
    { key: 'interval', label: 'Interval', min: -24, max: 24, step: 1, value: 12, format: fmtInterval, hint: 'How far the shifted voice goes with the treadle all the way down.' },
    { key: 'treadle', label: 'Treadle', min: 0, max: 1, step: 0.01, value: 1, format: v => (v < 0.02 ? 'Heel (no shift)' : v > 0.98 ? 'Toe (full shift)' : pct(v)), hint: 'Where the treadle is: heel is no shift, toe is the full interval.' },
    { key: 'detune', label: 'Detune', min: -50, max: 50, step: 1, value: 0, format: v => (v > 0 ? '+' : '') + fmt(v, 0) + ' cents', hint: 'A slight offset for a thicker, doubled sound.' },
  ];
  const HARM = [
    { key: 'voice1', label: 'Voice 1', min: -12, max: 12, step: 1, value: 4, format: fmtInterval, hint: 'Interval of the first harmony, in semitones (Fixed mode).' },
    { key: 'voice2', label: 'Voice 2', min: -12, max: 12, step: 1, value: 7, format: v => (v === 0 ? 'Off' : fmtInterval(v)), hint: 'A second voice to make a chord. 0 turns it off (Fixed mode).' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0.5, format: pct, hint: 'Balance between your note and the harmony.' },
    { key: 'window', label: 'Window', min: 20, max: 120, step: 1, value: 50, format: fmtMs, hint: 'How much audio each voice replays. Short windows warble on low notes; long ones smear fast playing.' },
    { key: 'level1', label: 'Voice 1 level', min: 0, max: 1, step: 0.01, value: 1, format: pct, hint: 'Volume of the first voice.' },
    { key: 'level2', label: 'Voice 2 level', min: 0, max: 1, step: 0.01, value: 1, format: pct, hint: 'Volume of the second voice.' },
    sw('mode', 'Harmony', [[0, 'Fixed'], [1, 'Major key'], [2, 'Minor key']], 0, 'Fixed always shifts by the same interval. In a key, the interval changes with the note so the harmony stays in the scale.'),
    { key: 'key', label: 'Key', min: 0, max: 11, step: 1, value: 0, format: v => NOTES[Math.round(v)], hint: 'The key you’re playing in (Major and Minor modes).' },
    { key: 'steps1', label: 'Harmony 1', min: -7, max: 7, step: 1, value: 2, format: fmtSteps, hint: 'Scale steps for the first voice (a 3rd up is the classic harmony).' },
    { key: 'steps2', label: 'Harmony 2', min: -7, max: 7, step: 1, value: 4, format: fmtSteps, hint: 'Scale steps for the second voice. 0 turns it off.' },
  ];
  const CHORUS = [
    { key: 'rate', label: 'Speed', min: 0.1, max: 5, value: 0.8, log: true, format: fmtHz, hint: 'How fast the copy wobbles.' },
    { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, value: 0.5, format: pct, hint: 'How far its pitch wobbles.' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0.6, format: pct, hint: 'How much of the wobbling copy you hear.' },
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, step: 0.01, value: 0, format: pct, hint: 'Feeds the copy back on itself: a ringing, metallic edge (flanger resonance).' },
    { key: 'manual', label: 'Manual', min: 1, max: 25, step: 0.5, value: 12, format: fmtMs, hint: 'The base delay: short for a flanger’s jet sweep, longer for chorus.' },
    sw('wave', 'Wave', [[0, 'Sine'], [1, 'Triangle']], 0, 'The shape of the wobble.'),
    sw('voice', 'Voice', [[0, 'Standard'], [1, 'Vintage'], [2, 'Vibrato']], 0, 'Vintage is warmer (CE-1 style); Vibrato is the wobbling copy alone.'),
  ];
  const PHASER = [
    { key: 'rate', label: 'Speed', min: 0.1, max: 6, value: 0.5, log: true, format: fmtHz, hint: 'How fast it sweeps.' },
    { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, value: 0.7, format: pct, hint: 'How wide the sweep goes.' },
    { key: 'feedback', label: 'Intensity', min: 0, max: 0.9, step: 0.01, value: 0.4, format: pct, hint: 'A sharper, more dramatic swoosh.' },
    sw('stages', 'Stages', [[4, '4 stages'], [8, '8 stages']], 4, 'More stages, more notches: a deeper, more complex sweep.'),
    sw('mode', 'Mode', [[0, 'Phaser'], [1, 'Vibe chorus'], [2, 'Vibe vibrato']], 0, 'Vibe modes stagger the stages for a throbbing Uni-Vibe sound; vibrato drops the dry signal.'),
    { key: 'level', label: 'Level', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Output volume.' },
  ];
  const TREM = [
    { key: 'rate', label: 'Speed', min: 1, max: 12, step: 0.1, value: 5, format: fmtHz, hint: 'Pulses per second.' },
    { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, value: 0.6, format: pct, hint: 'How far the volume dips.' },
    { key: 'shape', label: 'Shape', min: 0, max: 1, step: 0.01, value: 0.2, format: v => (v < 0.34 ? 'Smooth' : v > 0.66 ? 'Choppy' : 'In between') + ' · ' + pct(v), hint: 'Smooth waves to hard, choppy on-off pulses.' },
    sw('wave', 'Wave', [[0, 'Smooth–choppy'], [1, 'Square'], [2, 'Ramp']], 0, 'Square chops on and off; Ramp fades down and snaps back up.'),
    sw('mode', 'Type', [[0, 'Tube bias'], [1, 'Harmonic'], [2, 'Photo']], 0, 'Harmonic pulses the lows and highs in turn; Photo is the softer, lopsided pulse of an optical cell.'),
    { key: 'level', label: 'Level', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Output volume.' },
  ];
  const SWELL = [
    { key: 'rise', label: 'Fade-in time', min: 50, max: 2000, value: 350, log: true, format: fmtMs, hint: 'How long each note takes to fade in.' },
    { key: 'sensitivity', label: 'Sensitivity', min: -60, max: -10, step: 1, value: -40, format: fmtDb, hint: 'How hard you need to pick to start a new swell.' },
    sw('curve', 'Curve', [[0, 'Smooth'], [1, 'Linear']], 0, 'Smooth starts slowly; linear rises evenly.'),
    { key: 'level', label: 'Level', min: -12, max: 12, step: 0.5, value: 0, format: fmtSigned, hint: 'Output volume.' },
  ];
  const DELAY = [
    { key: 'time', label: 'Time', min: 60, max: 1500, value: 300, log: true, format: fmtMs, hint: 'Time between repeats.' },
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.75, step: 0.01, value: 0.35, format: pct, hint: 'How much of each echo feeds the next.' },
    { key: 'mix', label: 'Mix', min: 0, max: 0.8, step: 0.01, value: 0.3, format: pct, hint: 'Balance between the signal and its echoes.' },
    { key: 'character', label: 'Character', min: 0, max: 1, step: 0.01, value: 0, format: v => (v < 0.03 ? 'Clean (digital)' : v > 0.97 ? 'Dark (analog)' : pct(v) + ' darker'), hint: 'Clean, exact repeats to darker, grittier repeats that fade like an analog delay.' },
    sw('type', 'Type', [[0, 'Digital'], [1, 'Analog'], [2, 'Tape'], [3, 'Reverse']], 0, 'Analog repeats get darker; tape wobbles; reverse plays each slice backwards.'),
    sw('subdivision', 'Subdivision', [[0, 'Quarter'], [1, 'Eighth'], [2, 'Dotted 8th'], [3, 'Triplet']], 0, 'Treat Time as one beat and repeat on this note value.'),
    { key: 'modRate', label: 'Mod speed', min: 0.1, max: 5, value: 0.8, log: true, format: fmtHz, hint: 'Speed of the wobble on the repeats.' },
    { key: 'modDepth', label: 'Mod depth', min: 0, max: 1, step: 0.01, value: 0, format: v => (v < 0.01 ? 'Off' : pct(v)), hint: 'How much the repeats wobble, like a chorus on the echoes.' },
    sw('range', 'Range', [[200, 'Short'], [800, 'Medium'], [2000, 'Long']], 2000, 'Caps the delay time: short for slapback, long for big echoes.'),
  ];
  const REVERB = [
    { key: 'decay', label: 'Decay', min: 0, max: 1, step: 0.01, value: 0.6, format: pct, hint: 'How long the room rings.' },
    { key: 'tone', label: 'Tone', min: 0, max: 1, step: 0.01, value: 0.5, format: pct, hint: 'Dark to bright reflections.' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0.35, format: pct, hint: 'How much reverb you hear.' },
    { key: 'predelay', label: 'Pre-delay', min: 0, max: 200, step: 1, value: 0, format: fmtMs, hint: 'A gap before the reverb starts, so your notes stay clear.' },
    { key: 'lowCut', label: 'Low cut', min: 20, max: 600, value: 20, log: true, format: v => (v < 25 ? 'Off' : fmtHz(v)), hint: 'Removes muddy lows from the reverb.' },
    { key: 'dwell', label: 'Dwell', min: 0, max: 1, step: 0.01, value: 0.5, format: pct, hint: 'How hard your signal hits the reverb. High settings crash and splash.' },
    sw('mode', 'Type', [[0, 'Room'], [1, 'Hall'], [2, 'Plate'], [3, 'Spring'], [4, 'Shimmer']], 0, 'Hall is bigger; plate is bright and dense; spring is boingy; shimmer rings an octave up.'),
  ];

  /* ------------------------------------------------------------ models
   * controls: a key, or { key, label, invert, options (positions to show),
   * labels (renamed positions), presets ([[value, label]] shown as a switch) }. */
  const types = {
    gate: { name: 'Noise gate', short: 'Gate', specs: GATE, explanation: 'Silences the quiet parts. Attack opens the gate; hold and release preserve the tails. Try a gate after delay to cut off the echoes.',
      models: [
        { id: 'decimator', name: 'ISP Decimator', shape: 'mxr', controls: ['threshold'] },
        { id: 'ns2', name: 'Boss NS-2', shape: 'boss', controls: ['threshold', { key: 'release', label: 'Decay' }, { key: 'mode', options: [1, 0], labels: { 1: 'Reduction', 0: 'Mute' } }] },
        { id: 'sentry', name: 'TC Electronic Sentry', shape: 'small', controls: ['threshold', { key: 'range', label: 'Damp' }, 'tone', { key: 'mode', options: [0, 2], labels: { 0: 'Gate', 2: 'Multiband' } }], defaults: { mode: 2 } },
      ] },
    comp: { name: 'Compressor', short: 'Comp', specs: COMP, explanation: 'Controls peaks above the threshold. Two compressors can share the work: use the first for gentle leveling and the second to catch the remaining peaks.',
      models: [
        { id: 'dynacomp', name: 'MXR Dyna Comp', shape: 'mxr', controls: [{ key: 'makeup', label: 'Output' }, { key: 'threshold', label: 'Sensitivity', invert: true }] },
        { id: 'keeley', name: 'Keeley Compressor Plus', shape: 'box', controls: [{ key: 'threshold', label: 'Sustain', invert: true }, { key: 'makeup', label: 'Level' }, 'blend', 'tone', { key: 'input', label: 'Pickups', presets: [[6, 'Single coil'], [0, 'Humbucker']] }], defaults: { ratio: 4, blend: 0.7 } },
        { id: 'cali76', name: 'Studio compressor (Cali76 style)', shape: 'big', controls: [{ key: 'threshold', label: 'Input', invert: true }, { key: 'makeup', label: 'Output' }, 'ratio', 'attack', 'release', { key: 'blend', label: 'Dry', invert: true }] },
      ] },
    boost: { name: 'Boost', short: 'Boost', specs: BOOST, explanation: 'Clean extra volume. In front of an overdrive it pushes it harder for more crunch; at the end of the board it just makes everything louder.',
      models: [
        { id: 'ep', name: 'Xotic EP Booster', shape: 'mini', controls: ['boost'] },
        { id: 'microamp', name: 'MXR Micro Amp', shape: 'mxr', controls: [{ key: 'boost', label: 'Gain' }] },
        { id: 'spark', name: 'TC Electronic Spark Booster', shape: 'box', controls: [{ key: 'boost', label: 'Gain' }, 'level', 'bass', 'treble', 'voicing'] },
      ] },
    drive: { name: 'Overdrive', short: 'Drive', specs: DRIVE, explanation: 'Adds harmonics by rounding off peaks. Try compression before drive for a more even distortion, or after it to tame the result.',
      models: [
        { id: 'ts9', name: 'Ibanez Tube Screamer TS9', shape: 'ts', controls: ['drive', 'tone', 'level'], defaults: { mix: 1, voicing: 1, tone: 0.5, level: -6 } },
        { id: 'klon', name: 'Klon Centaur', shape: 'box', controls: [{ key: 'drive', label: 'Gain' }, 'treble', { key: 'level', label: 'Output' }], defaults: { mix: 0.6, voicing: 0, tone: 1, clipping: 0 } },
        { id: 'ocd', name: 'Fulltone OCD', shape: 'box', controls: [{ key: 'level', label: 'Volume' }, 'drive', 'tone', { key: 'voicing', options: [2, 3] }], defaults: { mix: 1, voicing: 2, tone: 0.6, clipping: 2, level: -6 } },
      ] },
    dist: { name: 'Distortion', short: 'Dist', specs: DIST, explanation: 'Clips the wave hard, so its tops go flat: heavier and more even than overdrive. Overdrive rounds the peaks, distortion flattens them, fuzz squares the whole wave off.',
      models: [
        { id: 'rat', name: 'ProCo RAT', shape: 'rat', controls: [{ key: 'gain', label: 'Distortion' }, { key: 'tone', label: 'Filter', invert: true }, { key: 'level', label: 'Volume' }] },
        { id: 'ds1', name: 'Boss DS-1', shape: 'boss', controls: ['level', 'tone', { key: 'gain', label: 'Dist' }] },
        { id: 'hm2', name: 'Boss HM-2 Heavy Metal', shape: 'boss', controls: ['level', { key: 'bass', label: 'Color low' }, { key: 'treble', label: 'Color high' }, { key: 'gain', label: 'Dist' }], defaults: { bass: 8, treble: 8, mid: -4 } },
        { id: 'heavy', name: 'Empress Heavy', shape: 'big', controls: ['gain', 'weight', { key: 'level', label: 'Output' }, { key: 'bass', label: 'Low' }, 'mid', 'midFreq', { key: 'treble', label: 'High' }, 'tight'] },
      ] },
    fuzz: { name: 'Fuzz', short: 'Fuzz', specs: FUZZ, explanation: 'Clips so hard the wave turns almost square, and the two halves clip unevenly for a sputtery edge. Compare it with overdrive, which only rounds the peaks.',
      models: [
        { id: 'fuzzface', name: 'Dallas Arbiter Fuzz Face', shape: 'round', controls: [{ key: 'level', label: 'Volume' }, 'fuzz'], defaults: { type: 1 } },
        { id: 'bigmuff', name: 'Electro-Harmonix Big Muff Pi', shape: 'box', controls: [{ key: 'level', label: 'Volume' }, 'tone', { key: 'fuzz', label: 'Sustain' }], defaults: { type: 0 } },
        { id: 'fuzzfactory', name: 'ZVEX Fuzz Factory', shape: 'box', controls: [{ key: 'level', label: 'Volume' }, 'gate', { key: 'compress', label: 'Comp' }, { key: 'fuzz', label: 'Drive' }, { key: 'stability', label: 'Stab' }], defaults: { type: 1 } },
      ] },
    eq: { name: 'EQ', short: 'EQ', specs: EQ, explanation: 'Turns bass, mids and treble up or down. Switch the view to Tone to see exactly what it changes.',
      models: [
        { id: 'ge7', name: 'Boss GE-7', shape: 'eqboss', controls: [...GRAPHIC.map(f => 'g' + f), 'level'] },
        { id: 'paraeq', name: 'Empress ParaEQ', shape: 'big', controls: [{ key: 'bass', label: 'Low gain' }, { key: 'mid', label: 'Mid gain' }, { key: 'treble', label: 'High gain' },
          { key: 'bassFreq', label: 'Low freq' }, { key: 'midFreq', label: 'Mid freq' }, { key: 'trebleFreq', label: 'High freq' },
          { key: 'bassQ', label: 'Low Q', presets: [[0.7, 'Wide'], [2.5, 'Narrow']] }, { key: 'midQ', label: 'Mid Q', presets: [[0.7, 'Wide'], [2.5, 'Narrow']] }, { key: 'trebleQ', label: 'High Q', presets: [[0.7, 'Wide'], [2.5, 'Narrow']] }] },
      ] },
    wah: { name: 'Wah', short: 'Wah', specs: WAH, explanation: 'A peak in the sound that moves from dark (heel) to bright (toe), like a voice saying “wah”. It can be held still, follow your picking (an auto-wah), or rock by itself.',
      models: [
        { id: 'crybaby', name: 'Dunlop Cry Baby', shape: 'treadle', controls: [{ key: 'position', label: 'Treadle' }], defaults: { mode: 0 } },
        { id: 'badhorsie', name: 'Morley Bad Horsie', shape: 'treadle', controls: [{ key: 'position', label: 'Treadle' }, { key: 'range', label: 'Contour' }, { key: 'level', label: 'Contour level' }], defaults: { mode: 0 } },
        { id: 'qtron', name: 'Electro-Harmonix Q-Tron', kind: 'Envelope filter', short: 'Env', shape: 'box', controls: [{ key: 'sensitivity', label: 'Drive' }, { key: 'resonance', label: 'Q' }, { key: 'level', label: 'Gain' }, 'direction', { key: 'filter', label: 'Mode', labels: { 0: 'BP', 1: 'LP', 2: 'HP' } }], defaults: { mode: 1 } },
      ] },
    octave: { name: 'Octave', short: 'Octave', specs: OCTAVE, explanation: 'Adds notes an octave below and above. It tracks single notes best; chords confuse it, much like an analog octave pedal. Watch the octave down turn the wave into wide square steps.',
      models: [
        { id: 'micropog', name: 'Electro-Harmonix Micro POG', shape: 'box', controls: ['dry', 'sub', 'up'] },
        { id: 'oc5', name: 'Boss OC-5', shape: 'boss', controls: [{ key: 'dry', label: 'Direct' }, { key: 'sub', label: 'Oct 1' }, { key: 'sub2', label: 'Oct 2' }, 'range'] },
        { id: 'whammy', name: 'DigiTech Whammy', kind: 'Pitch shifter', short: 'Whammy', shape: 'whammy', controls: ['treadle', { key: 'interval', label: 'Preset', presets: [[24, '2 oct up'], [12, 'Oct up'], [7, '5th up'], [-12, 'Oct down'], [-24, '2 oct down']] }], defaults: { dry: 0, sub: 0, up: 0, sub2: 0, shift: 1 } },
      ] },
    harm: { name: 'Harmonizer', short: 'Harmony', specs: HARM, explanation: 'Adds pitch-shifted copies of your playing to build harmonies. In a key, the interval follows the note you play, so the harmony stays in the scale.',
      models: [
        { id: 'whammyharm', name: 'DigiTech Whammy (harmony mode)', shape: 'whammy', controls: ['voice1', 'voice2', 'mix'] },
        { id: 'ps6', name: 'Boss PS-6 Harmonist', shape: 'boss', controls: [{ key: 'mix', label: 'Balance' }, 'key', { key: 'steps1', label: 'Harmony' }, { key: 'mode', label: 'Mode' }], defaults: { mode: 1, steps2: 0 } },
      ] },
    chorus: { name: 'Chorus', short: 'Chorus', specs: CHORUS, explanation: 'Blends in a copy of your playing whose pitch wobbles slightly, like two guitars playing together. Subtle settings shimmer; extreme ones warble.',
      models: [
        { id: 'smallclone', name: 'Electro-Harmonix Small Clone', shape: 'small', controls: [{ key: 'rate', label: 'Rate' }, { key: 'depth', presets: [[0.4, 'Shallow'], [1, 'Deep']] }] },
        { id: 'ce2w', name: 'Boss CE-2W', shape: 'boss', controls: ['rate', 'depth', { key: 'voice', label: 'Mode', labels: { 0: 'S', 1: 'CE-1', 2: 'Vibrato' } }] },
        { id: 'flanger', name: 'Classic flanger', kind: 'Flanger', short: 'Flanger', shape: 'box', controls: ['manual', { key: 'depth', label: 'Width' }, 'rate', { key: 'feedback', label: 'Resonance' }], defaults: { manual: 2, feedback: 0.6, mix: 1, wave: 1, rate: 0.3 } },
      ] },
    phaser: { name: 'Phaser', short: 'Phaser', specs: PHASER, explanation: 'Cuts moving notches into the sound for a swirling “whoosh”. In the Tone view you can see the dips slide back and forth.',
      models: [
        { id: 'phase90', name: 'MXR Phase 90', shape: 'mxr', controls: ['rate'] },
        { id: 'smallstone', name: 'Electro-Harmonix Small Stone', shape: 'small', controls: [{ key: 'rate', label: 'Rate' }, { key: 'feedback', label: 'Color', presets: [[0.1, 'Off'], [0.75, 'On']] }] },
        { id: 'univibe', name: 'Uni-Vibe', kind: 'Uni-Vibe', short: 'Vibe', shape: 'big', controls: [{ key: 'level', label: 'Volume' }, { key: 'depth', label: 'Intensity' }, 'rate', { key: 'mode', options: [1, 2], labels: { 1: 'Chorus', 2: 'Vibrato' } }], defaults: { mode: 1, rate: 2 } },
      ] },
    trem: { name: 'Tremolo', short: 'Trem', specs: TREM, explanation: 'Turns the volume up and down in a steady pulse. Watch the waveform throb.',
      models: [
        { id: 'tr2', name: 'Boss TR-2', shape: 'boss', controls: ['rate', 'depth', { key: 'shape', label: 'Wave' }] },
        { id: 'flint', name: 'Strymon Flint (tremolo)', shape: 'box', controls: ['rate', { key: 'depth', label: 'Intensity' }, { key: 'mode', options: [1, 0, 2], labels: { 1: 'Harmonic', 0: '’63 Tube', 2: '’65 Photo' } }] },
      ] },
    swell: { name: 'Volume swell', short: 'Swell', specs: SWELL, explanation: 'Fades every new note in, as if you rolled a volume pedal up after each pick. It hides the pick attack for soft, violin-like notes.',
      models: [
        { id: 'crescendo', name: 'TC Electronic Crescendo', shape: 'small', controls: [{ key: 'rise', label: 'Swell' }, 'sensitivity'] },
        { id: 'sg1', name: 'Boss SG-1 Slow Gear', shape: 'boss', controls: [{ key: 'sensitivity', label: 'Sens' }, { key: 'rise', label: 'Attack' }] },
      ] },
    delay: { name: 'Delay', short: 'Delay', specs: DELAY, explanation: 'Time sets the spacing of echoes; feedback controls their decay. Digital repeats are exact; analog and tape ones get darker and wobblier.',
      models: [
        { id: 'dd3', name: 'Boss DD-3', shape: 'boss', controls: [{ key: 'mix', label: 'E. level' }, { key: 'feedback', label: 'F. back' }, 'time', { key: 'range', label: 'Mode', labels: { 200: 'S', 800: 'M', 2000: 'L' } }] },
        { id: 'carbon', name: 'MXR Carbon Copy', shape: 'mxr', controls: [{ key: 'feedback', label: 'Regen' }, 'mix', { key: 'time', label: 'Delay' }, { key: 'modDepth', label: 'Mod', presets: [[0, 'Off'], [0.5, 'On']] }], defaults: { type: 1 } },
        { id: 'multi', name: 'Modern multi-delay', shape: 'big', controls: ['time', { key: 'feedback', label: 'Repeats' }, 'mix', { key: 'character', label: 'Tone', invert: true }, 'modRate', 'modDepth', 'subdivision', 'type'] },
      ] },
    reverb: { name: 'Reverb', short: 'Reverb', specs: REVERB, explanation: 'The sound of a room: thousands of tiny reflections that ring on after each note. Decay sets how big the room sounds.',
      models: [
        { id: 'holygrail', name: 'Electro-Harmonix Holy Grail Nano', shape: 'small', controls: [{ key: 'mix', label: 'Reverb' }, { key: 'mode', options: [3, 1, 0] }] },
        { id: 'fender', name: 'Fender ’63 spring reverb', shape: 'box', controls: ['dwell', 'mix', 'tone'], defaults: { mode: 3 } },
        { id: 'bigsky', name: 'Strymon BigSky style', shape: 'big', controls: ['decay', 'predelay', 'mix', 'tone', 'lowCut', { key: 'dwell', label: 'Drive' }, 'mode'], defaults: { mode: 1 } },
      ] },
  };

  // Pedal names, control labels, switch positions and value formats match the
  // English terms printed on pedals. Only explanatory copy is localized.
  for (const info of Object.values(types)) {
    const explanation = info.explanation;
    Object.defineProperty(info, 'explanation', { enumerable: true, get: () => tr(explanation) });
    for (const spec of info.specs) {
      const hint = spec.hint;
      Object.defineProperty(spec, 'hint', { enumerable: true, get: () => tr(hint) });
    }
  }

  /* ------------------------------------------------------------ helpers */
  const modelOf = pedal => types[pedal.type].models.find(m => m.id === pedal.model) || types[pedal.type].models[0];
  const kindName = pedal => modelOf(pedal).kind || types[pedal.type].name;
  const shortName = pedal => modelOf(pedal).short || types[pedal.type].short;
  const specOf = (type, key) => types[type].specs.find(s => s.key === key);
  // The model's characteristic settings over the effect's defaults.
  const modelDefaults = (type, modelId) => ({ ...Object.fromEntries(types[type].specs.map(s => [s.key, s.value])), ...(types[type].models.find(m => m.id === modelId)?.defaults || {}) });
  // Boards saved before models existed: pick the model that showed those controls.
  function legacyModel(type, params) {
    if (type === 'eq') return 'paraeq';
    if (type === 'wah') return params?.mode === 1 ? 'qtron' : params?.mode === 2 ? 'badhorsie' : 'crybaby';
    return types[type].models[0].id;
  }
  // One descriptor per control to show: on the pedal, or all of them.
  function controlsFor(pedal, all = false) {
    const model = modelOf(pedal);
    const shown = model.controls.map(c => (typeof c === 'string' ? { key: c } : c));
    const describe = c => {
      const spec = specOf(pedal.type, c.key);
      let options = c.presets || spec.options;
      if (!c.presets && spec.options && c.options) options = c.options.map(v => [v, (c.labels && c.labels[v]) || spec.options.find(([o]) => o === v)[1]]);
      else if (!c.presets && spec.options && c.labels) options = spec.options.map(([v, l]) => [v, c.labels[v] || l]);
      return { key: c.key, spec, label: c.label || spec.label, invert: !!c.invert, options, onPedal: true };
    };
    const list = shown.map(describe);
    if (all) {
      const keys = new Set(list.map(c => c.key));
      for (const spec of types[pedal.type].specs) if (!keys.has(spec.key)) list.push({ key: spec.key, spec, label: spec.label, invert: false, options: spec.options, onPedal: false });
    }
    return list;
  }
  // 0..1 position of a control (for knobs, faders and switches).
  function level(pedal, control) {
    const spec = control.spec, v = pedal.params[control.key];
    let t;
    if (control.options) {
      const i = control.options.reduce((best, [o], k) => (Math.abs(o - v) < Math.abs(control.options[best][0] - v) ? k : best), 0);
      t = control.options.length > 1 ? i / (control.options.length - 1) : 0;
    } else t = spec.log ? Math.log(v / spec.min) / Math.log(spec.max / spec.min) : (v - spec.min) / (spec.max - spec.min);
    t = Math.max(0, Math.min(1, t));
    return control.invert ? 1 - t : t;
  }

  /* ----------------------------------------------------------- outlines
   * Drawn in a 76 × 140 box: chrome 0–24, controls 24–48, name 48–80,
   * footswitch 80–112, drag handle 112–140. `inset` and `jack` place the
   * cable connections. Knobs and switches show the pedal's real settings. */
  const ART_W = 76, ART_H = 140, JACK_Y = 66;
  function knob(cx, cy, r, t) {
    const a = (-135 + 270 * t) * Math.PI / 180;
    const x = (cx + Math.sin(a) * (r - 1.6)).toFixed(1), y = (cy - Math.cos(a) * (r - 1.6)).toFixed(1);
    return `<circle class="art-knob" cx="${cx.toFixed(1)}" cy="${cy}" r="${r.toFixed(1)}"/><line class="art-pointer" x1="${cx.toFixed(1)}" y1="${cy}" x2="${x}" y2="${y}"/>`;
  }
  function toggle(cx, cy, t) {
    const y = (cy + 4 - 8 * t).toFixed(1);
    return `<rect class="art-line" x="${(cx - 3).toFixed(1)}" y="${cy - 7}" width="6" height="14" rx="2"/><circle class="art-knob" cx="${cx.toFixed(1)}" cy="${y}" r="2.2"/>`;
  }
  const stomp = (cx, cy, r = 6.5) => `<circle class="art-line" cx="${cx}" cy="${cy}" r="${r + 3.5}"/><circle class="art-switch" cx="${cx}" cy="${cy}" r="${r}"/>`;
  const ridges = (ys, x1, x2) => ys.map(y => `<line class="art-line" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/>`).join('');
  const led = (cx, cy) => `<circle class="art-led-glow" cx="${cx}" cy="${cy}" r="4.5"/><circle class="art-led" cx="${cx}" cy="${cy}" r="2.3"/>`;
  const screws = [[14, 6], [62, 6], [14, 134], [62, 134]].map(([x, y]) => `<circle class="art-line" cx="${x}" cy="${y}" r="1.4"/>`).join('');
  const bossTreadle = `<path class="art-switch" d="M10 80 H66 L70 86 V134 Q70 137 67 137 H9 Q6 137 6 134 V86 Z"/>${ridges([93, 98, 103, 108], 16, 60)}`;
  // A row (or two) of knobs and switches between x0 and x1.
  function controlRow(pedal, controls, x0, x1, y, maxPerRow = 4, maxR = 8) {
    if (!controls.length) return '';
    const rows = controls.length > maxPerRow ? [controls.slice(0, Math.ceil(controls.length / 2)), controls.slice(Math.ceil(controls.length / 2))] : [controls];
    const ys = rows.length > 1 ? [y - 6.5, y + 7] : [y];
    return rows.map((row, r) => {
      const gap = (x1 - x0) / row.length, radius = Math.min(maxR, gap * 0.4, rows.length > 1 ? 5 : maxR);
      return row.map((c, i) => {
        const cx = x0 + gap * (i + 0.5);
        return c.options ? toggle(cx, ys[r], level(pedal, c)) : knob(cx, ys[r], radius, level(pedal, c));
      }).join('');
    }).join('');
  }
  const SHAPES = {
    boss: { inset: 3, led: [38, 19], draw: (p, c) => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="4"/>${controlRow(p, c, 6, 70, 36, 4, 6)}${bossTreadle}` },
    eqboss: { inset: 3, led: [38, 14], draw: (p, c) => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="4"/>` +
      c.filter(x => x.key.startsWith('g')).map((x, i) => {
        const cx = (12 + i * 8.67).toFixed(1), cy = (44 - level(p, x) * 18).toFixed(1);
        return `<line class="art-line" x1="${cx}" y1="24" x2="${cx}" y2="46"/><rect class="art-knob" x="${(cx - 3).toFixed(1)}" y="${(cy - 2).toFixed(1)}" width="6" height="4" rx="1"/>`;
      }).join('') + bossTreadle },
    mxr: { inset: 9, led: [57, 48], draw: (p, c) => `<rect class="art-body" x="9" y="1" width="58" height="138" rx="3"/>${screws}${controlRow(p, c, 12, 64, 35, 4, 9)}${stomp(38, 98)}` },
    small: { inset: 6, led: [60, 86], draw: (p, c) => `<rect class="art-body" x="6" y="1" width="64" height="138" rx="5"/>${controlRow(p, c, 10, 66, 36, 4, 8)}${stomp(38, 100)}` },
    mini: { inset: 14, led: [54, 33], draw: (p, c) => `<rect class="art-body" x="14" y="24" width="48" height="115" rx="4"/>${controlRow(p, c, 16, 48, 37, 3, 7)}${stomp(38, 108, 5)}` },
    box: { inset: 3, led: [62, 86], draw: (p, c) => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="6"/>${controlRow(p, c, 5, 71, 36, 4, 8)}${stomp(38, 100)}` },
    rat: { inset: 3, led: [62, 86], draw: (p, c) => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="3"/><line class="art-line" x1="3" y1="46" x2="73" y2="46"/>${controlRow(p, c, 5, 71, 32, 4, 7)}${stomp(38, 100)}` },
    ts: { inset: 3, led: [38, 19], draw: (p, c) => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="8"/>${controlRow(p, c, 5, 71, 36, 4, 7)}<rect class="art-switch" x="10" y="82" width="56" height="52" rx="3"/>` },
    round: { inset: 1.5, led: [38, 47], draw: (p, c) => `<circle class="art-body" cx="38" cy="70" r="36.5"/>${controlRow(p, c, 18, 58, 46, 3, 6)}${stomp(38, 95, 5)}` },
    treadle: { inset: 3, led: [38, 14], draw: (p, c) => `<rect class="art-body" x="3" y="1" width="70" height="138" rx="12"/>` +
      (c.length > 1 ? `${controlRow(p, c.slice(1), 10, 66, 34, 3, 6)}<rect class="art-switch" x="9" y="48" width="58" height="84" rx="8"/>` : `<rect class="art-switch" x="9" y="24" width="58" height="108" rx="8"/>`) +
      ridges([90, 96, 102, 108, 114, 120], 17, 59) },
    whammy: { inset: 1, led: [64, 20], draw: (p, c) => `<rect class="art-body" x="1" y="1" width="74" height="138" rx="10"/>${controlRow(p, c.filter(x => x.key !== 'treadle'), 6, 70, 34, 4, 7)}<rect class="art-switch" x="7" y="50" width="62" height="84" rx="7"/>${ridges([88, 94, 100, 106, 112], 15, 61)}` },
    big: { inset: 1, led: [38, 88], draw: (p, c) => `<rect class="art-body" x="1" y="1" width="74" height="138" rx="3"/>${controlRow(p, c, 3, 73, 36, 5, 6)}${stomp(20, 104, 4.5)}${stomp(56, 104, 4.5)}` },
  };
  const shapeOf = pedal => SHAPES[modelOf(pedal).shape];
  function pedalArt(pedal) {
    const shape = shapeOf(pedal), inset = shape.inset;
    const jacks = `<rect class="art-jack" x="${inset - 3}" y="${JACK_Y - 3}" width="3" height="6"/><rect class="art-jack" x="${ART_W - inset}" y="${JACK_Y - 3}" width="3" height="6"/>`;
    return jacks + shape.draw(pedal, controlsFor(pedal)) + led(...shape.led);
  }
  const artSvg = (pedal, cls) => `<svg class="${cls}" viewBox="0 0 ${ART_W} ${ART_H}" aria-hidden="true" focusable="false">${pedalArt(pedal)}</svg>`;

  TL.Pedals = { types, modelOf, kindName, shortName, modelDefaults, legacyModel, controlsFor, level, pedalArt, artSvg, shapeOf, SHAPES, ART_W, ART_H, JACK_Y,
    fmt, fmtMs, fmtDb, fmtSigned, fmtHz, pct, fmtInterval };
})((globalThis.TL = globalThis.TL || {}));
