# Tonelab

See how audio effects change a waveform, live.

Tonelab generates a test signal (guitar plucks, with an adjustable noise floor), runs it through an effect chain and draws the dry input (grey) and the processed output (ink) on top of each other.

**Effects so far**

- **Noise gate**: threshold, attack, hold, release, range
- **Compressor**: threshold, ratio, attack, release, knee, makeup
- **Overdrive**: drive, dry/wet mix
- **Delay**: time, feedback, dry/wet mix

Tap **Listen** to hear the synthesized source, then compare **Dry input** with **With effects**. Guitar uses a plucked-string model, rather than a recorded sample. Audio starts only after a user gesture and has a volume control. The internal 8 kHz signal is resampled for playback.

Drag the effect handles to change the processing order on desktop or mobile. Arrow buttons and keyboard left/right arrows provide another way to reorder the chain.

The gate and compressor show their transfer curves (input level → output level) with a dot tracking the live signal. A lane under the waveform shows what the effect is doing over time: gate gain and compressor gain reduction.

## Run it

It's a static site with no build step. Open `index.html` in a browser, or serve the folder:

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
