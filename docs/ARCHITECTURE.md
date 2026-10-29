# Architecture

How Yardmaster's parts fit together. This is the public summary of [PRD](PRD.md) §5–7; the PRD stays the source of truth for requirements, and `packages/protocol` for every message and type.

## Overview

```
 Cursor window A ─ Yardmaster extension ─┐
 Cursor window B ─ Yardmaster extension ─┼── WS /ws/editor ──▶┌──────────────────────────────┐
 VS Code window …                     ───┘                    │  Yardmaster server (Node, TS) │◀── WS /ws/ui ──▶ Browser UI
                                                              │  127.0.0.1:4317               │                 (React, Vite)
 Every Claude Code session (any terminal, -p, SDK)            │                               │
   └─ hooks (command, async) ─ POST /api/hooks/claude ───────▶│  • state store + patches      │
                                                              │  • hook ingest / status FSM   │
 ~/.claude/projects/**.jsonl ◀── tail / SDK readers ──────────│  • transcript reader          │
                                                              │  • process + port scanner     │
 Agent SDK query() sessions ◀── runs in-process ──────────────│  • session runner (SDK)       │
                                                              │  • sqlite (node:sqlite)       │
                                                              └───────────────────────────────┘
```

Four inputs feed one in-memory state store on the server: editor extensions (terminals and their output), Claude Code hooks (session status), transcripts (session content) and a process and port scanner. The store sends the browser a snapshot on connect and coalesced patches after that. Every user action travels back the same socket, is validated, and becomes a command to an extension, an Agent SDK call or a store change.

## Packages

pnpm workspaces, TypeScript (strict, ESM), Node ≥ 22.

| Path | Purpose |
|---|---|
| `packages/protocol` | Shared TypeScript types and zod schemas: domain model, WebSocket messages, hook payloads. The single source of truth. |
| `apps/server` | Fastify HTTP + WebSocket server, state store, ingest, scanners, Agent SDK session runner, and the `yardmaster` CLI. |
| `apps/web` | The dashboard, a React SPA built with Vite. The server serves the built assets. |
| `apps/extension` | VS Code-compatible extension (works in Cursor). Streams terminals and runs commands from the board. |
| `packages/hook` | The hook script, plus the settings installer and uninstaller. |

## Technology

| Concern | Choice |
|---|---|
| Runtime | Node ≥ 22. `node:sqlite` is built in, so the core has no native dependencies. |
| Server | Fastify 5, `@fastify/websocket`, pino |
| Validation | zod 4, on every external input (WebSocket, HTTP, hook payloads, transcript lines). Bad input is logged and skipped, never thrown. |
| Claude | `@anthropic-ai/claude-agent-sdk`: `query()`, `canUseTool`, `listSessions`, `getSessionMessages`, `forkSession` |
| Web | React 19, Vite 8, Tailwind CSS 4, Motion (`motion/react`), zustand |
| Terminal rendering | `@xterm/xterm` 6 with the fit, WebGL and search addons |
| 3D (Grid layout only) | `three` and its `CSS3DRenderer`, lazy-loaded, one WebGL context, with a 2D fallback |
| Board terminals | `node-pty` |
| Fonts | Geist and Geist Mono, self-hosted |
| Extension | `engines.vscode ^1.93.0` (stable shell-integration execution API), esbuild, `@vscode/vsce` |
| Tooling | Biome, Vitest, Playwright |

## Ports, files and data

- Port `4317` by default (`YARDMASTER_PORT`), bound to `127.0.0.1` only.
- Data directory `~/.yardmaster/` (`YARDMASTER_HOME`, 0700): `token` (0600, 32 random bytes, base64url), `board.sock` (0600), `board.db` (SQLite), `logs/` and `settings.json`.
- The extension and the hook scripts talk to the server only through `~/.yardmaster/board.sock`, a Unix socket only the user can create, never the TCP port that any program could bind first.

## Integrations

### Claude Code hooks

The installer (`yardmaster hooks install|uninstall|status`) registers command hooks in `~/.claude/settings.json`. User-level hooks apply to interactive, `claude -p` and Agent SDK sessions. It merges idempotently, recognizes its own entries by the `yardmaster-hook` command path, writes a timestamped backup first, supports `--dry-run`, never touches other hooks, and asks before writing unless `--yes` is passed.

Subscribed events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, and in away mode `PermissionRequest`.

**Observer hook** (`packages/hook/bin/yardmaster-hook`): POSIX `sh` and `curl`, no Node startup. It reads the event from stdin and POSTs it to `/api/hooks/claude` over the board's socket, with the token (read from `~/.yardmaster/token`, never embedded in settings) and Claude's PID (`$PPID`), with a 1 s timeout. It runs `async`, so Claude never waits for it. It always exits 0 and never prints, because hook output can be read as a decision.

We use `command` hooks rather than `http` ones so the hook can attach `$PPID` for terminal linking, read the token from a file, and fail silently when the board is off.

**Away-mode permission hook** (`packages/hook/bin/yardmaster-hook-permission.mjs`, synchronous, run by the absolute Node path the installer writes): exits at once with no output unless the board reports away mode. When it is on, the hook posts the request over the socket and long-polls for the board's decision (120 s by default): allow, always allow, or deny with a reason. It writes the `PermissionRequest` output itself, taking "always allow" rules only from Claude Code's own `permission_suggestions` and never emitting `updatedInput`. On a timeout or an error it exits quietly, and the normal terminal prompt appears.

### Claude session status

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

With no hook for a live process the status falls back to "unknown, alive"; once the process is gone the session is marked ended.

### Claude Agent SDK

Board sessions run in-process with `query()` in streaming-input mode: the prompt is an async queue the server pushes each user message into. The `Query` handle provides `interrupt()`, `setPermissionMode()` and `setModel()`. Approvals come through `canUseTool`, answered with allow (optionally with updated permissions from the suggestions) or deny with a message. The SDK's `session_state_changed` message (`idle`, `running`, `requires_action`) drives a board session's status directly. History uses `listSessions` and `getSessionMessages`.

The SDK uses the local Claude Code login of whoever runs Yardmaster. Yardmaster never reads, stores or sends credentials. If `ANTHROPIC_API_KEY` is set in the server's environment, the SDK bills that key instead, and `doctor` warns about it.

### Transcripts

`~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`. The format is undocumented and changes between versions, so history goes through the SDK helpers and the raw file is only tailed for live increments. The reader keeps `user` and `assistant` lines with `text`, `thinking`, `tool_use` and `tool_result` blocks, ignores unknown types and never fails on a bad line. Token usage comes from `assistant.message.usage`.

Current Claude Code versions also write `~/.claude/sessions/<pid>.json`. Yardmaster uses it only as an optional, feature-detected hint to find sessions that started before it did. It reads nothing else under `~/.claude`, and never credentials.

### Editor extension

The extension activates on `onStartupFinished` and uses the terminal and shell-integration APIs (stable since VS Code 1.93): it lists terminals, follows their state, and for each command reads the output stream from inside the start event (`execution.read()`), plus the command line, cwd and exit code. It can send text, interrupt, create, focus and close terminals.

Output is only captured for commands that start after the extension activates; a process that was already running shows up with "output unavailable, restart to capture". Raw output keeps ANSI for xterm; the server strips VS Code's OSC 633 sequences.

### Processes and ports

- `ps -axo pid=,ppid=,pcpu=,rss=,etime=,command=` every 2 s builds a process tree, which gives each terminal's CPU and memory.
- `lsof -nP -iTCP -sTCP:LISTEN -F pn` every 5 s finds listening ports (`ss -ltnp` on Linux without `lsof`).
- **Linking a session to its terminal:** the hook sends Claude's PID; the server walks up its ancestors until it reaches a terminal shell PID reported by an extension.

## Protocol

Full schemas live in `packages/protocol`. Every message is a JSON envelope `{ v: 1, type, id?, ts, payload }`.

**Editor → server** (`/ws/editor`, on the local socket only, token required):

- `editor.hello {windowId, appName, appVersion, workspaceFolders[], extensionVersion, capabilities {shellExecution}}`
- `terminal.upsert`, `terminal.sync {terminals[]}` (the full list after every connect), `terminal.closed`
- `exec.start {execId, terminalId, commandLine, confidence, cwd}`, `exec.data {execId, seq, chunk}` (batched every ≤ 50 ms or 16 KB), `exec.interactive {execId}` (the command switched to the alternate screen), `exec.end {execId, exitCode}`
- `editor.heartbeat`

**Server → editor:** `cmd.sendText {terminalId, text, execute}`, `cmd.interrupt {terminalId}`, `cmd.createTerminal {cwd, name, command?}`, `cmd.focusTerminal`, `cmd.disposeTerminal`, `cmd.rerun {execId}`. The extension acknowledges each with `cmd.result {id, ok, error?}`.

**Server → UI** (`/ws/ui`, same-origin only):

- `snapshot {state}` on connect, then `patch {ops[]}` coalesced to at most 30 per second
- `stream.data {streamId, seq, chunk}` for subscribed terminal or execution output
- `toast`, `approval.new`, `approval.resolved`
- `activity {events[], replace}` for the Pulse timeline: the last 15 minutes right after the snapshot, then live batches

**UI → server:** `subscribe` / `unsubscribe {streamId, fromSeq?}`, `action {kind, …}` (every user action, validated with zod), `session.send {sessionId, text}`, `approval.decide {approvalId, decision}`.

## Security

The full list is in [PRD §8](PRD.md#8-security-and-privacy-requirements). In short:

- The server binds `127.0.0.1` and rejects requests whose `Host` is not the board's own (DNS-rebinding defence). `/ws/ui` accepts only the board's origin.
- Editors and hooks connect only through the local socket `~/.yardmaster/board.sock`, and check it is a socket the user owns before they send anything; their routes are refused over TCP.
- A per-install token guards everything for the CLI, the extension and the hooks. Browsers sign in through a one-time link (`/auth?c=`) and get their own session secret, kept in the board origin's storage and sent as a header (a WebSocket subprotocol on `/ws/ui`), never a cookie; phones pair with a single-use QR code. Every session can be signed out from Settings, and rotating the token ends them all.
- Processes are spawned with `execFile` and argument arrays, never shell strings. Markdown renders without raw HTML, and terminal output only ever goes to xterm.
- Remote access is off by default: only allowed Tailscale `*.ts.net` hosts, over HTTPS, while the server still binds `127.0.0.1`.
