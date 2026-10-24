import type { PortShare } from '@c-board/protocol';
import * as Dialog from '@radix-ui/react-dialog';
import { Copy, ExternalLink, ShieldCheck } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useBoard } from '../data/index.js';
import { dur, ease } from '../motion.js';
import { useMediaQuery } from '../prefs.js';
import { QrCode } from '../settings/PhoneSettings.js';
import { onRemoteHost } from '../settings/remoteHost.js';
import { NARROW_QUERY } from '../shell/prefs.js';
import { SheetPanel } from '../ui/BottomSheet.js';
import { Button, buttonClass } from '../ui/Button.js';
import {
  copyText,
  portShareRequest,
  sharePort,
  stopSharing,
  usePortShare,
  usePortShares,
  VITE_HINT,
} from './shares.js';

const dismiss = () => portShareRequest.set(null);

/**
 * Open on phone (12.6e2): shares the port on the tailnet with `tailscale serve`, then shows its
 * link with Copy, Open and, on the Mac, a QR code. A glass modal on wide screens, a bottom
 * sheet on phones.
 */
export function PortShareDialog() {
  const port = useSyncExternalStore(portShareRequest.subscribe, portShareRequest.get);
  const listening = useBoard((s) =>
    port === null ? false : Object.values(s.board.ports).some((p) => p.port === port),
  );
  const narrow = useMediaQuery(NARROW_QUERY);
  const open = port !== null && listening;

  // The port closed: its share is gone too.
  useEffect(() => {
    if (port !== null && !listening) dismiss();
  }, [port, listening]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && dismiss()}>
      <AnimatePresence>
        {open && port !== null && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="palette-overlay fixed inset-0 z-50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: dur.fast, ease: ease.out } }}
                exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount>
              {narrow ? (
                <SheetPanel data-port-share={port} onDismiss={dismiss}>
                  <ShareBody port={port} qr={false} />
                </SheetPanel>
              ) : (
                <motion.div
                  data-port-share={port}
                  className="palette fixed top-[14vh] left-1/2 z-50 flex max-h-[min(640px,80vh)] w-[min(460px,calc(100vw-32px))] flex-col overflow-hidden rounded-modal border border-line-strong shadow-raised outline-none"
                  style={{ x: '-50%' }}
                  initial={{ opacity: 0, scale: 0.96, filter: 'blur(4px)' }}
                  animate={{
                    opacity: 1,
                    scale: 1,
                    filter: 'blur(0px)',
                    transition: { duration: dur.fast, ease: ease.out },
                    transitionEnd: { filter: 'none' },
                  }}
                  exit={{
                    opacity: 0,
                    scale: 0.98,
                    transition: { duration: dur.fast, ease: ease.out },
                  }}
                >
                  <ShareBody port={port} qr={!onRemoteHost()} />
                </motion.div>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

type Phase = { kind: 'sharing' } | { kind: 'failed'; message: string } | { kind: 'shared' };

function ShareBody({ port, qr }: { port: number; qr: boolean }) {
  const share = usePortShare(port);
  const host = usePortShares()?.host ?? null;
  const [phase, setPhase] = useState<Phase>(share ? { kind: 'shared' } : { kind: 'sharing' });
  const [attempt, setAttempt] = useState(0);
  const [stopping, setStopping] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt only triggers a retry
  useEffect(() => {
    let live = true;
    sharePort(port).then(
      () => live && setPhase({ kind: 'shared' }),
      (err: unknown) =>
        live &&
        setPhase({
          kind: 'failed',
          message: err instanceof Error ? err.message : 'tailscale serve failed.',
        }),
    );
    return () => {
      live = false;
    };
  }, [port, attempt]);

  const stop = async () => {
    setStopping(true);
    try {
      await stopSharing(port);
      toast.success(`Stopped sharing :${port}`);
      dismiss();
    } catch {
      toast.error(`Could not stop sharing :${port}`);
      setStopping(false);
    }
  };

  const shown = phase.kind === 'shared' ? share : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-5">
        <div className="flex flex-col gap-1">
          <Dialog.Title className="font-medium text-text-1 text-title-sm">
            Open <span className="font-mono">:{port}</span> on your phone
          </Dialog.Title>
          <Dialog.Description className="flex items-start gap-1.5 text-body-sm text-text-2">
            <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 stroke-[1.5] text-text-3" />
            <span>
              Shared on your tailnet only, with <code className="font-mono">tailscale serve</code>.
              Only devices signed in to your Tailscale can open it; nothing goes on the public
              internet.
            </span>
          </Dialog.Description>
        </div>
        {phase.kind === 'sharing' && (
          <p
            data-port-share-state="sharing"
            aria-live="polite"
            className="text-body-sm text-text-2"
          >
            Sharing :{port}…
          </p>
        )}
        {phase.kind === 'failed' && (
          <div
            data-port-share-state="failed"
            role="alert"
            className="flex flex-col gap-2 rounded-panel border border-st-err/40 bg-st-err/5 p-3"
          >
            <p className="font-medium text-body-sm text-text-1">Couldn’t share :{port}</p>
            <p className="whitespace-pre-wrap break-words text-label text-text-2">
              {phase.message}
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="self-start"
              onClick={() => {
                setPhase({ kind: 'sharing' });
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </div>
        )}
        {shown && <SharedLink share={shown} qr={qr} />}
        {shown && <Hints share={shown} host={host} />}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-line border-t px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {shown?.mine && (
          <Button
            variant="ghost"
            className="mr-auto"
            disabled={stopping}
            onClick={() => void stop()}
            data-port-stop=""
          >
            Stop sharing
          </Button>
        )}
        <Dialog.Close asChild>
          <Button variant="secondary">Done</Button>
        </Dialog.Close>
      </footer>
    </div>
  );
}

function SharedLink({ share, qr }: { share: PortShare; qr: boolean }) {
  return (
    <div
      data-port-share-state="shared"
      className="flex flex-col items-center gap-4 rounded-panel border border-line bg-bg-0 p-4 sm:flex-row sm:items-center"
    >
      {qr && (
        <QrCode value={share.url} label={`QR code for ${share.url}`} className="size-36 shrink-0" />
      )}
      <div className="flex w-full min-w-0 flex-col gap-3">
        <p
          data-port-share-url=""
          className="break-all font-mono text-body-sm text-text-1"
          title={share.url}
        >
          {share.url}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void copyText(share.url, 'the link')}
          >
            <Copy aria-hidden className="size-4 stroke-[1.5]" />
            Copy
          </Button>
          <a
            href={share.url}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass('secondary', 'sm')}
          >
            <ExternalLink aria-hidden className="size-4 stroke-[1.5]" />
            Open
          </a>
        </div>
        {qr && (
          <p className="text-meta text-text-3">
            Scan it with your phone’s camera. The phone needs Tailscale on, in the same tailnet.
          </p>
        )}
        {!share.mine && (
          <p className="text-meta text-text-3">
            You shared this port outside c-board, so it stays shared when the port closes.
          </p>
        )}
      </div>
    </div>
  );
}

function Hints({ share, host }: { share: PortShare; host: string | null }) {
  return (
    <ul className="flex flex-col gap-2 text-label text-text-2">
      {share.hint === 'vite_blocked' && (
        <li
          data-port-hint="vite_blocked"
          className="rounded-panel border border-st-wait/40 bg-st-wait/5 p-3 text-text-1"
        >
          <p className="font-medium">It answers “Blocked request”</p>
          <p className="mt-1 text-text-2">{VITE_HINT}</p>
          <pre className="mt-2 overflow-x-auto rounded-control bg-bg-2 px-2 py-1.5 font-mono text-meta text-text-1">
            {"server: { allowedHosts: ['.ts.net'] }"}
          </pre>
        </li>
      )}
      <li data-port-hint="other-ports">
        If the app calls <span className="font-mono">localhost:&lt;another port&gt;</span>, like an
        API, share that port too and point its URL at{' '}
        <span className="break-words font-mono">{host ?? 'the tailnet name'}</span>.
      </li>
    </ul>
  );
}
