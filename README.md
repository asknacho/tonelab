# Tonelab

See how audio effects change a waveform, live.

Tonelab generates a test signal (guitar plucks, with an adjustable noise floor), runs it through an effect chain and draws the dry input (grey) and the processed output (ink) on top of each other.

**Effects** (16, each with its own settings and outline after a classic pedal of its kind)

- **Dynamics:** noise gate (ISP Decimator), compressor (MXR Dyna Comp), boost (Xotic EP Booster), volume swell (Ernie Ball volume pedal, automatic)
- **Gain:** overdrive (Ibanez Tube Screamer), distortion (ProCo RAT), fuzz (Dallas Arbiter Fuzz Face)
- **Tone:** EQ with bass, mids, mid point and treble (Boss GE-7, sliders follow the curve), wah that is held still, follows your picking (auto-wah / envelope filter) or rocks by itself (Dunlop Cry Baby)
- **Pitch:** octave (Electro-Harmonix POG), harmonizer (DigiTech Whammy)
- **Modulation:** chorus (Electro-Harmonix Small Clone), phaser (MXR Phase 90), tremolo (Boss TR-2)
- **Time:** delay with a Character knob from clean digital to dark analog-style repeats (Boss DD-3), reverb (Electro-Harmonix Holy Grail)

**Loudness or Tone.** The scope and the step-by-step can show loudness over time, or tone: how much bass, mids and treble there is (a spectrum, bass on the left). Tone is the view for EQ, wah, phaser and chorus.

Each pedal card is drawn as the outline of a classic pedal of its kind (Decimator, Dyna Comp, Tube Screamer, Fuzz Face, POG, Whammy, DD-3), and its knobs and faders follow the current settings. A cable runs from Input through every pedal in processing order to Output, wrapping with the rows. The page behind a settings sheet or dialog stays still while it's open.

Tap **Listen** to hear the synthesized source, then compare **Dry input** with **With effects**. Guitar uses a plucked-string model, rather than a recorded sample. Audio starts only after a user gesture and has a volume control. The internal 24 kHz signal is resampled for playback.

Use **Add effect** to build any combination, including repeated effects. Every pedal has its own settings, processor state, and on/off control. Tap a pedal to bypass it; **Edit** opens its settings sheet, where you can duplicate it, remove it, or move it earlier/later.

Drag the handles to change processing order on desktop or mobile, or use the arrow keys while a handle is focused. The pedal follows your pointer; drag it outside the dashed board and it turns red with an ✕, and letting go removes it. An Undo bar (or Ctrl/⌘+Z) puts the last removed pedal back for 8 seconds. Compact pedals wrap onto additional rows as the board grows; position numbers show the processing order. Input and Output stay outside the dashed board. Removing every pedal gives a clean dry signal.

The gate and compressor settings show transfer curves (input level → output level) with a dot tracking the signal. Scope meters and threshold lines follow the most recently inspected gate/compressor, or the first instance of each type. Their labels identify the pedal being measured.

## I want to sound like…

The page starts with **I want to sound like…**: pick a famous sound (The Edge, Hendrix, Gilmour) or a technique (clean echo, boost into overdrive, tight metal rhythm, surf tremolo and reverb, ambient swells, lush 80s clean, funky auto-wah, slow phaser swirl) and it's built on the board in A. Its first **What if…** goes into B: the same sound with one change, such as the echo on the beat, the compressor before the gate, or the fuzz before the octave.

- **A and B** each have their own picker: what-ifs, *Same as A/B*, any sound, or your own. *Match volume* keeps the comparison fair.
- **Step by step** shows your guitar, then each pedal in order with what it does in plain words, and the signal after it, drawn live from the same chain you hear. Pedals that differ from the other slot are marked, and a box explains what B changes.
- **The lab and pedalboard** below work as before. Changing a loaded sound marks it *(edited)*; **Save as my sound** keeps it under *My sounds*. A board you built is never lost: before a sound replaces it, it's kept as *My last board*. Loading a sound can also be undone.

Sounds live in the `TONES` list in `js/app.js`: each has the playing pattern and noise floor, a short "how to play it", each pedal as `[type, settings, what it does]`, a tip, and its what-ifs (each with a chain and an explanation). The what-ifs were checked against Tonelab's own effects (for example, compressor-before-gate really does leave the gate open on hiss).

The **Playing** selector switches the synthesized guitar between free picking and steady, short eighth notes.

## Pedal models

Each effect supports its full set of controls (`js/dsp.js`), and each classic pedal is a *model* that shows only some of them, under that pedal's own names (`js/pedals.js`). Pick a model in the settings sheet; the card outline changes to match. **Show all controls** reveals the rest for any model. Switch controls (Mode, Clipping, Voicing and so on) appear as tappable options.

Every control defaults to the effect's original behaviour, so boards and sounds saved before models existed still sound the same. The Looper (a utility, not an effect) isn't included.

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
