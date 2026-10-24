import type { CliResult, TailscaleCli } from '../port-shares.js';

export const DEMO_TAILNET_HOST = 'demo-mac.tailnet-demo.ts.net';

/**
 * A simulated `tailscale` for the demo board: an in-memory serve config that starts with the
 * board's own entry, so sharing a port works without Tailscale and never touches the real one.
 */
export function demoTailscale(boardPort: number): TailscaleCli {
  const serve = new Map<number, string>([[443, `http://127.0.0.1:${boardPort}`]]);
  const ok = (stdout = ''): CliResult => ({ ok: true, stdout });
  return {
    find: async () => '/demo/tailscale',
    run: async (args) => {
      const [cmd, sub] = args;
      if (cmd === 'status') {
        return ok(
          JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${DEMO_TAILNET_HOST}.` } }),
        );
      }
      if (cmd !== 'serve') return { ok: false, error: 'failed', output: 'unknown command' };
      if (sub === 'status') {
        const ports = [...serve.keys()];
        return ok(
          JSON.stringify({
            TCP: Object.fromEntries(ports.map((p) => [String(p), { HTTPS: true }])),
            Web: Object.fromEntries(
              ports.map((p) => [
                `${DEMO_TAILNET_HOST}:${p}`,
                { Handlers: { '/': { Proxy: serve.get(p) } } },
              ]),
            ),
          }),
        );
      }
      const https = args.find((a) => a.startsWith('--https='));
      const port = Number(https?.slice('--https='.length));
      if (!Number.isInteger(port)) return { ok: false, error: 'failed', output: 'bad port' };
      if (args.includes('off')) {
        return serve.delete(port) ? ok() : { ok: false, error: 'failed', output: 'no handler' };
      }
      serve.set(port, args.at(-1) ?? '');
      return ok(`Available within your tailnet:\n\nhttps://${DEMO_TAILNET_HOST}:${port}/\n`);
    },
  };
}
