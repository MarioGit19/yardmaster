# Changelog

## Unreleased

- Worktrees sit behind their main checkout in every project list, and the git panel lists them.
- Review changes: a file-by-file diff against what the branch came from, with viewed marks, Commit, Discard and Ask Claude to fix, on desktop and phone.
- A read-only pull request and checks badge when `gh` is signed in, and New parallel session through `claude --worktree`.
- Search across every transcript: a local index of what you and Claude said, in ⌘K and a Search view with project, date and status filters. A result opens the transcript at its message. Settings → Data and security shows its size, sets a limit, and rebuilds or clears it. Forgetting a project removes it from the index, and nothing leaves your computer.
- Starting twice at once on a fresh install, or rotating the token while another start reads it, can no longer leave the two with different tokens.

## 0.1.0 (2026-10-30)

First public release.

### The board

- One live dashboard for every project you have open: Cursor/VS Code terminals, dev servers and Claude Code sessions, with waiting and failing work first.
- Five layouts (Minimal, Office, Grid, Transit, Retro), light and dark themes, a command palette and a Motion setting (Full, Reduced, Off).
- Pulse: a cross-project activity timeline, with git status, ports and daily stats per project.
- Open project: pick root folders once, then launch any project into Cursor, a Claude session and its terminals in one step.

### Terminals

- The editor extension mirrors terminals with colored output, commands, exit codes, CPU, memory and listening ports. Send input or Ctrl+C, re-run a command, or jump to the terminal in Cursor.
- Board terminals: fully interactive terminals for projects with no editor window open.

### Claude Code

- Hooks report every session's status live, with its current tool, todos, subagents, tokens and context. Transcripts show history plus a live tail, with tool calls as cards and diffs.
- Start and chat with Claude sessions from the board through the Claude Agent SDK, using your own signed-in Claude Code. Interrupt, switch model or permission mode, and resume past sessions.
- Approve, always allow or deny permission requests from the board or your phone. Away mode sends terminal sessions' prompts to the board too.

### Phone

- Use the board from your phone over your own Tailscale network: QR pairing, phone-ready screens, push notifications for approvals, and Open on phone for dev servers.

### Security

- The server listens on `127.0.0.1` only. The extension and the hooks talk to it through an owner-only socket in `~/.yardmaster`.
- One-time sign-in links, a separate session for each browser and phone, and Settings → Data and security to sign any of them out.
- Phones can't change settings that reach your computer's disk, editor or sign-ins.
- A trust card before the first board Claude session in a folder whose Claude settings or `.mcp.json` can run commands. Git status is skipped for repositories whose config runs commands.
- Notifications mask secrets before they reach the lock screen.
- See [SECURITY.md](SECURITY.md) for what Yardmaster protects against and how to report a problem.
