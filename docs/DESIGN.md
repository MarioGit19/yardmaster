# Yardmaster — Design & Motion Spec

The UI has one job: make the state of many projects readable at a glance, and make it feel **alive**. Motion is not decoration here. Every animation encodes real activity: something is thinking, something is streaming, something needs you.

Read this before changing the UI.

---

## 1. Concept: "Observatory"

A dark, calm, deep-space control room. Projects are **pods** floating on a softly lit field. Claude sessions are **orbs** that breathe, swirl and pulse according to what they are doing. Terminals are **lanes** with light flowing through them as output streams. When something needs you, the room **turns toward it**: its pod glows amber, the ambient light shifts, and the Attention Center slides in.

Three words: **calm, precise, alive.** Never noisy or gamer-RGB. Think Linear × Vercel × a planetarium.

Observatory is the **Minimal** layout, the default. The overview can also be shown as **Office** or **Grid** (§10). Everything in §1–§9 applies to all layouts unless §10 says otherwise.

## 2. Design tokens (CSS custom properties, Tailwind v4 `@theme`)

### Color, dark "Night" (default)

| Token | Value | Use |
|---|---|---|
| `--bg-0` | `#05060A` | page base |
| `--bg-1` | `#0A0C12` | panels |
| `--bg-2` | `#10131B` | raised / hover |
| `--glass` | `rgb(255 255 255 / 0.03)` + `backdrop-blur(16px)` | pods, overlays |
| `--line` | `rgb(255 255 255 / 0.07)` | 1px borders |
| `--line-strong` | `rgb(255 255 255 / 0.14)` | focus, active |
| `--text-1` | `#EDEFF5` | primary |
| `--text-2` | `#A3A9B8` | secondary |
| `--text-3` | `#787E90` | tertiary / meta (≥ 4.5:1 on every Night surface) |

**Status colors** are semantic and identical everywhere, and each has a `-glow` variant at 35% alpha:

| Status | Token | Value |
|---|---|---|
| working / running | `--st-work` | `#7C9CFF` (indigo-blue) |
| tool active | `--st-tool` | `#5EE7FF` (cyan) |
| waiting for you | `--st-wait` | `#FFB547` (amber) |
| success / done | `--st-ok` | `#3DDC97` (green) |
| error / crashed | `--st-err` | `#FF5C7A` (rose) |
| idle | `--st-idle` | `#6B7183` |

### 2.1 Status vocabulary

Every layout, the phone, the rail and Pulse speak these tokens (`StatusToken` in `packages/protocol`), so a state can't mean one thing in Office and another in Grid. Each has at least two cues, and a shape never returns in another colour with a different meaning.

| Token | Tier | Mark | Colour | When |
|---|---|---|---|---|
| **Needs you** | high | ring | `--st-wait` | an approval, a question or input is waiting |
| **Failed** | high | diamond | `--st-err` | a failed session; a terminal whose last command exited non-zero (not Ctrl+C) |
| **Running** | medium | filled dot | `--st-work`, `--st-tool` | a busy session, background work after a turn, a running or serving terminal |
| **Stale** | medium | flat bar | `--st-idle` | it claims Running but the board can't vouch for it (below) |
| **Done, unseen** | low | square | `--st-ok` | a turn or a command of 30 s or more finished after this browser last opened it |
| **Quiet** | none | no mark | | nothing to act on: plain text only, never a dot (Carbon: no indicator when no action is needed) |

**Stale** replaces a frozen Running, and only a Running: what needs you stays on screen. It applies while the board has lost its connection to the server, while a terminal's editor window is gone, and when a session in Running has had no hook, transcript or output event for 10 minutes (20 during a tool call). The caption says which, and actors stop acting: Retro prints `[LOST]`, Transit says "Signal lost", crew and ops crew stand idle.

**Seen** is per browser, on its signed-in session on the server, so the phone and the Mac clear their own marks. Opening a project in the focus view clears its Done, unseen marks, along with whatever finishes while it stays on screen. A browser that signs in later starts clean. The top bar's Active counts Running only, not Stale.

**Project accents:** each project gets a stable hue from a hash of its path. Pick from 10 curated OKLCH hues at L=0.72 C=0.14, avoiding the status hues ±15°. The accent is used only for the project's identity (avatar ring, top hairline, sparkline tint), never for status.

**Light "Daylight":** `--bg-0 #F7F7F4`, `--bg-1 #FFFFFF`, `--line rgb(0 0 0 / .08)`, `--text-1 #0E1116`. Status colors darken by ~12% L for contrast. Glass becomes white at 70% with blur.

### Type

- UI: **Geist Variable**. Mono: **Geist Mono Variable** (terminals, commands, ports, numbers in tables).
- Scale (px): 11 meta · 12 label · 13 body-sm · 14 body · 16 title-sm · 20 title · 28 display · 44 hero-number.
- Numbers use `font-variant-numeric: tabular-nums` everywhere they update.
- No all-caps labels and no decorative eyebrow labels above self-explanatory content. Meta text is 11px `--text-3`.

### Space, radius, elevation

- 4px grid. Pod padding 16, panel padding 20, gaps 12/16/24.
- Radius: 6 (chips), 10 (buttons/inputs), 16 (pods/panels), 24 (modals).
- Elevation comes from light, not shadows: a 1px `--line` border, an inner top highlight (`inset 0 1px 0 rgb(255 255 255 / .04)`), and on emphasis a colored outer glow (`0 0 0 1px <status>, 0 8px 40px -8px <status-glow>`).

## 3. Motion system

Library: **Motion** (`motion/react`). Use CSS for trivial hovers. Use canvas or WebGL for particles and shaders.

### Springs and durations

```ts
export const spring = {
  snappy: { type: "spring", stiffness: 520, damping: 38, mass: 0.8 }, // buttons, chips, toggles
  smooth: { type: "spring", stiffness: 260, damping: 30 },            // panels, layout changes
  gentle: { type: "spring", stiffness: 120, damping: 20 },            // ambient, large surfaces
};
export const dur = { fast: 0.12, base: 0.22, slow: 0.42 };
export const ease = { out: [0.16, 1, 0.3, 1], inOut: [0.65, 0, 0.35, 1] };
```

### Choreography rules

1. **One orchestrated entrance:** only the first load of the overview staggers pods in (fade, y 8→0, blur 4→0, `smooth`, 30–40 ms apart, max 8). After that, new items enter with a plain fade plus a 4px rise, without stagger. Never animate sections in on scroll. Ambient motion must always encode real state (see §4), never decorate.
2. **Exit:** faster than enter (`dur.fast`), with no stagger.
3. **Layout:** a status never moves a project (§4.3a). Pods glide with `layout` plus `smooth` when the user moves one. Going from pod to focus view is a **shared-element transition** (`layoutId` on the pod container, header and orb).
4. **Attention:** a status change to `waiting` triggers a one-time "ripple" ring (scale 1→1.6, opacity .6→0, 900 ms), then a slow amber breathing glow (2.4 s loop) until resolved.
5. **Completion:** `working → idle` after a turn plays a brief green check sweep on the orb (600 ms). It never loops.
6. **Errors:** a 2-frame horizontal glitch (±2px, 120 ms) plus a rose glow that stays until acknowledged.
7. **Numbers:** counters animate with a spring on value change (a rolling digit ticker for HUD metrics).
8. **Only animate `transform`, `opacity`, `filter`** (and canvas). Never animate width, height, top or left on hot paths. Use `layout` for size changes.
9. **One token system.** Durations and easings come from `motion.ts` and its CSS mirror (`--dur-*`, `--ease-*`). Named exceptions (orb ripple 900 ms, sweeps 600 ms, pod dim 800 ms) are documented where they are defined.
10. **Reduced means still.** Motion's `reducedMotion` does not reduce a whole `transform` string, so every transform-string animation goes through the `motion.ts` helper that keeps it still at Reduced. The motion level is applied before the first paint.
11. **Keyboard is instant.** Indicators that glide on pointer clicks (tab underlines) snap when moved with the keyboard.

### Third-party effects

Visual effects may be adapted from React Bits (its license and the adapted components are listed in `THIRD_PARTY_NOTICES.md`) into `apps/web/src/fx/`. Rules: adapt to our tokens, status colors and motion levels; pause when hidden or off screen; no new dependencies (no `gsap`; `three` only inside the Grid layout chunk); an effect that uses WebGL replaces the ambient field while shown, so there is still one WebGL context; keep the upstream copyright notice in the file header and list the component in `THIRD_PARTY_NOTICES.md`. React Bits is MIT + Commons Clause: fine to ship inside Yardmaster, never to publish the components on their own.

### Motion levels (Settings, default follows OS)

- **Full:** everything.
- **Reduced:** no ambient shader motion (static gradient), no particles, no stagger, cross-fades instead of movement. Status still shows through color and static rings.
- **Off:** no animation at all.

## 4. Signature elements (the "wow")

### 4.1 Ambient field (background)

- A full-viewport WebGL fragment shader: a slow, dark aurora / nebula noise field (2–3 layered fbm noise octaves) in deep blue and violet at very low luminance (max L ≈ 12%).
- **Reacts to real activity:** a uniform `uEnergy` (0..1) is derived from the number of working sessions and the output throughput. The field brightens and flows faster as energy rises. A `uAttention` uniform tints a soft amber bloom toward the position of the pod that is waiting.
- Renders at 0.5× device pixel ratio, is capped at 30 fps, pauses on `visibilitychange`, and uses a single context. The fallback is a CSS radial-gradient composition.
- Subtle film grain overlay (3% opacity) to avoid banding. It's generated procedurally once at startup (canvas noise turned into an object URL), so there's no binary asset.

### 4.2 Claude Orb

A 28–64 px living sphere drawn on canvas (one shared rAF loop for all orbs):

| State | Visual |
|---|---|
| idle | dim, slow breathing (scale 0.98↔1.0, 4 s), faint accent rim |
| working (thinking) | brighter core, internal swirl (rotating noise gradient), soft `--st-work` halo |
| tool | 3–6 small particles orbiting, colored by tool family (Bash cyan, Edit/Write violet, Read/Grep blue, Web teal, Task/subagent pink); a tiny label chip with the tool name slides out beside the orb |
| waiting | amber, ripple on enter, then breathing glow, plus a ring that fills as a countdown if a timeout exists |
| error | rose, glitch, static |
| compacting | the orb compresses (scale 0.85) with an inward particle drift |
| ended | desaturated, no motion |

Subagents appear as tiny satellite orbs orbiting the parent orb.

### 4.3 Project Pod (overview card)

```
┌───────────────────────────────────────────────────────────┐  ← 1px accent hairline on top edge
│ ◉ acme-shop        ⎇ feat/checkout  ●3   ↑1      ⋯       │  ← avatar w/ accent ring · branch · dirty · ahead
│                                                           │
│  (orb) ● Editing src/cart.ts                    12.4k tok │  ← each session row: orb, status mark, what it is doing, needs or produced, tokens
│         "Refactoring the cart totals to use…"            │  ← last assistant line while busy or blocked, 1-line clamp, shimmer while streaming
│         Claude · waiting 3m · ⎇ fix/tax · ▣ tax-fix      │  ← name, time, branch when it isn't the pod's, worktree
│                                                           │
│  ▸ backend     pnpm dev        ▁▂▅▇▅▂▁   :3000  ● 2m     │  ← terminal lanes: name · cmd · activity (line, ticks or value) · port · uptime
│  ▸ web         pnpm dev        ▁▁▂▁▁▁▁   :5173  ●        │
│  ▸ zsh         git status      ✓ 0                        │
└───────────────────────────────────────────────────────────┘
```

- **Lead with what needs you:** the header carries the project's status token next to its name, and each row leads with the session's own token (§2.1). Quiet shows no mark and no word. The caption says what the session is doing (tool and target), what it needs (the waiting reason), or what it produced: the last line of `last_assistant_message`, then the session title, then "Ready". Stale replaces it with the reason.
- **Two sizes:** a project with something going on gets the full card. A quiet one (nothing needs you or runs, nothing crashed, no activity for five minutes: the test that dims a pod, §4.10) folds to a **one-line row**: mark, name, branch, last activity, and a count of live sessions and open terminals. A row keeps the pod's menu, link, grip (in its left gutter) and morph. Cells are a stable grid and each pod is as tall as its content, top-aligned; no masonry, because that reorders cards. A pod folding or unfolding never moves in the order: its neighbours glide (`layout`, `smooth`) into the new heights, and the pod itself swaps at once.
- **Density** (Comfortable, Compact, List; Settings and ⌘K, kept per device) changes which fields render, for Minimal and the phone's Projects list. Picking one applies at once, with no glide:
  - **Comfortable:** everything above.
  - **Compact:** more columns and no header crew, tokens, last assistant line, session meta line, empty placeholders or lane graphs. A session is one line with its time at the end; each card keeps two sessions and two lanes and counts the rest. A phone row loses its branch.
  - **List:** every project is a row, in one column, with its columns lined up and the top session's caption after the branch. Under 40rem the caption goes; narrower still the branch, then the time. The strip (§4.5) still says what needs you.

  Office, Grid, Transit and Retro keep their geometry and show the same split with `data-dim` (a darker room, a faded node, track or frame).
- **Times are relative**, with the absolute time in a tooltip: `4m ago`, and `waiting 3m` on a blocked row. A running row shows no time. Session hashes, the word "Idle" and clock times stay off cards.
- Hover: a cursor-following spotlight (radial gradient at the pointer position, 6% white) plus border brightening. No lift or scale: hover feedback stays quiet so status motion stands out.
- **Activity track:** it draws only what says something, and the first match wins:
  1. **CPU line**, when the CPU moved at least 10 points inside its 5-minute window (60 samples, one every 5 s, at least 2 minutes of them). The axis is fixed at 0–100 %, so multi-core work pins to the top and nothing auto-scales. An end dot sits on the current value, and the window label reads `5m`.
  2. **Output ticks**, when the terminal wrote in the last minute (60 samples, one a second): output comes in bursts, so each second with output is a tick instead of a joined line. Height is on a fixed log scale up to 64 KiB/s, the same for every terminal. The window label reads `1m`.
  3. **CPU as text** (`12%`), when a command is running and using at least 2 %.
  4. **Nothing**, when the terminal is idle.

  New samples slide in from the right. The color is the project accent, and it turns rose on error output. The full reading is in the tooltip. In a pod narrower than 22rem, and in Compact, the graphs and labels go first and only the number stays.
- **Flow light:** when a lane is streaming, a thin gradient "comet" travels along its bottom border (CSS keyframe on a pseudo-element, transform only).
- The pod border takes the highest-priority status color of its children (wait > err > work).
- **Terminal peek:** hovering (or focusing) a lane expands a live 6-line preview of that terminal's latest output beneath it (DOM text, Geist Mono 11px, ANSI colors, updated at most 10×/s), so you can read logs without opening anything.

### 4.3a Project order

Projects never re-sort because their status changed: what needs you goes to the strip (§4.5), and the grid holds still. The order is pinned projects first, then a stable order. By default that's most recently active, worked out once on load. New projects join at the end. Dragging a pod by its grip (it shows on hover, always on touch) or focusing the grip and pressing the arrow keys sets the order for this device; pinned and unpinned projects each keep to their own group. Every layout uses the same order; the grip lives on Minimal's pods.

### 4.4 HUD (top bar)

Rolling-digit counters, named for what they ask of you: **Needs you** (approvals, questions, input needed), **Failed** (failed sessions, and terminals that exited non-zero since this browser last opened them) and **Active** (the Running token of §2.1: busy sessions and terminals running a command; `claude` in a terminal counts once), then **Tokens today**. Each is a button with a tooltip saying what it counts. Needs you opens the Attention Center; Failed and Active jump to a lone item, or list several in a popover, and do nothing at zero. A 1 px ring around the three takes the colour of the most severe non-zero one (amber, then rose, then the working blue). Which failures count as seen is kept per browser. On the right are the usage chip (5-hour and 7-day percent used, with reset times and "as of" in its tooltip; a warning triangle and amber ink above the thresholds in Settings; hidden when Claude Code reports no limits; a window past its reset shows — ), the connection status dot (with a reconnect spinner), ⌘K hint, motion toggle and theme.

### 4.5 Needs you strip

Above the overview in every layout, on the phone too, a strip lists everything with a high token (§2.1), oldest first: the mark, project and session or terminal, a one-line reason, how long it has waited, and its one action. **Approve** and **Deny** for an approval the board can answer, **Rerun** for a failed command it can type again (an open terminal, no control characters), otherwise **Open**. The row itself opens the item. Failures follow the top bar's Failed counter: opening a failed terminal clears it from the strip, and a Ctrl+C never appears. Past three rows the rest fold behind "+N more". The strip takes no space when nothing needs you, and from tablet up, in a window at least 720 px tall, it sticks to the top of the overview as you scroll. Rows enter and leave like Attention Center cards. When the strip changes height, the overview below glides by transform (`dur.base`, Full only) rather than jumping under the pointer.

### 4.5a Attention Center

- A right-side sheet (or a bottom sheet on narrow screens), sliding in with `smooth`.
- Each approval card shows the project chip, session orb, tool name, and the exact payload: the command in mono with syntax highlight, or for Edit a mini diff. Actions: **Allow** (A), **Always allow** (⇧A), **Deny…** (D, with an optional reason). Keyboard first.
- Resolved cards collapse with a height animation (`layout`) and a check sweep.

### 4.6 Focus view (project)

- A shared-element transition from the pod. The background dims and blurs other content.
- Layout: the chat comes first. The center is the **Claude panel** and takes what the side columns leave. On the left, the session list and history fold to a slim **rail** (52 px: each live session's crew member, linking to it). On the right, a **side panel** has two tabs, **Terminals** (the terminal stack: tabs or a 2×2 grid toggle) and **Changes** (the git panel), and folds to a rail with a counted button per tab. Open columns resize with spring-snapped handles (sizes per project). What is folded and which tab is on top are remembered per device. Folding springs the column on `smooth` (Reduced and Off land at once), and the terminals refit once when it lands. A terminal asked for from anywhere else (⌘K, a band character, a deep link) opens the side panel on Terminals. Below 1024 px the columns become tabs: Sessions, Claude, Terminals, Changes.
- Header: back, the project with its branch under it (the path in the tooltip), the session's status token and its one-line caption with Allow / Deny (§4.10). Office and Transit keep their bands, and Office its small crew of selectable characters (§10.8). The mascot sits in the chat instead (§4.11).
- Transcript detail, a toggle in the panel's header (a strip above the chat on the phone, §11), per device: **Summary** (what was said, plus file edits, subagents and failures as closed cards), **Normal** (everything, as it is), **Verbose** (thinking open, every card open, with the tool's input and its whole output). A chat keeps the reader's place across a switch, and a card the reader toggled stays as they left it. A compact chat (inside a terminal pane or a cockpit) has no toggle and reads at Normal.
- Claude panel: message stream with markdown, collapsible thinking blocks, and tool cards (Bash with output, Edit/Write with diffs, Read/Grep as compact chips, TodoWrite as an animated checklist where checks draw in, Task as a nested subagent thread). The composer has model and permission-mode pills, Enter to send and Esc to interrupt.
- Streaming text shows a soft caret glow at the tail. Tool cards enter with a scale 0.98→1 and fade.

### 4.7 Pulse (activity timeline)

A collapsible bottom rail: a horizontal time axis covering the last 15 min. Each event is a dot in its project's lane, colored by type. New dots fly in from the right edge. Hover shows a tooltip, and click jumps to the event.

### 4.8 Command palette (⌘K)

Built on cmdk, inside a glass modal with a scale 0.96→1 and blur-in. Groups: Projects, Sessions, Terminals, Actions. Fuzzy search highlights matched characters. Selecting a destination triggers its normal transition.

### 4.9 Brand and icons

- **Name:** **Yardmaster** in sentences, titles and labels. The brand is about what the product is, one calm view over everything running across your projects, alive with activity; it is **not** a railway theme, so no tracks, trains or signals.
- **Logomark, "Confluence":** a Y whose two arms and stem meet at one point, where the **orb** (the ClaudeOrb motif, §4.2) sits in a cut socket: many streams arrive at one lit place. Three round-capped strokes (40/256 wide, arms at exactly 45°) and a 30/256 orb with a 12/256 gap. It uses `currentColor` for the Y and one accent for the orb (`--st-work` in the app). It's flat: no gradients, filters or text, so it holds at 16 px (the socket closes up and the Y still reads) and in one color. One source file, `apps/web/src/brand/logo.svg`, and every other brand asset is generated from it.
- **Wordmark:** lowercase `yardmaster` in **Geist 600**, tracked in by 2.5% (`.wordmark`). In a lockup the mark is 1.5× the wordmark's font size, 0.34× away, centered on the word's ascender height. The app sets it as live text; the standalone SVGs embed Geist (OFL) so they render anywhere.
- **Where it appears:** the HUD (lockup), the phone top bar (mark), the setup guide (the brand moment below), the pre-script loading state (the still mark, dimmed and centered, inlined into `index.html` at build), the board-level empty states (the mark in `--text-3`), Settings → About (lockup, tagline, version) and the document title.
- **Brand moment:** the first time a browser opens the setup guide, the Y's three strokes converge on the hub and the orb lights there (transform and opacity, `ease.out`, within `dur.slow` after a `dur.fast` lead so the card has settled). Once per browser (`yardmaster.brandIntro`); at Reduced and Off it's the still mark.
- **Favicon:** the SVG favicon is **live**, drawn on the mark: idle is a midtone grey Y with the blue orb (it reads on light and dark tab strips), waiting turns the mark amber and adds a dot in the empty bottom-right corner, crashed turns it rose. The document title shows the count, for example `(2) Yardmaster`.
- **Generated assets (`pnpm brand:build`, also run by the web build when stale):** the static `favicon.svg` and 32 px PNG; the app icons (a Night tile with the lit mark and a soft glow behind the orb: `apple-touch-icon` 180, `icon-192`/`512` rounded, `icon-maskable-192`/`512` full-bleed with the mark inside the safe circle, `icon-monochrome-512` for Android themed icons) listed in `manifest.webmanifest`; the extension's 128 px icon; the 1200×630 social image (`og-image.png`, upload it as the repo's social preview). With `--all` it also writes the committed README hero (`docs/brand/hero-dark.svg`, `hero-light.svg`) and the review kit and brand sheet in `artifacts/brand/`. Nothing binary is drawn or edited by hand.
- **Icons:** `lucide-react` only, 1.5px stroke, 16/20 px. Tool families map to fixed icons (Bash → `terminal`, Edit/Write → `file-pen`, Read → `file-text`, Grep/Glob → `search`, Web → `globe`, Task → `git-fork`, Todo → `list-checks`). **Never** use third-party brand logos (Claude, Cursor, VS Code); use text labels instead.
- **No sound.** Yardmaster is silent. Attention is visual: pod glow, the live favicon, the Attention Center and optional browser notifications.

### 4.10 Activity animation (the core of the "alive" feel)

The rule: **if something is doing work, it moves, and if it's not, it's still.** Motion is the activity signal, so you can scan 10 projects and immediately see which ones are busy, waiting or broken without reading anything. Each signal is small and cheap, driven only by real events (hooks, terminal output), and never decorative.

| What | Idle | Active | Needs you / broke |
|---|---|---|---|
| **Crew mascot** (§4.11) | idle fidgets, or asleep after 5 min | acts out the work: typing, reading, running a command, delegating, thinking | raises a hand with an amber "!" / sweats with ×-eyes |
| **Claude session** (orb, §4.2) | dim, slow breathing | swirling core while thinking, orbiting particles while running a tool (colored by tool family) | amber ripple then breathing glow / rose glitch |
| **Session row caption** | the last turn's summary in `--text-3` | a live caption of the current action ("✎ Editing src/cart.ts", "⌕ Searching \"totals\"", "▶ pnpm test") that swaps with a quick vertical slide and a shimmer sweep across it | "Waiting for approval: Bash(pnpm test)" in amber |
| **Terminal lane** | empty activity track, grey dot | CPU line or output ticks scrolling (§4.3), a pulsing green dot (pulse speed ∝ lines/s, capped), and a comet light running along the lane's bottom edge | rose dot, exit badge pops in, the last error line slides into the caption |
| **Pod** | dims to 70% after 5 min with no activity | an **activity border**: a soft light travels around the pod's edge (conic-gradient rotation, speed ∝ how many things are active), plus a tiny particle on the top hairline for each new event | border becomes a steady amber or rose glow (§3 rule 4/6) |
| **Turn finished** | | one gentle green sweep across the pod (left to right, 600 ms), played once | |
| **Whole board** | ambient field calm | ambient field brightens and flows faster as total activity rises (§4.1) | amber bloom toward the waiting pod |
| **Focus view header** | | the same caption as the session row, larger, with an animated progress shimmer while a tool runs, and elapsed time for long commands | inline Allow / Deny for a waiting request |

Implementation notes:
- One **activity level** per entity (0..1, an exponentially decaying event rate) computed in the store. All animations read it, so they speed up and calm down smoothly instead of flickering on every event.
- Everything runs on the shared scheduler with transform, opacity and conic-gradient angle only. Idle entities register no frame callbacks, so a board of mostly idle projects costs close to nothing.
- At the Reduced motion level, active states use color and a static glow (no movement), and captions still update. At Off, nothing moves.

### 4.11 Crew mascot

Every project has a small original character, the **crew member**, that acts out what is happening in that project. It's the most readable activity signal on the board: you see someone typing, someone waiting with a raised hand, or someone asleep.

**Look.** An original vector character (inline SVG, no third-party art): a rounded capsule body in `--bg-2` with a 1px `--line-strong` outline, and a dark glass visor with two glowing eye dots. On top is a short antenna whose tip is the **ClaudeOrb** (§4.2), so the orb and the character are one system. The visor glow and the antenna orb take the session color (project accent for the main session). Simple stub arms and legs, no mouth, so expressions come from eyes, posture and props. It must not resemble Anthropic's or any other existing mascot, and it uses no brand colors.

**Who gets one.** One crew member per Claude session, shown in its session row and in the pod header. A subagent appears as a **mini crew member** that pops out next to its parent (scale 0→1 with a small particle puff) and leaves the same way. A project with no Claude session still gets one crew member, whose state follows the terminals ("watching" or "sleeping").

| State | Trigger | Acting |
|---|---|---|
| sleeping | no activity at all for 5 min | eyes closed (two short lines), slow breathing, a small "z" drifting up every 3 s |
| idle | session idle, nothing running | breathing, a random blink every 2–6 s, a look-around (eyes and head tilt) every 8–15 s |
| watching | Claude idle while a terminal is streaming | leaning back, eyes slowly tracking downward as if following a scrolling log, with a tiny monitor prop that flickers with the output rate |
| thinking | working, no tool yet | hand to visor, eyes up, a "…" bubble pulsing, and the antenna orb swirling |
| typing | Edit / MultiEdit / Write / NotebookEdit | leaning over a floating keyboard, alternating hand taps (about 8 Hz), small code glyphs rising off the keys |
| reading | Read / Grep / Glob / WebFetch / WebSearch | holding a small page or magnifier, eyes scanning left↔right |
| running | Bash | presses a key once, then watches a tiny terminal prop whose lines scroll |
| delegating | Task (subagent started) | points to the side, and a mini crew member pops out there |
| waiting | permission or input needed | turns toward the viewer, raises a hand, an amber "!" bubble, a small bounce every 2 s |
| error | StopFailure or a failed tool | a quick shake, then a sweat drop. Eyes become "×" for 600 ms, then a worried look until the error is acknowledged |
| done | turn finished | arms up with a small sparkle burst, played once, then idle |

**Animation rules.**
- Built from separate SVG part groups (body, visor/eyes, arms, legs, prop layer) animated with Motion variants and keyframes. Use transforms and opacity only.
- State changes **blend** (200–300 ms, `smooth`) and never snap. Props enter and leave with a quick scale and fade.
- Idle variety (blinks, look-arounds) is randomized per instance so a board of characters never moves in sync.
- Sizes: 24 px (session row: eyes, antenna orb and posture only, no props), 56 px (pod header: full acting), 72 px (the chat at rest: under an idle session's last message, or over a session with no messages yet, playing the done sparkle when a turn finishes) and 120 px (a blank new-session panel: full acting plus props in detail). The focus view's header carries no mascot.
- Characters off screen or in hidden tabs are paused. At the Reduced motion level each state is a static pose. At Off it's a static pose without bubbles.

## 5. Component inventory

`AppShell, AmbientField, Hud, ProjectRail, PodGrid, ProjectPod, SessionRow, ClaudeOrb, CrewMascot, TerminalLane, Sparkline, PortChip, StatusDot, AttentionCenter, ApprovalCard, FocusView, ClaudePanel, MessageList, ToolCard(*), DiffView, Composer, TerminalStack, XtermView, GitPanel, PulseRail, CommandPalette, Toasts, SettingsSheet, OnboardingWizard, EmptyState, Skeleton, Kbd, Tooltip, NumberTicker`.

## 6. Empty, loading and error states

- **First run:** a centered onboarding card over the ambient field, with a 3-step checklist (Server ✓, Hooks, Extension). Each step shows live detection: it ticks itself the moment the first hook event or editor connection arrives.
- **Loading:** shimmer skeletons in pod shape. Never spinners for content.
- **Disconnected:** the HUD dot turns rose, a top inline banner reads "Reconnecting…", and data greys to 60%. Nothing jumps.

## 7. Performance rules (hard)

- One WebGL context at a time (the ambient field, or the Grid layout's renderer, §10.4). Orbs and sparklines share **one** `requestAnimationFrame` scheduler and draw only when visible (IntersectionObserver).
- xterm instances mount only in the focus view, with the WebGL addon and a fallback to canvas/DOM. Inactive tabs dispose their renderer but keep the buffer in the store.
- Lists over 50 items are virtualized (`@tanstack/react-virtual`).
- Store updates are batched. Components subscribe to narrow selectors. Overview re-renders are capped by the 30 Hz patch coalescing.
- Lighthouse performance ≥ 90 on the overview in demo mode. No long tasks over 50 ms during steady-state streaming.

## 8. Accessibility

- Every status uses color **plus** shape or text (dot + label, icon on the orb) for color-blind users.
- Focus ring: 2px `--line-strong` plus a 4px accent glow.
  - It is a `box-shadow` from a base rule, so any element that sets its own shadow (`shadow-raised`, a status glow) must restore it with `focus-visible:shadow-[var(--focus-ring)]` (or combine it in CSS). `e2e/keyboard.spec.ts` fails on a Tab stop that shows no focus.
- Text never fades below AA: quiet items dim their marks (hexes, rings, satellites), not their text; text colors in code and terminal output use the `-ink` tones (`--st-*-ink`, `--orb-*-ink`), which darken in Daylight.
- No keyboard traps: a read-only terminal lets Tab move on; a board terminal keeps Tab for the shell and Shift+Tab leaves it. Esc closes the innermost layer first (a tooltip, then a sheet, then the workspace); text fields keep Esc. Toasts never send focus back on their own.
- `aria-live="polite"` region announces new approvals and crashes.
- Every action is reachable from the keyboard and appears in ⌘K with its shortcut.
- **Cursor:** everything clickable shows the pointer. A base rule in `styles/index.css` gives it to `button`, `a[href]`, `summary`, `select`, `label[for]` and the interactive roles (`button`, `tab`, `menuitem`, `option`, `switch`, …), and `not-allowed` to disabled controls. Build pressables as a real `button`/link or give them a role (with keyboard handling); use `cursor-pointer` only where no role fits (a card holding its own buttons, a canvas hit area). Special cursors stay: `col-resize` on dividers, `grab`/`grabbing` on draggables, the text cursor in terminals. The `cursor` e2e check enforces it; mark a deliberate arrow with `data-cursor="default"`.

## 9. Visual QA checklist

- [ ] No element touches the viewport edge without padding. 16px minimum gutter at 390px width.
- [ ] Phones (§11): no sideways page scroll and nothing spilling out of its container at 360, 390 and 412 px and in landscape; the composer stays visible with the keyboard open.
- [ ] Type uses only the scale above, and numbers are tabular.
- [ ] No default browser focus rings, no unstyled scrollbars (thin custom ones).
- [ ] Status colors match the token table exactly. Accents never signal status.
- [ ] Dark and light both look intentional, with no pure #000 or #fff surfaces in dark.
- [ ] Pods align on a grid. Lane columns (name/cmd/spark/port) align across pods.
- [ ] Motion at Reduced level has no movement other than cross-fades.
- [ ] Nothing overflows. Long project names, commands and branches truncate with a tooltip.
- [ ] Empty, loading, error and disconnected states all exist and look designed.

## 10. Layouts

The overview can be shown in different **layouts**. A layout is a different way of *seeing* the same board: the same projects, sessions, terminals, statuses and actions, drawn as a different world. Layout is a separate choice from the color theme (Night/Daylight) and the motion level, and all three combine.

| Layout | Idea | One-line pitch |
|---|---|---|
| **Minimal** (default) | The current Observatory overview (§1–§4): pods on the ambient field | Calm, dense, fastest to scan |
| **Office** | Each project is an office room in a cut-away building. Every running thing is a character at a station | You see your crew at work |
| **Grid** | A dark neon network. Projects are nodes fed by pipelines carrying data packets. Enter a node and its screens phase in around you | Mission control from the future |
| **Transit** | A station concourse: a departures board beside a metro map where each project is a line and every session and terminal is a train at its station | What needs you on the board, the whole network beside it |
| **Retro** | A green-phosphor CRT text console, all characters and box drawing | Maximum density, pure nostalgia |

### 10.1 What every layout shares (the contract)

- **One data model.** Layouts render a scene-neutral model (`selectSceneModel`): projects, each with **actors** (Claude session, subagent, terminal), each actor with a kind, a state (the §4.11 crew states, plus `serving` and `exited` for terminals), an activity level (§4.10), a label, a live caption and its links. No layout reads the store any other way, so state semantics can't drift between layouts.
- **Same meaning, same colors.** Status colors and shapes mean the same in every layout: amber is waiting, rose is error, `--st-work` is working, and every status also has a non-color cue (§8).
- **Same chrome.** HUD, project rail, Pulse rail, Attention Center, ⌘K, toasts and settings stay on top of every layout, unchanged.
- **Same destinations.** Clicking any actor opens the **Actor inspector**, a shared popover: what it is (kind, name, project), state and live caption, the last 6 output lines or the last assistant line, ports, uptime and tokens, plus actions: *Open* (focus view with that session or terminal selected), *Focus in Cursor*, *Ctrl+C* for a running terminal, and *Allow / Deny* when it's waiting. Opening a project lands in the focus view (§4.6), the same component and the same features in every layout, wearing that layout's **workspace skin** (§10.8).
- **Switching.** Settings → Appearance → Layout, the ⌘K action "Layout: Minimal / Office / Grid / Transit / Retro", and `⌥1` … `⌥5`. The choice persists per browser (`yardmaster.layout`). A switch cross-fades the old scene out and the new one in (`dur.slow`). Each layout is a lazy-loaded chunk with a skeleton while it loads.
- **Keyboard.** Tab moves between projects (rooms or nodes) in the board's order, arrow keys move between the actors inside one, Enter opens, Esc goes back. Every actor is a real focusable element with an accessible name such as "acme-shop, Claude, waiting for approval: Bash(pnpm test)".
- **Motion levels.** Every layout defines Full, Reduced and Off (§3): Reduced keeps state readable through static poses, color and glows, with cross-fades instead of travel. Off moves nothing.
- **Performance.** Every layout meets §7 and PRD §9 under `--demo-stress` (≥ 55 fps, no long tasks over 50 ms on the overview). Off-screen actors pause. Only one WebGL context exists at a time: Office and Grid unmount the ambient field and draw their own backdrop.
- **Phones (390 px) and touch.** Every layout is designed for the phone, not just squeezed onto it:
  - Office stacks rooms in one column (each room full width, characters at 56 px); the room view fills the screen with the actor list as a bottom sheet. Grid shows its 2D map as a vertical list of nodes on one trunk, and the cockpit becomes a swipeable stack of screens. Transit puts its departures board first and turns each line into a station list read top to bottom. Retro reflows to one frame per project in a single column (at least 40 characters wide).
  - **Touch replaces hover:** tap a character, node, train or line to open the Actor inspector as a bottom sheet (Radix dialog on narrow screens, popover on desktop); hover-only details (name tags, tooltips, lane peeks) appear in that sheet. Long-press shows the name tag.
  - **Gestures:** swipe between screens in the Grid cockpit and between tabs in the focus view; pinch and drag in the Grid 3D view (when shown on a tablet); pull down on a bottom sheet to close it; the system back gesture and the browser back button behave like Esc.
  - Tap targets are at least 44 × 44 px, text never drops below 12 px, and nothing relies on keyboard shortcuts alone (⌘K is a button on phones).
  - Phones also respect performance: the Office and Grid layouts cap animated characters and packets lower (half of desktop) and pause everything while the page is in the background.
- **Assets.** All art is original inline SVG, CSS or code-drawn geometry. No third-party sprites, models, textures or fonts beyond the existing ones.

### 10.2 Minimal

The current overview, unchanged (§4.3 pods, §4.4 HUD, §4.10 activity). It's the reference: anything a user can see or do in Minimal must be reachable in the other layouts too.

### 10.3 Office

**Concept.** A cut-away building seen from the front, like a dollhouse: floors of office rooms with the front wall removed. Each project is one room. Everyone in the room is a character that acts out what its process is doing. It reads like a small company you run.

**The building.** Rooms sit on a grid of floors (3–4 rooms per floor at 1440 px, 4–5 at 1920 px, 1 at 390 px), in the board's stable order (§4.3a), and re-ordering rooms animates with `layout` + `smooth`. A thin roof line and a ground floor frame the stack. In Night the building sits against a dark sky and lit rooms glow warm. In Daylight the walls are light and the windows are bright.

**A room.** Same footprint for every room so the grid stays even:
- **Door and nameplate** (left wall): project avatar, name, branch and dirty count. The nameplate is a link to the focus view. A small **door light** above it is off, amber when something in the room waits for you (it pulses with the §3 rule 4 ripple), or rose on an error.
- **Ceiling light**: brightness follows the room's activity level. After 5 min with no activity the light dims, like the 70 % pod dim.
- **Whiteboard**: the main session's TodoWrite list (up to 3 lines, checks draw in), or the last turn's summary when there's no list.
- **Port sign** by the door: the room's listening ports as small chips.
- **Stations**: places where characters work. A **desk with a monitor** for each Claude session, a **side desk** for subagents, a **server rack** for each long-running terminal (a dev server, anything with a listening port or running over 30 s), a **workbench** for one-shot commands, and a **couch** for idle terminal shells. Two shared stations give the crew somewhere to go: a **bookshelf** (a Claude session that is reading or searching for more than a few seconds walks over to it) and the **whiteboard** (a session in plan mode, or writing its todo list, stands at the whiteboard drawing).
- **Name plates** on the floor in front of each station: the status mark (§2.1) and the session or terminal's name, readable at the default zoom without hovering. A plate stays at its station while the character is on a trip, a shared couch stacks its two names, and the side desk names its first subagent with a "+N". With a mouse the name is a link to the focus view with that session or terminal selected; on touch it's plain text, and tapping the character opens the inspector.
- At most 8 characters are drawn per room. More shows a "+N" badge on the door that opens the room view.

**Characters.**
- **Claude sessions** are the crew mascot (§4.11) at 56 px, seated at a desk. The monitor shows the tool-family color and a glyph of the current action (✎ ⌕ ▶ …). All §4.11 states apply: typing at the keyboard, reading with the page prop, thinking with the "…" bubble, standing up to raise a hand when waiting.
- **Subagents** are mini crew at the side desk. They pop in when the subagent starts and walk out of the door when it ends.
- **Terminals** are the **ops crew**: a sibling of the crew mascot with the same body proportions but a rectangular visor, a small headset instead of the antenna orb, and the terminal's status color on the visor. States:

| Ops state | Trigger | Acting |
|---|---|---|
| idle | shell with nothing running | on the couch, slow breathing, random blinks; asleep with a "z" after 5 min |
| running | a one-shot command is running | at the workbench, typing then watching a small progress screen whose lines scroll with output rate |
| serving | a long-running command (dev server) | standing at the server rack; the rack's LEDs blink with the output rate, and the ports show on the rack |
| done | the command exited 0 | small thumbs-up with a check sparkle, then walks to the couch |
| error | the command exited non-zero or crashed | the rack or bench sparks once, ×-eyes for 600 ms, then a worried look; a rose exit badge stays above until acknowledged |
| waiting | a Claude prompt in this terminal needs input (linked session waiting) | turns to the viewer and raises a hand, amber "!" |

- **Moving between stations.** When a character's station changes (couch → rack, desk → door), it walks there: translate along the floor over 600–900 ms with a leg swing, no path-finding, never through another character's station (stations are laid out so straight lines work). At Reduced it cross-fades to the new station instead.
- Idle variety is randomized per character (§4.11), so a building of characters never moves in sync.

**Position means something.** A room is a project; inside it, a desk is a session, a rack a long-running command, a bench a one-shot and the couch an idle shell.

**Legend.** Above the building a small legend (`StatusLegend`, shared with Transit) maps every token in §2.1 to its pose: its mark, its name and how a character acts it out. It folds to one button, per device (`yardmaster.legend`). By default it is open on desktop and folded on phones, and it steps aside while a room is open.

**Interactions.**
- Hover a character: a small name tag with its live caption ("pnpm dev · :3000 · streaming").
- Click a character: the Actor inspector (§10.1), anchored to the character.
- Click a room (anywhere but a character), or Enter on it: the **room view**. The camera zooms into the room (scale and translate of the building layer, `smooth`, about 500 ms), the room fills the stage, characters grow to 120 px with full props, and a side panel lists every actor with its caption. From there, *Open workspace* goes to the focus view with a cross-fade, and Esc zooms back out to the building.

**Look.** Flat vector with soft shading: walls in `--bg-1`/`--bg-2`, furniture in `--bg-2`/`--bg-3` with 1 px `--line` outlines, accent only on the project's door, nameplate and the main session's visor. Warm ceiling light in Night is the one indulgence (a radial glow at low opacity). No pixel art, no outlines heavier than 1 px.

### 10.4 Grid

**Concept.** A dark, precise neon world: an infinite perspective floor grid, a central **core** (you), and each project as a **node** connected to the core by a glowing **pipeline**. Data packets travel along the pipelines when work happens, so the busiest parts of your world are literally the brightest and fastest. Entering a node dives you down its pipeline into the project, where its screens phase in around you.

This layout is allowed a stronger look than the rest of the app (neon on near-black, scanlines), but the §1 rule still holds: it encodes real activity and is never noisy. One neon hue (`--grid-neon`, a cool cyan) is used for structure, status colors keep their meanings, and nothing flashes more than 3 times a second (WCAG 2.3.1). No full-screen flashes.

**Overview (3D).**
- **Floor and sky:** a perspective grid fading into fog at the horizon, near-black (`--grid-bg`), with a very faint scanline overlay (3 %).
- **Core:** a small faceted shape at the center that brightens with total activity (the same energy as the ambient field, §4.1).
- **Nodes:** each project is a hexagonal monolith on a ring around the core, in the board's stable order (§4.3a) clockwise from the front. Its height grows slightly with activity, its edge light takes the priority status color, and its label (name, branch, live caption of the busiest actor) is crisp DOM text floating above it.
- **Satellites:** each actor orbits its node as a small shape: Claude sessions as bright spheres (the ClaudeOrb's colors), terminals as small cubes, subagents as tiny spheres around their parent. Each satellite has a short sub-pipe to its node.
- **Pipelines:** curved tubes from the core to each node and from each node to its satellites. **Packets** (small light pulses) travel along them: terminal output emits packets at a rate proportional to its throughput (capped), each Claude tool call fires a short burst in its tool-family color, a finished turn sends one green pulse back to the core. Packets are instanced (max 400 at once).
- **Attention:** a waiting node raises an amber beacon (a soft vertical beam) and its pipeline pulses amber toward it every 2.4 s. An error makes a pipeline segment glitch rose once, then stay rose until acknowledged.
- **Camera:** a slow idle orbit drift (one revolution per ~3 min) that stops while the pointer is over the scene. Drag to rotate, scroll to zoom (clamped), double-click to reset.
- Hover a node: its pipeline and label brighten and a tooltip shows counts. Click a satellite: the Actor inspector.

**Entering a project (the dive).** Click a node or press Enter on it:
1. The camera flies along the node's pipeline into the node (about 900 ms, `ease.inOut`), other nodes fade back into the fog.
2. **Phase-in:** a horizontal scanline sweep passes over the view and the project's screens resolve from a brief chromatic split into sharp panels (about 400 ms).
3. **The cockpit:** the project's screens float in a gentle arc around the viewer: the **Claude screen** in the middle (live messages and caption), **terminal screens** to the sides (live tail of each terminal, ports and uptime in the title bar), and small screens above for git, ports and the todo list. Screens are real DOM placed in 3D with CSS3D, so text is sharp and selectable.
4. Click a screen: it flies to the center and becomes fully interactive (one xterm mounted at a time). *Open workspace* goes to the standard focus view. Esc steps back: from a centered screen to the arc, then the reverse dive out to the network.

**2D map (fallback).** The same network drawn as a flat SVG diagram (core in the middle, nodes on a ring, straight pipelines with CSS-animated packets), used when WebGL is unavailable, at Reduced motion (no packets travel; pipelines just light up), and at 390 px (a vertical list of nodes on one trunk pipeline). Entering a node cross-fades to the cockpit laid out flat.

**Tech.** `three` with its `CSS3DRenderer` addon, driven imperatively by one `GridRenderer` class that subscribes to the scene model (no per-frame React renders). One WebGL context, DPR capped at 1.5, render loop paused when hidden or offstage, and the loop idles at a low rate when nothing moves.

### 10.5 Transit

**Concept.** A station concourse: a **departures board** that tells you what needs you, beside a **network map** in the style of a classic transit diagram (flat, thick colored lines, white station marks, 45° spurs, signage type). Each **project is a line** in its accent; each **Claude session and terminal is a train**, standing at its own station on that line. The ground is light grey (Daylight) or deep navy (Night).
- **Departures board:** a dark flat panel in both themes (it keeps the Night text and status tones in Daylight, like a real concourse board). Header: "Departures", a summary ("1 due · 5 departing") and the clock. One row per session and terminal: the line's roundel, the train's name, its project and live caption, and its status in station-board words: **Due · needs you** (waiting, amber, with an amber edge bar that breathes on the §3 rule 4 period), **Cancelled · exit N** (error, rose edge bar), **Departing** (working, in the work or tool tone), **In service** (serving), **Arrived** (just finished, or done and unopened), **Signal lost** (stale), **At platform** (idle), **Stabled** (asleep), **Out of service** (closed). Rows sort what needs you first, then work, then the rest, in project order; the board holds as many as the window does (6 when stacked, 5 on a phone) and counts the rest ("+15 more on the lines"). A row opens the Actor inspector; pointing at or focusing one lights its station on the map. The board is one Tab stop; ↑/↓, Home and End move between its rows.
- **Lines:** each line is a band: its **sign** (route roundel with the project's initial, the name in bold tight Geist, the branch in mono, and a "Needs you" or "Failed" flag; the roundel takes an amber or rose ring), then the track (8 px, flat, a terminus bar at each end), then the **service log**. Lines follow the board's stable order (§4.3a) and glide to a new place when the user changes it (`layout`, `smooth`).
- **Stations:** every session and terminal is a station on its line: its status mark and name above the track (the name is a link to the focus view; the rest of the station opens the Actor inspector), a white mark on it (round for Claude, rounded square for a terminal; amber or rose ring when it waits or failed), and its **train** just past the mark. Stations sit in columns shared by every line (as many as the busiest line needs, at least 4, never under 132 px), so they line up down the map; they keep a stable order (sessions, then terminals, oldest first), so a state change never moves one. When a line has more than fit, the ones that need attention win and the rest show as "+N" (a link to the project).
- **Trains:** a working train **pulls out** of its platform (about 24 px, `dur.slow`) trailing speed lines; it rolls back when the work ends. A waiting train stands at the platform with amber doors that pulse; a failed one is a rose car halted short of the next station with a "!" for windows; the rest are parked. Claude trains carry a round headlight, terminals a square one. **Subagents and background tasks** are short trains on a 45° spur off their session's station (two shown, then "+N"), with the first one's name after them when the slot has room.
- **Status words:** a train's board word comes from its §2.1 token, and the board, the stations and the phone rows carry the token's mark. The same legend as Office sits above the concourse and maps each token to its train. Position means something too: a line is a project, and a train's place past its mark is its state.
- **Service log:** under each line, the last 60 minutes in fixed bins (24 px, 44 px on touch): each bin with events is one stop, a bar that grows with its count in the worst kind's color (turns `--text-3`, clean exits `--st-ok`, failures and crashes `--st-err` capped with a diamond, commits the line's accent capped with a ring). Bins can't overlap, so a busy hour stays calm. Hover shows what happened, a click jumps to the newest event (like the Pulse rail, §4.7). A time scale ("−60m … now") runs under the last line.
- **Motion:** stations scale in (0.9 → 1 with a fade, `dur.base`) when a session or terminal arrives; a new log bin's bar grows from the rule; bins step left together as the hour moves on. Reduced: trains cross-fade between platform and departed, nothing travels or loops. Off: static. Loops pause off stage.
- **Layout by width:** from 1080 px of stage the board (360 px, sticky) stands beside the map; from 640 px it sits above it with up to 6 rows; below 640 px, and on any touch screen, the lines become **station lists** (below).
- **Phone (390 px):** the board first (up to 5 rows: what needs you is on the first screen), then each line top to bottom: its sign (a 44 px link), its service log with 44 px bins, and the line dropping down the left edge through one 52 px row per station (mark, train, name, status word; subagents on a short branch), up to 6 and then "+N more in <project>". No sideways scroll, no pager.

### 10.6 Retro

**Concept.** A 1980s green-phosphor terminal. Everything is text: box-drawing frames per project, `[RUN]` `[WAIT]` `[ERR]` tags, ASCII output ticks over the last minute (`▁▂▃▅▇`, on the lanes' fixed scale, blank when quiet, dropped on phones), a blinking block cursor on whatever is working, and the live caption typed out character by character. It's the densest layout (fits 20+ projects on one screen) and works over any connection.
- Look: Geist Mono only, one phosphor hue for text, status shown with tag text **and** the status colors at reduced saturation, a faint scanline and a gentle screen curvature vignette at the edges (CSS only), a subtle phosphor glow on text (text-shadow).
- Motion: the cursor blinks at 1 Hz on working items only, captions type in, new lines scroll up. Nothing else moves. Reduced: no typing, no blink. Off: static.
- Keyboard-first: every project and actor has a number shortcut shown in the frame (`[3]`), Enter opens, Esc goes back.
- Daylight variant: dark text on a warm paper background, like a line printer, with no glow.
- **Phosphors:** green (`--retro-fg`, the default), amber, red, purple, cyan and white, picked in Settings → Appearance → Retro phosphor or with the ⌘K actions "Retro color: …" (listed up front while Retro is the layout, found by search elsewhere), persisted per browser (`yardmaster.phosphor`). Each is a family of tokens, `--retro-<color>` with `-dim` and `-bright` (green's is `--retro-fg`, `--retro-fg-dim`, `--retro-fg-bright`), tuned per theme: in Night the dim keeps ≥ 6.5:1 on the tube, in Daylight each prints as its own ink on the paper. The console maps the chosen family onto `--retro-ink`, `--retro-dim-ink`, `--retro-bright-ink` and the glow (`--retro-glow-ink`); the faint ink is mixed in sRGB from the dim so it keeps the hue and AA. The status tones (`--retro-tone-*`) are resolved at the root, so the workspace skin can map `--st-*` onto them.
- **Tags on every phosphor:** `[WAIT]` and `[ERR]` print in **inverse video** (the paper or tube color on the dimmed status tone), so a red phosphor never hides an error and an amber one never hides a wait. `[RUN]` and `[DONE]` keep their dimmed tone as text, and `[LOST]` prints in the dim ink.

### 10.7 Visual QA additions

- [ ] Each layout has screenshots at 390 / 1440 / 1920 in dark and light, at rest and under demo activity, plus its enter view (room, cockpit) at 390.
- [ ] On phones: every tap target ≥ 44 px, the inspector opens as a bottom sheet, nothing needs hover or a keyboard.
- [ ] The same demo moment shows the same statuses in every layout (count the amber and rose cues).
- [ ] Office: no character overlaps another station; nameplates truncate with a tooltip; the +N badge appears past 8.
- [ ] Grid: labels never overlap at 1440 with 10 projects; nothing flashes faster than 3 Hz; the 2D map is complete without WebGL.
- [ ] Transit: what needs you is on the board's first rows and on the first phone screen; station signs never overlap (shared columns, "+N" past them); a busy hour stays readable (the service log's fixed bins, at least 24 px apart, 44 px on touch); stations line up down the map.
- [ ] Retro: every frame aligns on the character grid; nothing breaks the monospace columns.
- [ ] Workspace skins (§10.8): each layout's focus view at 390 / 1440 in dark and light, with a Claude session streaming, a running terminal and a waiting approval; every status cue still reads.

### 10.8 Workspace skins

The focus view (§4.6) keeps one implementation: the same columns, rails, session list, side panel, git panel, chat, tool cards, composer, terminal stack, resize handles, keyboard map and accessible names in every layout. A layout changes only how it **looks**, so a feature added to the workspace works everywhere at once.

- **How:** the focus view root carries `data-layout`. Each skin is (1) a token override scoped to `[data-layout="…"] .focus` (surfaces, lines, text, radii, shadows, fonts within the existing families), (2) an xterm theme, and (3) at most a few small slot components the focus view renders by layout: a **header band**, a **panel frame** and an **entry transition**. No layout forks a panel; if a skin needs a change inside a component, the change is a token or a `data-layout` CSS hook.
- **Same meaning:** status colors, the non-color cues (§8), the ClaudeOrb's states and every caption stay readable and mean the same thing. Contrast meets §8 in both themes.
- **Continuity:** the entry transition starts from where the layout's overview left off (Office's room view, Grid's cockpit, a Transit line, a Retro frame), and Esc returns there.
- **Minimal:** the standard focus view, unchanged. It is the reference skin.
- **Office:** the project's room carried into the workspace. The header band is the room's front: door and nameplate, door light, ceiling light following activity, the whiteboard's todo lines, and the room's characters at small size acting their live states (the same crew components, capped at 8). Panels are framed as **monitors** on desks: a thin bezel in `--bg-3` with a 1 px `--line`, a small power LED in the panel's status color, a soft warm desk-lamp glow under the Claude monitor in Night. Walls and surfaces follow §10.3's palette.
- **Grid:** the cockpit made fully interactive. Near-black `--grid-bg` behind everything, the faint perspective floor and 3 % scanlines at the edges (not under text), panels as **holo screens**: a 1 px `--grid-neon` edge with corner brackets, a soft outer glow whose strength follows the panel's activity level, title bars in Geist Mono caps. Tabs and the active session glow cyan; the terminal theme is neon on black. Entry plays the cockpit's phase-in (scanline sweep, about 400 ms) instead of the cross-fade. Static at Reduced: no sweep, no glow pulsing.
- **Transit:** wayfinding signage. The header band is the project's own **line** from §10.5 (reusing its renderer): its sign (roundel, name, branch, the "Needs you" or "Failed" flag) beside the line with its stations and trains, the subagent spurs and the service log; clicking a station selects its session or terminal, clicking a log bin jumps to its event. The line is one Tab stop and the arrows move along it. Panels are flat (no glass) with a 4 px strip in the line's color along the top, amber or rose when the panel waits or failed. Column headings are station signs (the roundel's ink on the line color, rounded, bold), terminal tabs carry numbered route roundels, and the session list is a departures board (the board's dark panel in both themes, the status in its words: "Due · needs you", "Departing · Bash", "At platform", "Cancelled", "Held · interrupted", "Out of service", with the amber or rose edge bar). Only the words change; tone, color and mark stay. The §10.5 grounds in both themes, the standard terminal palette. Entry: the line grows from its place on the map into the band (a still copy, `smooth`) while the panels rise 16 px in; Esc returns to the map with focus on the line's sign, which stays lit in the line's color for a moment.
- **Retro:** text mode. Geist Mono only, the chosen phosphor (§10.6), box-drawing frames around every panel (`┌─ CLAUDE ─┐` titles), buttons as `[ SEND ]`, pills as `<opus>`, status as tags (`[RUN]` `[WAIT]` `[ERR]`) plus dimmed status colors, `[WAIT]` and `[ERR]` in inverse video. Chat renders as a console transcript: each turn opens after a blank line on a full-width header rule, `── YOU · 14:02 ────` or `── CLAUDE · 14:02 ────` (a skin hook: the message list marks the first row of each turn with `data-turn` and `data-turn-label`), your messages print in the bright phosphor after a `>` prompt, Claude's in the normal one, tool calls and thinking as dimmer lines indented 2 characters (`├─ Bash pnpm test [RUN]`, expanding in place at full brightness), code in a box with its language in the top rule, and a diff's changed words underlined rather than tinted; the streaming caret is the blinking block cursor, the terminal theme is phosphor on black. Scanline and vignette as in §10.6; Daylight is the line-printer variant. Keyboard-first: the number shortcuts from the overview keep working in the session list and tabs.
- **Phones:** every skin dresses the phone workspace from §11 (the project hub, its cards and the item pages) without changing its structure or labels: Office shows the hub as the room (cards as the characters' desks, with the nameplate and up to 3 characters in the header), Grid as a stack of holo screens, Transit as a departures board (each group a dark board, rows in the board's words) with the project's line, up to 4 station marks, in the app bar, Retro as a text menu with numbered items. Frames thin out and tap targets stay ≥ 44 px.
- **Performance:** skins add no per-frame work beyond what the layout already draws; the Office header characters and Grid glow follow the off-screen pause and motion-level rules, and the focus view still meets §7 under `--demo-stress`.

## 11. Phones

The board must be fully usable one-handed on a phone (360–430 px wide, portrait, and landscape at 844 × 390), not a desktop squeezed down. Below 768 px the app switches to the **phone shell**; 768–1023 px keeps the desktop shell with the project rail collapsed to icons.

**Phone shell.**
- **Top bar** (48 px, plus `env(safe-area-inset-top)`): the logomark (no wordmark), the three status counts (Needs you, Failed, Active, as in §4.4), and a search button for ⌘K on the right. Theme, editor status and *Open project* leave the top bar.
- **Bottom tab bar** (56 px plus `env(safe-area-inset-bottom)`, glass, thumb reach): **Overview**, **Projects** (the project rail as a list, with *Open project* at the top), **Attention** (with its count badge; the Attention Center full-screen), **Pulse** (the timeline as a vertical list, newest first), and **More** (layout, theme, motion, editor status, settings). The active tab's indicator glides (`layoutId`, `tabGlide`). The tab bar replaces the left rail and the Pulse rail, which don't render on phones.
- **Workspace (focus view)** is full-bleed: no card inset, no outer margin, the bottom tab bar hidden while it's open (back brings it back). It is organised around **what the user wants to do**, not the desktop's three columns:
  - **Project hub** (the workspace's first screen): an app bar (back, project avatar and name, branch, overflow menu), a one-line summary ("2 working · 1 needs you · :3000 serving"), then **one list of everything in the project**, grouped **Needs you**, **Running**, **Idle**. Each Claude session and each terminal is one card. A Claude session that runs in a terminal is a single card, never two. A card shows a kind icon (orb or terminal), its name, its status in words plus color, the live caption, and ports. Below the list are rows that open their own pages: **Git** (branch, changed count), **History** (past sessions, count) and **Ports**. A large **+ New** button opens a sheet with *Claude session*, *Terminal* and the recent-command chips.
  - **Item pages:** tapping a card opens that item full screen: a Claude chat, or a terminal's output. The header shows the item's name and status. Tapping the name opens a **switcher sheet** listing every item in the project (the same groups as the hub) to jump between them, and swiping left or right moves to the neighbouring item. A Claude chat that runs in a terminal has a *Chat / Terminal* segmented toggle in its header. When another item in the project needs you, a slim amber bar under the header says so and opens it.
  - **Words over icons:** every action on a phone has a visible text label (an icon with a word under or beside it), or lives in a labelled menu. Terminal actions read *Stop* (Ctrl+C), *Restart*, *Open in Cursor*, *Find*, *Clear*. History rows say *Resume here* / *Resume in Cursor*. Board-owned terminals get a key bar (Tab, Esc, Ctrl, arrows) above the keyboard.
  - **Reachability:** from the overview, any session's chat, any terminal's output, a waiting approval and a new terminal are each at most two taps away. Back always returns to the hub, and the hub's scroll position and the last-opened item are kept.
  - A chat page has the transcript detail toggle (§4.6) in a strip under its header.
  - The composer is pinned to the bottom and rides above the on-screen keyboard (`interactive-widget=resizes-content` in the viewport meta, `visualViewport` as a fallback), so the field and Send are always visible while typing. Its state is written as a sentence ("Claude is working, you can reply when it's done") with *Stop* as a labelled button.
- **Sheets and dialogs** are bottom sheets, at most 90 dvh, with a drag handle and their own scroll; nothing opens as a centered desktop dialog on a phone.
- Toasts sit above the tab bar (or above the composer in a workspace) and never cover the tab bar or Send.

**Fit rules (hard).**
- The page never scrolls sideways. Use `100dvh`, never `100vh`; `viewport-fit=cover` with the safe-area insets applied to the bars.
- 16 px gutters. Every flex or grid child that holds text has `min-width: 0`.
- Wide content (diffs, code, tool output, tables, xterm, git graphs) scrolls **inside its own box** horizontally, with a soft edge fade showing there's more; it never widens its parent.
- Long names, branches, commands and paths truncate with an ellipsis (middle truncation for paths), and the full value is one tap away (inspector or sheet).
- Tap targets ≥ 44 × 44 px with 8 px between neighbors, text ≥ 12 px, inputs ≥ 16 px (so mobile browsers don't zoom on focus).
- Every layout's phone version follows §10.1's phone rules inside the phone shell.
