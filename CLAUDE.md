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

## Skills & tools

Installed for this project: the plugins in `.claude/settings.json`, and the skills in `.claude/skills/` (run `scripts/setup-skills.sh` to install or refresh them). Use them as follows:

| When | Use |
|---|---|
| Any library API you aren't 100% sure of (Motion 14, Vite 8, Tailwind 4, xterm 6, zod 4, Fastify 5, Agent SDK, VS Code API) | **Context7** MCP: resolve the library, then fetch docs for the exact version in `package.json`. Our stack is newer than your training data. |
| Building any UI component or view | `frontend-design` + `emil-design-eng` |
| Adding or changing an animation | `animate` (decide purpose, properties, curve and duration first), then `apple-design` for springs, gestures and depth |
| After finishing a UI task | `review-animations` on the motion you added, plus an `impeccable` critique of the screen. Fix what they flag, if it doesn't contradict DESIGN.md. |
| Charts, sparklines, stat tiles, HUD counters | `dataviz` |
| Performance work (11.1, 10.10) or a janky animation | `animation-performance` + `react-best-practices` |
| Polish, a11y and audit tasks (11.2, 11.4) | `web-design-guidelines` + `impeccable` audit/polish |
| Edge-case hardening of data-heavy components | `break-ui` |
| Looking for places that should animate but don't | `find-animation-opportunities` (proposes only; you implement what fits DESIGN.md) |

`review-animations` is user-invocable only (`disable-model-invocation`). To use it, Read `.claude/skills/review-animations/SKILL.md` and follow it.

Precedence: **PRD/DESIGN.md > this file > skill advice.** If a skill wants a different font, palette or aesthetic, keep ours.

## Commands (available once Phase 0 is done)

- `pnpm dev`: server and web in watch mode. `pnpm dev:demo` does the same with synthetic data.
- `pnpm check`: privacy check, lint, typecheck and tests. It must pass before a task is ticked.
- `pnpm e2e` / `pnpm shots`: Playwright tests and screenshots (into `artifacts/shots/`, gitignored).
- When you start the server yourself (`c-board start`, `src/cli.ts start`), always pass `--no-open`. Never open the maintainer's browser.

## Git

- Small, focused commits. One commit per PLAN task, with the message `<task id>: <title>` and a short body.
- The maintainer is the **sole author**. Never add `Co-Authored-By` trailers or any AI or tool attribution to commits or PRs.
- Commits are signed through the repo's local git config. Don't change the git config, the identity or the remote.
- Never commit `loop/logs/`, `artifacts/`, `.c-board/` or `.privacy-denylist`.
