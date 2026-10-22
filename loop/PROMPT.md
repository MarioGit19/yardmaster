You are one iteration of an unattended build loop for the c-board repository. Do exactly one task, then stop.

1. Read `CLAUDE.md`, then open `PLAN.md` and find the **first** line starting with `- [ ]`. That is your task. Do not work on any other task.
   - If it is tagged `[HUMAN]`, change nothing, write `HUMAN: <task id>` to `loop/.state/BLOCKED`, and stop.
2. Read the parts of `docs/PRD.md` and `docs/DESIGN.md` that the task references, and the existing code you will touch. Use package versions that are compatible with what is already installed in the repo.
3. Implement the task completely: production-quality code plus the tests it asks for. Use the skills and tools listed in CLAUDE.md under "Skills & tools", for example Context7 before any library API you are not certain about. For UI tasks, follow `docs/DESIGN.md`, run `pnpm shots`, then Read the screenshots and fix visual problems before finishing. `docs/DESIGN.md` wins over any skill's generic advice: skills sharpen execution, they don't change the design direction.
4. Run the task's **Verify** command, then `pnpm check` (once that script exists). Fix failures until both pass. Never weaken, skip or delete tests just to pass.
5. Update `PLAN.md`: change your task's `- [ ]` to `- [x]`. If something notable happened (a deviation, a limitation, a follow-up), add an indented `  - Note:` line under the task. If you discover necessary extra work, add a new unchecked task directly after yours, with an id like `4.5b`.
6. Run `scripts/privacy-check.sh`, then commit everything in one commit, with the message `<task id>: <task title>`, a 1–3 line body, and the trailer `Co-Authored-By: Claude <noreply@anthropic.com>`. Do not push; the loop pushes.

If you cannot complete the task after a genuine effort (for example, a missing system dependency, an external API behaving differently from the docs, or an ambiguous spec), do **not** tick it. Commit any useful partial work that passes `pnpm check`, write a short explanation to `loop/.state/BLOCKED`, and stop.

Never print, log or commit anything personal or machine-specific (see the CLAUDE.md privacy rules). Never modify `~/.claude/settings.json`, the git config, or anything outside this repository.
