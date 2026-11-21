---
name: tonelab-effects-and-tones
description: "Add or revise Tonelab pedal effects, pedal models, playing patterns or tone presets with DSP, guide and compatibility checks. Apply only to the Tonelab repository."
---

# Tonelab effects and tones

Read `AGENTS.md`, `DESIGN_DECISIONS.md` and relevant `README.md` sections. Inspect existing examples in `js/dsp.js`, `js/pedals.js` and `js/app.js`; locate current definitions before editing rather than assuming a historical schema.

Choose the actual change: a DSP effect, a model exposing existing parameters, a playing pattern, or a TONES preset. Reuse supported parameter mappings and defaults. Preserve old saved boards/share links and independent state for duplicate pedals. Keep bilingual help aligned while preserving English hardware terminology as documented.

For a preset, check existing entries to avoid duplicates, explain playing technique and distinguish generic patterns from song transcriptions. Build a meaningful A/B what-if supported by the actual engine; do not claim authentic hardware equivalence without evidence.

For DSP changes, check bypass, empty chains, order, duplicate processors, lifecycle/cleanup, finite output and relevant signal behavior. Run `node --test tests/*.test.cjs` and add focused coverage for the changed audio behavior where useful. Inspect browser controls and guides, including mobile player/tutorial clearance. Automated checks do not establish audible quality; perform or clearly identify listening checks.

Preserve accepted responsive decisions and local-only recording behavior. Update accepted decisions only when the user changes them; label new alternatives as proposals.


## Shared workflows

Use the shared character, animation, comparison-gallery, reference-construction or UX-review skills only when that work is actually needed. Project documentation owns product-specific constraints. Keep implemented behavior, proposed changes and verified deployment status distinct.
