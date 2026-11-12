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

The player docked at the bottom of the screen has **Play**, what's **Playing** (pattern, speed and volume), and an **A/B** switch. It stays put while you scroll. Compare **Dry guitar** with **With pedals**, or **Before** and **After** a single pedal. Guitar uses a plucked-string model, rather than a recorded sample. Audio starts only after a user gesture and has a volume control. The internal 24 kHz signal is resampled for playback.

Use **Add effect** to build any combination, including repeated effects. Every pedal has its own settings, processor state, and on/off control. Tap a pedal to edit its settings; its **On/Off** control bypasses it. The inspector also lets you duplicate it, remove it, or move it earlier/later.

Drag the handles to change processing order on desktop or mobile, or use the arrow keys while a handle is focused. The pedal follows your pointer; drag it outside the dashed board and it turns red with an ✕, and letting go removes it. An Undo bar (or Ctrl/⌘+Z) puts the last removed pedal back for 8 seconds. Compact pedals wrap onto additional rows as the board grows; position numbers show the processing order. Input and Output stay outside the dashed board. Removing every pedal gives a clean dry signal.

**Choose where to listen.** Selecting a pedal opens its controls without changing playback or the graph's listening position. Tap a dot on the cable between pedals to hear the signal at that point, **Input** for the dry guitar, or **Output** for the full chain (the default). The active listening point is highlighted and named above the graph. The inspector's Play button is another explicit shortcut to hear after that pedal. Repeating a listening action pauses playback. Removing an auditioned pedal returns the listening point to the full chain.

The gate and compressor settings show transfer curves (input level → output level) with a dot tracking the signal. Scope meters and threshold lines follow the most recently inspected gate/compressor, or the first instance of each type. Their labels identify the pedal being measured.

## I want to sound like…

The page starts with a compact header: the Tonelab name and the **I want to sound like…** search. pick a famous sound (The Edge, Hendrix, Gilmour) or a technique (clean echo, boost into overdrive, tight metal rhythm, surf tremolo and reverb, ambient swells, lush 80s clean, funky auto-wah, slow phaser swirl) and it's built on the board in A. Its first **What if…** goes into B: the same sound with one change, such as the echo on the beat, the compressor before the gate, or the fuzz before the octave.

- **Finding a sound.** The box is searchable: type part of a name (accents are ignored) and use the arrow keys and Enter, or tap an item. Songs and techniques are both searched.
- **Compare A and B** (next to the step by step) holds the sound's summary and a picker for each of A and B: what-ifs, *Same as A/B*, any sound, or your own. *Match volume* keeps the comparison fair.
- **Your signal** is one workspace. A chain strip runs In → each pedal → Out, with a dot between pedals: tap a dot to hear and see the signal at that point on the one live scope (Loudness or Tone). Tap a pedal to tweak it in an inline editor that keeps the chain and a smaller scope pinned above it, so you watch the waveform change as you turn the knobs. Edits save as you go. Status messages (like *Loaded · Undo*) appear as a line under the header, float at the top when you've scrolled away, or show inside the editor while it's open, never over the controls. **+ Add** under the chain strip adds a pedal. On desktop and landscape tablets the workspace has two columns: the chain and scope stay in view on the left while the editor and explanations scroll on the right, and the player floats as a compact bar.
- **Step by step** explains each pedal in order in plain words, with a **Hear after this** button. Pedals that differ from the other slot are marked, and a box explains what B changes.
- **The lab and pedalboard** below work as before. Changing a loaded sound marks it *(edited)*; **Save as my sound** keeps it under *My sounds*. A board you built is never lost: before a sound replaces it, it's kept as *My last board*. Loading a sound can also be undone.

Sounds live in the `TONES` list in `js/app.js`: each has the playing pattern and noise floor, a short "how to play it", each pedal as `[type, settings, what it does]`, a tip, and its what-ifs (each with a chain and an explanation). The what-ifs were checked against Tonelab's own effects (for example, compressor-before-gate really does leave the gate open on hiss).

The **Playing** selector switches the synthesized guitar between free picking and steady, short eighth notes.

## What the guitar plays

Use the **Bring your own recording** audio-file icon beside the pattern selector to open a local audio file. Recordings are decoded and mixed to mono at the pedal engine's sample rate entirely in the browser, then loop through the same A/B effects and live graph. Play/Pause works as usual; tempo and synthetic noise are disabled so the recording keeps its original speed and background noise. Switching presets keeps your recording active. Choose a built-in pattern to return to the demo, or the audio-file button again to replace the file.

On iPhone and iPad, export a Voice Memo with **Share → Save to Files**, then select it with the audio-file button. Safari does not support receiving recordings directly from the Voice Memos share sheet.

The recording is held only in memory. Reloading clears it, and saved sounds and shared links contain pedal settings, never the audio or its filename. Supported formats depend on the browser decoder; try WAV, MP3, or M4A. Files are limited to 50 MB and 10 minutes.

The demo guitar is generated in the browser (`js/dsp.js`), and **Playing** chooses what it plays: free picking, **single notes** (a long sustained note, a singing lead, a melody in A major), **strums** (down strums, a folk strum, driving eighths, a bright 16th strum, big ringing chords), **picking** (arpeggios, fingerstyle, boom-chick) and **rhythm** (reggae chops, funk 16ths, palm-muted chugs, power chords, a Texas shuffle). **Speed** sets the tempo of any pattern from 40 to 220 BPM.

Each built-in sound plays a pattern in the style of its feel, at a typical tempo. These are generic patterns in the spirit of the song or style, not transcriptions of the actual parts. A pattern is a chord progression plus a rhythm (one token per step: `D`/`U` strums, `d`/`u` palm-muted, `b` bass note, `c` upper-string chick, `0`–`5` single strings, `.` rest), or a list of single notes (pitch, beats, ring time). To add one, add an entry to `PATTERNS` in `js/dsp.js`; it shows up in the list automatically.

## Pedal models

Each effect supports its full set of controls (`js/dsp.js`), and each classic pedal is a *model* that shows only some of them, under that pedal's own names (`js/pedals.js`). Pick a model directly above the controls in the pedal editor on every screen size; the card outline changes to match. **More pedal settings** reveals the rest for any model, without a second disclosure. Switch controls (Mode, Clipping, Voicing and so on) appear as tappable options.

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
node --test tests/*.test.cjs
```

Checks cover first-play and pause/resume through the real audio worklet, independent duplicate compressors, bypass and empty chains, processor cleanup, streamed audio continuity, effect ordering, octave and harmonizer pitch accuracy, and fuzz clipping.


## UX review updates

The player compares **Dry / A / B**. **Analyse** expands the waveform tools and intermediate listening points; the waveform stays above the pedalboard and pauses with playback. Peak, RMS and headroom readouts describe the selected signal before the listening volume control.

Save opens an inline name form, New board uses an in-app confirmation, and loading a sound remains reversible with Undo. Share opens a dialog with Copy feedback and a compressed, self-contained URL; legacy board links still open. Audio files stay local.

The five-step Quick start follows the main loop, including listening and watching the waveform before editing a pedal. Effects are grouped by chain stage. Phone and tablet editors remain inline and include a selected-pedal preview. See `DESIGN_DECISIONS.md` for the accepted responsive behavior and review proposals still open.

The Guide button beside Your pedalboard opens the full board guide separately. Each pedal’s Guide contains only that pedal’s explanation, playing advice, and settings (expanded by default), with Previous/Next navigation. Printing remains in the full board guide.

The interface, Quick start, pedal guides, and sound lessons are available in English and Spanish. Pedal/effect names, knob labels, switch options, and parameter value formats retain the standard English terminology used on physical pedals. The first supported browser language is selected by default (English fallback); the globe beside header help switches languages immediately and remembers the choice on this device. Audio, recordings, board edits, and tutorial progress stay in place. Translation strings live in `js/locales/es.js`; `js/i18n.js` provides the language selection and reactive catalog helpers.
