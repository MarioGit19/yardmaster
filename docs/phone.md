# Use it from your phone

c-board only ever listens on `127.0.0.1`. To reach it from your phone, you bring the phone into your own private network with [Tailscale](https://tailscale.com), and Tailscale forwards HTTPS to the board on your Mac. Nothing is exposed to the internet.

## 1. Install Tailscale on both devices

Install Tailscale on your Mac and on your phone, and sign in to the **same tailnet** on both. In the Tailscale admin console, make sure **MagicDNS** and **HTTPS certificates** are turned on (DNS page).

## 2. Forward HTTPS to the board

On the Mac, with c-board running:

```bash
tailscale serve --bg 4317
```

The first time, Tailscale may answer "Serve is not enabled on your tailnet" with a link: open it, approve Serve (and HTTPS certificates if asked), and the command finishes on its own. Then Tailscale prints the address it serves, such as `https://my-mac.tailnet-name.ts.net`. It terminates HTTPS with a real certificate and forwards to `127.0.0.1:4317`. `tailscale serve status` shows it again; `tailscale serve reset` stops it.

If you run c-board on another port (`CBOARD_PORT`), use that port instead of `4317`.

## 3. Add the host in c-board

On the Mac, open c-board → **Settings → Phone → Allowed hosts** and add the name, without `https://`: `my-mac.tailnet-name.ts.net`. Only `*.ts.net` names are accepted, and the board answers on them over HTTPS only.

## 4. Scan the QR code

Still on the Mac, click **Show pairing code**. Point your phone's camera at the QR code and open the link. The code works once and expires after 5 minutes; it signs that browser in with its own device key. The access token never leaves the Mac.

Your phone now appears under **Paired devices**. It stays signed in until you **revoke** it there, which also disconnects it right away. Add c-board to your home screen for a full-screen board.

## Why not ngrok or Cloudflare Tunnel?

Public tunnels put the board on the internet. The board can type into your terminals and start Claude sessions, so a leaked link or a weak spot in a tunnel would be a remote shell on your Mac. c-board refuses any host that isn't on your allowed list, and the docs only support Tailscale, where the only devices that can reach the board are the ones you signed in to your tailnet.

## Troubleshooting

- **`forbidden_host`:** the name in the address bar isn't in Allowed hosts. Check the spelling, including the tailnet part.
- **`https_required`:** the request didn't come through `tailscale serve` over HTTPS. Use the `https://` address.
- **The phone can't reach the address:** check `tailscale serve status` on the Mac ("No serve config" means step 2 didn't finish) and that the Tailscale app on the phone says Connected. The very first HTTPS request can take up to a minute while Tailscale gets the certificate.
- **"Could not pair":** the code was used, replaced by a newer one, or expired. Show a new code on the Mac.
