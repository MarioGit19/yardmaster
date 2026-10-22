# c-board — Design & Motion Spec

The UI has one job: make the state of many projects readable at a glance, and make it feel **alive**. Motion is not decoration here. Every animation encodes real activity: something is thinking, something is streaming, something needs you.

Read this before any UI task. For UI work, also load the `frontend-design` skill if it's available.

---

## 1. Concept: "Observatory"

A dark, calm, deep-space control room. Projects are **pods** floating on a softly lit field. Claude sessions are **orbs** that breathe, swirl and pulse according to what they are doing. Terminals are **lanes** with light flowing through them as output streams. When something needs you, the room **turns toward it**: its pod glows amber, the ambient light shifts, and the Attention Center slides in.

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
│  (orb)  Claude · Editing src/cart.ts            12.4k tok │  ← each session row: orb, status text (typewriter), tokens
│         "Refactoring the cart totals to use…"            │  ← last assistant line, 1-line clamp, shimmer while streaming
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

### 4.4 HUD (top bar)

Rolling-digit counters: **Working · Waiting · Running terminals · Errors · Tokens today**. A clickable "Waiting" count opens the Attention Center. On the right are the connection status dot (with a reconnect spinner), ⌘K hint, motion toggle and theme.

### 4.5 Attention Center

- A right-side sheet (or a bottom sheet on narrow screens), sliding in with `smooth`.
- Each approval card shows the project chip, session orb, tool name, and the exact payload: the command in mono with syntax highlight, or for Edit a mini diff. Actions: **Allow** (A), **Always allow** (⇧A), **Deny…** (D, with an optional reason). Keyboard first.
- Resolved cards collapse with a height animation (`layout`) and a check sweep.

### 4.6 Focus view (project)

- A shared-element transition from the pod. The background dims and blurs other content.
- Layout: left column is the session list plus the git panel. The center is the **Claude panel** (chat). The right is a **terminal stack** (tabs or a 2×2 grid toggle). All panels are resizable with spring-snapped handles.
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
- **No sound.** c-board is silent. Attention is visual: pod glow, the live favicon, the Attention Center and optional browser notifications.

### 4.10 Activity animation (the core of the "alive" feel)

The rule: **if something is doing work, it moves, and if it's not, it's still.** Motion is the activity signal, so you can scan 10 projects and immediately see which ones are busy, waiting or broken without reading anything. Each signal is small and cheap, driven only by real events (hooks, terminal output), and never decorative.

| What | Idle | Active | Needs you / broke |
|---|---|---|---|
| **Crew mascot** (§4.11) | idle fidgets, or asleep after 5 min | acts out the work: typing, reading, running a command, delegating, thinking | raises a hand with an amber "!" / sweats with ×-eyes |
| **Claude session** (orb, §4.2) | dim, slow breathing | swirling core while thinking, orbiting particles while running a tool (colored by tool family) | amber ripple then breathing glow / rose glitch |
| **Session row caption** | the last turn's summary in `--text-3` | a live caption of the current action ("✎ Editing src/cart.ts", "⌕ Searching \"totals\"", "▶ pnpm test") that swaps with a quick vertical slide and a shimmer sweep across it | "Waiting for approval: Bash(pnpm test)" in amber |
| **Terminal lane** | flat sparkline, grey dot | sparkline scrolling with output rate, a pulsing green dot (pulse speed ∝ lines/s, capped), and a comet light running along the lane's bottom edge | rose dot, exit badge pops in, the last error line slides into the caption |
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
- Sizes: 24 px (session row: eyes, antenna orb and posture only, no props), 56 px (pod header: full acting), and 120 px (focus-view header: full acting plus props in detail).
- Characters off screen or in hidden tabs are paused. At the Reduced motion level each state is a static pose. At Off it's a static pose without bubbles.

## 5. Component inventory

`AppShell, AmbientField, Hud, ProjectRail, PodGrid, ProjectPod, SessionRow, ClaudeOrb, CrewMascot, TerminalLane, Sparkline, PortChip, StatusDot, AttentionCenter, ApprovalCard, FocusView, ClaudePanel, MessageList, ToolCard(*), DiffView, Composer, TerminalStack, XtermView, GitPanel, PulseRail, CommandPalette, Toasts, SettingsSheet, OnboardingWizard, EmptyState, Skeleton, Kbd, Tooltip, NumberTicker`.

## 6. Empty, loading and error states

- **First run:** a centered onboarding card over the ambient field, with a 3-step checklist (Server ✓, Hooks, Extension). Each step shows live detection: it ticks itself the moment the first hook event or editor connection arrives.
- **Loading:** shimmer skeletons in pod shape. Never spinners for content.
- **Disconnected:** the HUD dot turns rose, a top inline banner reads "Reconnecting…", and data greys to 60%. Nothing jumps.

## 7. Performance rules (hard)

- One WebGL context (ambient). Orbs and sparklines share **one** `requestAnimationFrame` scheduler and draw only when visible (IntersectionObserver).
- xterm instances mount only in the focus view, with the WebGL addon and a fallback to canvas/DOM. Inactive tabs dispose their renderer but keep the buffer in the store.
- Lists over 50 items are virtualized (`@tanstack/react-virtual`).
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
