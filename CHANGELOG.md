# Changelog

## Unreleased

### Release packaging

- `pnpm build` bundles the server with esbuild into one file, `apps/server/dist/cli.js`, and builds the web app it serves. The workspace packages are inlined, so `node apps/server/dist/cli.js` runs without extra flags. node-pty and the Claude Agent SDK stay outside the bundle.
- `npm i -g .` in a built clone installs the `yardmaster` command (and the deprecated `c-board` alias), linked to the clone.
- CI packages the editor extension and uploads `yardmaster.vsix` as a build artifact.
- The version is now 0.1.0.

### Renamed: c-board is now Yardmaster

The CLI, packages, extension, settings and docs use the new name. Upgrading keeps everything:

- **Data:** the first `yardmaster start` (or `doctor`, `token`) moves `~/.c-board` to `~/.yardmaster` and leaves a symlink at the old path. The token, paired phones, notification keys, settings, history and shared ports carry over. A data dir set through `CBOARD_HOME` stays where it is.
- **Environment:** `YARDMASTER_*` replaces `CBOARD_*`; the old names are still read when the new ones are unset.
- **CLI:** `c-board` still works and prints a notice; it will be removed in a later version. `yardmaster install-hooks` (or `yardmaster hooks install`) replaces the hook entries installed as `c-board-hook` in Claude's `settings.json`, after a backup. Until then the old entries keep working.
- **Server:** the old `X-CBoard-*` headers and the old session and device cookies are accepted for one version, so installed hooks, the old extension and paired phones keep working. A phone's device cookie moves to the new name on its next visit.
- **Extension:** install the Yardmaster extension and uninstall the c-board one. While both are installed, the new one waits and says so. Its settings are `yardmaster.enabled` and `yardmaster.port`; the old `cboard.*` values are used until you set the new ones.
- **Browser:** preferences saved under `cboard.*` move to `yardmaster.*` on the first load.
