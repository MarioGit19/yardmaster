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

- [ ] **5.1 Extension scaffold**
  - `package.json`: `name: c-board`, `publisher: c-board`, `engines.vscode: ^1.93.0`, `@types/vscode@1.93.0`, `activationEvents: ["onStartupFinished"]`, `main: dist/extension.js`, `icon: media/icon.png` (from task 3.5). Settings `cboard.enabled` and `cboard.port`. Commands `c-board.openDashboard` and `c-board.reconnect`. Build with esbuild to a single CJS file (`vscode` external), and `package` via `@vscode/vsce` to `dist/c-board.vsix` (no `repository` warnings; include a LICENSE placeholder note if LICENSE is missing).
  - Isolate pure logic in `src/core/*` (no `vscode` import) so it can be unit tested.
  - **Done when:** `pnpm --filter c-board-extension package` produces a `.vsix`.
  - **Verify:** `pnpm --filter c-board-extension build && pnpm --filter c-board-extension package`

- [ ] **5.2 Server connection**
  - A core `EditorLink` class: reads the token from `~/.c-board/token`, connects to `ws://127.0.0.1:<port>/ws/editor` with the token header, sends `editor.hello` (windowId = uuid persisted in `context.workspaceState`, `vscode.env.appName`, version and workspace folders), runs a heartbeat every 10 s, reconnects with backoff, and queues messages while offline (capped). Server side: an `/ws/editor` handler that registers windows and projects in the store and removes them on disconnect (after a 15 s grace period).
  - Status bar item: `$(pulse) c-board` with a connected/disconnected tooltip, which runs `openDashboard` on click (`vscode.env.openExternal` of the auth link).
  - **Done when:** unit tests run EditorLink against a fake server (hello, reconnect, queue cap), and a server test covers window registration and removal.
  - **Verify:** `pnpm --filter c-board-extension test && pnpm --filter @c-board/server test`

- [ ] **5.3 Terminal inventory**
  - Track `window.terminals` with stable ids (a WeakMap Terminal→uuid). Send `terminal.upsert` (name, processId, cwd from `shellIntegration?.cwd`, creationOptions name, state, exitStatus) on open, close, state change, shell-integration change and active change. Send a full resync after reconnect.
  - Server side: a terminal reducer, linking each terminal to its project by the cwd prefix or the window's folder.
  - **Done when:** core logic tests use a fake terminal model, and server reducer tests pass.
  - **Verify:** `pnpm --filter c-board-extension test && pnpm --filter @c-board/server test`

- [ ] **5.4 Execution streaming**
  - On `onDidStartTerminalShellExecution`: send `exec.start` and **immediately** start `for await (const chunk of execution.read())`. Feed a core `ChunkBatcher` (flush at 50 ms or 16 KB, with seq numbers). On end, send `exec.end` with `exitCode`. Detect alt-screen (`\x1b[?1049h`) and mark the execution `interactive`. Capability check: if `onDidStartTerminalShellExecution` is undefined, report `capabilities.shellExecution=false` in the hello.
  - Server side: an exec reducer plus output buffers, and streams `exec:<execId>` and `term:<terminalId>` (concatenated executions).
  - **Done when:** batcher tests (timing with fake timers, size flush, ordering) and server stream tests pass.
  - **Verify:** `pnpm --filter c-board-extension test && pnpm --filter @c-board/server test`

- [ ] **5.5 Remote commands**
  - The extension handles `cmd.sendText`, `cmd.interrupt` (`sendText('\x03', false)`), `cmd.createTerminal` (create, show, and run the command through `shellIntegration.executeCommand` once integration activates, falling back to `sendText` after 3 s), `cmd.focusTerminal`, `cmd.disposeTerminal` and `cmd.rerun`. Each replies with `cmd.result`.
  - Server side: typed actions from the UI become routed editor commands with an ack and a 5 s timeout. Add an `editorRouter` that picks the window owning the terminal or project.
  - **Done when:** routing, ack and timeout tests pass on the server, and the command handler is unit tested with a mocked vscode facade.
  - **Verify:** `pnpm --filter c-board-extension test && pnpm --filter @c-board/server test`

- [ ] **[HUMAN] 5.6 Install the extension in Cursor**
  - Run `pnpm --filter c-board-extension package && cursor --install-extension apps/extension/dist/c-board.vsix`, then reload every Cursor window (Cmd+Shift+P, "Developer: Reload Window"). Start `pnpm dev`, run something in a terminal, and confirm it shows up in `c-board doctor` and the UI. Note any Cursor-specific quirks under this task, then tick it.

## Phase 6 — Processes, ports, git, linking

- [ ] **6.1 Process and port scanner**
  - `ProcessScanner`: every 2 s, run `ps` (via `execFile`) to build a pid tree. Every 5 s, run `lsof -nP -iTCP -sTCP:LISTEN -F pcn` (Linux fallback `ss -ltnp`). Aggregate CPU and RSS per terminal subtree and attach listening ports to terminals and projects. Diff before mutating the store, so nothing changes when nothing changed.
  - **Done when:** parser tests run on captured synthetic outputs for macOS and Linux, and aggregation tests pass.
  - **Verify:** `pnpm --filter @c-board/server test`

- [ ] **6.2 Session ↔ terminal linking**
  - Using `X-CBoard-Claude-Pid` and the pid tree, walk the ancestors until one matches a terminal `processId`. Set `session.terminalId`, and re-evaluate when terminals or processes change. Also map `~/.claude/sessions` registry pids the same way.
  - **Done when:** tree-walk tests cover a direct child, an intermediate `sh`, and no match.
  - **Verify:** `pnpm --filter @c-board/server test`

- [ ] **6.3 Git info**
  - Per project, every 5 s while connected UI clients exist (and on hook `PostToolUse` for Edit/Write/Bash), run `git status --porcelain=v2 --branch` and `git log -5 --format=…` through `execFile`. Fill `GitInfo` (branch, upstream ahead/behind, changed files with status, last commits). Skip non-git folders.
  - **Done when:** parser tests on synthetic porcelain output pass.
  - **Verify:** `pnpm --filter @c-board/server test`

## Phase 7 — Signature UI (build against `pnpm dev:demo`)

For every task in this phase: follow DESIGN.md exactly, run `pnpm shots` after implementing, **look at the screenshots** (Read the PNGs), and fix anything that fails the DESIGN.md §9 checklist before ticking.

- [ ] **7.1 Ambient field**
  - `AmbientField`: a WebGL fragment shader per DESIGN.md §4.1 with `uEnergy`/`uAttention` uniforms derived from the store, 0.5× DPR, a 30 fps cap, pause when hidden, a CSS fallback, motion-level aware, and a grain overlay.
  - **Done when:** it renders in demo mode, energy visibly responds (a debug slider is available in `/#/_tokens`), and Reduced mode is static.
  - **Verify:** `pnpm --filter @c-board/web build && pnpm shots`

- [ ] **7.2 Shared animation scheduler and ClaudeOrb**
  - A single rAF scheduler (`useFrame(cb, {visible})`) with IntersectionObserver gating. `ClaudeOrb` on canvas implements every state in DESIGN.md §4.2, including tool-family particle colors, subagent satellites, the waiting ripple and countdown ring, and the error glitch. Add a showcase on `/#/_tokens` with every state side by side.
  - **Done when:** the showcase renders all states, and the scheduler is unit tested (registers, unregisters, pauses).
  - **Verify:** `pnpm --filter @c-board/web test && pnpm shots`

- [ ] **7.2b Crew mascot**
  - `CrewMascot` per DESIGN.md §4.11: an original SVG character built from part groups, with every state in the table (sleeping, idle, watching, thinking, typing, reading, running, delegating, waiting, error, done) as Motion variants. Blended transitions, per-instance randomized blinks and look-arounds, three sizes (24/56/120 px) with the detail rules, the session color on the visor and antenna (the antenna tip is `ClaudeOrb`), a mini-crew subagent pop-in and pop-out, pausing when off screen, and static poses for Reduced and Off. Add a pure `mascotStateFor(session, terminals)` mapping with unit tests. Add a "character sheet" on `/#/_tokens` showing every state at every size, with a state switcher. Use the `animate` and `apple-design` skills, and run `review-animations` on it before finishing.
  - **Done when:** the character sheet screenshot shows every state clearly distinguishable at 56 px, the mapping tests pass, and 30 mascots on screen keep 60 fps (Playwright FPS sample).
  - **Verify:** `pnpm --filter @c-board/web test && pnpm shots && pnpm e2e`

- [ ] **7.3 Sparkline, TerminalLane, PortChip**
  - A canvas `Sparkline` (60 samples, slide-in, accent tint, rose on error), `TerminalLane` (name, command, sparkline, port chips, uptime, exit badge, streaming "comet" border, aligned columns), `PortChip` (click copies `localhost:port`, hover shows the process), and `TerminalPeek` (a live 6-line output preview on lane hover or focus, per DESIGN.md §4.3).
  - **Done when:** the lanes render in the demo with correct alignment across pods (screenshot check).
  - **Verify:** `pnpm shots`

- [ ] **7.4 ProjectPod and PodGrid (overview)**
  - Pod anatomy per DESIGN.md §4.3: accent hairline, header (avatar ring, name, branch, dirty, ahead, and the project's 56 px crew mascots per §4.11), SessionRows (orb, typewriter status text, last-line shimmer, tokens) and TerminalLanes. Cursor spotlight and lift on hover. The border takes the priority status color. `PodGrid` is responsive (1/2/3/4 columns), with attention-first ordering animated via `layout` and a staggered enter.
  - **Done when:** the overview looks finished in demo mode at all three widths, in dark and light.
  - **Verify:** `pnpm shots && pnpm e2e`

- [ ] **7.5 HUD**
  - Top bar with `NumberTicker` rolling-digit counters (Working, Waiting, Running, Errors, Tokens today), a connection dot with a reconnect state, a ⌘K hint, motion-level and theme toggles, and a "Waiting" click that opens the Attention Center.
  - **Done when:** the counters animate on demo changes, and the disconnect state is visible when the server is killed (e2e).
  - **Verify:** `pnpm e2e && pnpm shots`

- [ ] **7.6 Focus view and shared-element transition**
  - Route `/p/:id`: a `layoutId` transition from the pod (container, header, orb), with the backdrop dimmed and blurred. Three-column resizable layout (sessions + git | Claude panel | terminal stack), spring-snapped resize handles, and persisted sizes per project (localStorage, wrapped in try/catch). Back with Esc.
  - **Done when:** the transition is smooth in both directions and the layout is correct at 1440 and 1920 (stacked tabs at 390).
  - **Verify:** `pnpm shots && pnpm e2e`

- [ ] **7.7 Terminal stack (xterm)**
  - `XtermView` using `@xterm/xterm` 6 with the fit, webgl (with fallback) and search addons, themed from tokens and using the Geist Mono font. It subscribes to `term:<id>` with replay. Input goes to `cmd.sendText`, and the toolbar has Ctrl+C, re-run, focus-in-Cursor, search and clear-view. Tabs, a 2×2 grid toggle, and maximize. Interactive (alt-screen) executions show an "Interactive app, open in Cursor" placeholder card. Dispose the renderer on hidden tabs.
  - **Done when:** an e2e test types into a demo terminal and sees the echo, and a crash shows the exit badge.
  - **Verify:** `pnpm e2e && pnpm shots`

- [ ] **7.8 Claude panel: message list**
  - Render the transcript stream: user bubbles, assistant markdown (react-markdown, no raw HTML, shiki code blocks with the theme matched to tokens), collapsible thinking, and a streaming caret glow. Use virtualization (`@tanstack/react-virtual`) with stick-to-bottom behaviour and a "jump to latest" pill.
  - **Done when:** a long demo transcript (500+ messages) scrolls smoothly, with no long tasks over 50 ms (Playwright performance check).
  - **Verify:** `pnpm e2e`

- [ ] **7.9 Tool cards and diff view**
  - `ToolCard` variants: Bash (command plus collapsible output plus exit status), Edit/MultiEdit/Write (`DiffView`, unified/split toggle, using `diff` and shiki highlighting), Read/Grep/Glob (compact chips with path and line counts), TodoWrite (animated checklist), Task/subagent (nested thread, collapsible), WebFetch/WebSearch (URL chips), and an unknown-tool fallback (pretty JSON). Enter animation per DESIGN.md.
  - **Done when:** every variant appears in a demo transcript and in the `/#/_tokens` showcase.
  - **Verify:** `pnpm shots`

- [ ] **7.10 Command palette**
  - cmdk in a glass modal (⌘K / Ctrl+K). Groups Projects, Sessions, Terminals and Actions (new board session in project, interrupt session, approve all waiting in project, re-run last command, toggle motion, toggle theme, open settings, open project in Cursor). Fuzzy match highlighting and shortcut hints.
  - **Done when:** an e2e test opens the palette, navigates to a project and runs an action.
  - **Verify:** `pnpm e2e`

- [ ] **7.11 Pulse rail**
  - A bottom collapsible timeline with a 15-min window, project lanes, event dots colored by type that fly in, hover tooltips, click to navigate, filters (Claude, terminals, errors), all on canvas for performance.
  - **Done when:** it renders in the demo, and clicking a dot navigates.
  - **Verify:** `pnpm shots && pnpm e2e`

- [ ] **7.12 Git panel and session history**
  - `GitPanel` (branch, ahead/behind, changed files grouped by status, last 5 commits). `SessionHistory` per project (SDK-backed list with AI title, date, tokens), with actions "Resume in board" (wired in Phase 8) and "Resume in Cursor" (`cmd.createTerminal` with `claude --resume <id>`).
  - **Done when:** both render with demo data, and the "Resume in Cursor" action is routed (server test).
  - **Verify:** `pnpm shots && pnpm --filter @c-board/server test`

- [ ] **7.13 Activity animation system**
  - Per DESIGN.md §4.10: per-entity activity levels in the store (a decaying event rate), crew mascot states wired to live session and terminal data (including subagent mini-crews), the live session caption (action text from hook tool events, slide-swap plus shimmer), terminal lane activity (pulse speed and comet tied to output rate, crash state), the pod activity border (rotating light, speed ∝ activity), hairline event particles, a one-time "turn done" sweep, idle dimming, and the focus-view header caption with elapsed time and inline Allow / Deny. Idle entities register no frame callbacks.
  - **Done when:** in demo mode, busy, idle, waiting and crashed projects are distinguishable at a glance in the screenshots. An e2e test with fake timers checks that the done sweep plays once and that idle pods dim after 5 minutes. Reduced mode shows no movement.
  - **Verify:** `pnpm e2e && pnpm shots`

- [ ] **7.14 Worst-case data pass (break-ui)**
  - Use the `break-ui` skill on ProjectPod (including 6+ sessions, which means 6+ mascots), SessionRow (very long captions), TerminalLane, TerminalPeek, ApprovalCard and the HUD. Add a `?worst=1` demo variant (very long project names, branches and commands, 0 and 99+ sessions or terminals, huge token counts, non-Latin text, emoji, missing fields) and fix everything that breaks.
  - **Done when:** the screenshots of `?worst=1` at all widths show no overflow, overlap or broken alignment.
  - **Verify:** `pnpm shots`

- [ ] **7.15 Motion review pass**
  - Run `review-animations` across `apps/web/src`, then `find-animation-opportunities` for the overview and focus views. Apply the fixes and opportunities that fit DESIGN.md §3–4 (reject the rest, with a one-line reason in a Note). Recheck Reduced/Off motion levels.
  - **Done when:** the review comes back without blocking issues, and the motion levels still behave as specified.
  - **Verify:** `pnpm e2e && pnpm shots`

- [ ] **7.16 Impeccable design critique**
  - Run an `impeccable` critique and audit of the overview, focus view, Attention Center and settings, using the screenshots plus the code. Fix the top issues (hierarchy, spacing, typography, contrast, states) without leaving DESIGN.md's direction. If more than about 10 issues remain, add follow-up task `7.16b`.
  - **Verify:** `pnpm shots && pnpm check`

## Phase 8 — Act: headless sessions and approvals

- [ ] **8.1 SessionRunner (Agent SDK)**
  - `apps/server/src/claude/runner.ts`: `startSession({projectId, prompt, model?, permissionMode?})` and `resumeSession(sessionId)`, using `query()` in streaming-input mode (an async queue), `cwd` = project path, `includePartialMessages: true`, and default `settingSources`. Map the `SDKMessage`s (`assistant`, `user`, `result`, `system/session_state_changed`, `stream_event` partials) into the store and transcript stream. Controls: `send`, `interrupt`, `setModel`, `setPermissionMode` and `close`. Expose them as UI actions.
  - Tests mock the SDK module (never call the real API in tests).
  - **Done when:** mocked-SDK tests cover start, multi-turn send, partial streaming, interrupt and resume.
  - **Verify:** `pnpm --filter @c-board/server test`

- [ ] **8.2 Approvals via canUseTool**
  - The `canUseTool` callback creates an `Approval` (tool, input, suggestions, blockedPath) and awaits the UI decision, honouring `signal` abort. Decisions: allow once, always (returns `updatedPermissions` from `suggestions`), or deny with a message. There's a configurable timeout (default none for board sessions). Add `approval.new` and `approval.resolved` messages.
  - **Done when:** tests cover allow, always, deny, abort and concurrent approvals.
  - **Verify:** `pnpm --filter @c-board/server test`

- [ ] **8.3 Composer and board-session UX**
  - Claude panel composer: multiline (Enter sends, Shift+Enter adds a newline), model pill, permission-mode pill, interrupt (Esc) and send button with a "sending" morph. "New session" in a project. Board sessions get a distinct badge from terminal sessions. For terminal-origin sessions the composer shows "Resume here (fork)", which uses `forkSession` and warns if the original is still live.
  - **Done when:** an e2e test (demo mode with a mocked runner) starts a session, sends, sees streaming and interrupts.
  - **Verify:** `pnpm e2e`

- [ ] **8.4 Attention Center**
  - Right sheet per DESIGN.md §4.5. It collects approvals from every source, with keyboard shortcuts A, ⇧A and D, a deny reason input, collapse on resolve, a toast plus an `aria-live` announcement on new items and an optional browser Notification (permission asked in Settings).
  - **Done when:** an e2e test approves a demo request with the keyboard.
  - **Verify:** `pnpm e2e && pnpm shots`

- [ ] **8.5 Settings and onboarding**
  - The Settings sheet covers theme, motion level, notifications, redact secrets, away mode (Phase 9), hooks status plus an install button (calls the installer with a confirm dialog showing the diff), connected editor windows, data retention, and token rotate.
  - The onboarding wizard (shown when there are no hook events and no editors connected) follows DESIGN.md §6, with live auto-ticking steps and copyable commands.
  - **Done when:** the e2e onboarding flow ticks steps from simulated events.
  - **Verify:** `pnpm e2e && pnpm shots`

- [ ] **8.6 Secret redaction**
  - A shared `redact()` (patterns per PRD §8.7) applied in the UI to terminal lines (an xterm write filter), tool cards and messages when the setting is on, with a "reveal" per block on click.
  - **Done when:** unit tests cover the patterns (including no false positives on ordinary hashes and UUIDs).
  - **Verify:** `pnpm --filter @c-board/web test`

## Phase 9 — Stretch: away mode and terminal reply

- [ ] **9.1 Away-mode permission hook**
  - Re-verify the `PermissionRequest` hook input and decision-output schema at https://code.claude.com/docs/en/hooks and record the verified shape in a code comment with the date. Implement `c-board-hook --permission` (sync) per PRD §6.1, plus the server endpoints `GET /api/away` and `POST /api/hooks/permission` (long-poll). The installer adds the `PermissionRequest` entry only through `hooks install --away`.
  - **Done when:** script tests cover away off (instant exit, no output), away on plus decision, and timeout (no output).
  - **Verify:** `pnpm --filter @c-board/hook test && pnpm --filter @c-board/server test`

- [ ] **9.2 Reply into terminal sessions (experimental)**
  - For terminal-origin sessions with a linked terminal and status `waiting_input` or `idle`, the composer offers "Send to terminal" (`cmd.sendText`, execute=true), behind the setting `experimental.terminalReply`.
  - **Done when:** the routing test passes and the UI flag hides and shows the control.
  - **Verify:** `pnpm --filter @c-board/server test && pnpm e2e`

## Phase 10 — Quality, docs, release

- [ ] **10.1 Performance pass**
  - Add a `--demo-stress` mode (10 projects × 6 terminals, 2 terminals at about 200 lines/s each, and 4 Claude sessions doing roughly 5 tool calls per second), with every activity animation running. Write a Playwright perf test that measures FPS (rAF sampling over 10 s) and long tasks on the overview and focus views. Optimize until it reaches ≥ 55 fps and has no long tasks over 50 ms (PRD §9). Record the numbers under this task.
  - **Verify:** `pnpm e2e --grep @perf`

- [ ] **10.2 Accessibility pass**
  - Add `@axe-core/playwright` checks on every route (0 serious or critical issues). Run keyboard-only e2e tests through the main flows, and verify reduced motion.
  - **Verify:** `pnpm e2e --grep @a11y`

- [ ] **10.3 Security review**
  - Audit against PRD §8: Host and Origin checks, the token on every route, `execFile`-only usage (`grep -rn "exec(" apps` returns nothing unsafe), no raw HTML rendering, no credential-file reads (`grep -rn "credentials" apps packages`), the hook script being silent, and the installer's backups. Fix the findings and list them under this task.
  - **Verify:** `pnpm check`

- [ ] **10.4 Visual polish sweep**
  - Run `pnpm shots` and review every screenshot against DESIGN.md §9, using `impeccable` polish and `web-design-guidelines`. Fix up to 10 issues per iteration; if more remain, add a follow-up task `10.4b` below this one.
  - **Verify:** `pnpm shots`

- [ ] **10.5 README and docs**
  - Write a public README: hero screenshot or GIF (captured from demo mode only), features, how it works (diagram), requirements, install (clone, `pnpm i`, `pnpm build`, `c-board hooks install`, install the vsix), privacy statement ("runs locally, uses your own Claude Code login, no telemetry"), uninstall (`c-board hooks uninstall`, remove the extension, `rm -rf ~/.c-board`), troubleshooting (`c-board doctor`), and contributing. Add `docs/ARCHITECTURE.md` from PRD §5–7.
  - **Verify:** `scripts/privacy-check.sh && pnpm check`

- [ ] **10.6 Release packaging**
  - Add a `pnpm build` that bundles the server (esbuild) with the web dist and a `bin` entry, so that `npm i -g` from the repo works. CI uploads the `.vsix` artifact. Add a CHANGELOG.
  - **Verify:** `pnpm build && node apps/server/dist/cli.js doctor`

- [ ] **[HUMAN] 10.7 Real-world acceptance**
  - Use c-board for a day with your real projects. File issues or add tasks below for anything off. Decide on a license and the open questions in PRD §13.
