# Motion recorder

`pnpm motion:record [scenario]` builds the web app, boots `--demo` with a throwaway home, and
records a scripted walkthrough in full Chromium: 1440×900 (390×844 touch for `phone`), dark
theme, motion level Full. Each scripted moment becomes a contact sheet in `artifacts/motion/`
(gitignored). Animation tasks must run it and look at the sheets before they are ticked.

| Scenario   | Moments                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `overview` | `entrance`, `activity` (8 s), `pod-hover`, `lane-peek`, `route` (overview ↔ settings) |
| `reorder`  | `pods`: the first attention reorder of a fresh board (the riser flies over the others) |
| `busy`     | `activity` (8 s) on `--demo-stress`: set it beside `overview-activity` to compare a calm and a busy board |
| `focus`    | `open` (pod → focus), `session-switch`, `tool-finish`, `done` (when the demo gets there), `claude-tab`, `claude-raw` (chat ↔ raw), `new-terminal`, `close` (Esc) |
| `chrome`   | `palette-open`, `palette-close`, `toast`, `attention-open`, `approval-allow`, `approval-deny`, `attention-close`, `pulse-expand`, `pulse-collapse` |
| `crew`     | `loop` (2 s), `idle` (10 s), cropped to the `/#/_tokens` character sheet     |
| `fx`       | `text` (decrypt, glitch, split-flap), `darkveil`, `softaurora`, `faultyterminal` (energy 0.1 → 1), `ripplegrid`, `lighttunnel` (dive and surge), `phone` (swipe and hold), cropped to the `/#/_tokens` fx sections |
| `phone`    | `entrance`, `scroll`, `focus-open` (tap), `focus-close` (back)               |
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
