# Changelog

## Unreleased

### Browsers sign in with one-time links and their own sessions

- **Sign in once more:** browsers and phones signed in before this version see a "Sign in again" screen. On this computer, run `yardmaster open` (or Yardmaster: Open Dashboard in your editor); pair phones again from Settings → Phone.
- Sign-in links are one-time codes (`/auth?c=…`, single use, valid for 5 minutes) instead of links carrying the access token, which ended up in browser history. Old `/auth?t=…` links no longer sign in. `yardmaster start` prints one, and the new `yardmaster open` makes another.
- Each browser and phone keeps its own session in the board's own storage and sends it with each request, never as a cookie: browsers send a host's cookies to every port on it, so a dev server on another port (or one shared to your phone) could have picked it up.
- Settings → Data and security lists every signed-in browser and phone and signs any of them out at once. Phones sign out after 30 days unused.
- Rotating the token now ends every session and closes open board and editor connections, so they sign in again; the browser that rotated stays signed in.
- `pnpm dev` serves the web app on `http://127.0.0.1:4327` instead of port 5173.

### Editors and hooks connect through a private socket

- The server also listens on `~/.yardmaster/board.sock` (owner only). The extension, the Claude hooks and `yardmaster doctor` talk to it there and never send the token to the TCP port, so a program that grabs port 4317 while Yardmaster is off gets nothing and can't answer for it. The editor and hook routes are refused over TCP.
- The away-mode permission hook is now `yardmaster-hook-permission.mjs`, run by Node. The board only says allow, always allow or deny, and the hook writes Claude Code's answer itself. Run `yardmaster hooks install` once to switch to it: the old handler gives no decision, so the terminal prompt shows.
- The extension has no `yardmaster.port` setting any more, and reads `yardmaster.enabled` from your user settings only. Update the extension: older versions can't connect.
- `yardmaster doctor` reports the socket.

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
