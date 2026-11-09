# Tonelab

See how audio effects change a waveform, live.

Tonelab generates a test signal (guitar plucks, a drum loop or a speech-like voice, with an adjustable noise floor), runs it through an effect chain and draws the dry input (grey) and the processed output (ink) on top of each other.

**Effects so far**

- **Noise gate**: threshold, attack, hold, release, range
- **Compressor**: threshold, ratio, attack, release, knee, makeup

Each effect shows its transfer curve (input level → output level) with a dot tracking the live signal. A lane under the waveform shows what the effect is doing over time: gate gain and compressor gain reduction.

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

Space toggles pause.
