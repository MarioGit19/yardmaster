# c-board for Cursor and VS Code

Mirrors this window's integrated terminals (commands, exit codes and colored output) to the local
c-board dashboard, and lets the dashboard run commands in them.

The extension only talks to the c-board server on `127.0.0.1` and authenticates with the token in
`~/.c-board/token`. It needs no account and no API key.

## Settings

| Setting | Default | |
|---|---|---|
| `cboard.enabled` | `true` | Stream this window's terminals to c-board. |
| `cboard.port` | `4317` | Port of the local c-board server. |

## Commands

- **c-board: Open Dashboard** opens the board in your browser.
- **c-board: Reconnect** reconnects to the server right away.

## License

No license has been chosen for c-board yet. Until one is, all rights are reserved.
