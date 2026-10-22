# c-board: working rules for Claude

c-board is a local dashboard that mirrors every Cursor/VS Code terminal and Claude Code session across projects. Read `docs/PRD.md` for the product and architecture, `docs/DESIGN.md` for the UI and motion, and `PLAN.md` for the task list.

## Privacy (public repo, hard rules)

- **Never commit personal or machine-specific data:** absolute home paths, usernames, real emails (only `*@users.noreply.github.com` and `noreply@anthropic.com` are allowed), real project or company names, real transcripts, terminal logs, tokens or keys.
- Test fixtures and demo data are **synthetic**. Use paths like `/home/dev/acme-shop`, made-up UUIDs and fictional project names. Build fake secrets in tests by string concatenation, or mark the line with `privacy-check:allow`.
- Never read Claude credentials (`~/.claude/.credentials*`, Keychain, `~/.claude.json`) and never require an API key. c-board runs on each user's own Claude Code login.
- Run `scripts/privacy-check.sh` before every commit. A failure blocks the commit, so fix the content instead of bypassing the check.

## Engineering conventions

- pnpm workspaces, TypeScript strict, ESM, Node ≥ 22. Biome for lint and format.
- Shared types and schemas live only in `packages/protocol`. Never duplicate them.
- Validate every external input (WS, HTTP, hook payloads, transcript lines) with zod. Never throw on bad input from outside; log it and skip.
- Spawn processes with `execFile` and argument arrays only, never shell strings.
- Server binds `127.0.0.1` only. Every new route goes through the auth guard (PRD §8).
- Tests: Vitest for units, Playwright for e2e against `--demo`. Tests never call the real Claude API (mock `@anthropic-ai/claude-agent-sdk`).
- UI: follow `docs/DESIGN.md` exactly (tokens, springs, performance rules). Animate only transform, opacity and filter. Respect the motion level.
- Keep comments sparse and useful. Match the style of the surrounding code.

## Commands (available once Phase 0 is done)

- `pnpm dev`: server and web in watch mode. `pnpm dev:demo` does the same with synthetic data.
- `pnpm check`: privacy check, lint, typecheck and tests. It must pass before a task is ticked.
- `pnpm e2e` / `pnpm shots`: Playwright tests and screenshots (into `artifacts/shots/`, gitignored).

## Git

- Small, focused commits. One commit per PLAN task, with the message `<task id>: <title>` and a short body.
- Commits are signed through the repo's local git config. Don't change the git config, the identity or the remote.
- Never commit `loop/logs/`, `artifacts/`, `.c-board/` or `.privacy-denylist`.
