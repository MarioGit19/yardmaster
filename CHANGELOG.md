# Changelog

## Unreleased

### Renamed: c-board is now Yardmaster

The CLI, packages, extension, settings and docs use the new name. Upgrading keeps everything:

- **Data:** the first `yardmaster start` (or `doctor`, `token`) moves `~/.c-board` to `~/.yardmaster` and leaves a symlink at the old path. The token, paired phones, notification keys, settings, history and shared ports carry over. A data dir set through `CBOARD_HOME` stays where it is.
- **Environment:** `YARDMASTER_*` replaces `CBOARD_*`; the old names are still read when the new ones are unset.
- **CLI:** `c-board` still works and prints a notice; it will be removed in a later version. `yardmaster install-hooks` (or `yardmaster hooks install`) replaces the hook entries installed as `c-board-hook` in Claude's `settings.json`, after a backup. Until then the old entries keep working.
- **Server:** the old `X-CBoard-*` headers and the old session and device cookies are accepted for one version, so installed hooks, the old extension and paired phones keep working. A phone's device cookie moves to the new name on its next visit.
- **Extension:** install the Yardmaster extension and uninstall the c-board one. While both are installed, the new one waits and says so. Its settings are `yardmaster.enabled` and `yardmaster.port`; the old `cboard.*` values are used until you set the new ones.
- **Browser:** preferences saved under `cboard.*` move to `yardmaster.*` on the first load.
