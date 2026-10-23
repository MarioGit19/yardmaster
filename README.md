# c-board

**Mission control for your local dev work.** See every project you have open in one live, animated dashboard: every Cursor/VS Code terminal, every dev server, and every Claude Code session. You can act on them from there too: approve Claude's permission requests, chat with Claude, restart a crashed backend, or send Ctrl+C.

> Status: planning / early development. See [PLAN.md](PLAN.md).

## How it works

- A small **editor extension** (works in Cursor and VS Code) streams your integrated terminals to a local server.
- **Claude Code hooks** report the status of every Claude session (thinking, running a tool, waiting for approval, done) to the same server.
- The **dashboard** (served at `http://127.0.0.1:4317`) shows it all live, and can start its own headless Claude sessions through the Claude Agent SDK.

Your existing workflow doesn't change. You keep using Cursor and its terminals exactly as before.

## Running it

```bash
pnpm install
pnpm board        # builds once, then serves the board on http://127.0.0.1:4317
pnpm dev          # development: server and web in watch mode
```

Use `pnpm board` for the board you work with day to day. `pnpm dev` restarts the server on every edit under `apps/server/src`, and a restart stops the board's own Claude sessions. They come back as **interrupted**, with a Resume button, but a turn that was running is cut off. `c-board doctor` warns when board sessions are running on a watched server.

## Privacy

- Runs entirely on your machine, bound to `127.0.0.1`. No telemetry and no cloud.
- Uses **your own** Claude Code login or subscription. c-board never reads your credentials or asks for an API key.

## Docs

- [Product requirements](docs/PRD.md)
- [Design and motion spec](docs/DESIGN.md)
- [Build plan](PLAN.md)

## Building with the loop

This repo is built task by task by an unattended Claude Code loop:

```bash
loop/loop.sh            # runs one PLAN.md task per iteration, commits, pushes
touch loop/.state/STOP  # stop after the current iteration
```

The loop pauses at tasks tagged **[HUMAN]**, such as installing the hooks and the extension on your machine.
