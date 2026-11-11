# Accepted product decisions

Updated 2026-11-11. These decisions came from the user's reviews of the mobile settings and guide, and the subsequent tablet/desktop review.

## Page order and responsive layout

- Keep the waveform above the pedalboard on every screen size. Preserve the familiar order when fixing spacing or responsiveness.
- Mobile is the accepted baseline: compact waveform initially, horizontally scrollable pedals, inline settings beneath the board, and a fixed bottom player.
- Expand the waveform by default on tablets and desktops. Users can still collapse it.
- Tablet and desktop settings must have a working close button. Closing must not reopen the same pedal or reopen settings merely because the window is resized.
- Avoid a nested settings scrollbar that hides the editor heading and close button. Keep editing in the normal page flow.
- Use available width to balance the controls and eliminate awkward empty space. Exact column breakpoints are implementation choices, not permission to change page order.

## Playing source

- Import audio is a way to choose the playing pattern. Keep it immediately beside the pattern selector in the same group at every screen size.
- Do not move importing into the A/B comparison or volume group when rearranging the player. A compact labeled icon is acceptable on phones.

## Mobile pedal settings

- Use the inline editor beneath the pedalboard (the user's chosen option B), rather than a drawer or full-screen editor.
- Keep model selection and advanced settings under More on mobile.
- Open the mobile Guide separately so explanatory text does not crowd the controls.

## Pedal guide

- Show one pedal title and a small Pedal guide label in the popup.
- Keep Previous, the position count, and Next together in a compact footer. Use Done on the last pedal.
- Stay in Guide when navigating between pedals, including tapping a different pedal on the board. Switch to Controls only when requested, when starting a fresh edit after closing, or when finishing the guide.
- Put parameter values and A/B differences under View settings.
- Show useful playing guidance directly under How to play it; omit the section when no advice exists.
- Remove playback and printing from the individual pedal guide. Printing belongs in the full board guide.
- Offer Full board guide inside the current tone’s Guide view. Do not show it as a standalone element beneath the pedalboard.

## Development preview

- Keep one Tonelab preview server, on port 8000, bound to the local network.
- Stop duplicate Tonelab instances without affecting unrelated applications.
