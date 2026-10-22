# c-board — Product Requirements Document

> A local "mission control" for everything you're running across your projects: every Cursor/VS Code terminal, every dev server, every Claude Code session, all in one live, animated dashboard.

Status: Draft v1 · Owner: repo maintainer · Last updated: 2026-10-22

---

## 1. Problem

A developer working on several projects at once (for example 3 Cursor windows, each with a Claude Code session plus terminals running a backend, a storefront, a worker…) has to keep switching windows and terminal tabs to answer simple questions:

- Which Claude session is waiting for me to approve something?
- Which one finished, and what did it do?
- Is my backend still up? Did the storefront crash 10 minutes ago?
- Which ports are in use, and by what?

Nothing shows all of it in one place, and nothing lets you act on it (approve, reply, restart, stop) from that one place.

## 2. Goals

1. **One screen, all projects.** Every open project, its terminals, the commands running in them, and its Claude sessions, live.
2. **Act from the board.** Approve or deny Claude permission requests, chat with Claude, send input or Ctrl+C to terminals, restart commands, start new Claude sessions.
3. **Zero change to the existing workflow.** People keep using Cursor and its terminals exactly as before. c-board observes and mirrors, and only acts when asked.
4. **Premium, alive UI.** A dashboard that feels like a high-end product: fluid motion, ambient animation tied to real activity, polished micro-interactions, and still fast.
5. **Private by design and installable by anyone.** Runs entirely on localhost. Each installer uses their **own** Claude Code login or subscription. No telemetry, no cloud, no shared credentials.

### Non-goals (v1)

- Replacing Cursor or being a code editor.
- Remote or multi-user access. Bound to 127.0.0.1 only; reaching it from a phone through Tailscale is documented, not built in.
- Windows support. macOS and Linux first; Windows is a stretch.
- Managing remote, CI or cloud Claude sessions.

## 3. Users and scenarios

**Primary user:** a developer running 2–10 projects concurrently, each with Claude Code and some long-running dev processes.

| # | Scenario | Expected experience |
|---|---|---|
| S1 | Morning: opens c-board | Sees every project currently open in Cursor, with what's running and the state of each Claude session. |
| S2 | Claude in project B needs approval to run `pnpm test` | The pod for project B pulses amber, the Attention Center shows the request with the exact command, and the user approves from the board. |
| S3 | Storefront dev server crashes | The terminal lane turns red with the exit code and the last error lines. One click opens the full log, and one click re-runs the command. |
| S4 | Wants to give Claude a new task in project C without switching windows | Opens project C, starts a headless Claude session (or replies into the existing one), and watches it stream: tool calls, diffs, todos. |
| S5 | Away from the desk ("away mode") | Permission requests from interactive Cursor sessions are routed to the board, so they can be approved remotely. |
| S6 | "What used port 3000?" | The port chips on each pod show who is listening on what. |

## 4. Product scope

### 4.1 Core objects

- **Project:** a folder (resolved by realpath). Discovered from (a) workspace folders of connected Cursor/VS Code windows, (b) the `cwd` of Claude hook events, (c) manual add. Has a display name, accent color, git info (branch, dirty files, ahead/behind) and an "open in Cursor" action.
- **Window:** a connected Cursor/VS Code window (extension instance). Belongs to 1..n projects.
- **Terminal:** an integrated terminal in a window, or (stretch) a board-owned PTY. Has a name, shell PID, cwd, state, process subtree (CPU/mem), listening ports, and a list of executions.
- **Execution:** one command run in a terminal (via shell integration): command line, cwd, start and end time, exit code, output stream (kept in a ring buffer).
- **Claude session:** identified by `session_id`. Origin is either `terminal` (interactive, observed through hooks and transcripts) or `board` (headless, run through the Agent SDK). Has a status, title, model, permission mode, token usage and context size, current tool, todo list, subagents, and the linked terminal (when known).
- **Approval:** a pending permission decision, from an SDK `canUseTool` callback (board sessions) or from a `PermissionRequest` hook (terminal sessions in away mode).
- **Activity event:** a normalized, timestamped event used by the Pulse timeline and history.

### 4.2 Claude session status model

```
            SessionStart                UserPromptSubmit
  (none) ─────────────▶ idle ◀───────────────────────────┐
                          │ UserPromptSubmit              │ Stop
                          ▼                               │
                       working ──PreToolUse──▶ tool:<name> ┘
                          │   ◀──PostToolUse(Failure)──┘
                          │ Notification(permission_prompt) / PermissionRequest / canUseTool
                          ▼
                 waiting_permission ──(decision)──▶ working
     Notification(idle_prompt) ──▶ waiting_input
     StopFailure ──▶ error        SessionEnd / process gone ──▶ ended
     PreCompact ──▶ compacting ──PostCompact──▶ previous state
```

The status must also degrade gracefully: if no hook has arrived for a live process, fall back to "unknown, alive". If the process is gone, mark it "ended".

### 4.3 Features (MoSCoW)

**Must**
- F1 Overview ("Mission Control"): all projects as animated **pods**, sorted attention-first (waiting > error > working > idle).
- F2 Live terminal mirroring from Cursor/VS Code through the extension: list, status, command, exit codes, full colored output (xterm.js), history since the extension started.
- F3 Terminal actions: send input, Ctrl+C, re-run last command, create a terminal with a command, focus the terminal in Cursor, close it.
- F4 Claude session observation through hooks: real-time status, current tool, last message, tokens and context, linked terminal.
- F5 Transcript view of any session (history plus live tail), with tool calls rendered as rich cards (Bash, Edit/Write with diffs, Read, Grep, TodoWrite, Task/subagents).
- F6 Headless Claude sessions from the board (Agent SDK): new session per project, multi-turn chat, streaming, interrupt, model and permission-mode switch, resume past sessions.
- F7 Approvals: board sessions through `canUseTool`, with Allow once / Always allow (from suggestions) / Deny with reason.
- F8 Attention Center plus notifications (in-app toasts, optional browser notifications). No sound.
- F9 Ports and processes: listening ports per terminal and project; CPU/mem per terminal subtree.
- F10 Command palette (⌘K) for navigation and every action.
- F11 Onboarding plus `doctor`: guided setup (server, hooks, extension) with health checks.
- F12 Demo mode: realistic synthetic data for development, screenshots and testing.
- F23 **Activity animation** (DESIGN.md §4.10): every unit of work (a Claude session working, a terminal producing output) has a clear, live animation, so you can tell at a glance across many projects what's busy, what's idle, what's waiting and what broke. It's cheap enough to run for 10+ projects at once.

**Should**
- F13 Away mode: route `PermissionRequest` hooks from interactive terminal sessions to the board.
- F14 Reply to an interactive terminal session by typing into its terminal through the extension (experimental, flagged).
- F15 Git panel: branch, changed files, ahead/behind, and recent commits per project.
- F16 Pulse timeline: a cross-project activity stream with filters.
- F17 Session history browser per project (SDK `listSessions`), with "resume in board" or "resume in Cursor terminal".
- F18 Daily stats: sessions, tokens and tool calls per project (from transcripts).

**Could**
- F19 Board-owned terminals (node-pty) for projects with no editor window open.
- F21 Saved "launch profiles" per project (for example "backend + storefront + claude").
- F22 Light theme ("Daylight") polish beyond baseline.

## 5. Architecture

```
 Cursor window A ─ c-board extension ─┐
 Cursor window B ─ c-board extension ─┼── WS /ws/editor ──▶┌──────────────────────────────┐
 VS Code window …                     ┘                    │  c-board server (Node, TS)    │◀── WS /ws/ui ──▶ Browser UI
                                                           │  127.0.0.1:4317               │                 (React, Vite)
 Every Claude Code session (any terminal, -p, SDK)         │                               │
   └─ hooks (command, async) ─ POST /api/hooks/claude ───▶│  • state store + patches      │
                                                           │  • hook ingest / status FSM   │
 ~/.claude/projects/**.jsonl ◀── tail / SDK readers ──────│  • transcript reader          │
                                                           │  • process + port scanner     │
 Agent SDK query() sessions ◀── runs in-process ──────────│  • session runner (SDK)       │
                                                           │  • sqlite (node:sqlite)       │
                                                           └──────────────────────────────┘
```

### 5.1 Packages (pnpm monorepo)

| Path | Purpose |
|---|---|
| `packages/protocol` | Shared TypeScript types plus zod schemas: domain model, WS messages, hook payloads. Single source of truth. |
| `apps/server` | Fastify HTTP + WebSocket server, state store, ingest, scanners, SDK session runner, CLI (`c-board`). |
| `apps/web` | React SPA (Vite), the dashboard. Built assets are served by the server in production. |
| `apps/extension` | VS Code-compatible extension (works in Cursor). Streams terminals and executes remote commands. |
| `packages/hook` | Hook script plus the settings installer and uninstaller. |

### 5.2 Key technology choices (versions verified 2026-10-22)

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node ≥ 22 (dev on 25) | `node:sqlite` built in, so there are no native deps in core. |
| Package manager | pnpm 9 workspaces | |
| Language | TypeScript 6.0.x | Pin `~6.0.3`. TS 7 (native) is `latest` on npm but too new for the toolchain. |
| Lint/format | Biome 2.x | One tool. |
| Tests | Vitest 5, Playwright 1.64 | |
| Server | Fastify 5 + @fastify/websocket 11, pino | |
| Validation | zod 4 | |
| Claude | `@anthropic-ai/claude-agent-sdk` 0.3.x | `query()`, `canUseTool`, `listSessions`, `getSessionMessages`, `forkSession`. |
| Web | React 19, Vite 8, Tailwind CSS 4 (`@tailwindcss/vite`), Motion 14 (`motion/react`) | |
| Terminal render | `@xterm/xterm` 6 + addons fit, webgl, search | |
| State | zustand 5 | |
| UI bits | cmdk, Radix primitives (tooltip/dialog/popover), lucide-react, sonner, react-markdown + shiki, `diff` | |
| Fonts | Geist + Geist Mono (`@fontsource-variable/*`) | Self-hosted, no Google calls. |
| Extension | `@types/vscode` **1.93.0**, `engines.vscode ^1.93.0`, esbuild bundle, `@vscode/vsce` | 1.93 is where the shell-integration execution API became stable. Cursor 3.5 ships VS Code 1.105, so it's covered. |

### 5.3 Ports, files, data

- Default port `4317` (`CBOARD_PORT`). Bind `127.0.0.1` only.
- Data dir: `~/.c-board/` (`CBOARD_HOME`): `token` (0600, random 32 bytes, base64url), `board.db` (sqlite), `logs/`, `settings.json`.
- The extension and the hook script locate the server and token through `~/.c-board/`.

## 6. Integrations — verified facts and how we use them

### 6.1 Claude Code hooks (source: https://code.claude.com/docs/en/hooks)

- Registered in `~/.claude/settings.json` under `hooks.<Event>[] = { matcher?, hooks: [{ type: "command", command, async?, timeout? }] }`. User-level hooks apply to interactive, `claude -p`, and Agent SDK sessions (unless `--bare` or `settingSources: []`).
- Common stdin fields: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`.
- Events we subscribe to: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, and (away mode only) `PermissionRequest`.
- Exit-code semantics: 0 = success (stdout parsed as JSON if it is one object), 2 = blocking error on blockable events, other = non-blocking error notice. **Our observer hook always exits 0 and prints nothing.**
- `"async": true` command hooks run in the background without blocking Claude. All observer hooks use this.
- Handler types include `http`, but we use `command` so that we can (a) attach `$PPID` for terminal linking, (b) read the token from a file rather than embedding it in settings, and (c) fail silently.

**Observer hook contract** (`packages/hook/bin/c-board-hook`):
- POSIX `sh` plus `curl`, no Node startup cost.
- Reads stdin, then POSTs to `http://127.0.0.1:${CBOARD_PORT:-4317}/api/hooks/claude` with headers `X-CBoard-Token` (from `~/.c-board/token`) and `X-CBoard-Claude-Pid: $PPID`. The timeout is `-m 1`.
- If the token file is missing, the server is down, or anything else fails, it exits 0 silently.
- It must never print to stdout. Output could be interpreted as a hook decision.

**Away-mode permission hook** (`c-board-hook --permission`, sync, not async):
- Exits 0 immediately with no output unless the board reports away mode is ON (fast GET, 300 ms timeout).
- When away mode is on: POST the request, long-poll for a decision (≤ configurable, default 120 s), then print the `PermissionRequest` decision JSON. The exact output schema **must be re-verified against the hooks reference at implementation time**. On timeout or error it exits 0 with no output, and the normal terminal prompt appears.

**Installer** (`c-board hooks install|uninstall|status`): merges idempotently into `~/.claude/settings.json`, identifies its own entries by the `c-board-hook` command path, writes a timestamped backup first, supports `--dry-run` (prints a diff), and never touches other hooks. It always asks for confirmation unless `--yes` is passed.

### 6.2 Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, verified against 0.3.308 typings)

- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options })` returns a `Query` (an async generator of `SDKMessage`) with `interrupt()`, `setPermissionMode()`, `setModel()` and `close()`.
- Relevant `Options`: `cwd`, `resume`, `forkSession`, `sessionId`, `model`, `permissionMode` (`default | acceptEdits | bypassPermissions | plan | dontAsk | auto`), `canUseTool`, `allowedTools`, `disallowedTools`, `includePartialMessages`, `settingSources` (omitted means user+project+local, like the CLI), `maxTurns`, `maxBudgetUsd`, `abortController`, `env`, `pathToClaudeCodeExecutable`.
- `CanUseTool(toolName, input, { signal, suggestions, blockedPath, … })` returns `{ behavior: 'allow', updatedInput?, updatedPermissions? } | { behavior: 'deny', message, interrupt? }`.
- `SDKMessage` includes a `system/session_state_changed` message with `state: 'idle' | 'running' | 'requires_action'`, which drives board-session status directly.
- History helpers: `listSessions({ dir, limit, offset })`, `getSessionInfo`, `getSessionMessages(sessionId, { dir })`, `getSubagentMessages`, `forkSession`, `renameSession`, `tagSession`.
- **Auth:** the SDK uses the local Claude Code login of whoever runs c-board. c-board never reads, stores or transmits credentials. If `ANTHROPIC_API_KEY` is set in the server's environment, the SDK bills that key instead. `doctor` warns about this.
- Multi-turn: use streaming input mode, where the prompt is an async queue we push user messages into.

### 6.3 Transcripts (`~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`)

- The format is **undocumented and changes between versions**. Prefer the SDK helpers (`getSessionMessages`) for history. Raw-tail the file only for live increments, and parse defensively: only `type: "user" | "assistant"` lines with `message.content[]` blocks (`text`, `thinking`, `tool_use`, `tool_result`). Ignore unknown types. Never crash on a bad line.
- Token usage comes from `assistant.message.usage`.

### 6.4 Live-session registry (optional enrichment, undocumented)

- Current Claude Code versions write `~/.claude/sessions/<pid>.json` with `pid`, `sessionId`, `cwd`, `status`, `kind`, `entrypoint` and `name`. Use it **only as an optional, feature-detected hint** to discover live sessions that started before c-board did, with a try/catch around every read. Never depend on it. Never read other files in `~/.claude` beyond transcripts and this registry. Never read credentials.

### 6.5 VS Code / Cursor extension API (verified in `@types/vscode` 1.105)

- `window.terminals`, `onDidOpenTerminal`, `onDidCloseTerminal`, `onDidChangeTerminalState`, `onDidChangeActiveTerminal`; `Terminal.processId`, `name`, `exitStatus`, `state`, `shellIntegration`, `sendText(text, shouldExecute?)`, `show()`, `dispose()`.
- Shell integration (stable since 1.93): `window.onDidChangeTerminalShellIntegration`, `onDidStartTerminalShellExecution`, and `onDidEndTerminalShellExecution` (with `exitCode`); `TerminalShellExecution.commandLine` (`value`, `confidence`, `isTrusted`), `cwd`, and `read(): AsyncIterable<string>`; `TerminalShellIntegration.executeCommand(commandLine)`.
- **Limitation:** output is only captured for commands that start after the extension activates (use `activationEvents: ["onStartupFinished"]`). A process that was already running shows up as a terminal and process with "output unavailable, restart to capture".
- `execution.read()` must be called inside the start event handler to avoid losing data.
- Raw output contains ANSI and VS Code's OSC 633 sequences. Strip OSC 633 server-side and keep ANSI for xterm.

### 6.6 Processes and ports

- `ps -axo pid=,ppid=,pcpu=,rss=,etime=,command=` every 2 s, building a tree.
- `lsof -nP -iTCP -sTCP:LISTEN -F pn` every 5 s (macOS/Linux). On Linux, fall back to `ss -ltnp` if lsof is missing.
- **Session ↔ terminal linking:** the hook sends Claude's PID (`$PPID` of the hook shell; walk up if it is an intermediate `sh`). The server walks the ancestor chain until it hits a terminal shell PID reported by an extension.

## 7. Protocol (summary; full schemas live in `packages/protocol`)

All messages are JSON envelopes `{ v: 1, type, id?, ts, payload }`.

**Editor → server** (`/ws/editor`): `editor.hello {windowId, appName, appVersion, workspaceFolders[], extensionVersion, capabilities {shellExecution}}`, `terminal.upsert`, `terminal.sync {terminals[]}` (full list after every connect), `terminal.closed`, `exec.start {execId, terminalId, commandLine, confidence, cwd}`, `exec.data {execId, seq, chunk}` (batched every ≤ 50 ms / 16 KB), `exec.interactive {execId}` (the command switched to the alternate screen), `exec.end {execId, exitCode}`, `editor.heartbeat`.

**Server → editor:** `cmd.sendText {terminalId, text, execute}`, `cmd.interrupt {terminalId}`, `cmd.createTerminal {cwd, name, command?}`, `cmd.focusTerminal`, `cmd.disposeTerminal`, `cmd.rerun {execId}`. Each command is acknowledged with `cmd.result {id, ok, error?}`.

**Server → UI** (`/ws/ui`): `snapshot {state}` on connect, then `patch {ops[]}` coalesced to ≤ 30 per second, `stream.data {streamId, seq, chunk}` for subscribed terminal or execution output, `toast`, `approval.new/resolved`, and `activity {events[], replace}` for the Pulse timeline (the last 15 min right after the snapshot, then live batches).

**UI → server:** `subscribe/unsubscribe {streamId, fromSeq?}`, `action {kind, …}` (every user action, validated with zod), `session.send {sessionId, text}`, `approval.decide {approvalId, decision}`.

## 8. Security and privacy requirements

Treat these as non-negotiable. They are acceptance criteria for every phase.

1. **Network:** listen on `127.0.0.1` only. Reject requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defence).
2. **WebSocket origin check:** `/ws/ui` accepts only `Origin` equal to the board's own origin (plus the Vite dev origin in dev). `/ws/editor` requires the token header.
3. **Auth:** a per-install random token in `~/.c-board/token` (0600). The browser gets a session cookie (`HttpOnly`, `SameSite=Strict`) by visiting a one-time link `http://127.0.0.1:4317/auth?t=<token>` that the CLI opens. Every state-changing HTTP route requires the cookie or the token header.
4. **No credentials:** c-board never reads `~/.claude/.credentials*`, the Keychain or `~/.claude.json`, and it never asks for an API key. Each user runs with their own Claude Code login.
5. **No telemetry,** no external network calls at runtime. Fonts and assets are bundled.
6. **Rendering safety:** markdown is rendered without raw HTML. Terminal output goes only to xterm (never `innerHTML`).
7. **Secrets in output:** terminal and transcript data stays in memory and local sqlite under `~/.c-board`. A "redact" setting masks common secret patterns in the UI (`sk-ant-…`, `ghp_…`, `AKIA…`, `-----BEGIN … KEY-----`, `.env`-style `KEY=value` for names containing SECRET|TOKEN|KEY|PASSWORD).
8. **Shell safety:** the server never builds shell strings from user input. Use `execFile` with argument arrays. The hook installer writes JSON with a JSON serializer.
9. **Repository hygiene (public repo):** nothing machine-specific or personal is ever committed. That covers real home paths, usernames, emails other than GitHub noreply, real project names, real transcripts and tokens. Fixtures are synthetic (`/home/dev/acme-shop`). `scripts/privacy-check.sh` runs in pre-commit, in the build loop, and in CI.

## 9. Non-functional requirements

- **Performance:** 10 projects × 6 terminals, with 2 terminals each emitting about 200 lines per second, must keep the UI at ≥ 55 fps on an M-series Mac with the overview open. Server CPU must stay below 5% at idle and below 20% under that load.
- **Memory:** ring buffers cap output at 2 MB per execution and 8 MB per terminal; older data is dropped with a "truncated" marker.
- **Latency:** hook event to UI update ≤ 150 ms p95. Terminal output to UI ≤ 100 ms p95.
- **Resilience:** the server, extension and UI each reconnect with exponential backoff (max 10 s). Server restarts lose only output buffers; state is rebuilt from extensions on reconnect.
- **Accessibility:** full keyboard navigation, visible focus, WCAG AA contrast, and `prefers-reduced-motion` honored, plus an in-app "Motion: Full / Reduced / Off" setting.
- **Footprint:** a hook adds less than 5 ms to Claude (it is async). The extension uses less than 1% CPU at idle.

## 10. Success metrics

- You can go a full workday without switching to a Cursor window just to check status.
- A permission request goes from appearing to approved from the board in under 5 s.
- Zero missed crashes: every non-zero exit is surfaced in the UI within 1 s.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The transcript or session registry format changes | Prefer SDK APIs, parse defensively, feature-detect, and keep fixtures per version. |
| Cursor diverges from VS Code's shell-integration API | Keep engine 1.93 as the minimum, add a capability check at activation, and degrade to inventory-only plus a warning in the UI. |
| Commands started before activation have no output | UX copy plus a one-click "restart to capture". |
| Interactive TUIs (claude, htop) produce noisy streams | Detect alt-screen and render those executions as "interactive app (open in Cursor)", using hooks and transcripts for Claude instead. |
| A local website attacks the WS | Origin, Host and token checks (§8). |
| Heavy animation hurts performance | DESIGN.md perf rules: transform/opacity only, one WebGL context, pause when hidden, motion levels. |
| Away-mode hook delays the terminal prompt | Off by default. When off, the permission hook exits immediately. |

## 12. Release plan

- **M1 Observe (MVP):** server, protocol, hooks, extension mirroring, overview, focus view with terminals and transcript (read-only). Demo mode.
- **M2 Act:** terminal actions, headless SDK sessions, approvals, ⌘K, Attention Center.
- **M3 Wow plus polish:** ambient shader, orbs, Pulse timeline, git panel, stats, onboarding, docs and GIFs, performance and accessibility pass.
- **M4 Stretch:** away mode, terminal reply, board-owned PTYs, launch profiles.

## 13. Open questions

- Should we publish to npm (`npx c-board`) and the VS Code Marketplace / Open VSX, or keep it source-install only for v1? (Default: source install plus a `.vsix` from CI artifacts.)
- License choice (MIT suggested), to be decided by the maintainer before the first public release.
