# Security

Yardmaster can read every terminal and Claude Code session on your computer and type into them. This page says how to report a problem and what it does and doesn't protect against.

## Reporting a vulnerability

Please report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (GitHub private vulnerability reporting). Don't open a public issue, pull request or discussion for it.

Include what you did, what happened, and the version (`yardmaster --version`) and platform. You'll get an answer within a week. Once a fix is out, the advisory is published with credit, unless you'd rather stay anonymous.

## Supported versions

Yardmaster is pre-1.0. Only the latest release, and `main`, get security fixes. Update before you report, in case it's already fixed.

## Threat model

Yardmaster runs locally, as you, with your own Claude Code login. It has no cloud service and makes no network calls of its own.

### What it protects against

- **Web pages.** The server listens on `127.0.0.1` only and checks the `Host` and `Origin` of every request, so a site you visit can't reach it, even through DNS rebinding. Every request needs the install token or a browser session. Sessions live in the board's own storage, never in a cookie, so dev servers on other ports of the same host never see them.
- **Other devices.** Nothing listens on your network. A phone reaches the board only through your own Tailscale network, and only after you allow its host and pair it with a one-time code. Settings lists every signed-in browser and phone and can sign any of them out.
- **Other local users.** The token, the database and the socket the editor extension and Claude hooks use live in `~/.yardmaster`, which only you can read. The token never goes to the TCP port, so a program that grabs the port while Yardmaster is off gets nothing and can't answer in its place.
- **Untrusted repositories.** A cloned repo's Claude settings or `.mcp.json` that could run commands or widen permissions need your OK before a board Claude session starts there. Git status is skipped for repos whose own config runs commands. Text printed in a terminal can't plant a fake command for Rerun, and Rerun refuses hidden control characters. A project's editor settings can't point the extension elsewhere.
- **Your lock screen.** Push notifications mask known secret patterns, and **Hide details** leaves only the project name.

### What it can't protect against

- **Malware running as you.** A program running under your user account can read `~/.yardmaster`, your terminals and your Claude sessions, with or without Yardmaster. If it's on your computer, it already has what Yardmaster has.
- **Public tunnels.** Exposing the board through Tailscale Funnel, ngrok, Cloudflare Tunnel or similar puts a terminal on the internet. That is not supported: Funnel requests are refused, and other tunnels are on you.
- **Secrets the patterns don't know.** Redaction masks common formats (Anthropic, GitHub and AWS keys, PEM blocks, `*_TOKEN=`-style variables), not every secret.

### A paired phone can control your terminals

That's the point of pairing, and also the risk. A paired phone can read terminal output and Claude sessions, type into terminals, chat with Claude and answer permission prompts. It can't change project folders, the editor command, allowed hosts or history, install hooks, rotate the token or pair other devices: those stay on the Mac. Sign out a lost phone in **Settings → Data and security**, or run `yardmaster token --rotate` to sign out everything.
