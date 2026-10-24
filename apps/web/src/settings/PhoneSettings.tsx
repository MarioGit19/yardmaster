import {
  type PairedDevice,
  type PairingResponse,
  REMOTE_MAX_HOSTS,
  RemoteHost,
} from '@c-board/protocol';
import { Smartphone, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { encode } from 'uqr';
import { formatDateTime, formatWhen } from '../time.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { StatusDot } from '../ui/StatusDot.js';
import { ApiRequestError, api } from './api.js';
import type { ServerSettings } from './boardSettings.js';

/** True when this page itself came in over Tailscale: pairing codes are made on the Mac only. */
const onRemoteHost = () =>
  typeof location !== 'undefined' && location.hostname.toLowerCase().endsWith('.ts.net');

const PAIRED_POLL_MS = 2_000;

function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

function useDevices() {
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await api.devices(signal);
      setDevices(res.devices);
      setFailed(false);
      return res.devices;
    } catch {
      if (!signal?.aborted) setFailed(true);
      return null;
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);
  return { devices, failed, reload };
}

/** Settings → Phone (F27): allowed Tailscale hosts, the pairing QR code and paired devices. */
export function PhoneSettings({ server }: { server: ServerSettings }) {
  const { devices, failed, reload } = useDevices();
  return (
    <>
      <RemoteHostsRow server={server} />
      <PairRow server={server} devices={devices} reload={reload} />
      <DevicesRow devices={devices} failed={failed} reload={reload} />
    </>
  );
}

function RemoteHostsRow({ server: { settings, update } }: { server: ServerSettings }) {
  const hosts = settings?.remoteAllowedHosts ?? null;
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const full = (hosts?.length ?? 0) >= REMOTE_MAX_HOSTS;

  const add = async () => {
    const parsed = RemoteHost.safeParse(draft);
    if (!parsed.success) {
      setError('Use your Mac’s full Tailscale name, like my-mac.tailnet-name.ts.net.');
      return;
    }
    setError(null);
    if (hosts && !hosts.includes(parsed.data)) {
      await update({ remoteAllowedHosts: [...hosts, parsed.data] }, 'Could not add the host');
    }
    setDraft('');
  };
  const remove = (host: string) =>
    void update(
      { remoteAllowedHosts: (hosts ?? []).filter((h) => h !== host) },
      'Could not remove the host',
    );

  return (
    <div className="flex flex-col gap-3 p-5" data-setting="remote-hosts">
      <div className="flex flex-col gap-0.5">
        <h3 className="font-medium text-body text-text-1">Allowed hosts</h3>
        <p className="text-label text-text-2">
          Off until you add one. c-board still listens only on this Mac;{' '}
          <code className="whitespace-nowrap font-mono text-text-1">tailscale serve</code> brings
          your phone in over HTTPS. Only Tailscale names work: public tunnels are not supported,
          because the board can type into your terminals.
        </p>
      </div>
      {hosts && hosts.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line bg-bg-0">
          {hosts.map((host) => (
            <li
              key={host}
              data-remote-host={host}
              className="flex min-w-0 items-center gap-3 py-1.5 pr-1.5 pl-3"
            >
              <StatusDot tone="ok" label="Allowed" />
              <span
                className="min-w-0 flex-1 truncate font-mono text-label text-text-1"
                title={host}
              >
                {host}
              </span>
              <button
                type="button"
                aria-label={`Remove ${host}`}
                title="Remove"
                onClick={() => remove(host)}
                className="flex size-7 shrink-0 items-center justify-center rounded-control text-text-3 transition-colors duration-fast hover:bg-bg-2 hover:text-text-1 touch:size-11 [&_svg]:size-4 [&_svg]:stroke-[1.5]"
              >
                <X aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
        className="flex min-w-0 flex-col gap-2 sm:flex-row"
      >
        <label className="flex h-8 min-w-0 items-center rounded-control border sm:flex-1 touch:h-11 border-line bg-bg-0 px-3 transition-colors duration-fast focus-within:border-line-strong focus-within:shadow-[var(--focus-ring)]">
          <input
            aria-label="Tailscale host name"
            placeholder="my-mac.tailnet-name.ts.net"
            value={draft}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            inputMode="url"
            disabled={settings === null || full}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            className="h-full min-w-0 flex-1 bg-transparent font-mono text-label text-text-1 outline-none placeholder:text-text-3 focus-visible:shadow-none disabled:opacity-50"
          />
        </label>
        <Button type="submit" disabled={settings === null || full || !draft.trim()}>
          Add host
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-meta text-st-err-ink">
          {error}
        </p>
      )}
    </div>
  );
}

function formatLeft(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function PairRow({
  server: { settings },
  devices,
  reload,
}: {
  server: ServerSettings;
  devices: PairedDevice[] | null;
  reload: () => Promise<PairedDevice[] | null>;
}) {
  const hosts = settings?.remoteAllowedHosts ?? [];
  const [host, setHost] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const remote = onRemoteHost();
  const now = useNow(1_000, pairing !== null);
  const expired = pairing !== null && now >= pairing.expiresAt;
  const chosen = host !== null && hosts.includes(host) ? host : hosts[0];
  const known = useRef<Set<string> | null>(null);

  const show = async () => {
    setBusy(true);
    try {
      known.current = new Set((devices ?? []).map((d) => d.id));
      setPairing(await api.pair(chosen));
    } catch (err) {
      toast.error('Could not make a pairing code', {
        description: err instanceof ApiRequestError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  // While a code is up, watch for the phone that scans it, then put the code away.
  useEffect(() => {
    if (pairing === null || expired) return;
    const timer = setInterval(async () => {
      const list = await reload();
      const added = list?.find((d) => !known.current?.has(d.id));
      if (added) {
        setPairing(null);
        toast.success(`${added.name} paired`, {
          description: 'It stays signed in until you revoke it.',
        });
      }
    }, PAIRED_POLL_MS);
    return () => clearInterval(timer);
  }, [pairing, expired, reload]);

  // A removed host takes its code with it.
  useEffect(() => {
    if (pairing && !hosts.includes(pairing.host)) setPairing(null);
  }, [pairing, hosts]);

  let description: string;
  if (remote) description = 'Pair a new phone from the board on your Mac.';
  else if (hosts.length === 0) description = 'Add your Mac’s Tailscale name above first.';
  else
    description =
      'Scan the code with your phone’s camera. It signs that browser in, works once, and expires after 5 minutes. The access token never leaves this Mac.';

  return (
    <div className="flex flex-col gap-4 p-5" data-setting="pair">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="font-medium text-body text-text-1">Pair a phone</h3>
          <p className="text-label text-text-2">{description}</p>
        </div>
        {pairing === null && (
          <Button
            className="self-start sm:self-auto"
            variant="primary"
            disabled={remote || hosts.length === 0 || busy || settings === null}
            onClick={() => void show()}
          >
            <Smartphone aria-hidden className="size-4 stroke-[1.5]" />
            {busy ? 'Making a code…' : 'Show pairing code'}
          </Button>
        )}
      </div>
      {pairing === null && hosts.length > 1 && !remote && (
        <fieldset className="flex min-w-0 flex-wrap gap-1.5">
          <legend className="sr-only">Host the phone opens</legend>
          {hosts.map((h) => (
            <button
              key={h}
              type="button"
              aria-pressed={h === chosen}
              onClick={() => setHost(h)}
              className={cx(
                'h-7 max-w-full truncate rounded-chip border px-2.5 font-mono text-meta transition-colors duration-fast touch:h-11',
                h === chosen
                  ? 'border-line-strong bg-bg-2 text-text-1'
                  : 'border-line text-text-2 hover:text-text-1',
              )}
            >
              {h}
            </button>
          ))}
        </fieldset>
      )}
      {pairing && (
        <div
          className="flex flex-col items-center gap-4 rounded-control border border-line bg-bg-0 p-5 sm:flex-row sm:items-center sm:gap-6"
          data-pairing={expired ? 'expired' : 'live'}
        >
          <QrCode
            value={pairing.url}
            className={cx(
              'size-48 shrink-0 transition-opacity duration-fast',
              expired && 'opacity-15',
            )}
          />
          <div className="flex min-w-0 flex-col items-center gap-3 text-center sm:items-start sm:text-left">
            <div className="flex flex-col gap-1">
              <p
                className={cx(
                  'font-medium text-body tabular-nums',
                  expired ? 'text-st-err-ink' : 'text-text-1',
                )}
                aria-live="polite"
              >
                {expired
                  ? 'This code has expired'
                  : `Expires in ${formatLeft(pairing.expiresAt - now)}`}
              </p>
              <p
                className="max-w-full truncate font-mono text-meta text-text-3"
                title={pairing.host}
              >
                Opens {pairing.host}
              </p>
            </div>
            <p className="text-label text-text-2">
              Your phone needs Tailscale on, signed in to the same tailnet.
            </p>
            <div className="flex gap-2">
              <Button
                variant={expired ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() => void show()}
              >
                New code
              </Button>
              <Button variant="ghost" onClick={() => setPairing(null)}>
                Done
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Modules of white around the code; dark surroundings need more than the usual minimum. */
const QUIET_ZONE = 3;

/** A QR code as crisp SVG modules, dark on a white tile in both themes so every camera reads it. */
export function QrCode({ value, className }: { value: string; className?: string }) {
  const { path, size } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: QUIET_ZONE });
    let d = '';
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { path: d, size: qr.size };
  }, [value]);
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Pairing QR code"
      shapeRendering="crispEdges"
      className={cx('overflow-hidden rounded-control', className)}
      data-qr
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

function DevicesRow({
  devices,
  failed,
  reload,
}: {
  devices: PairedDevice[] | null;
  failed: boolean;
  reload: () => Promise<PairedDevice[] | null>;
}) {
  const now = useNow(30_000);
  const [revoking, setRevoking] = useState<string | null>(null);

  const revoke = async (device: PairedDevice) => {
    setRevoking(device.id);
    try {
      await api.revokeDevice(device.id);
      toast.success(`${device.name} signed out`, {
        description: 'Pair it again to use it.',
      });
    } catch {
      toast.error('Could not revoke the device');
    } finally {
      setRevoking(null);
      await reload();
    }
  };

  let summary: string;
  if (failed) summary = 'Could not load the paired devices.';
  else if (devices === null) summary = 'Loading…';
  else if (devices.length === 0) summary = 'No phone is paired.';
  else
    summary = `${devices.length} ${devices.length === 1 ? 'device stays' : 'devices stay'} signed in until revoked.`;

  return (
    <div className="flex flex-col gap-3 p-5" data-setting="devices">
      <div className="flex flex-col gap-0.5">
        <h3 className="font-medium text-body text-text-1">Paired devices</h3>
        <p className="text-label text-text-2">{summary}</p>
      </div>
      {devices && devices.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line bg-bg-0">
          {devices.map((device) => (
            <li
              key={device.id}
              data-device={device.id}
              className="flex min-w-0 items-center gap-3 py-2 pr-2 pl-3"
            >
              <Smartphone aria-hidden className="size-4 shrink-0 stroke-[1.5] text-text-3" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="min-w-0 break-words text-body-sm text-text-1">
                    {device.name}
                  </span>
                  {device.current && (
                    <span className="shrink-0 rounded-chip bg-bg-2 px-1.5 text-meta text-text-2">
                      This device
                    </span>
                  )}
                </span>
                <span className="text-meta text-text-3 tabular-nums">
                  <span title={formatDateTime(device.pairedAt)}>
                    Paired {formatWhen(device.pairedAt, now)}
                  </span>
                  {' · '}
                  <span title={formatDateTime(device.lastSeenAt)}>
                    seen {formatWhen(device.lastSeenAt, now)}
                  </span>
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={revoking === device.id}
                onClick={() => void revoke(device)}
              >
                {revoking === device.id ? 'Revoking…' : 'Revoke'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
