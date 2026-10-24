# Yardmaster for Cursor and VS Code

Mirrors this window's integrated terminals (commands, exit codes and colored output) to the local
Yardmaster dashboard, and lets the dashboard run commands in them.

The extension only talks to the Yardmaster server on `127.0.0.1` and authenticates with the token in
`~/.yardmaster/token`. It needs no account and no API key.

## Settings

| Setting | Default | |
|---|---|---|
| `yardmaster.enabled` | `true` | Stream this window's terminals to Yardmaster. |
| `yardmaster.port` | `4317` | Port of the local Yardmaster server. |

## Commands

- **Yardmaster: Open Dashboard** opens the board in your browser.
- **Yardmaster: Reconnect** reconnects to the server right away.

## Upgrading from c-board

This extension replaces the c-board one. Uninstall c-board and reload the window: while both are
installed, Yardmaster waits so terminals aren't mirrored twice. Old `cboard.*` settings still apply
until you set the `yardmaster.*` ones.

## License

No license has been chosen for Yardmaster yet. Until one is, all rights are reserved.
