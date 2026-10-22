# c-board — Design & Motion Spec

The UI has one job: make the state of many projects readable at a glance, and make it feel **alive**. Motion is not decoration here. Every animation encodes real activity: something is thinking, something is streaming, something needs you.

Read this before any UI task. For UI work, also load the `frontend-design` skill if it's available.

---

## 1. Concept: "Observatory"

A dark, calm, deep-space control room. Projects are **pods** floating on a softly lit field. Claude sessions are **orbs** that breathe, swirl and pulse according to what they are doing. Terminals are **lanes** with light flowing through them as output streams. When something needs you, the room **turns toward it**: its pod glows amber, the ambient light shifts, and the Attention Center slides in.

The centerpiece is the **Live Work Preview** (§4.10): for every project you can *see* the work happen. Each project's codebase is drawn as a glowing map, and Claude's orb travels across it, lighting up the files it reads and edits. A "Now Playing" stage shows the exact action live: a diff typing itself in, a command and its output, a search sweeping through the code. Animated beams connect every actor (session to file, session to terminal, request to you). You never have to read a log to know what's going on.

Three words: **calm, precise, alive.** Never noisy or gamer-RGB. Think Linear × Vercel × a planetarium.

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
| `--text-3` | `#6B7183` | tertiary / meta |

**Status colors** are semantic and identical everywhere, and each has a `-glow` variant at 35% alpha:

| Status | Token | Value |
|---|---|---|
| working / running | `--st-work` | `#7C9CFF` (indigo-blue) |
| tool active | `--st-tool` | `#5EE7FF` (cyan) |
| waiting for you | `--st-wait` | `#FFB547` (amber) |
| success / done | `--st-ok` | `#3DDC97` (green) |
| error / crashed | `--st-err` | `#FF5C7A` (rose) |
| idle | `--st-idle` | `#6B7183` |

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
3. **Layout:** pods reorder with `layout` plus `smooth` when attention ranking changes. Going from pod to focus view is a **shared-element transition** (`layoutId` on the pod container, header and orb).
4. **Attention:** a status change to `waiting` triggers a one-time "ripple" ring (scale 1→1.6, opacity .6→0, 900 ms), then a slow amber breathing glow (2.4 s loop) until resolved.
5. **Completion:** `working → idle` after a turn plays a brief green check sweep on the orb (600 ms). It never loops.
6. **Errors:** a 2-frame horizontal glitch (±2px, 120 ms) plus a rose glow that stays until acknowledged.
7. **Numbers:** counters animate with a spring on value change (a rolling digit ticker for HUD metrics).
8. **Only animate `transform`, `opacity`, `filter`** (and canvas). Never animate width, height, top or left on hot paths. Use `layout` for size changes.

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
│ ┌─────────────────────────────┐                           │
│ │  · ·  ·:· ✶ ·  ·    ·:·  ·  │ ← Mini Codebase Map (§4.10.1): live, files glow as touched,
│ │ ·:·  ·  ·══◉ ·:·  · ·  ·    │   orb + trail moves between files, subagent orbs in pink
│ └─────────────────────────────┘                           │
│  ◉ Claude · ✎ Editing src/cart/totals.ts   +12 −3  12.4k │ ← session row: orb, Now Playing caption (§4.10.2), live diff stat, tokens
│    "Refactoring the cart totals to use…"                 │ ← last assistant line, 1-line clamp, shimmer while streaming
│                                                           │
│  ▸ backend     pnpm dev        ▁▂▅▇▅▂▁   :3000  ● 2m     │  ← terminal lanes: name · cmd · throughput sparkline · port · uptime
│  ▸ storefront  shopify app dev ▁▁▂▁▁▁▁   :9292  ●        │
│  ▸ zsh         git status      ✓ 0                        │
└───────────────────────────────────────────────────────────┘
```

- Hover: a cursor-following spotlight (radial gradient at the pointer position, 6% white) plus border brightening. No lift or scale: hover feedback stays quiet so status motion stands out.
- Throughput sparkline: a 60-sample rolling canvas line. New samples slide in from the right. Its color is the project accent, and it turns rose on error output.
- **Flow light:** when a lane is streaming, a thin gradient "comet" travels along its bottom border (CSS keyframe on a pseudo-element, transform only).
- The pod border takes the highest-priority status color of its children (wait > err > work).
- **Terminal peek:** hovering (or focusing) a lane expands a live 6-line preview of that terminal's latest output beneath it (DOM text, Geist Mono 11px, ANSI colors, updated at most 10×/s), so you can read logs without opening anything.
- **Idle pods** (no session working, no output for 5 min) dim to 70% and their mini map stops animating. Active pods are always the brightest things on screen.

### 4.4 HUD (top bar)

Rolling-digit counters: **Working · Waiting · Running terminals · Errors · Tokens today**. A clickable "Waiting" count opens the Attention Center. On the right are the connection status dot (with a reconnect spinner), ⌘K hint, motion toggle and theme.

### 4.5 Attention Center

- A right-side sheet (or a bottom sheet on narrow screens), sliding in with `smooth`.
- Each approval card shows the project chip, session orb, tool name, and the exact payload: the command in mono with syntax highlight, or for Edit a mini diff. Actions: **Allow** (A), **Always allow** (⇧A), **Deny…** (D, with an optional reason). Keyboard first.
- Resolved cards collapse with a height animation (`layout`) and a check sweep.

### 4.6 Focus view (project)

- A shared-element transition from the pod. The background dims and blurs other content.
- Layout: the left column is the session list plus the git panel. The center is the **Stage**, with two tabs that switch by cross-fade: **Live** (default) shows the Codebase Map on top (§4.10.1) and the Now Playing card below (§4.10.2), and **Chat** shows the Claude panel. The right is a **terminal stack** (tabs or a 2×2 grid toggle). Along the bottom is the **session timeline** (§4.10.4). The flow-beam layer (§4.10.3) sits above all of it. All panels are resizable with spring-snapped handles.
- A compact composer is always docked under the Stage, so you can talk to Claude from the Live tab without switching.
- Claude panel: message stream with markdown, collapsible thinking blocks, and tool cards (Bash with output, Edit/Write with diffs, Read/Grep as compact chips, TodoWrite as an animated checklist where checks draw in, Task as a nested subagent thread). The composer has model and permission-mode pills, Enter to send and Esc to interrupt.
- Streaming text shows a soft caret glow at the tail. Tool cards enter with a scale 0.98→1 and fade.

### 4.7 Pulse (activity timeline)

A collapsible bottom rail: a horizontal time axis covering the last 15 min. Each event is a dot in its project's lane, colored by type. New dots fly in from the right edge. Hover shows a tooltip, and click jumps to the event.

### 4.8 Command palette (⌘K)

Built on cmdk, inside a glass modal with a scale 0.96→1 and blur-in. Groups: Projects, Sessions, Terminals, Actions. Fuzzy search highlights matched characters. Selecting a destination triggers its normal transition.

### 4.9 Brand and icons

- **Name and wordmark:** `c-board`, lowercase, in Geist Mono 500.
- **Logomark:** an inline SVG with a small glowing orb (the ClaudeOrb motif) inside a rounded-square ring, 1.5px stroke, using `currentColor` plus one accent. It's one source file (`apps/web/src/brand/logo.svg`), and every other brand asset is generated from it.
- **Favicon:** the SVG favicon is **live**. It turns amber with a dot when anything is waiting and rose when something has crashed. The document title shows the count, for example `(2) c-board`. A PNG fallback is generated at build.
- **Extension icon:** a 128×128 PNG rendered from the logomark at build time (Playwright screenshot of the SVG). It isn't hand-drawn and isn't committed as a binary if it can be generated.
- **Icons:** `lucide-react` only, 1.5px stroke, 16/20 px. Tool families map to fixed icons (Bash → `terminal`, Edit/Write → `file-pen`, Read → `file-text`, Grep/Glob → `search`, Web → `globe`, Task → `git-fork`, Todo → `list-checks`). **Never** use third-party brand logos (Claude, Cursor, VS Code); use text labels instead.
- **No sound.** c-board is silent; attention is visual (pod glow, live favicon, Attention Center, optional browser notifications).

### 4.10 Live Work Preview (the signature experience)

The research behind this section looked at Mindwalk (a repo drawn as a night map that lights up where an agent searched, read and edited), Agent Flow (a live node graph plus a file-attention heatmap), Pixel Agents (one character per agent, with poses per activity and bubbles when waiting) and the hook-based observability dashboards (swim lanes and live pulse charts). c-board combines the clearest ideas into one **live** view. Everything below is driven by real hook events (PRD §6.1), never faked.

#### 4.10.1 Codebase Map

- **What it shows:** the project's files (from `git ls-files`) as a **circle-packed constellation**. Directories are faint rings and files are small dots, with size ∝ √(file bytes), using a `d3-hierarchy` pack layout and rendered on canvas. Untouched files are dim (`--text-3` at 25%). Directory labels appear only at zoom ≥ 1.5 or on hover.
- **Heat (what Claude touched), decaying over 10 min:**
  - Glanced (Glob or ls hit): soft blue-grey glow, 30% intensity.
  - Read: cool white-blue glow (`--st-work`). A thin scan line sweeps across the dot once, covering the read range.
  - Search (Grep): a radial **sweep** from the orb across the searched directory ring, and every matched file blinks cyan (`--st-tool`) in turn, staggered by 25 ms.
  - Edited or written: a warm violet core plus an expanding **ripple ring** (scale 1→2.2, 700 ms), and a floating `+12 −3` badge that rises 12 px and fades. Edited files keep a persistent violet rim for the rest of the session (the "changed" layer).
  - Created file: the dot grows from 0 (spring `snappy`) and the layout eases in (positions are tweened, never jumping).
  - Error touching a file (failed tool): a rose flicker.
- **The orb on the map:** the session's ClaudeOrb sits at the file it's working on. When it moves to a new file it **travels along a curved path** (quadratic bezier through the parent ring, 450–700 ms, `ease.inOut`) and leaves a fading comet **trail** of its last 8 hops, so you can read the path of work at a glance. While thinking without a tool, it drifts slowly near the last file. Subagents spawn as smaller pink orbs that **split off** from the parent (particle burst) and run their own trails, then merge back on `SubagentStop`.
- **Several sessions in one project:** each orb is tinted with a per-session hue, and trails don't mix.
- **Interaction:** wheel or pinch to zoom, drag to pan, and double-click a directory to zoom to it. Hovering a file shows its path, last action and time. Clicking a file opens its latest diff (from the session's Edit/Write events) in a side sheet. The `F` key toggles "follow orb", where the camera smoothly tracks the active orb; it's on by default.
- **The mini version on pods** uses the same renderer at low detail: no labels, a 15 fps cap, and it redraws only while something is happening.
- **Large repositories:** above 4,000 files, subtrees with no activity collapse into single directory nodes. They expand automatically when something inside them is touched.

#### 4.10.2 Now Playing stage

A large card that shows the **current action** of the selected session as a live mini-scene. One variant exists per tool. It **morphs** between variants (shared `layout` plus a cross-fade, `smooth`), it doesn't swap.

| Action | Scene |
|---|---|
| Thinking or writing | The orb is large, and the assistant's streaming text types in with a caret glow. Thinking shows as a dim, collapsed "thinking…" shimmer. |
| Edit / MultiEdit | The file path header and a **diff that animates itself**: removed lines tint rose and collapse upward, then added lines type in (about 2–4 ms per character, capped at 600 ms per hunk), with a `+n −m` counter ticking. Code is syntax highlighted (shiki). |
| Write | The new file "prints" top-down with a scan line. Large files are truncated with "+N lines". |
| Read | The file peek with line numbers, and a highlight band scans the read range. |
| Grep / Glob | The pattern in a pill, and a hit counter rolling up as matched paths cascade in as chips (and blink on the map). |
| Bash (Claude's own shell) | A mini terminal: the command types in, there's a running spinner with elapsed time, then the output (from `PostToolUse.tool_response`) reveals with the exit badge. Long-running commands show "running for 12s". |
| WebFetch / WebSearch | A URL or query card with a loading bar, then the title and the first lines. |
| TodoWrite | The checklist, where new items slide in and completed items draw their check (stroke animation) and dim. |
| Task (subagent) | A split animation: a child card peels off the stage into a stacked "subagent" lane underneath, with its own live caption. |
| Waiting for permission | The stage freezes and desaturates except for an amber frame. The exact request is shown with inline **Allow / Deny** buttons, the same actions as the Attention Center. |
| Idle | A quiet summary of the last turn: files changed (with sparkline-style mini diff bars), commands run and duration. |

The same caption ("✎ Editing src/cart/totals.ts") feeds the pod's session row and the ⌘K results.

#### 4.10.3 Flow beams

An SVG overlay layer draws **animated connections** between related elements that are on screen at the same time:

- Session orb → the file node on the map, while acting on it.
- Session → its **terminal lane**, when the session is running in that terminal (pid link) or when Claude runs a Bash command whose output shows up there.
- Approval request → the HUD "Waiting" counter (on the overview) or the Attention Center (when open).
- Dev-server lane → its port chip, briefly, when the port starts listening.

Each beam is a gradient path (accent → status color) with small particles travelling along it, about 3 per second, moving from source to target, drawn with `stroke-dashoffset` and transform only. Beams fade in over 200 ms and fade out 1.5 s after the activity ends. There are at most 12 beams at once (prefer the newest). At the Reduced motion level they become static lines, and at Off they're hidden.

#### 4.10.4 Session timeline and replay

- The bottom strip of the focus view shows the session's events as markers on a time axis: edits (violet), reads (blue), searches (cyan), commands (green or rose by exit code), subagent spawns (pink), compactions (grey), user prompts (white), approvals (amber).
- **Scrub** by dragging the playhead or clicking a marker. The Codebase Map and the Now Playing stage **replay** that moment: heat is recomputed for that point in time, and the orb is placed at that event's file. The `LIVE` pill jumps back to now.
- Keys: `Space` play/pause replay (8× speed), `←/→` step through events, `E`, `X` and `U` jump to the next edit, error or user prompt.

#### 4.10.5 Overview-level storytelling

- New activity in any pod sends a tiny particle along the pod's top hairline. Several busy projects read as a calm "everything is flowing".
- When a project finishes a turn, its pod does one gentle green sweep across the mini map (edited files flash once in sequence, then settle). That's the "done" moment, and it plays once.

## 5. Component inventory

`AppShell, AmbientField, Hud, ProjectRail, PodGrid, ProjectPod, SessionRow, ClaudeOrb, CodebaseMap (+ MiniMap), NowPlayingStage (+ per-tool scenes), FlowBeams, SessionTimeline, TerminalPeek, TerminalLane, Sparkline, PortChip, StatusDot, AttentionCenter, ApprovalCard, FocusView, ClaudePanel, MessageList, ToolCard(*), DiffView, Composer, TerminalStack, XtermView, GitPanel, PulseRail, CommandPalette, Toasts, SettingsSheet, OnboardingWizard, EmptyState, Skeleton, Kbd, Tooltip, NumberTicker`.

## 6. Empty, loading and error states

- **First run:** a centered onboarding card over the ambient field, with a 3-step checklist (Server ✓, Hooks, Extension). Each step shows live detection: it ticks itself the moment the first hook event or editor connection arrives.
- **Loading:** shimmer skeletons in pod shape. Never spinners for content.
- **Disconnected:** the HUD dot turns rose, a top inline banner reads "Reconnecting…", and data greys to 60%. Nothing jumps.

## 7. Performance rules (hard)

- One WebGL context (ambient). Orbs and sparklines share **one** `requestAnimationFrame` scheduler and draw only when visible (IntersectionObserver).
- xterm instances mount only in the focus view, with the WebGL addon and a fallback to canvas/DOM. Inactive tabs dispose their renderer but keep the buffer in the store.
- Lists over 50 items are virtualized (`@tanstack/react-virtual`).
- Codebase Maps: compute the layout once per file-index change in a Web Worker. Render with Canvas 2D on the shared scheduler. Mini maps run at ≤ 15 fps and go fully idle when no events have arrived for 3 s. Only the focus-view map runs at 60 fps.
- Store updates are batched. Components subscribe to narrow selectors. Overview re-renders are capped by the 30 Hz patch coalescing.
- Lighthouse performance ≥ 90 on the overview in demo mode. No long tasks over 50 ms during steady-state streaming.

## 8. Accessibility

- Every status uses color **plus** shape or text (dot + label, icon on the orb) for color-blind users.
- Focus ring: 2px `--line-strong` plus a 4px accent glow.
- `aria-live="polite"` region announces new approvals and crashes.
- Every action is reachable from the keyboard and appears in ⌘K with its shortcut.

## 9. Visual QA checklist (used by the loop's screenshot review tasks)

- [ ] No element touches the viewport edge without padding. 16px minimum gutter at 390px width.
- [ ] Type uses only the scale above, and numbers are tabular.
- [ ] No default browser focus rings, no unstyled scrollbars (thin custom ones).
- [ ] Status colors match the token table exactly. Accents never signal status.
- [ ] Dark and light both look intentional, with no pure #000 or #fff surfaces in dark.
- [ ] Pods align on a grid. Lane columns (name/cmd/spark/port) align across pods.
- [ ] Motion at Reduced level has no movement other than cross-fades.
- [ ] Nothing overflows. Long project names, commands and branches truncate with a tooltip.
- [ ] Empty, loading, error and disconnected states all exist and look designed.
