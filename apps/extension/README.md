# Yardmaster for Cursor and VS Code

Mirrors this window's integrated terminals (commands, exit codes and colored output) to the local
Yardmaster dashboard, and lets the dashboard run commands in them.

The extension only talks to the Yardmaster server through its socket, `~/.yardmaster/board.sock`, after
checking it is a socket you own, and authenticates with the token in `~/.yardmaster/token`. It never
connects to the TCP port, which another program could hold. It needs no account and no API key.

## Settings

| Setting | Default | |
|---|---|---|
| `yardmaster.enabled` | `true` | Stream this window's terminals to Yardmaster. Read from your user settings only: a workspace's `.vscode/settings.json` can't change it. |

## Commands

- **Yardmaster: Open Dashboard** opens the board in your browser.
- **Yardmaster: Reconnect** reconnects to the server right away.

## Upgrading from c-board

This extension replaces the c-board one. Uninstall c-board and reload the window: while both are
installed, Yardmaster waits so terminals aren't mirrored twice. Old `cboard.*` settings still apply
until you set the `yardmaster.*` ones.

## License

No license has been chosen for Yardmaster yet. Until one is, all rights are reserved.
