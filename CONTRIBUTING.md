# Contributing to Yardmaster

Thanks for helping. This guide covers the setup, the commands, and the conventions a change needs to follow.

Read these first:

- [docs/PRD.md](docs/PRD.md): the product, the architecture and the security requirements.
- [docs/DESIGN.md](docs/DESIGN.md): the UI and motion spec. UI changes follow it exactly.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the parts fit together.

## Setup

You need macOS or Linux, Node.js 22 or newer and pnpm 9. Claude Code is only needed to try real board sessions; demo mode runs without it.

```bash
git clone <this repository's URL> yardmaster && cd yardmaster
pnpm i                   # also installs the pre-commit hook (privacy check and lint)
pnpm exec playwright install chromium   # for the e2e tests and screenshots
pnpm dev:demo
```

`pnpm dev:demo` runs the server and the web app in watch mode with synthetic demo data, on http://127.0.0.1:4327. Demo mode never touches your real terminals, Claude sessions or `~/.claude`.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Server and web app in watch mode, against your real editors and Claude sessions. |
| `pnpm dev:demo` | The same, with synthetic demo data. |
| `pnpm check` | Privacy check, lint (Biome), typecheck and unit tests (Vitest). Must pass before a change is done. |
| `pnpm e2e` | Playwright tests against the demo board. |
| `pnpm shots` | Screenshots of every screen into `artifacts/shots/` (gitignored). |
| `pnpm motion:record [scenario]` | Records the demo at motion level Full and writes contact sheets to `artifacts/motion/`. See [e2e/motion/README.md](e2e/motion/README.md). |
| `pnpm format` | Applies Biome's formatting and safe fixes. |

When you start the server yourself (`pnpm yardmaster start`), pass `--no-open` if you don't want it to open a browser.

## Engineering conventions

- pnpm workspaces, TypeScript strict, ESM, Node 22 or newer. Biome for lint and format.
- Shared types and schemas live only in `packages/protocol`. Don't duplicate them.
- Validate every external input (WebSocket and HTTP messages, hook payloads, transcript lines) with zod. Never throw on bad input from outside: log it and skip it.
- Spawn processes with `execFile` and argument arrays only, never shell strings.
- The server binds `127.0.0.1` only. Every new route goes through the auth guard (PRD §8) and gets a row in its route inventory.
- Tests: Vitest for units, Playwright for e2e against `--demo`. Tests never call the real Claude API: mock `@anthropic-ai/claude-agent-sdk`.
- Yardmaster never reads Claude credentials (`~/.claude/.credentials*`, the Keychain, `~/.claude.json`) and never requires an API key. Board sessions run through the user's own signed-in Claude Code.
- Keep comments sparse and useful, and match the style of the code around them.

### UI and motion

- Follow [docs/DESIGN.md](docs/DESIGN.md): its tokens, springs and performance rules. Animate only `transform`, `opacity` and `filter`, and respect the motion level (Full, Reduced, Off).
- Everything clickable shows the pointer cursor: use a real `button` or link, or an interactive role, or add `cursor-pointer`. Never leave an `onClick` on an element that shows the arrow.
- UI changes come with screenshots from demo mode (`pnpm shots`). After changing an animation, run `pnpm motion:record` and look at the contact sheets.
- Visual effects adapted from third-party code go in `apps/web/src/fx/`, keep the upstream notice in the file header and get a row in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- To refresh the README images, run `pnpm shots` and `pnpm e2e`, then `scripts/readme-shots.sh`.

## Privacy

This is a public repository. Never commit personal or machine-specific data:

- no absolute home paths, usernames or real email addresses (use your `@users.noreply.github.com` address for commits),
- no real project or company names, real transcripts or terminal logs,
- no tokens or keys.

Test fixtures and demo data are synthetic: paths like `/home/dev/acme-shop`, made-up UUIDs and fictional project names. Build fake secrets in tests by string concatenation, or mark the line with `privacy-check:allow`.

`scripts/privacy-check.sh` runs in the pre-commit hook and in `pnpm check`. If it fails, fix the content instead of bypassing the check. You can list extra personal terms to block, one per line, in a git-ignored `.privacy-denylist` file at the repo root.

## Pull requests

- Keep commits small and focused, with a message that says what changed and why.
- `pnpm check` and `pnpm e2e` pass.
- A change to the editor extension (`apps/extension`) needs a rebuilt extension to try: `pnpm --filter yardmaster-extension package`, then install `apps/extension/dist/yardmaster.vsix` in your editor and reload its windows.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
