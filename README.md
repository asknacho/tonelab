# Tonelab

See how audio effects change a waveform, live.

Tonelab generates a test signal (guitar plucks, with an adjustable noise floor), runs it through an effect chain and draws the dry input (grey) and the processed output (ink) on top of each other.

**Effects so far**

- **Noise gate**: threshold, attack, hold, release, range
- **Compressor**: threshold, ratio, attack, release, knee, makeup
- **Overdrive**: drive, dry/wet mix
- **Delay**: time, feedback, dry/wet mix

Tap **Listen** to hear the synthesized source, then compare **Dry input** with **With effects**. Guitar uses a plucked-string model, rather than a recorded sample. Audio starts only after a user gesture and has a volume control. The internal 24 kHz signal is resampled for playback.

Use **Add effect** to build any combination, including repeated effects. Every pedal has its own settings, processor state, and on/off control. Tap a pedal to bypass it; **Edit** opens its settings sheet, where you can duplicate it, remove it, or move it earlier/later.

Drag the handles to change processing order on desktop or mobile, or use the arrow keys while a handle is focused. Compact pedals wrap onto additional rows as the board grows; position numbers show the processing order. Input and Output stay outside the dashed board. Removing every pedal gives a clean dry signal.

The gate and compressor settings show transfer curves (input level → output level) with a dot tracking the signal. Scope meters and threshold lines follow the most recently inspected gate/compressor, or the first instance of each type. Their labels identify the pedal being measured.

## Run it

It's a static site with no build step. Serve the folder locally (audio requires localhost or HTTPS):

```sh
python3 -m http.server 8000
```

## Layout

- `index.html`: page structure
- `css/style.css`: styles (paper palette)
- `js/dsp.js`: signal generator, noise gate, compressor
- `js/app.js`: controls, effect chain and canvas drawing
- `js/audio-worklet.js`: continuous audio rendering off the main thread

The waveform uses a fixed decibel scale and normal playback speed.

## DSP checks

```sh
node --test tests/dsp.test.cjs
```

Checks cover independent duplicate compressors, bypass and empty chains, processor cleanup, streamed audio continuity, and effect ordering.
