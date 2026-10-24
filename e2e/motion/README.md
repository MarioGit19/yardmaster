# Motion recorder

`pnpm motion:record [scenario]` builds the web app, boots `--demo` with a throwaway home, and
records a scripted walkthrough in full Chromium: 1440×900 (390×844 touch for `phone`), dark
theme, motion level Full. Each scripted moment becomes a contact sheet in `artifacts/motion/`
(gitignored). Animation tasks must run it and look at the sheets before they are ticked.

| Scenario   | Moments                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `overview` | `entrance`, `activity` (8 s), `pod-hover`, `lane-peek`, `route` (overview ↔ settings) |
| `layouts`  | `switch` (⌥2 Minimal → Office → ⌥1 cross-fade), `inspector` (a crew opens the Actor inspector, Esc closes it) |
| `office`   | `activity` (8 s of the building), `walk` (a character crosses to its new station, when the demo gets there), `name-tag` (hover a character) |
| `room`     | `enter` (click a room: the Office camera zooms in), `workspace` (Open workspace cross-fades to the focus view, Esc back), `leave` (Esc zooms out) |
| `grid`     | Without WebGL (the 2D map): `activity` (8 s of the network), `packets` (2 s at 12 fps), `burst` (an event's three-packet burst), `enter` (a node cross-fades to its flat cockpit), `leave` (Esc back) |
| `grid3d`   | `activity` (8 s of the 3D network and its idle orbit), `packets` (2 s at 12 fps), `drag` (turn the camera), `reset` (double-click home), `zoom` (wheel in and out to the clamps), `hover` (a label lights its pipeline), `dive` (into a node and the cockpit's phase-in), `center` and `uncenter` (a terminal screen to the center and back), `rise` (the reverse dive) |
| `transit`  | `activity` (8 s of the metro map), `glide` (2 s at 12 fps: speed lines and amber doors), `station` (a new station scales in, when the demo gets there), `inspector` (click a train, Esc) |
| `retro`    | `activity` (8 s of the console), `typing` (2 s at 12 fps, cropped to two frames: captions typing, the cursor's 1 Hz blink), `line-in` (a new actor's line scrolls up, when the demo gets there), `numbers` (2, 1, Enter, Esc) |
| `reorder`  | `pods`: the first attention reorder of a fresh board (the riser flies over the others) |
| `busy`     | `activity` (8 s) on `--demo-stress`: set it beside `overview-activity` to compare a calm and a busy board |
| `focus`    | `open` (pod → focus), `session-switch`, `tool-finish`, `done` (when the demo gets there), `claude-tab`, `claude-raw` (chat ↔ raw), `new-terminal`, `close` (Esc) |
| `chrome`   | `palette-open`, `palette-close`, `toast`, `attention-open`, `approval-allow`, `approval-deny`, `attention-close`, `pulse-expand`, `pulse-collapse` |
| `crew`     | `loop` (2 s), `idle` (10 s), cropped to the `/#/_tokens` character sheet     |
| `fx`       | `text` (decrypt, glitch, split-flap), `darkveil`, `softaurora`, `faultyterminal` (energy 0.1 → 1), `ripplegrid`, `lighttunnel` (dive and surge), `phone` (swipe and hold), cropped to the `/#/_tokens` fx sections |
| `phone`    | `entrance`, `scroll`, `tabs` (the tab bar's gliding pill), `focus-open` (tap), `hub-item` (a hub card opens its page, a swipe to the next item, back), `focus-close` (back), `inspector-sheet` (tap a crew, pull the sheet down), `project-swipe` (a Projects row swiped open and shut, then closed) |
| `close`    | `confirm` (pod menu → Close project…), `leave` (confirm: the pod leaves the overview) |
| `all`      | every scenario above, each on a fresh demo board                             |

`--reduced` records at motion Reduced instead and names everything `<scenario>-reduced-*`, so
the two sets sit side by side: at Reduced nothing should travel, scale or loop, only fade.

The run prints which sheet covers which moment, with its time window in the recording and its
frame rate.

## Reading a sheet

- A sheet is `<scenario>-<moment>.png`: the moment's frames tiled **left to right, top to
  bottom**, oldest first. Transitions are sampled at 12 fps (one tile ≈ 83 ms), activity at
  2 fps (one tile = 500 ms). Long moments drop the rate so a sheet stays at 60 tiles or fewer.
- Each window opens 0.3 s before the action and closes 0.1 s after it, so the first tiles show
  the resting state and the last tiles may show the next moment beginning.
- What to look for: the tile where motion starts and stops (count tiles for duration), a
  jump between two neighbouring tiles (a teleport or a missing interpolation), anything moving
  that DESIGN.md says should be still, and loops that never settle.
- `<scenario>.webm` is the whole recording; open it when a sheet raises a question.

## Without ffmpeg

Sheets need `ffmpeg` on the `PATH`. Without it (or with `--no-ffmpeg`) the recorder takes a
burst of screenshots while each moment runs instead: `<scenario>-<moment>-NN.png`, as fast as
they come for transitions and every 500 ms for activity.

## Adding a scenario

Add a function to `SCENARIOS` in `record.ts` and wrap each thing worth watching in
`recorder.moment(name, 'transition' | 'activity', note, action, clip?)`. Keep actions
deterministic: wait on selectors, not on the demo's timing. For something the demo does on its own
clock (a reorder, a turn finishing), `catchMoment` waits for its selector and records around it,
or warns and skips it.
