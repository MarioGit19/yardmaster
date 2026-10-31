# Yardmaster — Product Requirements Document

> A local "mission control" for everything you're running across your projects: every Cursor/VS Code terminal, every dev server, every Claude Code session, all in one live, animated dashboard.

Version 1 · Last updated: 2026-10-29

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
3. **Zero change to the existing workflow.** People keep using Cursor and its terminals exactly as before. Yardmaster observes and mirrors, and only acts when asked.
4. **Premium, alive UI.** A dashboard that feels like a high-end product: fluid motion, ambient animation tied to real activity, polished micro-interactions, and still fast.
5. **Private by design and installable by anyone.** Runs entirely on localhost. Board sessions run through each user's **own** locally installed and signed-in Claude Code. No telemetry, no cloud, no shared credentials.

### Non-goals (v1)

- Replacing Cursor or being a code editor.
- Public remote or multi-user access. The server binds 127.0.0.1 only; the one supported way in from another device is the user's own Tailscale network (F27).
- Windows support. macOS and Linux first; Windows is a stretch.
- Managing remote, CI or cloud Claude sessions.

## 3. Users and scenarios

**Primary user:** a developer running 2–10 projects concurrently, each with Claude Code and some long-running dev processes.

| # | Scenario | Expected experience |
|---|---|---|
| S1 | Morning: opens Yardmaster | Sees every project currently open in Cursor, with what's running and the state of each Claude session. |
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
- **Claude session:** identified by `session_id`. Origin is either `terminal` (interactive, observed through hooks and transcripts) or `board` (headless, run through the Agent SDK). Has a status, title, git branch, model, permission mode, token usage and context size, current tool, todo list, subagents, and the linked terminal (when known).
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
     PermissionDenied ──▶ working    quota_auto_resume_fired ──▶ working
```

`StopFailure` keeps why the turn failed when it's the account's doing (`reason`: `rate_limit`, `auth`, `billing`). A `rate_limit` session reads "Rate limited", and offers a one-tap **Continue** that the user sends; the board never sends it by itself, and Claude's own auto-resume messages replace the text. Subagents and background tasks keep a session Running after its turn: an `idle_prompt` doesn't move it to waiting while they run.

The status must also degrade gracefully: if no hook has arrived for a live process, fall back to "unknown, alive". If the process is gone, mark it "ended".

### 4.3 Features (MoSCoW)

**Must**
- F1 Overview ("Mission Control"): all projects as animated **pods** in a stable order: pinned first, then an order the user sets by dragging (saved per device), by default most recently active as of page load. Status never reorders them; a pinned **Needs you** strip above every layout lists approvals, questions and failures, oldest first, with their action.
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
- F19 Board-owned terminals (node-pty) for projects with no editor window open: fully interactive, started from the board or the phone.
- F25 **Project library and launch:** the user picks root folders (for example `~/Desktop`). The overview shows only **active** projects; the "Open project" picker lists the roots' folders, and launching one can open it in Cursor, start a Claude session and start terminals, in one step.
- F26 Active-only overview: projects leave the overview when nothing has happened in them for a while (unless pinned) and come back the moment something starts.
- F26b Card sizes and density: active projects get a full card and quiet ones a one-line row. A per-device density (Comfortable, Compact, List) changes which fields Minimal and the phone's Projects list render.
- F26c Focus view around the chat: the session list folds to a rail, terminals and changes share a side panel that folds too, and a per-device transcript detail (Summary, Normal, Verbose) sets how much of a session the chat shows.
- F27 **Phone access** over the user's own Tailscale network: opt-in allowed hosts, QR pairing, and phone-ready screens.
- F24 **Layouts** (DESIGN.md §10): the overview can be shown as **Minimal** (default, the pod grid), **Office** (each project is an office room and every session and terminal is a character at a station, working or idling with its state) **Grid** (a neon network of projects fed by pipelines; entering a project dives into it and its screens phase in), **Transit** (a metro map where each project is a line and every session and terminal a train) or **Retro** (a dense green-phosphor text console). Same data, statuses and actions in every layout; click any character, node or screen to see where it is and act on it.

**Could**
- F21 Saved "launch profiles" per project (for example "backend + storefront + claude").
- F22 Light theme ("Daylight") polish beyond baseline.

## 5. Architecture

```
 Cursor window A ─ Yardmaster extension ─┐
 Cursor window B ─ Yardmaster extension ─┼── WS /ws/editor ──▶┌──────────────────────────────┐
 VS Code window …                     ┘                    │  Yardmaster server (Node, TS)    │◀── WS /ws/ui ──▶ Browser UI
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
| `apps/server` | Fastify HTTP + WebSocket server, state store, ingest, scanners, SDK session runner, CLI (`yardmaster`). |
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
| 3D (Grid layout only) | `three` + its `CSS3DRenderer` addon | Lazy-loaded with the Grid layout; one WebGL context; 2D SVG fallback. |
| Fonts | Geist + Geist Mono (`@fontsource-variable/*`) | Self-hosted, no Google calls. |
| Extension | `@types/vscode` **1.93.0**, `engines.vscode ^1.93.0`, esbuild bundle, `@vscode/vsce` | 1.93 is where the shell-integration execution API became stable. Cursor 3.5 ships VS Code 1.105, so it's covered. |

### 5.3 Ports, files, data

- Default port `4317` (`YARDMASTER_PORT`). Bind `127.0.0.1` only.
- Data dir: `~/.yardmaster/` (`YARDMASTER_HOME`, 0700): `token` (0600, random 32 bytes, base64url), `board.sock` (the local socket, 0600), `board.db` (sqlite), `logs/`, `settings.json`.
- The extension and the hook scripts reach the server only through `~/.yardmaster/board.sock`, never the TCP port (§8 item 13).

## 6. Integrations — verified facts and how we use them

### 6.1 Claude Code hooks (source: https://code.claude.com/docs/en/hooks)

- Registered in `~/.claude/settings.json` under `hooks.<Event>[] = { matcher?, hooks: [{ type: "command", command, async?, timeout? }] }`. User-level hooks apply to interactive, `claude -p`, and Agent SDK sessions (unless `--bare` or `settingSources: []`).
- Common stdin fields: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`.
- Events we subscribe to: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PermissionDenied`, `TaskCreated`, `TaskCompleted`, `CwdChanged`, and (away mode only) `PermissionRequest`.
- **Never subscribe to `WorktreeCreate` or `WorktreeRemove`.** A handler for either replaces Claude Code's own git worktree handling: creation fails unless the hook prints a path, and removal counts as done once the hook succeeds. Verified in Claude Code 2.1.308.
- `Notification` types: `permission_prompt` and `idle_prompt` set the status. `agent_needs_input` does too, but only for a session already on the board: agent view sends it about the sessions it lists, under its own session id. `agent_completed` is only ever about another session, so it stays in Pulse. `quota_auto_resume_fired` puts a usage-limited session back to work; `quota_auto_resume_stale` and `quota_auto_resume_disabled` keep it failed and replace the message.
- Exit-code semantics: 0 = success (stdout parsed as JSON if it is one object), 2 = blocking error on blockable events, other = non-blocking error notice. **Our observer hook always exits 0 and prints nothing.**
- `"async": true` command hooks run in the background without blocking Claude. All observer hooks use this.
- Handler types include `http`, but we use `command` so that we can (a) attach `$PPID` for terminal linking, (b) read the token from a file rather than embedding it in settings, and (c) fail silently.

**Observer hook contract** (`packages/hook/bin/yardmaster-hook`):
- POSIX `sh` plus `curl`, no Node startup cost.
- Reads stdin, then POSTs to `/api/hooks/claude` over the board's socket (`curl --unix-socket ~/.yardmaster/board.sock`) with headers `X-Yardmaster-Token` (from `~/.yardmaster/token`) and `X-Yardmaster-Claude-Pid: $PPID`. The timeout is `-m 1`. It posts only if the socket is a socket owned by the user (not a link), and never uses TCP.
- If the token file or the socket is missing, the server is down, or anything else fails, it exits 0 silently.
- It must never print to stdout. Output could be interpreted as a hook decision.

**Away-mode permission hook** (`packages/hook/bin/yardmaster-hook-permission.mjs`, sync, not async):
- Runs on Node. The installer writes the absolute path of the Node binary that runs Yardmaster into the hook command, because hooks may run without the user's shell `PATH` (nvm).
- Exits 0 immediately with no output unless the board reports away mode is ON (`GET /api/away` over the socket, 300 ms timeout).
- When away mode is on: POST the request, long-poll for a decision (≤ configurable, default 120 s). The board answers only `allow`, `allow_always` or `deny` with a reason. The hook builds the `PermissionRequest` output itself: "always allow" applies the `permission_suggestions` from Claude Code's own hook input, never rules from the server, and it never emits `updatedInput`. Anything else from the server is ignored. On timeout or error it exits 0 with no output, and the normal terminal prompt appears.
- A handler installed before this (the observer script with `--permission`) gives no decision; any `yardmaster hooks install` replaces it.

**Installer** (`yardmaster hooks install|uninstall|status`): merges idempotently into `~/.claude/settings.json`, identifies its own entries by the `yardmaster-hook` command path, writes a timestamped backup first, supports `--dry-run` (prints a diff), and never touches other hooks. It always asks for confirmation unless `--yes` is passed.

**Statusline forwarder** (`yardmaster statusline install|uninstall|status`, optional): Claude Code gives its statusline command JSON that hooks don't, the account's `rate_limits` above all. The installer sets `statusLine` to `yardmaster-statusline`, with the user's previous command as its argument, so `settings.json` itself holds what `uninstall` restores; it writes a backup and takes `--dry-run`. The script posts its stdin to `POST /api/hooks/statusline` over the local socket in the background (1 s limit), runs the previous command on the same stdin in bash, and passes on its stdout and exit status. Without a socket it posts nothing, so the statusline is never slower for it. The board reads `rate_limits.five_hour` and `seven_day`, `cost`, `context_window` and `worktree`; `rate_limits` is absent for API keys and some team plans, and before a session's first reply. The last limits are kept in `board.db`.

### 6.2 Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, verified against 0.3.308 typings)

- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options })` returns a `Query` (an async generator of `SDKMessage`) with `interrupt()`, `setPermissionMode()`, `setModel()` and `close()`.
- Relevant `Options`: `cwd`, `resume`, `forkSession`, `sessionId`, `model`, `permissionMode` (`default | acceptEdits | bypassPermissions | plan | dontAsk | auto`), `canUseTool`, `allowedTools`, `disallowedTools`, `includePartialMessages`, `settingSources` (omitted means user+project+local, like the CLI), `maxTurns`, `maxBudgetUsd`, `abortController`, `env`, `pathToClaudeCodeExecutable`.
- `CanUseTool(toolName, input, { signal, suggestions, blockedPath, … })` returns `{ behavior: 'allow', updatedInput?, updatedPermissions? } | { behavior: 'deny', message, interrupt? }`.
- `SDKMessage` includes a `system/session_state_changed` message with `state: 'idle' | 'running' | 'requires_action'`, which drives board-session status directly.
- History helpers: `listSessions({ dir, limit, offset })`, `getSessionInfo`, `getSessionMessages(sessionId, { dir })`, `getSubagentMessages`, `forkSession`, `renameSession`, `tagSession`.
- **Auth:** board sessions run through the locally installed, signed-in Claude Code of whoever runs Yardmaster: the SDK picks up whatever auth Claude Code already has. Yardmaster never reads, stores, transmits or asks for credentials. If `ANTHROPIC_API_KEY` is set in the server's environment, the SDK bills that key instead. `doctor` warns about this.
- Multi-turn: use streaming input mode, where the prompt is an async queue we push user messages into.

### 6.3 Transcripts (`~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`)

- The format is **undocumented and changes between versions**. Prefer the SDK helpers (`getSessionMessages`) for history. Raw-tail the file only for live increments, and parse defensively: only `type: "user" | "assistant"` lines with `message.content[]` blocks (`text`, `thinking`, `tool_use`, `tool_result`). Ignore unknown types. Never crash on a bad line.
- Token usage comes from `assistant.message.usage`.

### 6.4 Live sessions (optional enrichment)

- **`claude agents --json`** is the supported read. It prints a JSON array of live sessions: `pid`, `sessionId`, `cwd`, `kind` (`interactive`, `background`), `startedAt`, `name`, `status` (`busy`, `idle`, `waiting`), `waitingFor`, and `state` for background jobs. `pid` and `sessionId` can be missing on a background job; those rows are skipped. Checked on Claude Code 2.1.308, on one machine: it listed every live registry file, which covered entrypoints `cli`, `sdk-ts` and `sdk-cli`, so terminal and SDK sessions both appear. Nothing there separates a session in a Cursor/VS Code terminal from any other `cli` session, and that case wasn't tested on its own.
- Run with `execFile` every 30 s and when a board connects (at most every 5 s). It's feature-detected and never required: if it fails or prints something else, the registry below serves for 10 minutes and it's tried again. `YARDMASTER_CLAUDE_BIN` overrides the binary.
- Hooks and transcripts stay the primary source. The list finds sessions and corrects a terminal session's status only when the board's has sat unchanged for 30 s and disagrees: a missed `Stop`, a missed prompt, a prompt answered in the terminal, a question hooks didn't report. It leaves failures, the `idle_prompt` wait, approvals the board holds, board sessions, and `dialog open` (a slash-command panel) alone.
- **Fallback:** current Claude Code versions write `~/.claude/sessions/<pid>.json`, undocumented, with `pid`, `sessionId`, `cwd`, `status`, `kind`, `entrypoint`, `name` and `waitingFor`. It's read only when the list isn't available, only as a feature-detected hint, with a try/catch around every read, and never corrects a status hooks set. Never read other files in `~/.claude` beyond transcripts and this registry. Never read credentials.

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
2. **WebSocket origin check:** `/ws/ui` accepts only `Origin` equal to the board's own origin (plus the Vite dev origin in dev, `http://127.0.0.1:4327`, a fixed and unusual port so no other project's dev server shares its storage). A socket without a valid browser session is accepted and closed at once with code 4401, before any data. `/ws/editor` is served only on the local socket and requires the token header (item 13).
3. **Auth:** a per-install random token in `~/.yardmaster/token` (0600) for the CLI, the extension and the hooks. Browsers never get the token, and nothing signs in through a cookie: browsers send a host's cookies to every port on it, so any dev server on `127.0.0.1` (or a phone's `ts.net` name) would receive it. Instead each browser gets its own **session secret** at a sign-in moment and keeps it in the board origin's storage (`localStorage`, with an IndexedDB copy for the service worker). It sends it as the `X-Yardmaster-Session` header on fetches, and as a `Sec-WebSocket-Protocol` entry on `/ws/ui` (the server answers with the plain `yardmaster` protocol, never the secret). Requests and fetches send no cookies, and the server ignores every cookie.
   - **Sign-in moments:** a one-time code, `/auth?c=<code>` (single use, 5 minutes, held in memory), or phone pairing (item 12). `yardmaster start` mints a code in-process; `yardmaster open` and the extension's Open Dashboard get one from `/api/local/dashboard-link` over the local socket, with the token. The answer is a `no-store`, `no-referrer` page that hands the secret to the origin's storage and opens the board; it also expires the cookies of older versions. `/auth?t=<token>` (the old link, which put the token in browser history) shows a "use the new sign-in link" page and never signs in. A secret is never minted from an older credential alone.
   - **Session records:** the server keeps each session's id, kind (local, or remote for a phone), a label from the User-Agent, created and last-used times, and a sha256 of its secret, never the secret. Settings → Data and security lists them and can sign any of them out (a phone only itself, item 11), which closes its open sockets (4401) and drops its push subscriptions. Remote sessions end after 30 days unused (sliding; an open board socket's messages count as use, and an hourly sweep ends lapsed sessions and closes their sockets even if nothing asks for them); local ones last until signed out. A local session counts only on the loopback host and a remote one only over Tailscale.
   - **Rotation** (`POST /api/token/rotate`) ends every session, forgets every live code, and closes every open board and editor socket, so they re-authenticate; the calling browser is handed a new session. Sessions are sealed to the token they were made under, so a token changed on disk while the board was down (`yardmaster token --rotate`) ends them all at the next start.
   - Every `/api` route except `/api/health` requires a browser session or the token header.
4. **No credentials:** Yardmaster never reads `~/.claude/.credentials*`, the Keychain or `~/.claude.json`, and it never asks for an API key. Board sessions run through each user's own signed-in Claude Code.
5. **No telemetry,** no external network calls at runtime. Fonts and assets are bundled.
6. **Rendering safety:** markdown is rendered without raw HTML. Terminal output goes only to xterm (never `innerHTML`).
7. **Secrets in output:** terminal and transcript data stays in memory and local sqlite under `~/.yardmaster`. A "redact" setting masks common secret patterns in the UI (`sk-ant-…`, `ghp_…`, `AKIA…`, `-----BEGIN … KEY-----`, `.env`-style `KEY=value` for names containing SECRET|TOKEN|KEY|PASSWORD).
8. **Shell safety:** the server never builds shell strings from user input. Use `execFile` with argument arrays. The hook installer writes JSON with a JSON serializer.
9. **Repository hygiene (public repo):** nothing machine-specific or personal is ever committed. That covers real home paths, usernames, emails other than GitHub noreply, real project names, real transcripts and tokens. Fixtures are synthetic (`/home/dev/acme-shop`). `scripts/privacy-check.sh` runs in pre-commit, in the build loop, and in CI.
10. **Project library:** the server lists only the top-level directory names of the configured roots and checks `.git` existence. It reads nothing else under a root until a project is opened, and every path from the UI is `realpath`-checked to be inside a root (no `..`, no symlink escape). Editor launches go through `execFile` with the folder as a single argument.
11. **Remote hosts:** off by default. Allowed hosts are an explicit list (Tailscale `*.ts.net` names), HTTPS only, and the server still binds `127.0.0.1`. Public tunnels (ngrok, Cloudflare and the like) are unsupported, and the docs say why: the board can type into terminals. A request is remote if its `Host` is an allowed name **or** it carries any header `tailscale serve` adds (`Tailscale-User-*`, `X-Forwarded-For|Proto|Host`, `Forwarded`), whatever its `Host`, so a tailnet peer can't pass as this machine with `Host: 127.0.0.1`. Funnel requests (`Tailscale-Funnel-Request`) get 403 `funnel_unsupported`.
   - **Least privilege:** a phone does its day-to-day work (terminals, chat, approvals, notifications and their settings, Open on phone, closing projects, away mode, pins) but can't change what reaches this Mac's disk, editor or sign-ins. Over a remote request, 403 `local_only`: `PUT /api/settings` touching `editorCli`, `libraryRoots`, `remoteAllowedHosts` or `retentionDays` (the whole patch is refused), `POST /api/token/rotate`, `/api/hooks/plan|install`, `/api/remote/pair`, signing out any session or device but its own, and removing, test-pushing or re-subscribing another device's notification subscription. The hook routes are local-channel only (item 13).
12. **Pairing:** a phone signs in with a one-time code (5 min, single use) shown as a QR code, never the raw token. `/pair?c=<code>` starts a remote session the same way `/auth?c=` starts a local one (item 3). Paired devices are listed and can be revoked.
13. **Local channel for editors and hooks:** anything can bind `127.0.0.1:<port>` while Yardmaster isn't running (another user, a container with host networking), so the extension and the hooks never send the token to the TCP port or act on what it says. The server also listens on a Unix domain socket, `~/.yardmaster/board.sock` (data dir 0700, socket 0600; on start it removes a stale socket only if it is a socket owned by the user, and leaves anything else alone). Only the user can create a socket there, so a client that checks it is a socket owned by the user, not a link, knows it talks to this install's board. `/ws/editor`, `/api/hooks/claude`, `/api/hooks/permission`, `/api/away` and `/api/local/dashboard-link` are served only there (over TCP they answer 403 `local_channel_required`), and still require the token header. The socket serves `/api/*` and `/ws/editor` only, never the web app or `/ws/ui`, and refuses any request with an `Origin`. The extension's Open Dashboard opens the one-time sign-in link the server returns over the socket, on loopback only. Extension settings come from user settings only (`yardmaster.enabled` is machine-scoped; there is no port setting), so a cloned repo's `.vscode/settings.json` can't redirect or switch off the link. The away-mode hook builds its own decision (§6.1), so the server can't inject `updatedInput` or permission rules. Supported platforms are macOS and Linux, which both have Unix sockets.
14. **Folder trust for board sessions:** headless SDK runs load a folder's `.claude/settings*.json` and `.mcp.json` without the CLI's "trust this folder?" dialog. Before a board session starts, resumes or forks in a folder, the server scans those files for anything that runs code or widens permissions: hooks, allow rules, a `defaultMode` other than `default`/`plan`, extra directories, command settings (`apiKeyHelper`, `statusLine`, `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`, `fileSuggestion`), env (names only, values are never shown), MCP servers and plugins. An unreadable, oversized or invalid file counts too. If anything is found, nothing starts (`folder_untrusted`) until the user trusts exactly that list on a trust card, which phones get too (`folder.trust` with the hash the card showed; a stale hash answers `trust_changed`). The trusted list (path plus a sha256 of what was found) is the `trust.folders` setting in `board.db`, so any change to those settings asks again. A folder with none of these is trusted silently.
15. **Shell markers and reruns:** each board terminal gets a random nonce in `YARDMASTER_NONCE`. Our zsh and bash integration moves it into an unexported shell variable before any user file runs and signs OSC 633 `E`, `P;Cwd=` and OSC 7 with it. Unsigned markers are dropped (and stripped from the output), prompt and run markers count only after a signed one, and a run is recorded only after a signed command line, so output can't plant a past command. Before any rerun (board, editor or demo terminal) the server refuses command lines with control characters other than tab, or with bidi overrides (`unsafe_command_line`). The UI shows such characters as Control Pictures (`␛`) or `<U+202E>`, never hidden, and offers no rerun for them.
16. **Repository config and local files:** git runs with `GIT_CONFIG_NOSYSTEM=1` and `core.fsmonitor=false`. The scanner first lists the repository's own config (local and worktree scope, includes followed) and runs no git status or log for a repo that defines `filter.*`, `core.fsmonitor`, `core.hooksPath` or a `*command` key ("git status skipped: repository config runs commands"). Status runs with `--ignore-submodules=all`, since git would otherwise run inside each submodule under its own config (`.git/modules/<name>/config`), which the check doesn't see. On start the data dir (a link's target, such as a migrated `~/.c-board`, included) is tightened to 0700 and `board.db` with its WAL files is created or tightened to 0600; `yardmaster doctor` reports both. `project.openInEditor` launches the realpath that passed the library check.

17. **Route inventory.** Every endpoint and its guard. "Session or token" is a browser session (the `X-Yardmaster-Session` header or WS subprotocol) or the token header on loopback TCP; on the socket only the token counts, and over Tailscale only a remote session. Board actions (terminals, sessions, approvals, folder trust) travel over `/ws/ui` and take its guard; `settings.set` there is not implemented, so settings change only through `PUT /api/settings`. Every request also passes the Host, Origin, Funnel and HTTPS checks of items 1, 2 and 11, and the socket refuses any `Origin` and anything outside `/api/*` and `/ws/editor`. No route that changes state is reachable without a guard.

| Endpoint | Channel | Guard |
|---|---|---|
| `GET /api/health` | TCP, socket | none (version only) |
| `GET /auth?c=` | loopback TCP | one-time sign-in code; remote 403 `pair_required` |
| `GET /pair?c=` | Tailscale | one-time pairing code; loopback 403 `remote_only` |
| `GET /*` (web app) | TCP | none (static files, no data) |
| `GET /ws/ui` | TCP | Origin required; session or token, else closed 4401 |
| `GET /ws/editor` | socket only | token header; TCP 403 `local_channel_required` |
| `POST /api/hooks/claude`, `POST /api/hooks/permission`, `GET /api/away`, `POST /api/local/dashboard-link` | socket only | token header; TCP 403 `local_channel_required` |
| `GET /api/status`, `/api/library`, `/api/projects/:id/sessions`, `/api/settings`, `/api/hooks`, `/api/push`, `/api/ports/shares`, `/api/sessions`, `/api/remote/devices` | TCP, socket | session or token |
| `PUT /api/settings` | TCP, socket | session or token; remote 403 `local_only` for `editorCli`, `libraryRoots`, `remoteAllowedHosts`, `retentionDays` |
| `POST /api/hooks/plan`, `POST /api/hooks/install`, `POST /api/token/rotate`, `POST /api/remote/pair` | TCP, socket | session or token; remote 403 `local_only` |
| `GET`/`POST /api/seen` | TCP, socket | browser session (the token alone: 403); always the calling browser's own record |
| `DELETE /api/sessions/:id`, `DELETE /api/remote/devices/:id` | TCP, socket | session or token; remote only its own session |
| `POST /api/push/subscriptions` | TCP | browser session (the token alone: 403); the subscription belongs to the calling session; remote can't take over another device's endpoint |
| `DELETE /api/push/subscriptions/:id`, `POST /api/push/test` | TCP, socket | session or token; remote only its own subscriptions |
| `POST /api/approvals/:id/decision` | TCP, socket | session or token; `allow` or `deny` only, never `allowAlways` |
| `POST`/`DELETE /api/ports/:port/share` | TCP, socket | session or token; only ports the board saw a project listen on, never the board's own |
| `GET /api/push/outbox`, `POST /api/push/drill` | TCP, socket | session or token; demo mode only |

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
- **M3.5 Layouts:** Office and Grid layouts with the shared Actor inspector.
- **M3.6 Workspaces:** project library and launch, board terminals, phone access.
- **M4 Stretch:** away mode, terminal reply, board-owned PTYs, launch profiles.

## 13. Decisions

- **Distribution:** v1 installs from source, with the editor extension as a `.vsix` from CI artifacts. Publishing to npm (`npx yardmaster`) and the VS Code Marketplace / Open VSX may follow later.
- **License:** MIT (`LICENSE`). The adapted React Bits effects keep their own terms (`THIRD_PARTY_NOTICES.md`).
