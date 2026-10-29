import * as Dialog from '@radix-ui/react-dialog';
import type { TrustFindingKind } from '@yardmaster/protocol';
import {
  FileWarning,
  FolderOpen,
  Plug,
  Puzzle,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  SquareTerminal,
  Variable,
  Zap,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { useBoardClient } from '../data/index.js';
import { dur, ease } from '../motion.js';
import { useMediaQuery } from '../prefs.js';
import { NARROW_QUERY } from '../shell/prefs.js';
import { SheetPanel } from '../ui/BottomSheet.js';
import { Button } from '../ui/Button.js';
import {
  type FindingGroup,
  folderName,
  groupFindings,
  requestTrust,
  type TrustRequest,
  trustRequests,
} from './trust.js';

const ICONS: Record<TrustFindingKind, ReactNode> = {
  hook: <Zap />,
  mcp: <Plug />,
  command: <SquareTerminal />,
  plugin: <Puzzle />,
  allow: <ShieldCheck />,
  mode: <ShieldQuestion />,
  directory: <FolderOpen />,
  env: <Variable />,
  unreadable: <FileWarning />,
};

/**
 * The trust card: before the first board session in a folder whose Claude settings can run
 * code or widen permissions, it lists exactly what was found. Nothing starts until the user trusts
 * the folder; Cancel leaves it unstarted. A small glass modal on wide screens, a bottom sheet on
 * phones. It also answers the board client's trust gate, so every way to start a session asks.
 */
export function TrustFolderDialog() {
  const client = useBoardClient();
  useEffect(() => client.setTrustGate(requestTrust), [client]);
  const request = useSyncExternalStore(trustRequests.subscribe, trustRequests.get);
  const narrow = useMediaQuery(NARROW_QUERY);
  const open = request !== null;
  const cancel = () => request?.answer(false);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && cancel()}>
      <AnimatePresence>
        {request && (
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
                <SheetPanel data-trust-folder={request.review.path} onDismiss={cancel}>
                  <TrustBody key={request.review.hash} request={request} />
                </SheetPanel>
              ) : (
                <motion.div
                  data-trust-folder={request.review.path}
                  className="palette fixed top-[12vh] left-1/2 z-50 flex max-h-[min(640px,80vh)] w-[min(480px,calc(100vw-32px))] flex-col overflow-hidden rounded-modal border border-line-strong shadow-raised outline-none"
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
                  <TrustBody key={request.review.hash} request={request} />
                </motion.div>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function TrustBody({ request }: { request: TrustRequest }) {
  const { review } = request;
  const groups = groupFindings(review.findings);
  const [busy, setBusy] = useState(false);
  const name = folderName(review.path);

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        request.answer(true);
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className="grid size-10 shrink-0 place-items-center rounded-control border border-line bg-bg-2 text-st-wait-ink [&_svg]:size-5 [&_svg]:stroke-[1.5]"
          >
            <ShieldAlert />
          </span>
          <div className="min-w-0 flex-1">
            <Dialog.Title className="truncate font-medium text-text-1 text-title-sm">
              Trust {name}?
            </Dialog.Title>
            <Dialog.Description className="text-body-sm text-text-2">
              Its Claude settings can run commands or skip approvals as soon as a session starts.
              Nothing starts until you trust this folder.
            </Dialog.Description>
            <p
              data-trust-path=""
              className="mt-1 break-all font-mono text-meta text-text-3"
              title={review.path}
            >
              {review.path}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-3" data-trust-findings="">
          {groups.map((group) => (
            <FindingSection key={group.kind} group={group} />
          ))}
          {review.truncated && (
            <p className="text-meta text-text-3">
              More was found than fits here. Check the folder’s .claude and .mcp.json files.
            </p>
          )}
        </div>
        <p className="text-meta text-text-3">
          Yardmaster asks again if these settings change. Only trust folders whose authors you
          trust.
        </p>
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-line border-t px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Dialog.Close asChild>
          <Button variant="ghost" data-trust-cancel="">
            Cancel
          </Button>
        </Dialog.Close>
        <Button type="submit" variant="primary" disabled={busy} data-trust-confirm="">
          Trust and start
        </Button>
      </footer>
    </form>
  );
}

function FindingSection({ group }: { group: FindingGroup }) {
  return (
    <section
      data-trust-group={group.kind}
      className="rounded-panel border border-line bg-bg-2/40 p-3"
    >
      <h3 className="flex items-center gap-2 font-medium text-body-sm text-text-1">
        <span aria-hidden className="flex text-text-3 [&_svg]:size-4 [&_svg]:stroke-[1.5]">
          {ICONS[group.kind]}
        </span>
        {group.title}
        <span className="ml-auto text-meta text-text-3 tabular">{group.findings.length}</span>
      </h3>
      {group.note && <p className="mt-0.5 text-meta text-text-3">{group.note}</p>}
      <ul className="mt-2 flex flex-col gap-2">
        {group.findings.map((finding, index) => (
          <li
            // Findings can repeat (one hook event, two commands); their order is stable.
            // biome-ignore lint/suspicious/noArrayIndexKey: a static list, never reordered
            key={index}
            data-trust-finding={finding.kind}
            className="flex min-w-0 flex-col gap-0.5"
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 break-all font-mono text-label text-text-1">
                {finding.label}
              </span>
              <span className="shrink-0 font-mono text-meta text-text-3">{finding.file}</span>
            </span>
            {finding.detail !== null && (
              <code className="block break-all rounded-chip border border-line bg-bg-0/60 px-2 py-1 font-mono text-meta text-text-2">
                {finding.detail}
              </code>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
