# c-board — Build Plan

This plan is executed **one task per iteration** by `loop/loop.sh`. Each iteration does the following:

1. It picks the **first** unchecked task (`- [ ]`) in document order.
2. If that task is tagged **[HUMAN]**, the loop stops and asks the maintainer to do it.
3. It implements the task, makes **Verify** pass, and runs `pnpm check` once that script exists.
4. It ticks the box (`- [x]`), appends a short note under the task if anything notable happened, and makes one signed commit.

Specs: [docs/PRD.md](docs/PRD.md) (what and why) · [docs/DESIGN.md](docs/DESIGN.md) (look and motion) · [CLAUDE.md](CLAUDE.md) (rules).

Task format: `- [ ] **ID Title**`, then indented details, **Done when** and **Verify**.

---

## Phase 0 — Foundation

- [x] **0.1 Monorepo scaffold**
  - pnpm workspace with `apps/server`, `apps/web`, `apps/extension`, `packages/protocol`, `packages/hook`. Root `package.json` (`private`, `packageManager: pnpm@9`, `engines.node >=22`), `pnpm-workspace.yaml`, `tsconfig.base.json` (strict, `moduleResolution: bundler`, `verbatimModuleSyntax`), and `.nvmrc` (22).
  - TypeScript pinned to `~6.0.3`. Every package gets `typecheck` and `build` scripts, plus placeholder `src/index.ts`.
  - **Done when:** `pnpm install` and `pnpm -r typecheck` succeed.
  - **Verify:** `pnpm install && pnpm -r typecheck`

- [x] **0.2 Lint, format, test tooling**
  - Biome 2 at the root (`biome.json`: formatter 2-space, line width 100, recommended rules). Vitest 5 workspace config. Root scripts `lint`, `format`, `test`, `typecheck`, `build`, and `check` (= privacy check + lint + typecheck + test).
  - Add `simple-git-hooks` with a pre-commit hook running `scripts/privacy-check.sh --staged && pnpm lint`.
  - **Done when:** `pnpm check` passes on the empty scaffold, with one trivial passing test per package.
  - **Verify:** `pnpm check`
  - Note: Vitest 5 uses root `test.projects` (the old workspace file is gone); each package has its own `vitest.config.ts` and `test` script. Builds use `tsconfig.build.json` to keep tests out of `dist`. Biome skips Markdown so the docs stay hand-formatted.

- [x] **0.3 CI**
  - `.github/workflows/ci.yml`: on push/PR, runs on ubuntu-latest and macos-latest, sets up Node 22 and pnpm, then runs `pnpm install --frozen-lockfile`, `pnpm check` and `pnpm build`. Uploads the extension `.vsix` as an artifact once that exists (guard with `if: hashFiles(...)`).
  - **Done when:** the workflow file is valid YAML and references only existing scripts.
  - **Verify:** `pnpm dlx @action-validator/cli .github/workflows/ci.yml` (or a YAML parse via node if unavailable).

## Phase 1 — Protocol (`packages/protocol`)

- [x] **1.1 Domain model**
  - zod 4 schemas and inferred types for `Project`, `EditorWindow`, `Terminal`, `Execution`, `ClaudeSession` (status union per PRD §4.2), `ToolActivity`, `Approval`, `ActivityEvent`, `PortBinding`, `ProcessStats`, `GitInfo` and `BoardState` (normalized maps by id).
  - Helpers: `projectIdFromPath(realpath)` (stable short hash) and `accentForProject(id)` (returns one of the 10 hues from DESIGN.md §2).
  - **Done when:** the types export cleanly and unit tests cover the schemas (valid and invalid samples) and helper stability.
  - **Verify:** `pnpm --filter @c-board/protocol test`
  - Note: `SessionStatus` is a discriminated union on `kind`; `compacting` carries the `previous` status to restore. `BoardState` rejects map keys that differ from item ids. Activity events are not kept in `BoardState` (unbounded); they stream separately. `Project.accent` stores the index from `accentForProject`. The hash is a hand-rolled FNV-1a 64 so it runs in Node and the browser without `node:crypto`.

- [x] **1.2 Wire messages**
  - Envelope `{ v: 1, type, id?, ts, payload }` and discriminated unions for editor↔server, server↔UI and UI→server messages exactly as in PRD §7. Add `encode/decode` helpers that validate with zod and return typed results (never throw on bad input).
  - **Done when:** round-trip tests pass for every message type, and invalid messages are rejected with a reason.
  - **Verify:** `pnpm --filter @c-board/protocol test`
  - Note: The `PatchOp` schema (`set`/`merge`/`delete` at a path) lives in `patch.ts` now, because `patch {ops}` needs it. 1.4 adds `applyPatch` and the collector next to it. Server commands require an envelope `id` for `cmd.result`. The UI `action` payload is a union on `kind` (terminal, session, project and settings actions). Stream ids are `exec:<id>` or `term:<id>`. `decode` takes an optional `maxLength`.

- [x] **1.3 Hook payload schemas**
  - Permissive (`.passthrough()`) zod schemas for the hook events listed in PRD §6.1, with common fields `session_id`, `transcript_path`, `cwd`, `permission_mode` and `hook_event_name`, plus event-specific fields. Add `normalizeHookEvent(raw, claudePid?) → ActivityEvent`.
  - Add synthetic fixtures in `packages/protocol/fixtures/hooks/*.json`, using fake paths such as `/home/dev/acme-shop` and fake UUIDs.
  - **Done when:** every fixture parses and normalizes. Unknown events normalize to the `unknown` kind without throwing.
  - **Verify:** `pnpm --filter @c-board/protocol test`
  - Note: Event-specific fields are all optional (StopFailure/PostCompact shapes were not re-verified against the hooks reference). A known event with a malformed field normalizes to `unknown`. `normalizeHookEvent` takes an optional third `{ now, id }` argument for deterministic tests.

- [x] **1.4 Patch format**
  - A minimal patch op set for `BoardState` (`set`, `merge`, `delete` at a path of ids), plus `applyPatch(state, ops)` (immutable, structural sharing) and a `diffCollector` that records ops when the store mutates.
  - **Done when:** property-style tests show that applying the collected ops to the old state equals the new state.
  - **Verify:** `pnpm --filter @c-board/protocol test`
  - Note: the collector applies mutations immediately and computes coalesced ops on `flush()` by diffing the baseline against the current state (identity-skipping via structural sharing), so redundant ops never reach the wire. Objects whose `kind` changes are replaced whole. Added `fast-check` (dev) for property tests.

## Phase 2 — Server core (`apps/server`)

- [x] **2.1 Server skeleton and config**
  - Fastify 5 with pino. Config from env and defaults: `CBOARD_PORT=4317`, `CBOARD_HOME=~/.c-board`, `CBOARD_HOST=127.0.0.1` (refuse any non-loopback value). Add `GET /api/health`. Run in dev with `tsx watch`.
  - **Done when:** the server starts, `/api/health` returns `{ok:true, version}`, and a test uses `fastify.inject`.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: `buildServer(config)` / `startServer(config)` in `app.ts`, env parsing in `config.ts` (`loadConfig(env, home)`), entry `main.ts` (`pnpm --filter @c-board/server dev`; replaced by `cli.ts` in 2.7). Loopback means `127.0.0.0/8`, `::1` or `localhost`. `CBOARD_PORT=0` is allowed for ephemeral ports. Added `CBOARD_LOG_LEVEL` (default `info`). Request logging is off and pino omits the hostname.

- [x] **2.2 Security layer**
  - Token bootstrap: create `~/.c-board/token` (0600, 32 random bytes, base64url) if it's missing. Add `GET /auth?t=` to set an `HttpOnly; SameSite=Strict` cookie (signed) and redirect to `/`. Host-header allowlist and Origin check per PRD §8. Add an auth guard for `/api/*` (except health) that accepts the cookie or the `X-CBoard-Token` header.
  - **Done when:** tests cover a wrong Host (403), a cross-origin request (403), a missing token (401), the cookie flow, and the token header.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: `token.ts` (`ensureToken` creates/reuses `<home>/token`, dir 0700, tightens loose perms, replaces invalid content) and `security.ts` (`registerSecurity`, `request.isAuthorized()`). The cookie is hand-signed (HMAC-SHA256 keyed by the token, so rotating the token invalidates sessions) with no `@fastify/cookie` dependency, and it is a browser-session cookie (no Max-Age), per PRD §8. Absent `Origin` is allowed (curl, hook, extension), and those requests still need the token. Added `CBOARD_DEV_ORIGINS` (comma-separated loopback http origins) to allow the Vite dev server's Host and Origin. `buildServer(config, { token })` skips the token file in tests.

- [x] **2.3 State store**
  - An in-memory `BoardStore` holding `BoardState` with typed mutators (`upsertProject`, `upsertTerminal`, `appendExec`, `setSessionStatus`, …), a change emitter carrying patch ops (from 1.4), and `OutputBuffers` (ring buffer per execution, 2 MB, and per terminal, 8 MB, with seq numbers and a truncated flag). Strip OSC 633 sequences and keep ANSI.
  - **Done when:** unit tests cover the mutators, patch emission, ring-buffer truncation and seq continuity, and OSC stripping.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: `store.ts` (`BoardStore`), `output-buffers.ts` (`OutputBuffers`, stream ids `exec:`/`term:`), `ring-buffer.ts` (byte-capped `RingBuffer`; seqs are assigned by the buffer and keep counting across drops; `read(fromSeq)` reports `truncated`) and `osc.ts` (stateful OSC 633 stripper that handles sequences split across chunks). Patches auto-flush once per microtask (`autoFlush: false` + `flush()` for tests); 2.5 throttles them to ≤ 30/s. `appendExecOutput` ignores replayed sender seqs. Extra: executions are capped at 100 per terminal (oldest dropped with their buffers) so memory stays bounded. `@c-board/protocol` now has `exports` pointing at `src/index.ts`; packaging (2.7) may need a built entry.

- [x] **2.4 Persistence**
  - `node:sqlite` database at `~/.c-board/board.db`, with tables `projects`, `sessions` (metadata only), `activity` (events, 7-day retention, pruned hourly) and `settings` (k/v). Load projects and settings on boot. Write activity asynchronously in batches.
  - **Done when:** tests run against a temp `CBOARD_HOME` and verify persistence across restart and pruning.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: `persistence.ts` (`Persistence`): JSON rows plus indexed columns, schema version in `PRAGMA user_version` (a newer schema refuses to open), WAL, file 0600. Projects, session records and activity are queued and written in one transaction per batch (250 ms or 500 items); settings write immediately. `attach(store)` mirrors store patches: removed projects are deleted, removed sessions keep their history row. `listActivity(query)` is ready for Pulse. Pruning also runs on open. `buildServer` decorates `app.store`, `app.persistence` and `app.settings`; `BuildOptions.dbPath` (`:memory:` in tests). Node 22–25 prints an `ExperimentalWarning` for `node:sqlite`.

- [x] **2.5 UI WebSocket gateway**
  - `/ws/ui` (Origin and cookie checked). On connect, send a `snapshot`, then coalesced `patch` batches (≤ 30/s). Support `subscribe {streamId, fromSeq}`: replay the buffer from seq, then stream live `stream.data`. Add backpressure: if `bufferedAmount` exceeds 4 MB, drop live data for that client and send a `resync` marker. Route `action` messages to a typed action dispatcher (stub handlers for now).
  - **Done when:** integration tests with a real ws client verify the snapshot, patches, subscribe replay and live data, and the origin rejection.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: `ui-gateway.ts` (`UiGateway`, `registerUiGateway`) on `@fastify/websocket` 11, registered before the security layer so rejected upgrades are cleaned up. `/ws/ui` also refuses an absent Origin (browsers always send one) and needs a valid session (cookie or token). Patches are throttled to one batch per 34 ms; a client connecting mid-batch skips ops its snapshot already holds. Backpressure: over 4 MB `bufferedAmount`, every live stream of that client pauses and gets a new `stream.resync {streamId, fromSeq}`; the client re-subscribes from `fromSeq` to replay from the ring (patches keep flowing). Added `action.result {id, ok, error?}` (replies to UI messages that carry an `id`) to the protocol. `actions.ts` has the typed dispatcher with `not_implemented` stubs; `session.send` and `approval.decide` reply `not_implemented` too. `app.uiGateway.broadcast()` is ready for toasts and approvals.

- [x] **2.6 Demo simulator**
  - `--demo` flag and `pnpm dev:demo`. It generates 5 realistic synthetic projects (`acme-shop`, `orbit-api`, `pixel-studio`, `ledger-sync`, `docs-site`) with fake paths under `/home/dev/`, 2–5 terminals each, dev-server logs with ANSI colors (vite, next, rails-ish, jest), occasional crashes and restarts, and listening ports. Claude sessions cycle realistically through the states, with tool activities, streaming assistant text, token counts and todo lists. A permission request appears roughly every 45 s and awaits a decision, and subagents spawn occasionally.
  - The simulator must emit through the **same** store mutators as the real ingest.
  - **Done when:** `pnpm dev:demo` runs, and a test runs the simulator for 30 virtual seconds (fake timers) and asserts that the state contains all entity types.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: `demo/simulator.ts` (`DemoSimulator`, seeded mulberry32 `Rng` so runs are reproducible), `demo/content.ts` (projects, scenarios) and `demo/logs.ts` (next/vite/rails-ish/jest/shell output). `buildServer(config, { demo })` starts it after `ready`, stops it on close, and uses a `:memory:` database so demo data never reaches `board.db`. Activity goes to `persistence.recordActivity`; toasts and `approval.new/resolved` go through `uiGateway.broadcast`. Added a `decideApproval` option to the gateway so `approval.decide` reaches the simulator (undecided approvals expire after 2 min). `server --demo` is parsed with `util.parseArgs`; root `pnpm dev` / `pnpm dev:demo` run the server only until the web app exists.

- [x] **2.7 CLI**
  - A `c-board` bin (in `apps/server`) with `start [--demo] [--no-open]` (starts the server and opens `http://127.0.0.1:<port>/auth?t=…` in the default browser), `doctor` (checks the Node version, port free, token present, hooks installed, extensions connected, the `claude` binary on PATH and its version, and `ANTHROPIC_API_KEY` set → warning), and `token --rotate`.
  - In production the server serves the built `apps/web/dist` statically (SPA fallback). In dev, Vite proxies `/api` and `/ws` to the server.
  - **Done when:** `c-board doctor` prints a readable report, and the tests cover the doctor checks with mocks.
  - **Verify:** `pnpm --filter @c-board/server test && pnpm --filter @c-board/server exec tsx src/cli.ts doctor`
  - Note: `cli.ts` (bin entry) → `cli-app.ts` (`runCli(argv, io)`, injectable for tests; bare flags mean `start`; `pnpm c-board <cmd>` from the root). `doctor.ts` (`runDoctor(config, deps)` + `formatDoctorReport`, all I/O behind `DoctorDeps`; exits 1 only on a failed check). It reads only Claude's `settings.json` (`CLAUDE_CONFIG_DIR` aware) to spot `c-board-hook` commands, and asks a running board for the new authenticated `GET /api/status` (`ServerStatus` in protocol: editors, `hooks.received/lastAt` from `app.hookStats`, which 4.1's ingest must bump). `token --rotate` tells the user to restart; a running server keeps the old token until then. `static.ts` serves `apps/web/dist` (immutable `/assets/`, SPA fallback, `/api`, `/ws` and `/auth` never fall back) only when `index.html` exists and `webRoot` is passed (the CLI passes it; tests don't). The browser opener uses `open` / `xdg-open` / `rundll32` via `execFile`. `main.ts` is gone: `pnpm dev` runs `cli.ts start --no-open`. Limitations: the Vite dev proxy lands with the Vite setup in 3.1, and plain `node dist/cli.js` can't load `@c-board/protocol` (its exports point at TS source) until 10.6 bundles the server.

## Phase 3 — Web foundation (`apps/web`)

- [x] **3.1 Web scaffold and design tokens**
  - Vite 8, React 19, TS, and Tailwind 4 via `@tailwindcss/vite`. Self-hosted Geist and Geist Mono (`@fontsource-variable/*`). Implement every token in DESIGN.md §2 as CSS variables plus a Tailwind `@theme`, with dark default, light via `[data-theme=light]`, and a system option. Add a `motion.ts` with the springs and durations from DESIGN.md §3, plus a `useMotionLevel()` hook (OS preference plus a setting).
  - Dev proxy to the server.
  - **Done when:** `pnpm --filter @c-board/web build` succeeds and a token preview route (`/#/_tokens`) renders all colors, type and status samples.
  - **Verify:** `pnpm --filter @c-board/web build`
  - Note: `styles/tokens.css` (raw CSS variables; light overrides on `[data-theme=light]`; glows via `color-mix`; light status colors are the dark ones with OKLCH L −0.12) and `styles/index.css` (Tailwind `@theme inline`; default palette, fonts, type scale, radii and shadows are cleared so only tokens exist: `bg-bg-1`, `text-text-2`, `text-meta`…`text-hero`, `rounded-chip/control/panel/modal`, `shadow-raised`, plus `glow-st-*`, `glass` and `tabular` utilities). Accent hues 35/50/95/115/135/185/240/295/320/345 (`theme/accents.ts`, `accentVar(path)` via FNV-1a); a test checks each is ≥ 15° from the status hues. Theme and motion settings are localStorage preferences (`prefs.ts`) for now; settings sync can move them server-side. `useMotionLevel()` + `MotionRoot` (MotionConfig `reducedMotion`, `MotionGlobalConfig.skipAnimations` at Off, `data-motion` on `<html>` which kills CSS animations at Off). `/#/_tokens` is a lazy chunk behind a tiny hash switch until wouter (3.3). Dev: root `pnpm dev`/`dev:demo` run server and Vite (127.0.0.1:5173, strict port, honours `CBOARD_PORT`) together; the server dev scripts set `CBOARD_DEV_ORIGINS` inline (POSIX shells only). Biome now parses Tailwind directives.

- [x] **3.1b Demo: negative `rssBytes` drops snapshots**
  - Found while testing 3.1: `demo/simulator.ts` computes `rssBytes` as `(rssMb + rng.int(-30, 60))…`, which goes negative for small `rssMb`. The snapshot then fails `TerminalStats` validation, and `UiGateway.encode` drops it (logged as "dropped invalid ui message"), so roughly 40% of `/ws/ui` connects in demo mode get no snapshot. Clamp at ≥ 0, and add a simulator test that every emitted state passes `BoardState` validation over a 30 virtual-second run.
  - **Done when:** the new test passes and repeated connects in `pnpm dev:demo` always receive a `snapshot` first.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: RSS jitter is floored at half the base size rather than 0, so idle shells never report 0 bytes. Checked 40 sequential connects to a live demo server; each received `snapshot` first.

- [x] **3.2 Data layer**
  - A WS client with reconnect (exponential backoff up to 10 s), snapshot and patch application into a zustand store (using `applyPatch` from protocol), selectors per entity, connection state, and a `useStream(streamId)` hook that delivers chunks to a callback (outside React state).
  - **Done when:** unit tests with a mock WS cover reconnect, resync and patch application.
  - **Verify:** `pnpm --filter @c-board/web test`
  - Note: `src/data/`: `store.ts` (vanilla zustand: `board`, `hydrated`, `connection` {status connecting|syncing|live|reconnecting|stopped, attempt, retryAt, syncedAt}), `client.ts` (`BoardClient` with an injectable socket; backoff 500 ms doubling to 10 s with ≤ 20% jitter, reset only once a snapshot arrives; patches before a snapshot are ignored; every message is zod-decoded and bad ones logged and skipped; refcounted `subscribeStream` that resumes with `fromSeq` after reconnect or `stream.resync`, drops replayed duplicates and flags buffer gaps; `action`/`request` resolve with `action.result`, or `offline`/`disconnected`/`timeout`), `selectors.ts`, `react.tsx` (`BoardProvider`, `useBoard`, `useBoardList` via `useShallow`, `useStream`). `main.tsx` starts the client and reconnects on `online`. Limitation: if the server restarts, stream seqs restart at 0 and a resumed subscription drops them (follow-up: a server boot id in `snapshot` would let the client reset its seqs); zod now ships in the main chunk.

- [x] **3.3 App shell and routing**
  - `wouter` hash routes: `/` overview, `/p/:projectId` focus, `/p/:projectId/s/:sessionId`, `/settings`. AppShell layout: HUD top bar, left project rail (collapsible), main area, and slots for the right sheet and bottom Pulse rail. Base primitives: Button, IconButton, Kbd, Tooltip (Radix), Chip, StatusDot, Skeleton and Toasts (sonner, themed).
  - **Done when:** all routes render with demo data, and keyboard navigation works between rail items.
  - **Verify:** `pnpm --filter @c-board/web build && pnpm --filter @c-board/web test`
  - Note: `routes.ts` (patterns + `projectHref`/`sessionHref`), `App.tsx` (`AppRoutes` inside a wouter `Router`, `useHashLocation` by default; `/_tokens` stays outside the shell), `shell/` (`AppShell` with `sheet`/`pulse` slots, "Reconnecting…" banner and 60% dim while reconnecting, skip link; `Hud` with wordmark, connection dot and theme cycle; `ProjectRail` with one roving tab stop, ArrowUp/Down, j/k, Home/End, collapse via button or `[` (forced icon-only under 768 px, persisted as `cboard.rail`)), `ui/` primitives (server `toast` messages bridge into sonner), `status.ts` (session/project tone, wait > err > work). The overview cards and focus view are interim placeholders until 7.4 and phase 8. Tests: pure rail/status units plus happy-dom render tests of every route and rail key navigation (web vitest now includes `*.test.tsx`). Playwright arrives with 3.4, so screenshots were checked by hand with headless Chrome against `start --demo`. The formal `review-animations`/`impeccable` passes are deferred to the phase 7 tasks; the only motion added here is a CSS tooltip fade-in and the skeleton shimmer, both reduced to a fade or stillness at Reduced.

- [x] **3.4 Playwright harness and screenshot script**
  - Playwright config that boots `c-board start --demo --no-open` on a random port and authenticates through `/auth?t=`. A `pnpm shots` script captures `/`, the focus view and settings at 1440×900, 1920×1080 and 390×844, in dark and light, into `artifacts/shots/` (gitignored). Add one smoke e2e test.
  - **Done when:** `pnpm e2e` passes and `pnpm shots` writes the PNGs.
  - **Verify:** `pnpm e2e && pnpm shots`
  - Note: `e2e/` holds the Playwright config (projects `e2e` and `shots`), a global setup that spawns `tsx src/cli.ts start --demo --no-open` with `CBOARD_PORT=0` and a temp `CBOARD_HOME`, reads the sign-in URL from stdout, signs in through `/auth?t=` and passes origin + cookie to workers via env, and fixtures for a signed-in page with a `theme` option (sets `cboard.theme` and `colorScheme`). `pnpm e2e`/`pnpm shots` build the web app first. Shots are full-page, named `<screen>-<w>x<h>-<theme>.png`. Root `typecheck` now also checks `e2e/`; biome turns off `noEmptyPattern` there (Playwright fixtures need `{}`). CI does not run e2e yet (it would need `playwright install chromium`). One `pnpm check` run failed in vitest once and didn't reproduce in 7 reruns; watch for a flaky unit test.

- [x] **3.5 Brand assets**
  - Per DESIGN.md §4.9: create the `logo.svg` logomark and the `c-board` wordmark component. Add a live SVG favicon driven by the store (idle, waiting with amber dot, error with rose), plus the `(n) c-board` title count. Add a build script that renders `apps/web/public/favicon.png` (32/180 px) and `apps/extension/media/icon.png` (128 px) from the SVG with Playwright. Generated PNGs are build outputs (gitignored), except where packaging requires them.
  - **Done when:** the favicon changes state in demo mode (e2e checks `link[rel=icon]` href changes) and the icon script outputs the PNGs.
  - **Verify:** `pnpm --filter @c-board/web build && pnpm e2e`
  - Note: `pnpm icons` (also run by the web build, skipped when up to date) writes `favicon.png` (32), `apple-touch-icon.png` (180) and `apps/extension/media/icon.png` (128); all gitignored. Without Chromium the build warns and skips them; extension packaging should run `pnpm icons` first.

## Phase 4 — Claude observation (hooks and transcripts)

- [x] **4.1 Hook ingest endpoint**
  - `POST /api/hooks/claude` (token header). Parse with the protocol schemas, then upsert the project (from `cwd`) and the session, and drive the **status state machine** (PRD §4.2) in a pure, unit-tested `sessionReducer(session, event)`. Record the current tool (name plus a short summary of `tool_input`, such as the command, file path or pattern), the last assistant message (from `Stop.last_assistant_message`), and the error (`StopFailure`). Respond 204 quickly; the processing is async.
  - **Done when:** the reducer table tests cover every transition, and an endpoint test using fixtures updates the store.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: Code is in `apps/server/src/claude/` (`session-reducer.ts`, `hook-ingest.ts`). Events are applied in arrival order through a queue. A cwd maps to the deepest known project that contains it; if none does, a `hook` project is created at the cwd's realpath (no git-root detection yet). The route expects `Content-Type: application/json` (body limit 4 MB), so the 4.2 script must send that header. Activity rows keep `tool_input` with strings clipped to 1 000 chars. In demo mode hooks are counted but not applied. Limitation: terminal sessions get no hook when a permission is granted, so they stay `waiting_permission` until the tool's PostToolUse arrives. `toolFamily()`/`toolInputDetail()` moved into protocol (the demo uses them too).

- [x] **4.2 Hook script**
  - `packages/hook/bin/c-board-hook` in POSIX sh, per the PRD §6.1 "Observer hook contract". Reads `CBOARD_HOME` (default `~/.c-board`) and `CBOARD_PORT`, sends `X-CBoard-Claude-Pid: $PPID`, uses `curl -s -m 1`, stays silent on stdout, and always exits 0. Run shellcheck if it's available.
  - **Done when:** a test runs the script against a local test server and receives the payload and headers. With the server down, it exits 0 within about 1.2 s and prints nothing. With no token file, it exits 0 immediately.
  - **Verify:** `pnpm --filter @c-board/hook test`
  - Note: the token header is passed to curl through a here-doc on fd 3 (`-H @/dev/fd/3`) so it never appears in `ps`; curl runs with `-q --noproxy '*'`. shellcheck was not installed, so its test is skipped here.

- [x] **4.3 Hook installer**
  - `c-board hooks install|uninstall|status [--dry-run] [--yes]`, implemented in `packages/hook/src/installer.ts` and wired into the CLI. It merges into `~/.claude/settings.json` (path overridable through `CLAUDE_CONFIG_DIR` or a `--settings-path` flag for tests). It registers the observer hook (`"async": true`) for the events listed in PRD §6.1, except `PermissionRequest`. It's idempotent, keeps every other key and hook untouched, makes a timestamped backup, prints a diff for `--dry-run`, and refuses to write if the existing JSON is invalid.
  - **Done when:** tests on temp files cover a fresh install, an install over existing third-party hooks, a second install (no change), uninstall (restores exactly the other hooks), and invalid JSON (refused).
  - **Verify:** `pnpm --filter @c-board/hook test`
  - Note: the handler command is the absolute path of `packages/hook/bin/c-board-hook` (shell-quoted if needed), with `async: true` and `timeout: 5`. An event counts as installed only with exactly one c-board handler of that shape; otherwise install replaces ours in place and leaves third-party groups where they are. Uninstall removes every c-board handler, including an away-mode `PermissionRequest` one, and drops the `hooks` key if it ends up empty. The file is rewritten with 2-space JSON (atomic rename, same mode), and the write is refused if the file changed between planning and writing. Without `--yes` it asks on a TTY and refuses when there is none. `claudeSettingsPath` now lives in `@c-board/hook` (doctor reuses it).

- [x] **[HUMAN] 4.4 Install hooks on your machine**
  - Run `pnpm --filter @c-board/server exec tsx src/cli.ts hooks install --dry-run`, review the diff, then run it without `--dry-run`. Start the server (`pnpm dev`), use Claude in any project, and check that `c-board doctor` reports hook events received. Then tick this box.

- [x] **4.5 Transcript reader**
  - `TranscriptService`: on session upsert, load history through the SDK's `getSessionMessages(sessionId, { dir: cwd })` (fall back to defensive JSONL parsing). Tail `transcript_path` for live increments (chokidar 6 with an fs offset). Normalize to `ChatMessage[]` (user text, assistant text, thinking, tool_use with input, tool_result linked by id, and usage). Compute tokens used and approximate context size per session. Expose it as a stream `transcript:<sessionId>`.
  - **Done when:** tests use synthetic JSONL fixtures (including unknown line types and a truncated last line) and verify normalization and incremental tail.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: code is in `apps/server/src/claude/` (`transcript-normalize.ts`, `jsonl-tail.ts`, `transcript-service.ts`); `ChatMessage` and the `transcript:<sessionId>` stream helpers live in `protocol/src/transcript.ts`. A `ChatMessage` is one content block (not one API message) so the stream stays append-only; assistant blocks carry `messageId` for grouping. Each `stream.data` chunk is one `ChatMessage` as JSON (8 MB ring per session; use `decodeChatMessage`). SDK history (checked against 0.3.308: it reads the local JSONL offline and drops `isMeta` lines) is followed by a tail from the last complete line, and lines are de-duplicated by uuid. An empty SDK result or an error falls back to the raw file. Without a `transcript_path`, the path is derived from the cwd under `CLAUDE_CONFIG_DIR`/`~/.claude/projects`. Tokens count the latest usage per message id; context ≈ the latest usage's input + cache read + cache creation + output. Sidechain lines are skipped. Not started in demo mode.

- [x] **4.6 Live-session discovery**
  - On boot and every 10 s, read the optional `~/.claude/sessions/*.json` registry (feature-detected, try/catch per file, and only the fields listed in PRD §6.4). For each entry, check that the process is alive (`process.kill(pid, 0)`). Upsert sessions with origin `terminal`, so sessions that started before c-board still appear. Mark them `ended` when the process is gone. Also list recent sessions per known project through the SDK `listSessions({ dir, limit: 20 })` for history.
  - **Done when:** tests with a temp registry dir cover alive, dead and malformed files.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: `claude/session-discovery.ts` (`SessionDiscovery`, `app.sessionDiscovery`, off in demo). Registry entries are parsed with `SessionRegistryEntry` (protocol; extra fields dropped, bad optional fields read as absent; registry `status` `busy`→working, `idle`→idle). Hooks win: the registry only fills null fields and sets status while no hook has touched the session since its last write. A dead pid ends the session only if its `claudePid` matches; dead files for unknown sessions are ignored; a new pid on an ended session counts as a resume. The project lookup moved to `claude/project-lookup.ts` (shared with hook ingest). History: `listSessions({ dir, limit: 20 })` per project, cached 60 s, read via `history(projectId)` / `loadHistory(projectId)` as `SessionHistoryEntry` (protocol); no HTTP/WS route yet, 7.12 wires it. Server tests set `CLAUDE_CONFIG_DIR` to a temp path so they never read the real `~/.claude`.

## Phase 5 — Editor extension (`apps/extension`)

- [x] **5.1 Extension scaffold**
  - `package.json`: `name: c-board`, `publisher: c-board`, `engines.vscode: ^1.93.0`, `@types/vscode@1.93.0`, `activationEvents: ["onStartupFinished"]`, `main: dist/extension.js`, `icon: media/icon.png` (from task 3.5). Settings `cboard.enabled` and `cboard.port`. Commands `c-board.openDashboard` and `c-board.reconnect`. Build with esbuild to a single CJS file (`vscode` external), and `package` via `@vscode/vsce` to `dist/c-board.vsix` (no `repository` warnings; include a LICENSE placeholder note if LICENSE is missing).
  - Isolate pure logic in `src/core/*` (no `vscode` import) so it can be unit tested.
  - **Done when:** `pnpm --filter c-board-extension package` produces a `.vsix`.
  - **Verify:** `pnpm --filter c-board-extension build && pnpm --filter c-board-extension package`
  - Note: The manifest `name` is `c-board-extension` (display name `c-board`, so the ID is `c-board.c-board-extension`), because the root workspace package is already called `c-board` and the Verify filter targets `c-board-extension`. The package has no `"type": "module"`, so `dist/extension.js` loads as CJS (the Vitest config is now `.mts`). `package` builds a minified bundle, renders `media/icon.png` if it is stale (`--strict`, so it needs Playwright Chromium), then runs `vsce --no-dependencies --allow-missing-repository --skip-license`. The repo has no LICENSE yet, and the extension README says so. `c-board.reconnect` only logs until 5.2 adds the server link. CI now uploads `apps/extension/dist/*.vsix`.

- [x] **5.2 Server connection**
  - A core `EditorLink` class: reads the token from `~/.c-board/token`, connects to `ws://127.0.0.1:<port>/ws/editor` with the token header, sends `editor.hello` (windowId = uuid persisted in `context.workspaceState`, `vscode.env.appName`, version and workspace folders), runs a heartbeat every 10 s, reconnects with backoff, and queues messages while offline (capped). Server side: an `/ws/editor` handler that registers windows and projects in the store and removes them on disconnect (after a 15 s grace period).
  - Status bar item: `$(pulse) c-board` with a connected/disconnected tooltip, which runs `openDashboard` on click (`vscode.env.openExternal` of the auth link).
  - **Done when:** unit tests run EditorLink against a fake server (hello, reconnect, queue cap), and a server test covers window registration and removal.
  - **Verify:** `pnpm --filter c-board-extension test && pnpm --filter @c-board/server test`
  - Note: Extension: `core/editor-link.ts` (`EditorLink`, uses `ws` because the editor's Node 20 has no WebSocket client that can set headers), `core/token.ts` (`CBOARD_HOME` or `~/.c-board`, token re-read on every attempt) and `core/status.ts`. Backoff is 0.5 s doubling to 30 s with ±25 % jitter; the queue holds at most 1 000 messages / 4 MB (oldest dropped) and is cleared when the link stops. Each heartbeat also sends a ws ping; a missed pong terminates the socket and reconnects. Empty windows (no folders) get a fresh windowId per activation, since they share one workspaceState. Folder changes re-send `editor.hello`. Server: `editor-gateway.ts` (`app.editorGateway`); the token must be in the header (a cookie isn't enough). A newer connection for the same windowId closes the old one with `EDITOR_CLOSE_REPLACED` (4001, protocol), and the extension then stops retrying until `c-board.reconnect`. Sockets silent for 35 s are dropped. Disconnect removes only the window (and its terminals) after the 15 s grace; projects stay, since they're persisted. Workspace folders become `editor` projects via `ensureProject` (a `hook` project at the same path is promoted). In demo mode sockets are accepted but ignored. Messages other than hello/heartbeat are logged and skipped until 5.3/5.4. The bundle is ~510 KB minified, mostly zod from `@c-board/protocol`.

- [x] **5.3 Terminal inventory**
  - Track `window.terminals` with stable ids (a WeakMap Terminal→uuid). Send `terminal.upsert` (name, processId, cwd from `shellIntegration?.cwd`, creationOptions name, state, exitStatus) on open, close, state change, shell-integration change and active change. Send a full resync after reconnect.
  - Server side: a terminal reducer, linking each terminal to its project by the cwd prefix or the window's folder.
  - **Done when:** core logic tests use a fake terminal model, and server reducer tests pass.
  - **Verify:** `pnpm --filter c-board-extension test && pnpm --filter @c-board/server test`
  - Note: Extension: `core/terminal-tracker.ts` (`TerminalTracker`, generic over a `TerminalLike` so tests use plain objects). Ids are random per activation (WeakMap), so a reloaded window gets new ids; the full list goes out as a new protocol message `terminal.sync {terminals[]}` (added to PRD §7) on every connect, and the server removes that window's terminals missing from it. The pid is resolved once and upserted again when known. cwd is the shell-integration cwd, else the creation-options cwd; only local absolute paths are sent. Upserts also fire on `onDidEndTerminalShellExecution`, since 1.93 has no cwd-change or rename event. Server: pure `terminal-reducer.ts` (`terminalReducer`, `linkTerminalProject`: deepest known project containing the realpath'd cwd, else the window's first folder; a missing pid/cwd keeps the known value). `terminal.closed` keeps the terminal as `closed`; events for another window's terminal are ignored. `deepestProject()` now lives in `claude/project-lookup.ts`. Closed terminals are only dropped by a sync or window removal.

- [x] **5.4 Execution streaming**
  - On `onDidStartTerminalShellExecution`: send `exec.start` and **immediately** start `for await (const chunk of execution.read())`. Feed a core `ChunkBatcher` (flush at 50 ms or 16 KB, with seq numbers). On end, send `exec.end` with `exitCode`. Detect alt-screen (`\x1b[?1049h`) and mark the execution `interactive`. Capability check: if `onDidStartTerminalShellExecution` is undefined, report `capabilities.shellExecution=false` in the hello.
  - Server side: an exec reducer plus output buffers, and streams `exec:<execId>` and `term:<terminalId>` (concatenated executions).
  - **Done when:** batcher tests (timing with fake timers, size flush, ordering) and server stream tests pass.
  - **Verify:** `pnpm --filter c-board-extension test && pnpm --filter @c-board/server test`
  - Note: Extension: `core/chunk-batcher.ts` (`ChunkBatcher`, splits input above 16 KB of UTF-8 without breaking code points), `core/alt-screen.ts` (`?1049h`, `?1047h` and `?47h`, also when split across chunks) and `core/exec-streamer.ts` (`ExecStreamer`, generic over an `ExecutionLike`). `exec.end` waits for `read()` to drain, at most 1 s after the end event; a closed terminal or deactivation ends its executions with a null exit code. Alt-screen is reported as a new protocol message `exec.interactive {execId}` (added to PRD §7), flushed after the output that precedes it, and stored as `Execution.interactive`. The hello now carries `capabilities {shellExecution}`, stored on `EditorWindow.capabilities`; without the API only the inventory is mirrored. Server: `exec-reducer.ts` (`applyExecEvent`) on top of the existing store and `OutputBuffers` (`exec:`/`term:` rings); events for another window's terminal, replayed seqs and data after the end are ignored. A new `exec.start` or a closed terminal ends a still-running execution with a null exit code. The gateway records `exec.start`/`exec.end` activity. The demo marks its `claude` executions interactive.

- [x] **5.5 Remote commands**
  - The extension handles `cmd.sendText`, `cmd.interrupt` (`sendText('\x03', false)`), `cmd.createTerminal` (create, show, and run the command through `shellIntegration.executeCommand` once integration activates, falling back to `sendText` after 3 s), `cmd.focusTerminal`, `cmd.disposeTerminal` and `cmd.rerun`. Each replies with `cmd.result`.
  - Server side: typed actions from the UI become routed editor commands with an ack and a 5 s timeout. Add an `editorRouter` that picks the window owning the terminal or project.
  - **Done when:** routing, ack and timeout tests pass on the server, and the command handler is unit tested with a mocked vscode facade.
  - **Verify:** `pnpm --filter c-board-extension test && pnpm --filter @c-board/server test`
  - Note: Extension: `core/command-handler.ts` (`CommandHandler`, generic over an `EditorFacade`, so tests use a mocked facade). Terminals are looked up by `TerminalTracker.find` (open terminals only). `cmd.rerun` reruns from `ExecStreamer.lookup`, which remembers the last 500 executions of this activation, so an execution from before an editor reload answers `unknown_execution`. A rerun goes through `shellIntegration.executeCommand` when active, else `sendText`. `cmd.createTerminal` shows the new terminal and replies once its command has been dispatched (≤ 3 s, inside the server's 5 s timeout). Server: `editor-router.ts` (`EditorRouter`: terminal → owning window; project → connected window with it as a folder, else the deepest containing folder, ties to the most recently seen), `editor-actions.ts` (the six `terminal.*` UI actions, now the default handlers instead of stubs) and `EditorGateway.sendCommand`/`isConnected`. Errors are codes: `unknown_terminal`, `terminal_closed`, `unknown_execution`, `unknown_project`, `no_editor`, `editor_offline`, `editor_timeout`, `editor_disconnected`, `nothing_to_rerun`. A `cmd.result` is only accepted from the connection the command went to. In demo mode the actions answer `editor_offline`, since demo windows have no socket.

- [x] **[HUMAN] 5.6 Install the extension in Cursor**
  - Run `pnpm --filter c-board-extension package && cursor --install-extension apps/extension/dist/c-board.vsix`, then reload every Cursor window (Cmd+Shift+P, "Developer: Reload Window"). Start `pnpm dev`, run something in a terminal, and confirm it shows up in `c-board doctor` and the UI. Note any Cursor-specific quirks under this task, then tick it.
  - Notes: installed from the .vsix and reloaded the windows; doctor shows 3 Cursor windows connected. No Cursor-specific quirks so far.

## Phase 6 — Processes, ports, git, linking

- [x] **6.1 Process and port scanner**
  - `ProcessScanner`: every 2 s, run `ps` (via `execFile`) to build a pid tree. Every 5 s, run `lsof -nP -iTCP -sTCP:LISTEN -F pcn` (Linux fallback `ss -ltnp`). Aggregate CPU and RSS per terminal subtree and attach listening ports to terminals and projects. Diff before mutating the store, so nothing changes when nothing changed.
  - **Done when:** parser tests run on captured synthetic outputs for macOS and Linux, and aggregation tests pass.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: `ps` runs without `etime` (unused); Linux uses `ps -eo …,args=`. CPU is rounded to 0.1 % and RSS to 64 KiB so sampling noise doesn't produce patches. Ports of processes outside a terminal get no project (no cwd lookup). Server tests that build a real server pass `processes: false`. The hook package's 500 ms timing test is occasionally flaky under full-suite load (also seen on the baseline with another test).

- [x] **6.2 Session ↔ terminal linking**
  - Using `X-CBoard-Claude-Pid` and the pid tree, walk the ancestors until one matches a terminal `processId`. Set `session.terminalId`, and re-evaluate when terminals or processes change. Also map `~/.claude/sessions` registry pids the same way.
  - **Done when:** tree-walk tests cover a direct child, an intermediate `sh`, and no match.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: `terminalForPid` (in `processes.ts`) walks the ppid chain to the nearest open terminal's shell (loop-guarded). `session-linker.ts` (`SessionLinker`, `app.sessionLinker`) runs after every ps sample (new `ProcessScanner` option `onSample`) and on the microtask after any terminal or session patch (except stats). Registry pids are covered because discovery already writes them to `claudePid`. A pid not in the latest sample keeps its last link (so a short-lived hook `sh` that is gone by the next sample doesn't unlink); ended sessions are never relinked (pid reuse); a link to a removed terminal is cleared. Linking never moves `updatedAt`. Off in demo mode and with `processes: false`.

- [x] **6.3 Git info**
  - Per project, every 5 s while connected UI clients exist (and on hook `PostToolUse` for Edit/Write/Bash), run `git status --porcelain=v2 --branch` and `git log -5 --format=…` through `execFile`. Fill `GitInfo` (branch, upstream ahead/behind, changed files with status, last commits). Skip non-git folders.
  - **Done when:** parser tests on synthetic porcelain output pass.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: `GitInfo` gained `upstream`, `files` (path, origPath, status, staged/unstaged; capped at 200, `dirty` counts all) and `commits` (5, newest first), defaulted so older `board.db` rows still parse. `git.ts` parses `status -z` and `log -z`; `GitScanner` (`app.gitScanner`) runs git with `-C`, `--no-optional-locks` and `core.fsmonitor=false` (repo config can't spawn programs), writes only on change, rechecks non-git folders every 60 s, and turns off if git is missing. Hook refreshes (Edit, MultiEdit, Write, NotebookEdit, Bash) are debounced 250 ms and run even without UI clients. One test runs real git in a temp repo. The demo board has synthetic files and commits. Not ticked: the hook package's 500 ms timing test (`c-board-hook.test.ts`, missing token) kept failing `pnpm check` at 510 to 1020 ms. It failed on the baseline (6.2) in the same runs, and the 6.3 changes passed the full suite 3 out of 3 when the machine was quieter. Re-run `pnpm check` and tick once it passes.

## Phase 7 — Signature UI (build against `pnpm dev:demo`)

For every task in this phase: follow DESIGN.md exactly, run `pnpm shots` after implementing, **look at the screenshots** (Read the PNGs), and fix anything that fails the DESIGN.md §9 checklist before ticking.

- [x] **7.1 Ambient field**
  - `AmbientField`: a WebGL fragment shader per DESIGN.md §4.1 with `uEnergy`/`uAttention` uniforms derived from the store, 0.5× DPR, a 30 fps cap, pause when hidden, a CSS fallback, motion-level aware, and a grain overlay.
  - **Done when:** it renders in demo mode, energy visibly responds (a debug slider is available in `/#/_tokens`), and Reduced mode is static.
  - **Verify:** `pnpm --filter @c-board/web build && pnpm shots`
  - Note: mounted once in `App` (so `/#/_tokens` gets it too). Reduced/Off and no-WebGL use the static CSS field; energy and attention only cross-fade it. Throughput is derived from `Execution.outputBytes` deltas sampled at 4 Hz. Pods carry `data-pod` so the amber bloom finds the waiting project (falling back to its rail link).

- [x] **7.2 Shared animation scheduler and ClaudeOrb**
  - A single rAF scheduler (`useFrame(cb, {visible})`) with IntersectionObserver gating. `ClaudeOrb` on canvas implements every state in DESIGN.md §4.2, including tool-family particle colors, subagent satellites, the waiting ripple and countdown ring, and the error glitch. Add a showcase on `/#/_tokens` with every state side by side.
  - **Done when:** the showcase renders all states, and the scheduler is unit tested (registers, unregisters, pauses).
  - **Verify:** `pnpm --filter @c-board/web test && pnpm shots`
  - Note: idle orbs breathe with a CSS transform and register no frame callbacks (DESIGN.md §4.10); error and ended draw once. Added `--orb-*` family tokens, an `expand` effect so leaving compacting eases back to size, and ✕ / ! glyphs on error and waiting orbs ≥ 36 px as the non-color cue (§8).

- [x] **7.2b Crew mascot**
  - `CrewMascot` per DESIGN.md §4.11: an original SVG character built from part groups, with every state in the table (sleeping, idle, watching, thinking, typing, reading, running, delegating, waiting, error, done) as Motion variants. Blended transitions, per-instance randomized blinks and look-arounds, three sizes (24/56/120 px) with the detail rules, the session color on the visor and antenna (the antenna tip is `ClaudeOrb`), a mini-crew subagent pop-in and pop-out, pausing when off screen, and static poses for Reduced and Off. Add a pure `mascotStateFor(session, terminals)` mapping with unit tests. Add a "character sheet" on `/#/_tokens` showing every state at every size, with a state switcher. Use the `animate` and `apple-design` skills, and run `review-animations` on it before finishing.
  - **Done when:** the character sheet screenshot shows every state clearly distinguishable at 56 px, the mapping tests pass, and 30 mascots on screen keep 60 fps (Playwright FPS sample).
  - **Verify:** `pnpm --filter @c-board/web test && pnpm shots && pnpm e2e`
  - Note: `crew/` (`CrewMascot`, `model.ts` with `mascotStateFor(session, terminals, {now, previous})`, `poses.ts`). Poses blend through Motion variants (`spring.smooth`); the repeating loops (breathing, taps, scanning, scrolling, z, flicker) are CSS keyframes, paused via `data-crew-paused` off screen and dropped at Reduced, so 30 mascots cost no per-frame JS beyond the antenna orbs. `CrewTerminal` takes optional `streaming`/`lastOutputAt`, which 7.13 fills from activity levels. A project without a session is watching, idle (activity in the last 5 min) or sleeping. Tools map edit/todo → typing, read/search/web → reading, bash → running, task → delegating, others → thinking; a failed tool while working counts as error. "done" comes from `previous` and settles into idle after 1.4 s; the `settle={false}` prop holds one-shots for the sheet. Mini crew pop-in starts at scale 0.4 (not 0, per review-animations). New token `--crew-visor`. The character sheet is on `/#/_tokens`; the e2e FPS sample measured 60 fps with 30 mascots.

- [x] **7.3 Sparkline, TerminalLane, PortChip**
  - A canvas `Sparkline` (60 samples, slide-in, accent tint, rose on error), `TerminalLane` (name, command, sparkline, port chips, uptime, exit badge, streaming "comet" border, aligned columns), `PortChip` (click copies `localhost:port`, hover shows the process), and `TerminalPeek` (a live 6-line output preview on lane hover or focus, per DESIGN.md §4.3).
  - **Done when:** the lanes render in the demo with correct alignment across pods (screenshot check).
  - **Verify:** `pnpm shots`
  - Note: `lanes/`. One `ThroughputSampler` per store samples each watched terminal's `outputBytes` once a second (timer stops with the last watcher) and backfills the first 60 s from execution timings, so sparklines aren't flat after a load. The sparkline redraws once per sample and slides one step via WAAPI `transform`, so it needs no per-frame callbacks. Lanes are fixed grid tracks (`.lane-row`, slimmer under a 22rem container) and select a flat execution view, so streaming bytes don't re-render them. The peek is an overlay below the lane (`pointer-events: none`, opaque) fed by `term:<id>` through a small ANSI tail parser (`ansi.ts`), flushed at most every 100 ms; clicking the lane name pins it. `ProjectCard` is now an `article` with a stretched name link so port chips and lanes stay clickable, and it must not clip overflow (7.4: keep the spotlight in an inner clipped layer). Extra ports collapse into `+N` on the first chip. Not done: "the last error line slides into the caption" (§4.10) needs output without a peek subscription, so it moves to 7.13 with activity levels. New shots: `lanes-*.png`, `lane-peek-*.png`.

- [x] **7.4 ProjectPod and PodGrid (overview)**
  - Pod anatomy per DESIGN.md §4.3: accent hairline, header (avatar ring, name, branch, dirty, ahead, and the project's 56 px crew mascots per §4.11), SessionRows (orb, typewriter status text, last-line shimmer, tokens) and TerminalLanes. Cursor spotlight and lift on hover. The border takes the priority status color. `PodGrid` is responsive (1/2/3/4 columns), with attention-first ordering animated via `layout` and a staggered enter.
  - **Done when:** the overview looks finished in demo mode at all three widths, in dark and light.
  - **Verify:** `pnpm shots && pnpm e2e`
  - Note: `pod/` (`ProjectPod`, `SessionRow`, `PodGrid`, `Typewriter`, `model.ts`, `useMascotState`); `ProjectCard` is gone. No hover lift: DESIGN.md §4.3 says "no lift or scale" and wins over the plan. The spotlight moves by transform on its own clipped layer, only on fine pointers. Attention-first means waiting, then errors, then by name; working/idle don't reorder, so pods don't reshuffle every turn. Columns follow the grid's container width (1/2/3/4 at 40/66/96 rem), so 1920 gets 4 next to the rail. The stagger plays once per page load. Header crew: one per live session (max 3, room kept for mini crew), or one for the project. `useMascotState` holds "done" for `DONE_MS`. Captions come from status + `currentTool.summary` and type in by per-character CSS delay; 7.13 adds the slide-swap and activity-driven states. The 30-mascot FPS sample was flaky under parallel e2e load on the 7.3 baseline too (45–56 fps), so it now runs alone first in a `perf` Playwright project that `e2e` depends on. Same test, same 55 fps bar. New shots: `overview-waiting-*.png`.

- [x] **7.5 HUD**
  - Top bar with `NumberTicker` rolling-digit counters (Working, Waiting, Running, Errors, Tokens today), a connection dot with a reconnect state, a ⌘K hint, motion-level and theme toggles, and a "Waiting" click that opens the Attention Center.
  - **Done when:** the counters animate on demo changes, and the disconnect state is visible when the server is killed (e2e).
  - **Verify:** `pnpm e2e && pnpm shots`
  - Note: `ui/NumberTicker` (0–9 strips per digit moved by `spring.smooth`, keyed from the right, no roll on mount) and `shell/counts.ts` (`selectHudCounts`). Working = working/tool/compacting; Running and terminal errors follow the lanes (`laneView`); Errors also counts sessions in error; "tokens today" sums the totals of sessions updated since local midnight (no per-day token history exists). The Waiting count toggles a minimal in-memory `AttentionCenter` sheet (`attention/`, right sheet or bottom sheet under 768 px) that lists waiting sessions and links to them; 8.4 adds the approval cards. The ⌘K hint is display-only until 7.10. While reconnecting, the dot gets a spinning ring (still at Reduced) and the counters grey to 60 % with `main`. The e2e boot moved to `e2e/board.ts` (`startDemoBoard`) so the disconnect test kills its own server. New shots: `hud-*.png`, `attention-*.png`, `hud-reconnecting-1440-dark.png`.

- [x] **7.6 Focus view and shared-element transition**
  - Route `/p/:id`: a `layoutId` transition from the pod (container, header, orb), with the backdrop dimmed and blurred. Three-column resizable layout (sessions + git | Claude panel | terminal stack), spring-snapped resize handles, and persisted sizes per project (localStorage, wrapped in try/catch). Back with Esc.
  - **Done when:** the transition is smooth in both directions and the layout is correct at 1440 and 1920 (stacked tabs at 390).
  - **Verify:** `pnpm shots && pnpm e2e`
  - Note: `focus/` (`FocusStage`, `FocusView`, `ResizableColumns`, `layout.ts`, `shared.ts`). The overview stays mounted under the focus card (`FocusBackdrop`: opacity 0.35 + blur 6 px, inert, `aria-hidden`), so the pod is there to morph from and back into and the overview keeps its scroll. It is offstage while covered: a new `OffstageContext` makes `useInView` report hidden (orbs, sparklines and mascots stop) and CSS keyframes pause. The card, header and session orbs share `layoutId`s with the pod; pods use a fixed `layoutDependency` so their own re-renders don't play layout animations, and a returning pod is raised over its neighbours. No morph on a direct load of the route or below Full motion (Motion still painted one frame at the pod's box at Reduced). Columns: 280 / rest / 420 px by default, the Claude panel keeps ≥ 360 px, released handles spring (`snappy`) to snap widths within 28 px, sizes persist as `cboard.focus.<projectId>`; handles are keyboard separators (arrows, Shift, Home/End, Enter or double-click resets). The release spring animates `grid-template-columns`, a layout property: a transform would distort the columns' content. Under 1024 px the columns become tabs (Claude first). Esc goes back unless a text field, the Attention Center or a lane peek has it; focus lands on the heading, and back on the pod's link. The columns' contents are interim (git summary, session details, lanes) until 7.7, 7.8 and 7.12. `Sparkline` now measures its layout size (`offsetWidth`), since `getBoundingClientRect` picked up the morph's scale. New shots: `focus-enter-mid-*`, `focus-exit-mid-*`, `focus-handle-hover-*`.

- [x] **7.7 Terminal stack (xterm)**
  - `XtermView` using `@xterm/xterm` 6 with the fit, webgl (with fallback) and search addons, themed from tokens and using the Geist Mono font. It subscribes to `term:<id>` with replay. Input goes to `cmd.sendText`, and the toolbar has Ctrl+C, re-run, focus-in-Cursor, search and clear-view. Tabs, a 2×2 grid toggle, and maximize. Interactive (alt-screen) executions show an "Interactive app, open in Cursor" placeholder card. Dispose the renderer on hidden tabs.
  - **Done when:** an e2e test types into a demo terminal and sees the echo, and a crash shows the exit badge.
  - **Verify:** `pnpm e2e && pnpm shots`
  - Note: `terminal/` (`TerminalStack`, `XtermView` lazy-loaded into its own chunk, `stack.ts`, `theme.ts`). Tokens are resolved through a probe element and a 1×1 canvas, because computed `color-mix()` comes out as `color(srgb …)`, which xterm doesn't parse; the theme follows `data-theme`. The renderer is WebGL, falling back to DOM on failure or context loss (`data-renderer`). The xterm itself is a read-only mirror (`disableStdin`): input goes through a command line under it (Enter → `terminal.sendText` with execute, ↑/↓ history, ⌃C interrupts), because VS Code's execution stream never contains what is typed at the prompt. Hidden tabs unmount their xterm. The stack keeps every terminal's stream subscribed, and `BoardClient` now keeps up to 2 M chars of recent history per open stream, which it replays to listeners that join late (cleared at a gap), so a remounted pane gets its output back. Renderers mount 550 ms after a pod morph, otherwise the morph lost frames under e2e load. The server now writes a dim `$ command` line into `term:<id>` before each execution (`commandHeader`, control characters flattened); `exec:` streams are unchanged. The layout (tabs / 2×2 grid) is a global preference. Maximize covers the other columns (Esc restores first); it is hidden in the narrow tab layout. Up to 4 closed terminals stay as tabs. Demo mode: `DemoSimulator.terminalActions()` echoes typed commands (`echo`, `pwd`, `true`, `false`, `exit N`, the scripted commands, else 127), handles Ctrl+C (exit 130; Claude only prints a hint) and reruns; create and close still answer `editor_offline`. `ExitBadge` moved to `ui/`. New shots: `terminals-{tab,search,interactive,grid,maximized}-*.png`.

- [x] **7.8 Claude panel: message list**
  - Render the transcript stream: user bubbles, assistant markdown (react-markdown, no raw HTML, shiki code blocks with the theme matched to tokens), collapsible thinking, and a streaming caret glow. Use virtualization (`@tanstack/react-virtual`) with stick-to-bottom behaviour and a "jump to latest" pill.
  - **Done when:** a long demo transcript (500+ messages) scrolls smoothly, with no long tasks over 50 ms (Playwright performance check).
  - **Verify:** `pnpm e2e`
  - Note: `claude/` (`ClaudePanel`, `MessageList` lazy-loaded into its own chunk, `Markdown`, `transcript.ts`, `useTranscript`, `highlight.ts` + `highlight.worker.ts`). Demo mode now serves `transcript:<id>` streams (`demo/transcripts.ts`, wording from a separate seeded Rng so the simulation's sequence is unchanged); the first acme-shop session gets an 800-entry history (~550 rows, tool results fold into their calls). Shiki runs in a module worker (JS regex engine, grammars loaded on demand, `worker.format: 'es'`), with a css-variables theme whose `--shiki-*` tokens map onto ours; blocks render plain until highlighted. Stick-to-bottom uses the virtualizer's `anchorTo: 'end'` + `followOnAppend`, with a few frames of re-aiming after a jump while rows measure. The streaming tail is `session.lastAssistantText` while working and not yet in the transcript, with a CSS caret glow (static at Reduced). Tool calls are interim one-line rows until 7.9. The panel defers its stream subscription until the morph settles (`MORPH_SETTLE_MS`, now shared with the terminal stack). The transcript e2e tests run in order in a `perf-messages` project before the parallel suite: in parallel they took enough CPU to make the 7.6 morph sample flaky. Perf result: 0 long tasks over a full scroll to the top and back. New shots: `claude-latest-*`, `claude-history-*`.

- [x] **7.9 Tool cards and diff view**
  - `ToolCard` variants: Bash (command plus collapsible output plus exit status), Edit/MultiEdit/Write (`DiffView`, unified/split toggle, using `diff` and shiki highlighting), Read/Grep/Glob (compact chips with path and line counts), TodoWrite (animated checklist), Task/subagent (nested thread, collapsible), WebFetch/WebSearch (URL chips), and an unknown-tool fallback (pretty JSON). Enter animation per DESIGN.md.
  - **Done when:** every variant appears in a demo transcript and in the `/#/_tokens` showcase.
  - **Verify:** `pnpm shots`
  - Note: `claude/tools/` (`ToolCard`, `DiffView`, `diff.ts`, `results.ts`, `viewState.tsx`). Tool inputs are parsed by zod schemas in `protocol/src/tools.ts` (`parseToolCall`, lenient; malformed input gets the generic JSON card). Diffs use `diff` 9 (`diffLines` with `maxEditLength`, word marks via `diffWordsWithSpace` on lines similar enough to be edits), shiki tokens split at the mark edges; Edit line numbers come from the numbered snippet in Claude Code's result, and are left out when ambiguous. Unified/split is a global preference (`cboard.diff.layout`); pure additions/removals stay unified. Long diffs clamp to 18 rows ("Show N more"). Read/Grep/Glob/WebFetch/WebSearch are chips that open a preview; Bash opens its output on failure; Task is a collapsed nested thread (prompt + result markdown): the transcript stream carries no subagent messages, so the thread is the call and its final answer. TodoWrite checks draw in (pathLength) only for items finished since the previous list, and fade at Reduced. Open/closed state survives virtualization (`ToolViewState`). Demo transcripts now carry realistic results plus TodoWrite, MultiEdit, Write and an MCP tool (`mcp__tracker__create_ticket`), drawn from the text RNG so the simulation's sequence is unchanged. The terminal-stack shot is now `test.slow()`: with the new shots running in parallel it crossed 30 s. New shots: `tool-cards-{dark,light}`, `tool-cards-open-*`, `tool-cards-enter-mid`.

- [x] **7.10 Command palette**
  - cmdk in a glass modal (⌘K / Ctrl+K). Groups Projects, Sessions, Terminals and Actions (new board session in project, interrupt session, approve all waiting in project, re-run last command, toggle motion, toggle theme, open settings, open project in Cursor). Fuzzy match highlighting and shortcut hints.
  - **Done when:** an e2e test opens the palette, navigates to a project and runs an action.
  - **Verify:** `pnpm e2e`
  - Note: Own fuzzy matcher (word starts and runs, highlighted) with cmdk's filtering off. Project actions target the focused project; from the overview they appear per project once you type. Terminal sessions are interrupted with Esc sent to their terminal; session.create, session.interrupt and project.openInEditor still answer "Not available yet" until Phase 8 wires them.

- [x] **7.11 Pulse rail**
  - A bottom collapsible timeline with a 15-min window, project lanes, event dots colored by type that fly in, hover tooltips, click to navigate, filters (Claude, terminals, errors), all on canvas for performance.
  - **Done when:** it renders in the demo, and clicking a dot navigates.
  - **Verify:** `pnpm shots && pnpm e2e`
  - Note: activity events had no path to the UI. Added an `activity` server→UI message (the 15-min window replayed after the snapshot, then live batches at the patch rate) and a synthetic 15-min backfill in the demo. Toggle from ⌘K ("Toggle the Pulse timeline"); dots are keyboard-navigable (arrows, Home/End, Enter).

- [x] **7.12 Git panel and session history**
  - `GitPanel` (branch, ahead/behind, changed files grouped by status, last 5 commits). `SessionHistory` per project (SDK-backed list with AI title, date, tokens), with actions "Resume in board" (wired in Phase 8) and "Resume in Cursor" (`cmd.createTerminal` with `claude --resume <id>`).
  - **Done when:** both render with demo data, and the "Resume in Cursor" action is routed (server test).
  - **Verify:** `pnpm shots && pnpm --filter @c-board/server test`
  - Note: `git/` (`GitPanel`, `model.ts`) and `history/` (`SessionHistory`, `api.ts`, `model.ts`) in the focus view's left column, under the live sessions. History comes from a new authenticated `GET /api/projects/:id/sessions` (`SessionHistoryResponse`), served from `SessionDiscovery`'s cached SDK listing (`freshHistory`, 60 s TTL); the demo serves synthetic past sessions. The SDK listing has no token usage, so `SessionHistoryEntry.tokens` is filled from live sessions and the database (`Persistence.sessionTokens`) and is null otherwise. "Resume in Cursor" is a new `session.resumeInEditor` action → `cmd.createTerminal` with `claude --resume <id>`; ids must match `RESUMABLE_SESSION_ID` (no shell syntax can reach the terminal). It answers `editor_offline` in demo mode, like terminal creation. "Resume in board" sends `session.resume` (still "Not available yet" until Phase 8). Row actions float over the row end on hover/focus where hover exists, and stay inline on touch. New shots: `git-history-{dark,light}`, `git-history-390-dark`.

- [x] **7.13 Activity animation system**
  - Per DESIGN.md §4.10: per-entity activity levels in the store (a decaying event rate), crew mascot states wired to live session and terminal data (including subagent mini-crews), the live session caption (action text from hook tool events, slide-swap plus shimmer), terminal lane activity (pulse speed and comet tied to output rate, crash state), the pod activity border (rotating light, speed ∝ activity), hairline event particles, a one-time "turn done" sweep, idle dimming, and the focus-view header caption with elapsed time and inline Allow / Deny. Idle entities register no frame callbacks.
  - **Done when:** in demo mode, busy, idle, waiting and crashed projects are distinguishable at a glance in the screenshots. An e2e test with fake timers checks that the done sweep plays once and that idle pods dim after 5 minutes. Reduced mode shows no movement.
  - **Verify:** `pnpm e2e && pnpm shots`
  - Note: carried over from 7.3: on a crash, slide the last error line into the lane's command caption (§4.10). 7.3 already has the pulse speed (`rateLevel`) and comet from the lane's own `ThroughputSampler`; switch them to the store's activity level here.
  - Note: done: lane pulse and comet now read the store's activity level (`rateLevel` removed; the sampler still feeds the sparkline). A crashed lane's error line comes from its execution's `exec:` stream and takes the sparkline and port tracks while shown.
  - Note: "crashed" = an open terminal whose newest command exited non-zero (Ctrl+C/130 excluded), so a failed test run also turns its pod rose (without reordering it). The demo gained a quiet sixth project (`field-notes`) and a `storybook` server that crashes once and stays down, so each state is on screen.
  - Note: the focus header caption shows from `md` up; on phones the Attention Center carries Allow / Deny. Motion's WAAPI fades don't follow Playwright's fake clock, so the dim e2e finishes the fade before reading the opacity.

- [x] **7.14 Worst-case data pass (break-ui)**
  - Use the `break-ui` skill on ProjectPod (including 6+ sessions, which means 6+ mascots), SessionRow (very long captions), TerminalLane, TerminalPeek, ApprovalCard and the HUD. Add a `?worst=1` demo variant (very long project names, branches and commands, 0 and 99+ sessions or terminals, huge token counts, non-Latin text, emoji, missing fields) and fix everything that breaks.
  - **Done when:** the screenshots of `?worst=1` at all widths show no overflow, overlap or broken alignment.
  - **Verify:** `pnpm shots`
  - Note: `?worst=1` only does something on a `--demo` server: the page passes it to `/ws/ui`, which then serves a separate, mostly static worst-case board (`apps/server/src/demo/worst.ts`). Shots: `worst-*` at 1920/1440/1024/390/320 in both themes.
  - Note: Fixed: billions shown as "11479M" and 999,949 as "1000k" (`formatCount` now has B/T), emoji names broke the avatar initial (now grapheme-based, skips emoji), the wordmark wrapped at 320 px, the header crew covered the name and git line in narrow pods (the crew thins out and git counts drop away using container queries), unnamed terminals showed a blank label, a long project name hid the session title in the Attention Center, the crash dot pushed 3-digit exit badges out of their track, and RTL assistant lines now get `dir="auto"`.
  - Note: ApprovalCard doesn't exist yet (8.4), so the Attention Center rows were checked in its place. The header crew is still capped at 3 (`MAX_CREW`), so 6+ sessions show 3 mascots plus "N more sessions". On phones, lane names are cut off at the end ("worker-12…"), so similar names look the same; the full name is in the tooltip and the focus view.

- [x] **7.15 Motion review pass**
  - Run `review-animations` across `apps/web/src`, then `find-animation-opportunities` for the overview and focus views. Apply the fixes and opportunities that fit DESIGN.md §3–4 (reject the rest, with a one-line reason in a Note). Recheck Reduced/Off motion levels.
  - **Done when:** the review comes back without blocking issues, and the motion levels still behave as specified.
  - **Verify:** `pnpm e2e && pnpm shots`
  - Note: Fixed: the HUD digit roll, Attention sheet, orb tool chip and exit badge now animate full transform strings instead of Motion's `x`/`y`/`scale` shorthands, so they stay on the compositor while the board streams. Reduced handles them explicitly because Motion's reduced mode only skips the shorthand keys. The exit badge starts at 0.9 (was 0.8). At Off the sheet mounts at rest, with no frame at opacity 0. Hardcoded beziers and built-in `ease-*` keywords now use the `--ease-out`/`--ease-in-out` tokens. New e2e test: the Attention sheet slides at Full, only fades at Reduced, and appears at once at Off.
  - Note: Rejected: the ⌘K palette animation is keyboard-triggered, but DESIGN §4.8 specifies it, so it stays (already 120 ms). Pod grid entrance and crew prop/mini-crew scales keep their shorthands: one shares its element with `layout` projection, the others are SVG groups using `transform-box`. Backdrop dim (420 ms) and ambient fades (0.6–1.2 s) stay over 300 ms because they are large-surface or ambient state, not responses to input. Opportunity sweep of overview and focus found nothing that passed the gate: the remaining instant swaps (git counts, elapsed time, history rows) are data the user reads.
  - Note: Follow-ups seen in shots, not caused by this pass: at 390 a Sonner toast covers the Attention bottom sheet. `focus.spec` "pod morphs" sometimes counts only 4 distinct widths under load; it also fails on the unchanged code. Other AnimatePresence entrances may still show one frame of their `initial` state at Off.

- [x] **7.16 Impeccable design critique**
  - Run an `impeccable` critique and audit of the overview, focus view, Attention Center and settings, using the screenshots plus the code. Fix the top issues (hierarchy, spacing, typography, contrast, states) without leaving DESIGN.md's direction. If more than about 10 issues remain, add follow-up task `7.16b`.
  - **Verify:** `pnpm shots && pnpm check`
  - Note: The critique ran as two isolated passes: a design review of the screenshots and code, and the `impeccable detect` scan. The review scored 29/40 and found 19 issues. The detector found nothing, but it only matches source text and can't check contrast or rendered sizes.
  - Note: Fixed:
    - Light-theme status text was 2.2–2.7:1. New `--st-*-ink` tokens (the status colour in dark, darker in light, ≥4.7:1 on every light surface) are now used for every `text-st-*`; dots, borders and glows keep the status colour. Light `--text-3` is now `#5f6573` (5.1:1 on `--bg-2`).
    - The reconnect banner pushed the layout down 32px. It is now a glass overlay, and the rail and Pulse grey out along with main (§6 "nothing jumps").
    - Settings ignored its max width: `cx` doesn't merge classes, so `max-w-[1600px]` won. Fixed with `Page width="narrow"`, plus clearer descriptions in text-2.
    - Lanes no longer sit at the bottom of the pod (`mt-auto` removed), which left large gaps in equal-height rows.
    - Session rows hide "0 tok".
    - All three focus-column titles share a 28px `ColumnHeading` row (with an `actions` slot), so they line up.
    - Toasts sit above the Pulse rail: AppShell publishes `--pulse-h`.
  - Note: Tried a 340px default for the terminal column to give the Claude panel more room. Reverted: the 2×2 terminal grid broke at that width (the interactive placeholder overlapped its tile header).
  - Note: e2e on a heavily loaded machine (load ~30): each full run failed 1–3 different timing-sensitive tests (pod morph widths, pulse oldest-dot hover, grid lefts mid-reorder), and each passed when re-run alone or with `--repeat-each`. One full run passed clean. The pulse test hovers the oldest dot, which can age out of the 15-min window before the hover lands.

- [x] **7.16b Design critique follow-ups**
  - Remaining issues from the 7.16 critique, all within DESIGN.md's direction:
    - (a) Dark `--text-3` `#6B7183` is 4.0:1 on `--bg-1` and 3.8:1 on `--bg-2`, below AA for 11–12px meta. Either change the DESIGN-specified hex (e.g. `#7A8093`, needs maintainer sign-off) or move information-bearing meta to text-2.
    - (b) Dimmed pods (opacity 0.7) put meta text at ~2.5:1: dim only the non-text layers.
    - (c) The Pulse rail defaults to expanded and takes ~22% of a 900px-tall or phone viewport: collapse it by default on short or narrow screens.
    - (d) At 1440 the Claude panel is ~430px, so titles and code clip: give the terminal column a width-relative default, and fix the 2×2 grid's narrow tiles first.
    - (e) The terminal stack opens on a terminal it can't mirror ("Interactive app" placeholder): prefer an xterm-mirrorable terminal when there's no explicit choice.
    - (f) Rail status dots and the HUD below `lg` are colour-only (§8): add a shape or icon.
    - (g) Crash toast copy ("Tests failed / tests") lacks the project and exit code: fix server-side.
    - (h) Interim Attention Center rows show no tool payload, and the sheet covers the third pod column without a scrim (full cards are 8.4).
    - (i) Identical idle rows ("Idle / No reply yet"): show the start time or a short id.
    - (j) The pod skeleton doesn't match the real pod (56px crew, lane rows).
    - (k) Off-scale radius and spacing leftovers (`rounded-[4px]` in ToolCard and PulseRail, 10/14px steps).
    - (l) The pulse e2e test's oldest-dot hover is timing-sensitive.
  - **Verify:** `pnpm shots && pnpm check`
  - Note: (a) The DESIGN hex for dark `--text-3` is unchanged (it needs maintainer sign-off). Information-bearing meta moved to text-2 instead: git lines, token counts, last assistant lines, idle captions, lane commands and uptime, history and commit meta, Pulse counts and times, column and page meta, and empty states. text-3 stays only on icons, placeholders, path prefixes beside a file name, and kbd hints.
  - Note: (b) Quiet pods keep opacity 1. Only `.pod-dim` layers (avatar, crew, orbs, sparklines, lane dots) fade to 70%, through a CSS transition (800 ms out, 120 ms back). (c) The Pulse preference now defaults to `auto`: collapsed below 960px tall or 768px wide, until the user toggles it. (d) Columns nobody has resized follow `defaultSizes(width)` (terminal column 30% of the body, between 300 and 520px; left column 240 below a 1280px body). Only the column that was resized is saved. Grid tiles get a compact interactive card that can't overflow its header.
  - Note: (e) Without a choice, the stack prefers a mirrorable terminal. If an interactive app starts in the auto-picked terminal, the stack moves on to another one. (f) StatusDot and the HUD use shaped marks: wait is a ring, err a diamond, ok a square, idle a small dot. (g) Demo crash, test-failure and Claude-error toasts name the project and the exit code. (h) Attention rows show the request's payload (relative to the project), and a scrim behind the sheet closes it on click. (i) Untitled rows with no reply show "Started 14:05 · <short id>". (l) The pulse test clicks a dot five steps back from the newest instead of the oldest.
  - Note: e2e at load 27–38: the full run failed only `focus.spec` "pod morphs" and `overview.spec` grid columns (mid-reorder). The unchanged code (stashed and rebuilt) failed the morph test 5/5 under the same load, so the failures come from load, not from this change. The focus tests now expect the width-relative defaults. `pnpm shots` passed 67/67 on one run. On the next run, three shots timed out at load 38 and passed when re-run.

## Phase 8 — Act: headless sessions and approvals

- [x] **8.1 SessionRunner (Agent SDK)**
  - `apps/server/src/claude/runner.ts`: `startSession({projectId, prompt, model?, permissionMode?})` and `resumeSession(sessionId)`, using `query()` in streaming-input mode (an async queue), `cwd` = project path, `includePartialMessages: true`, and default `settingSources`. Map the `SDKMessage`s (`assistant`, `user`, `result`, `system/session_state_changed`, `stream_event` partials) into the store and transcript stream. Controls: `send`, `interrupt`, `setModel`, `setPermissionMode` and `close`. Expose them as UI actions.
  - Tests mock the SDK module (never call the real API in tests).
  - **Done when:** mocked-SDK tests cover start, multi-turn send, partial streaming, interrupt and resume.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: New sessions get their id up front (`sessionId` option), so the store and transcript stream exist before the SDK answers. SDK messages feed the transcript stream through `TranscriptService.claim/feed/release` (the file isn't tailed while the runner owns the session; tailing resumes from the file's end after close). Prompts are echoed into the transcript by the runner, since the SDK doesn't echo them.
  - Note: Partial text streams into a new optional `ClaudeSession.draft` field (throttled to 50 ms, cleared when the block's assistant message lands). The UI doesn't render it yet: that's 8.3. `session.resume` gained an optional `projectId` so the history browser can resume sessions the board hasn't seen live. A non-fork resume of a live terminal session is refused (`session_live`); `send` to a stopped board session resumes it first.

- [x] **8.2 Approvals via canUseTool**
  - The `canUseTool` callback creates an `Approval` (tool, input, suggestions, blockedPath) and awaits the UI decision, honouring `signal` abort. Decisions: allow once, always (returns `updatedPermissions` from `suggestions`), or deny with a message. There's a configurable timeout (default none for board sessions). Add `approval.new` and `approval.resolved` messages.
  - **Done when:** tests cover allow, always, deny, abort and concurrent approvals.
  - **Verify:** `pnpm --filter @c-board/server test`
  - Note: `approval.new`/`approval.resolved` already existed in the protocol; `Approval` gained optional `suggestions` and `blockedPath`. When the SDK sets `suppressAlwaysAllowRule`, suggestions are dropped, so "Always" acts as allow once. Aborts, timeouts (`approvalTimeoutMs`, default none) and closed sessions resolve as `expired` and deny the call. A session with several pending approvals points its `waiting_permission` status at the oldest one. Resolved approvals leave the store after 60 s, like demo ones. Hook approvals (away mode) don't route through `approval.decide` yet.

- [x] **8.3 Composer and board-session UX**
  - Claude panel composer: multiline (Enter sends, Shift+Enter adds a newline), model pill, permission-mode pill, interrupt (Esc) and send button with a "sending" morph. "New session" in a project. Board sessions get a distinct badge from terminal sessions. For terminal-origin sessions the composer shows "Resume here (fork)", which uses `forkSession` and warns if the original is still live.
  - **Done when:** an e2e test (demo mode with a mocked runner) starts a session, sends, sees streaming and interrupts.
  - **Verify:** `pnpm e2e`
  - Note: The "mocked runner" is the real `SessionRunner` over a scripted `createDemoQuery` (`apps/server/src/demo/demo-query.ts`), feeding `DemoTranscripts`. So `--demo` now runs board sessions too: a Read tool call on the first turn, then a streamed reply. Interrupts keep the text written so far, and forks copy the parent's transcript. `action.result` gained an optional `sessionId` (the session `session.create` or a fork started), so the UI navigates to it.
  - Note: Board sessions stream from `session.draft`. "New session" (the + in the Sessions column) swaps the Claude panel for a new-session composer. A project with no session shows it directly. The model and permission pills are native selects behind a pill face. They change a live session through `session.setModel`/`setPermissionMode` and are disabled once it has ended or errored. The model pill offers the aliases opus/sonnet/haiku. Not yet in ⌘K: New session.
  - Note: e2e at load ~30–35: `composer.spec` passed on every run. Across full runs, the only failures were the known load-sensitive `focus.spec` morph and `messages.spec` long-task tests, and both pass when run alone.

- [x] **8.4 Attention Center**
  - Right sheet per DESIGN.md §4.5. It collects approvals from every source, with keyboard shortcuts A, ⇧A and D, a deny reason input, collapse on resolve, a toast plus an `aria-live` announcement on new items and an optional browser Notification (permission asked in Settings).
  - **Done when:** an e2e test approves a demo request with the keyboard.
  - **Verify:** `pnpm e2e && pnpm shots`
  - Note: Pending approvals (SDK and hook) render as `ApprovalCard`s: a highlighted command, a unified mini diff for Edit/MultiEdit/Write, or the main argument. Sessions that wait without a decidable approval (a reply is due, or a terminal asks in its terminal) are listed below under "Answer in the session". ↑↓ and J/K move the selection. "Always allow" (⇧A) is disabled when the request carries no suggestions. A decided card shows its outcome and a check sweep for 700 ms, then collapses, while the selection moves on at once. The toast has a "Review" action, isn't shown while the sheet is open, and is dismissed when the approval resolves.
  - Note: Settings is still a route (the sheet is 8.5), so the Notifications on/off row lives in `SettingsView`. Turning it on asks for browser permission. Notifications show only while the tab is hidden or unfocused.
  - Note: at load 30–40, the full `pnpm e2e` failed only the known `focus.spec` morph test, and `pnpm shots` timed out on two shots (focus transition, claude panel messages). All three pass when re-run alone.

- [x] **8.5 Settings and onboarding**
  - The Settings sheet covers theme, motion level, notifications, redact secrets, away mode (Phase 9), hooks status plus an install button (calls the installer with a confirm dialog showing the diff), connected editor windows, data retention, and token rotate.
  - The onboarding wizard (shown when there are no hook events and no editors connected) follows DESIGN.md §6, with live auto-ticking steps and copyable commands.
  - **Done when:** the e2e onboarding flow ticks steps from simulated events.
  - **Verify:** `pnpm e2e && pnpm shots`
  - Note: Settings stays a routed page (`#/settings`), now grouped into sections. New authenticated routes: `GET/PUT /api/settings` (activity retention 1/7/30/90 days, applied live), `GET /api/hooks`, `POST /api/hooks/plan` (diff plus a fingerprint) and `POST /api/hooks/install` (409 if settings.json changed since the plan), and `POST /api/token/rotate` (swaps the token live and re-issues this browser's cookie; refused in demo mode). Demo mode uses a synthetic in-memory settings.json. `/api/status` gains `setup.{hookSeen,editorSeen}`, persisted, so the guide only shows on a truly empty board; `#/welcome` (Settings, ⌘K) opens it on demand. The redact toggle only stores the preference until 8.6; away mode is shown disabled until 9.1. The e2e onboarding test runs a non-demo board with a throwaway `CLAUDE_CONFIG_DIR`. The composer shots flake on a clean `main` too (shared demo board state).

- [x] **8.6 Secret redaction**
  - A shared `redact()` (patterns per PRD §8.7) applied in the UI to terminal lines (an xterm write filter), tool cards and messages when the setting is on, with a "reveal" per block on click.
  - **Done when:** unit tests cover the patterns (including no false positives on ordinary hashes and UUIDs).
  - **Verify:** `pnpm --filter @c-board/web test`
  - Note: `apps/web/src/redact/`. Terminals hold an unfinished line for at most 40 ms while it is checked, and reveal per pane from the toolbar (the pane replays unmasked); messages, tool cards and approval payloads reveal per row. Peeks and lane error lines are masked too. Demo data has no secrets, so the reveal buttons don't appear in `pnpm shots`. Four shots timed out once under load in a full run; the same tests pass alone at baseline timings.

## Phase 9 — Stretch: away mode and terminal reply

- [x] **9.1 Away-mode permission hook**
  - Re-verify the `PermissionRequest` hook input and decision-output schema at https://code.claude.com/docs/en/hooks and record the verified shape in a code comment with the date. Implement `c-board-hook --permission` (sync) per PRD §6.1, plus the server endpoints `GET /api/away` and `POST /api/hooks/permission` (long-poll). The installer adds the `PermissionRequest` entry only through `hooks install --away`.
  - **Done when:** script tests cover away off (instant exit, no output), away on plus decision, and timeout (no output).
  - **Verify:** `pnpm --filter @c-board/hook test && pnpm --filter @c-board/server test`
  - Note: The hook output schema was re-verified on 2026-10-22 and is recorded in `packages/protocol/src/hooks.ts` and the script header. Away mode is a server setting (`awayMode`, `awayTimeoutSec` 10–300 s, default 120), and the Settings toggle is now live. A request becomes a `source: 'hook'` approval in the Attention Center. When the hook process exits (the user answered in the terminal) or the board stops, the approval expires and the terminal prompt stays. The installer writes the `PermissionRequest` handler with `timeout: 330` and no `async`.

- [x] **9.2 Reply into terminal sessions (experimental)**
  - For terminal-origin sessions with a linked terminal and status `waiting_input` or `idle`, the composer offers "Send to terminal" (`cmd.sendText`, execute=true), behind the setting `experimental.terminalReply`.
  - **Done when:** the routing test passes and the UI flag hides and shows the control.
  - **Verify:** `pnpm --filter @c-board/server test && pnpm e2e`
  - Note: The flag is a server setting (stored as `experimental.terminalReply`, `experimentalTerminalReply` in `/api/settings`, off by default), toggled under Settings → Experimental. A new action `session.replyInTerminal {sessionId, text}` (`terminal-reply.ts`) checks the flag and `terminalReplyBlock()` (protocol, shared with the UI), then goes through `terminal.sendText`, so it routes like the board's terminal input (the demo simulator in `--demo`). Errors: `terminal_reply_disabled`, `unknown_session`, `not_terminal_session`, `no_linked_terminal`, `session_busy`, `empty_reply`. The text is sent as one line: control characters, newlines included, become spaces, so nothing submits early or drives the TUI. The web app now shares server settings through `settings/boardSettings.ts`.
  - Note: The control sits on top of the terminal session's fork bar whenever the flag is on. Outside idle or waiting-for-input it stays visible but can't send, with a hint, so it doesn't flicker with the session status. The e2e test only toggles the control: sending waits on the demo's turn timing, so routing is covered by the server tests (unit plus a socket-to-socket test). The composer fork shot now picks a terminal session (parallel shots start board sessions). New shots: `composer-terminal-reply-*`. At load 35–45, `pnpm e2e` failed only the known `messages.spec` long-task test, `focus.spec` (both also fail on a clean `main`) and `onboarding.spec` (passes alone).

## Phase 10 — Layouts: Minimal, Office, Grid, Transit, Retro

Spec: DESIGN.md §10. Build against `pnpm dev:demo`. For every task in this phase: run `pnpm shots` and **look at the screenshots** (Read the PNGs) before ticking; use `frontend-design` + `emil-design-eng` for the look, `animate` + `apple-design` for motion, and Context7 for `three` APIs. Every layout must keep the same statuses, chrome and actions as Minimal.

- [ ] **10.1 Layout framework and Actor inspector**
  - `selectSceneModel` (pure, unit tested): projects → actors (Claude session, subagent, terminal) with kind, state (crew states plus `serving`/`exited` for terminals, from a new `opsStateFor(terminal, executions)`), activity level, label, caption and links, attention-first order. A `layouts/` registry (`minimal`, `office`, `grid`, `transit`, `retro`), each a lazy-loaded overview component; the current overview becomes `minimal` with no visual change. The `cboard.layout` preference (via `createPreference`), the switcher in Settings → Appearance, ⌘K actions "Layout: …", `⌥1`…`⌥5`, and a cross-fade between layouts (`dur.slow`, instant at Off).
  - `ActorInspector`: the shared popover from DESIGN.md §10.1 (Radix popover, anchored, keyboard reachable) with Open, Focus in Cursor, Ctrl+C and Allow/Deny. Deep links `/p/:projectId/s/:sessionId` (exists) and a new `/p/:projectId/t/:terminalId` that opens the focus view with that terminal's tab active. Wire the inspector into Minimal too (clicking a lane's crew/session orb).
  - Office, Grid, Transit and Retro start as placeholders ("coming soon" cards listing the scene model) so the switcher works end to end.
  - **Done when:** model and `opsStateFor` tests pass, switching layouts works from Settings, ⌘K and shortcuts, survives a reload, and the inspector's actions work in e2e on Minimal.
  - **Verify:** `pnpm --filter @c-board/web test && pnpm e2e && pnpm shots`

- [ ] **10.2 Office: art kit and ops crew**
  - Original SVG components per DESIGN.md §10.3: room shell (back wall, floor, door with nameplate and door light, ceiling light, window), desk + monitor, side desk, server rack (LED rows driven by a 0..1 rate prop), workbench + progress screen, couch, bookshelf, whiteboard (todo lines with draw-in checks, plus a drawing pose for a crew member standing at it), port sign, plant. `OpsMascot`: the crew's sibling (rectangular visor, headset) with the states idle, running, serving, done, error, waiting as Motion variants and CSS keyframes, reusing `CrewMascot`'s part structure, sizes (24/56/120), randomized idles and pausing rules. Add an "office kit" sheet to `/#/_tokens` showing every prop and every ops state at every size, in dark and light. Run `review-animations` on the ops crew.
  - **Done when:** the kit sheet screenshots show every ops state clearly distinguishable at 56 px in both themes, and ops state tests pass.
  - **Verify:** `pnpm --filter @c-board/web test && pnpm shots`

- [ ] **10.3 Office: building overview**
  - The building per DESIGN.md §10.3: rooms on floors (responsive columns, attention-first, `layout` re-order), one room per project with stations laid out from the scene model, characters at their stations (crew at desks, mini crew at the side desk, ops crew at racks/benches/couch, the bookshelf and whiteboard trips from DESIGN.md §10.3, max 8 plus a "+N" badge), door light, ceiling light following activity (dim after 5 min), whiteboard and port sign. Characters **walk** between stations on state changes (600–900 ms, leg swing; cross-fade at Reduced). Hover name tags with live captions; click a character → `ActorInspector`. Night/Daylight building backdrops; the ambient field is unmounted in this layout.
  - **Done when:** the overview reads correctly in demo mode at 390/1440/1920 in dark and light (screenshots), the same demo moment shows the same amber/rose cues as Minimal (e2e compares counts), and characters pause offscreen.
  - **Verify:** `pnpm shots && pnpm e2e`

- [ ] **10.4 Office: room view**
  - Click or Enter on a room → zoom the building layer into it (transform only, `smooth`, ~500 ms), characters at 120 px with full props, and a side panel listing every actor with its caption and inspector actions. "Open workspace" cross-fades to the focus view; Esc zooms back out and restores focus on the room. Keyboard per DESIGN.md §10.1 (Tab between rooms, arrows between characters). Reduced: cross-fade instead of zoom.
  - **Done when:** e2e enters a room, opens a terminal's inspector, opens the workspace, and returns with Esc to the same room; mid-zoom screenshots look right.
  - **Verify:** `pnpm e2e && pnpm shots`

- [ ] **10.5 Grid: 2D network map**
  - The SVG version of the Grid layout per DESIGN.md §10.4 "2D map": core, nodes on a ring (attention-first clockwise), straight pipelines, satellites per actor, CSS-animated packets driven by activity (rate ∝ throughput, tool-family bursts, green return pulse on turn done), amber beacon and pulse for waiting, rose glitch for errors, crisp labels. `--grid-*` tokens (bg, neon, fog) for dark and light. Narrow (390 px): a vertical list of nodes on one trunk. Click a satellite → `ActorInspector`; Enter on a node → a flat cockpit (DESIGN.md §10.4 step 3, laid out as a 2D arc of screens) with a cross-fade. This is the Grid layout at Reduced motion, without WebGL and on narrow screens.
  - **Done when:** the map and flat cockpit render in demo at all widths and themes, packets visibly follow activity, and nothing flashes faster than 3 Hz.
  - **Verify:** `pnpm shots && pnpm e2e`

- [ ] **10.6 Grid: 3D network**
  - Add `three` (current stable; check with Context7 and npm) to `apps/web`, loaded only in the Grid chunk. `GridRenderer` (imperative class, subscribes to the scene model): perspective floor grid with horizon fog, the core, hexagonal nodes with status edge light and activity height, satellites with sub-pipes, curved tube pipelines, instanced packets (max 400), amber beacons, rose glitch, scanline overlay. Labels and captions via `CSS3DRenderer` (or projected DOM), never canvas text. Camera: slow idle orbit that stops on hover, drag to rotate, clamped zoom, double-click to reset. One WebGL context (ambient field unmounted), DPR ≤ 1.5, paused when hidden or offstage. Falls back to the 10.5 map when WebGL is unavailable or the motion level is Reduced/Off.
  - **Done when:** the 3D overview renders in demo at 1440/1920 in both themes, `--demo-stress` keeps ≥ 55 fps on it (Playwright FPS sample), and disabling WebGL in the test shows the 2D map.
  - **Verify:** `pnpm shots && pnpm e2e`

- [ ] **10.7 Grid: dive and cockpit**
  - Enter a node: camera flies along its pipeline (~900 ms, `ease.inOut`), other nodes fade into fog, then the phase-in (scanline sweep + brief chromatic split resolving, ~400 ms, no full-screen flash). The cockpit: the project's screens in an arc via CSS3D (Claude screen center with live messages and caption, terminal screens with live tails, ports and uptime, small git/ports/todo screens above). Click a screen → it flies to center and becomes interactive (one xterm at a time); "Open workspace" → focus view. Esc steps back (screen → arc → reverse dive). Keyboard reachable throughout.
  - **Done when:** e2e dives into a node, centers a terminal screen, sends a command and sees the echo, and backs out with Esc twice; mid-dive and cockpit screenshots look right.
  - **Verify:** `pnpm e2e && pnpm shots`

- [ ] **10.8 Transit layout**
  - The metro map per DESIGN.md §10.5: one line per project over the last 60 minutes, trains per actor (glide, park, amber doors, rose stop), stations from the activity history the Pulse rail uses (turn done, exit ✓/×, commit, crash), subagent branch lines, horizontal time scroll with "now" pinned, station merging when crowded, click a train → `ActorInspector`, vertical lines at 390 px. SVG, transforms only.
  - **Done when:** the map reads correctly in demo at 390/1440/1920 in both themes, and an e2e test clicks a station and lands on its event.
  - **Verify:** `pnpm shots && pnpm e2e`

- [ ] **10.9 Retro layout**
  - The CRT console per DESIGN.md §10.6: box-drawing frames per project on a character grid, status tags, ASCII sparklines, blinking cursor on working items, typed captions, number shortcuts, scanlines, vignette and phosphor glow in CSS, the amber-phosphor option in Settings, and the paper variant for Daylight. Fits 20 projects at 1440 × 900.
  - **Done when:** screenshots show aligned columns with 20 projects (`--demo-stress`) in both themes, and the number shortcuts work in e2e.
  - **Verify:** `pnpm shots && pnpm e2e`

- [ ] **10.10 Layouts review pass**
  - For Office, Grid, Transit and Retro: `review-animations` (read its SKILL.md), an `impeccable` critique of each overview and enter view, `break-ui` with worst-case data (20 projects, a room with 12 actors, very long names, no terminals, only errors), and a `--demo-stress` FPS check of every layout (≥ 55 fps, no long tasks over 50 ms). Add the DESIGN.md §10.5 checks to the shots review. Fix what is found (up to 10 issues; add `10.10b` for the rest).
  - **Verify:** `pnpm check && pnpm e2e && pnpm shots`

- [ ] **[HUMAN] 10.11 Try the layouts**
  - Run `pnpm dev:demo` (and `pnpm dev` for your real projects), switch between all five layouts, and write any feedback as new tasks below this one before ticking it.

## Phase 11 — Quality, docs, release

- [x] **11.1 Performance pass** (committed as 10.1)
  - Add a `--demo-stress` mode (10 projects × 6 terminals, 2 terminals at about 200 lines/s each, and 4 Claude sessions doing roughly 5 tool calls per second), with every activity animation running. Write a Playwright perf test that measures FPS (rAF sampling over 10 s) and long tasks on the overview and focus views. Optimize until it reaches ≥ 55 fps and has no long tasks over 50 ms (PRD §9). Record the numbers under this task.
  - **Verify:** `pnpm e2e --grep @perf`
  - Note: Ran before the layouts phase existed. 10.10 re-checks every layout under `--demo-stress`.
  - Note: Numbers (an M-series Mac, `e2e/stress.spec.ts`, 1440×900, motion Full, 10 s rAF sampling). Before: overview 52 fps with 54 long tasks; focus view (log firehose tab open) 33 fps with 3 long tasks (up to 82 ms) on the headless shell. After: overview 60.0 fps, focus 59.8–60.0 fps, no long tasks over 50 ms. Main thread in the focus view went from about 62% to 33% busy.
  - Note: Fixes: the overview subscribed to whole project objects for a count, so every activity patch re-rendered the pod grid, whose `layout` slots then re-measured every pod (about 20×/s each); it now reads a count, and the slots measure only on a reorder (`layoutDependency`). The overview under the focus view now reads a frozen board (`FrozenBoard`) that catches up when it is shown again; before, its pods restyled and repainted under the blur many times a second.
  - Note: The stress tests run in their own `perf-stress` project on full Chromium (`channel: 'chromium'`), which renders with the GPU. The default headless shell uses SwiftShader (software WebGL), where the WebGL terminal and the shaders stall compositor commits; that says nothing about the PRD §9 machine. Server CPU (PRD §9) is not measured by this test.
  - Note: Flaky under parallel load on main before this task, too: `onboarding.spec` (extension step), `attention.spec` (keyboard approval) and the `composer` shots. They pass when run alone.

- [ ] **11.2 Accessibility pass**
  - Add `@axe-core/playwright` checks on every route and every layout (Minimal, Office, Grid, Transit, Retro) (0 serious or critical issues). Run keyboard-only e2e tests through the main flows, and verify reduced motion.
  - **Verify:** `pnpm e2e --grep @a11y`

- [ ] **11.3 Security review**
  - Audit against PRD §8: Host and Origin checks, the token on every route, `execFile`-only usage (`grep -rn "exec(" apps` returns nothing unsafe), no raw HTML rendering, no credential-file reads (`grep -rn "credentials" apps packages`), the hook script being silent, and the installer's backups. Fix the findings and list them under this task.
  - **Verify:** `pnpm check`

- [ ] **11.4 Visual polish sweep**
  - Run `pnpm shots` and review every screenshot against DESIGN.md §9, using `impeccable` polish and `web-design-guidelines`. Fix up to 10 issues per iteration; if more remain, add a follow-up task `11.4b` below this one.
  - **Verify:** `pnpm shots`

- [ ] **11.5 README and docs**
  - Write a public README: hero screenshot or GIF (captured from demo mode only), one shot per layout, features, how it works (diagram), requirements, install (clone, `pnpm i`, `pnpm build`, `c-board hooks install`, install the vsix), privacy statement ("runs locally, uses your own Claude Code login, no telemetry"), uninstall (`c-board hooks uninstall`, remove the extension, `rm -rf ~/.c-board`), troubleshooting (`c-board doctor`), and contributing. Add `docs/ARCHITECTURE.md` from PRD §5–7.
  - **Verify:** `scripts/privacy-check.sh && pnpm check`

- [ ] **11.6 Release packaging**
  - Add a `pnpm build` that bundles the server (esbuild) with the web dist and a `bin` entry, so that `npm i -g` from the repo works. CI uploads the `.vsix` artifact. Add a CHANGELOG.
  - **Verify:** `pnpm build && node apps/server/dist/cli.js doctor`

- [ ] **[HUMAN] 11.7 Real-world acceptance**
  - Use c-board for a day with your real projects. File issues or add tasks below for anything off. Decide on a license and the open questions in PRD §13.
