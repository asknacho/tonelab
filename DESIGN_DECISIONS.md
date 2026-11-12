# Accepted product decisions

Updated 2026-11-12. These decisions came from the user's reviews of the mobile settings and guide, and the subsequent tablet/desktop review.

## Page order and responsive layout

- Keep the waveform above the pedalboard on every screen size. Preserve the familiar order when fixing spacing or responsiveness.
- Mobile is the accepted baseline: compact waveform initially, horizontally scrollable pedals, inline settings beneath the board, and a fixed bottom player.
- Expand the waveform by default on tablets and desktops. Users can still collapse it.
- Tablet and desktop settings must have a working close button. Closing must not reopen the same pedal or reopen settings merely because the window is resized.
- Avoid a nested settings scrollbar that hides the editor heading and close button. Keep editing in the normal page flow.
- On tablet and desktop, the pedalboard fills the same available width as the waveform. Start with details closed; only narrow the workspace when a pedal is explicitly selected. Closing details restores full width. The waveform keeps its full width when details open; the board and editor share the row beneath it.
- Use available width to balance the controls and eliminate awkward empty space. Exact column breakpoints are implementation choices, not permission to change page order.

## Playing source

- Import audio is a way to choose the playing pattern. Keep it immediately beside the pattern selector in the same group at every screen size.
- Present audio import as a borderless drop-or-click upload affordance, not a rounded button. Accept dropped audio through the same local recording flow as the file picker.
- Do not move importing into the A/B comparison or volume group when rearranging the player. A compact labeled icon is acceptable on phones.

## Mobile pedal settings

- Use the inline editor beneath the pedalboard (the user's chosen option B), rather than a drawer or full-screen editor.
- Show the pedal model selector directly above the controls on mobile and tablet. Keep advanced settings under More. This replaces the earlier decision to put model selection under More (user follow-up, 2026-11-11).
- Open the mobile Guide separately so explanatory text does not crowd the controls.

## Pedal guide

- Show one pedal title and a small Pedal guide label in the popup.
- Keep Previous, the position count, and Next together in a compact footer. Use Done on the last pedal.
- Stay in Guide when navigating between pedals, including tapping a different pedal on the board. Switch to Controls only when requested, when starting a fresh edit after closing, or when finishing the guide.
- Put parameter values and A/B differences under View settings, expanded by default when a pedal guide opens or navigates to another pedal. Users can collapse it.
- Show useful playing guidance directly under How to play it; omit the section when no advice exists.
- Remove playback and printing from the individual pedal guide. Printing belongs in the full board guide.
- The Guide button beside Your pedalboard opens only the Full board guide, in its own dialog, without selecting a pedal or opening its editor.
- Each pedal’s Guide keeps its individual explanation, playing advice, settings and Previous/Next navigation. Do not include the Full board guide inside it. This replaces the earlier nested full-board disclosure (user follow-up, 2026-11-12).

## Development preview

- Keep one Tonelab preview server, on port 8000, bound to the local network.
- Stop duplicate Tonelab instances without affecting unrelated applications.


## UX review follow-up (2026-11-11)

- Loading a sound uses Undo without a confirmation. Save uses an inline name form; New board uses an in-app confirmation with Undo; failed recordings show a dismissible in-app error.
- Notifications float outside page layout and stay clear of the player. They must not add or remove a workspace row.
- Keep the waveform above the board. Use a lighter trace, a compact height, peak/RMS and headroom feedback, and freeze the time axis while playback is paused.
- Use Dry / A / B in the player as the main comparison. Keep directional A-to-B / B-to-A copy text. Import stays beside the playing pattern.
- Analyse expands the waveform tools and reveals intermediate listening points and input noise. Preserve the accepted expanded default on tablet/desktop and compact default on phones.
- Below 1024 px, keep the inline editor beneath the board, with a live selected-pedal preview in its sticky heading. Keep Guide separate on these sizes. The review's bottom-sheet suggestion does not replace the previously selected inline editor.
- Save, Guide and New board have text labels. Give New board horizontal padding so its label does not crowd the border. Help is in the header; the creator credit is in the footer. Use sans for text and mono for numeric readouts.
- Pedal bypass and drag controls have at least 44 px touch targets. Center the grip in the pedal artwork’s bottom row on mobile and desktop; tilt the pedal slightly when dragging activates on any device (after a long press on touch, on handle press with mouse or pen), until release or cancellation (user follow-up, 2026-11-12). Show the red removal × only while the dragged pedal is outside the pedalboard; hide it again when it returns inside. Show one On/Off label per card and keep both endpoint labels inside the scrollable board.
- More pedal settings is the single disclosure for extra controls and labeled pedal actions; there is no second Show all controls checkbox.
- The effect library groups pedals by signal-chain stage. Chorus / flanger names both available model families; model-specific help only describes the offered options.
- Quick start has five anchored steps: pick a sound, play, compare, watch the waveform, open a pedal. The waveform step asks users to switch between Dry and B, listen, and watch for changes. On mobile, the final Make it yours card sits immediately above the player, with the whole pedal highlighted and scrolled into view above the card. This replaces the four-step sequence (user follow-up, 2026-11-12). Platform-specific audio tips appear only on the applicable devices.
- Open Quick start automatically on the first visit. Remember locally when it has been shown so closing it, finishing it, or returning later does not reopen it automatically. The header help button can restart it at any time (user follow-up, 2026-11-12).
- Share offers a Copy button and Copied feedback. Compress the self-contained board link and continue reading existing links; no link-shortening service is required.

### Review proposals left open

- Turning knobs directly on pedal artwork or using its footswitch for bypass requires a separate interaction design; the current labeled controls remain the editing surface.
- A bottom sheet, a permanently reserved desktop panel column, and moving the board above the waveform remain alternatives to the accepted layout, not accepted replacements.
