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
- Labels are uppercase only for 11px meta with +0.06em tracking.

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

1. **Enter:** fade 0→1 plus y 8→0 plus blur 4→0, `smooth`. Lists stagger children by 30–40 ms (max 8 staggered, then the rest together).
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
- Subtle film grain overlay (static PNG noise, 3% opacity) to avoid banding.

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

- Hover: a cursor-following spotlight (radial gradient at the pointer position, 6% white) plus border brightening. Lift via `translateY(-2px)`.
- Throughput sparkline: a 60-sample rolling canvas line. New samples slide in from the right. Its color is the project accent, and it turns rose on error output.
- **Flow light:** when a lane is streaming, a thin gradient "comet" travels along its bottom border (CSS keyframe on a pseudo-element, transform only).
- The pod border takes the highest-priority status color of its children (wait > err > work).

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

## 5. Component inventory

`AppShell, AmbientField, Hud, ProjectRail, PodGrid, ProjectPod, SessionRow, ClaudeOrb, TerminalLane, Sparkline, PortChip, StatusDot, AttentionCenter, ApprovalCard, FocusView, ClaudePanel, MessageList, ToolCard(*), DiffView, Composer, TerminalStack, XtermView, GitPanel, PulseRail, CommandPalette, Toasts, SettingsSheet, OnboardingWizard, EmptyState, Skeleton, Kbd, Tooltip, NumberTicker`.

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
