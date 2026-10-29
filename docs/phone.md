# Use it from your phone

Yardmaster only ever listens on `127.0.0.1`. To reach it from your phone, you bring the phone into your own private network with [Tailscale](https://tailscale.com), and Tailscale forwards HTTPS to the board on your Mac. Nothing is exposed to the internet.

## 1. Install Tailscale on both devices

Install Tailscale on your Mac and on your phone, and sign in to the **same tailnet** on both. In the Tailscale admin console, make sure **MagicDNS** and **HTTPS certificates** are turned on (DNS page).

## 2. Forward HTTPS to the board

On the Mac, with Yardmaster running:

```bash
tailscale serve --bg 4317
```

The first time, Tailscale may answer "Serve is not enabled on your tailnet" with a link: open it, approve Serve (and HTTPS certificates if asked), and the command finishes on its own. Then Tailscale prints the address it serves, such as `https://my-mac.tailnet-name.ts.net`. It terminates HTTPS with a real certificate and forwards to `127.0.0.1:4317`. `tailscale serve status` shows it again; `tailscale serve reset` stops it.

If you run Yardmaster on another port (`YARDMASTER_PORT`), use that port instead of `4317`.

## 3. Add the host in Yardmaster

On the Mac, open Yardmaster → **Settings → Phone → Allowed hosts** and add the name, without `https://`: `my-mac.tailnet-name.ts.net`. Only `*.ts.net` names are accepted, and the board answers on them over HTTPS only.

## 4. Scan the QR code

Still on the Mac, click **Show pairing code**. Point your phone's camera at the QR code and open the link. The code works once and expires after 5 minutes; it signs that browser in with its own session, kept in the browser's storage for the board's address only (never a cookie, so dev servers you open on the phone never see it). The access token never leaves the Mac.

Your phone now appears under **Paired devices**. It stays signed in until you **revoke** it there (or under Settings → Data and security → Signed-in browsers), which also disconnects it right away, or until it goes 30 days without opening the board. Add Yardmaster to your home screen for a full-screen board.

## Dev servers on your phone

Once phone access works, the board can open a project's dev servers on your phone too. Click a port chip (`:3000` on a lane, in the focus view, the Actor inspector, the Office port sign or the Grid screens) and choose **Open on phone**. The board runs:

```bash
tailscale serve --bg --https=3000 http://127.0.0.1:3000
```

and shows the address, `https://my-mac.tailnet-name.ts.net:3000`, with Copy, Open and a QR code. On the phone itself, tapping a port chip opens that address straight away, sharing the port first if needed. A shared port carries a small phone mark wherever its chip appears.

- **Tailnet only.** The board uses `tailscale serve`, never Funnel, so only devices signed in to your tailnet can open the address.
- **It cleans up after itself.** The board remembers which serve entries it created, in its data folder, and removes only those: when the port stops listening, when you click **Stop sharing**, and when Yardmaster stops. It never touches its own `4317` entry or anything you served yourself; those show up as shared, but stay.
- **Hidden** until Tailscale is installed (on `PATH`, or the app in `/Applications`) and phone access is set up (an allowed host in step 3). **Settings → Phone → Dev servers on your phone** says what's missing and lists what is shared.

Common snags:

- **"Blocked request. This host is not allowed."** Vite only answers the host names it knows. Add the tailnet name to `server.allowedHosts` in `vite.config.ts` (`allowedHosts: ['.ts.net']` allows any tailnet name), then reload. The board checks for this right after sharing and says so in the sheet.
- **The page loads, but its data doesn't.** An app that calls `localhost:<another port>` (an API on `:8080`, say) reaches your phone's own localhost. Share that port too, and point the app's API URL at `https://my-mac.tailnet-name.ts.net:8080`.
- **Serve isn't enabled.** The first share can hit the same "Serve is not enabled on your tailnet" approval as step 2. Approve it from the link in the message, then try again.

## Why not ngrok or Cloudflare Tunnel?

Public tunnels put the board on the internet. The board can type into your terminals and start Claude sessions, so a leaked link or a weak spot in a tunnel would be a remote shell on your Mac. Yardmaster refuses any host that isn't on your allowed list, and the docs only support Tailscale, where the only devices that can reach the board are the ones you signed in to your tailnet.

## Troubleshooting

- **`forbidden_host`:** the name in the address bar isn't in Allowed hosts. Check the spelling, including the tailnet part.
- **`https_required`:** the request didn't come through `tailscale serve` over HTTPS. Use the `https://` address.
- **The phone can't reach the address:** check `tailscale serve status` on the Mac ("No serve config" means step 2 didn't finish) and that the Tailscale app on the phone says Connected. The very first HTTPS request can take up to a minute while Tailscale gets the certificate.
- **"Could not pair":** the code was used, replaced by a newer one, or expired. Show a new code on the Mac.
