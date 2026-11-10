# Tonelab

See how audio effects change a waveform, live.

Tonelab generates a test signal (guitar plucks, with an adjustable noise floor), runs it through an effect chain and draws the dry input (grey) and the processed output (ink) on top of each other.

**Effects so far**

- **Noise gate**: threshold, attack, hold, release, range
- **Compressor**: threshold, ratio, attack, release, knee, makeup
- **Overdrive**: drive, dry/wet mix
- **Fuzz**: fuzz, tone, level (hard asymmetric clipping that squares the wave)
- **Octave**: dry, octave down (flip-flop divider), octave up (full-wave rectifier)
- **Harmonizer**: two voices (±12 semitones), mix, window (delay-line pitch shifter that searches for the best-matching splice point)
- **Delay**: time, feedback, dry/wet mix

Each pedal card is drawn as the outline of a classic pedal of its kind (Decimator, Dyna Comp, Tube Screamer, Fuzz Face, POG, Whammy, DD-3), and its knobs and faders follow the current settings. A cable runs from Input through every pedal in processing order to Output, wrapping with the rows. The page behind a settings sheet or dialog stays still while it's open.

Tap **Listen** to hear the synthesized source, then compare **Dry input** with **With effects**. Guitar uses a plucked-string model, rather than a recorded sample. Audio starts only after a user gesture and has a volume control. The internal 24 kHz signal is resampled for playback.

Use **Add effect** to build any combination, including repeated effects. Every pedal has its own settings, processor state, and on/off control. Tap a pedal to bypass it; **Edit** opens its settings sheet, where you can duplicate it, remove it, or move it earlier/later.

Drag the handles to change processing order on desktop or mobile, or use the arrow keys while a handle is focused. The pedal follows your pointer; drag it outside the dashed board and it turns red with an ✕, and letting go removes it. An Undo bar (or Ctrl/⌘+Z) puts the last removed pedal back for 8 seconds. Compact pedals wrap onto additional rows as the board grows; position numbers show the processing order. Input and Output stay outside the dashed board. Removing every pedal gives a clean dry signal.

The gate and compressor settings show transfer curves (input level → output level) with a dot tracking the signal. Scope meters and threshold lines follow the most recently inspected gate/compressor, or the first instance of each type. Their labels identify the pedal being measured.

## Tone recipes

Below the pedalboard, **Tone recipes** explain classic sounds step by step. Loading one puts its board in A and an alternative in B (with the right noise floor and playing pattern), so switching A/B with Match volume shows what each choice does. Loading replaces both boards; an Undo bar puts them back.

- **Endless, clean echo**: gate → compressor → delay, compared with compressor → gate → delay (the compressor's makeup lifts the hiss past the gate, and the delay repeats it).
- **Dotted-eighth echo**, as on U2's "Where the Streets Have No Name": a ¾-beat delay (≈357 ms at 126 BPM) over steady eighth notes, compared with a straight-eighth delay.

Recipes live in the `RECIPES` list in `js/app.js`: each has A and B chains (pedal type plus any settings that differ from the defaults), the source pattern and noise floor, the steps, and the comparison text.

The **Playing** selector switches the synthesized guitar between free picking and steady eighth notes.

## Run it

It's a static site with no build step. Serve the folder locally (audio requires localhost or HTTPS):

```sh
python3 -m http.server 8000
```

## Layout

- `index.html`: page structure
- `css/style.css`: styles (paper palette)
- `js/dsp.js`: signal generator and every effect
- `js/app.js`: controls, effect chain and canvas drawing
- `js/audio-worklet.js`: continuous audio rendering off the main thread

The waveform uses a fixed decibel scale and normal playback speed.

## DSP checks

```sh
node --test tests/dsp.test.cjs
```

Checks cover independent duplicate compressors, bypass and empty chains, processor cleanup, streamed audio continuity, effect ordering, octave and harmonizer pitch accuracy, and fuzz clipping.
