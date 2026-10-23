import * as Dialog from '@radix-ui/react-dialog';
import { Check, ExternalLink, OctagonX, SquareArrowOutUpRight, X } from 'lucide-react';
import { AnimatePresence, motion, useDragControls } from 'motion/react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import { useNow } from '../anim/clock.js';
import { backgroundItems } from '../background/model.js';
import {
  type RequestResult,
  selectPortsByTerminal,
  selectSession,
  useBoard,
  useBoardClient,
  useBoardList,
} from '../data/index.js';
import { formatUptime } from '../lanes/lane.js';
import { PortChip } from '../lanes/PortChip.js';
import { TerminalPeek } from '../lanes/TerminalPeek.js';
import { dur, ease, spring } from '../motion.js';
import { editorName } from '../palette/commands.js';
import { LiveCaption } from '../pod/LiveCaption.js';
import { lastLine } from '../pod/model.js';
import { useMediaQuery } from '../prefs.js';
import { projectHref } from '../routes.js';
import { formatCount, totalTokens } from '../status.js';
import { actionErrorText } from '../terminal/stack.js';
import { Button, buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { Popover } from '../ui/Popover.js';
import { StatusDot } from '../ui/StatusDot.js';

import { actorId, actorKindName, actorStateLabel, type SceneActor } from './scene.js';
import { useSceneProject } from './useScene.js';

/** Phones and touch screens get a bottom sheet instead of an anchored popover (§10.1). */
export const SHEET_QUERY = '(max-width: 767px), (pointer: coarse)';
/** A pull this far (px) or this fast (px/s) closes the sheet. */
const PULL_CLOSE_PX = 80;
const PULL_CLOSE_VELOCITY = 500;
const TAIL_LINES = 6;

export interface ActorInspectorProps {
  projectId: string;
  /** A `SceneActor` id. */
  actorId: string;
  /** The inspector's accessible name, e.g. "acme-shop, Claude". */
  label: string;
  /** Opens the inspector on click; must forward its ref. */
  trigger: ReactElement;
  /** Told when it opens and closes (a lane hides its own peek meanwhile). */
  onOpenChange?(open: boolean): void;
}

/**
 * The Actor inspector, DESIGN.md §10.1: what an actor is, its state and live caption, its latest
 * output, ports, uptime and tokens, and the actions on it. Every layout opens this one. Anchored
 * to its trigger on desktop; a bottom sheet (pull down to close) on narrow and touch screens.
 */
export function ActorInspector({
  projectId,
  actorId,
  label,
  trigger,
  onOpenChange,
}: ActorInspectorProps) {
  const [open, setOpenState] = useState(false);
  const sheet = useMediaQuery(SHEET_QUERY);
  const back = useBackCloses(open && sheet, () => setOpen(false));
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
    if (sheet) back(next);
  };
  const body = (
    <InspectorBody projectId={projectId} actorId={actorId} close={() => setOpen(false)} />
  );
  if (sheet) {
    return (
      <InspectorSheet open={open} onOpenChange={setOpen} trigger={trigger} label={label}>
        {body}
      </InspectorSheet>
    );
  }
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      label={label}
      side="bottom"
      align="start"
      className="w-[min(380px,calc(100vw-32px))] p-4"
      onOpenAutoFocus={focusPrimary}
      data-actor-inspector={actorId}
    >
      {body}
    </Popover>
  );
}

/** The history entry an open sheet pushes, so the back gesture closes it like Esc (§10.1). */
const HISTORY_KEY = 'cboardInspector';
let sheetEntries = 0;

/**
 * While `open`, the back gesture (or the browser's Back) calls `close` instead of leaving the
 * page. Returns the hook to call on every open and close: opening pushes an entry; closing any
 * other way steps back over it, unless something navigated on top meanwhile (Open's link).
 */
function useBackCloses(open: boolean, close: () => void): (open: boolean) => void {
  const entry = useRef<{ token: number; href: string } | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onPop = () => {
      const current = entry.current;
      if (!current || window.history.state?.[HISTORY_KEY] === current.token) return;
      entry.current = null;
      closeRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open]);
  return (next) => {
    if (next) {
      if (entry.current) return;
      sheetEntries += 1;
      entry.current = { token: sheetEntries, href: window.location.href };
      window.history.pushState({ ...window.history.state, [HISTORY_KEY]: sheetEntries }, '');
      return;
    }
    const current = entry.current;
    if (!current) return;
    entry.current = null;
    // After the click that closed it has run: a link inside the sheet navigates first.
    setTimeout(() => {
      if (
        window.history.state?.[HISTORY_KEY] === current.token &&
        window.location.href === current.href
      ) {
        window.history.back();
      }
    });
  };
}

/**
 * Opening lands on the main action (Allow, else Open), not on the first focusable thing: that
 * can be a port chip whose tooltip would then take the first Escape.
 */
function focusPrimary(event: Event) {
  const primary = document.querySelector<HTMLElement>('[data-actor-inspector] [data-primary]');
  if (!primary) return;
  event.preventDefault();
  primary.focus();
}

function InspectorSheet({
  open,
  onOpenChange,
  trigger,
  label,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  trigger: ReactElement;
  label: string;
  children: ReactElement;
}) {
  const drag = useDragControls();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="palette-overlay fixed inset-0 z-50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: dur.base, ease: ease.out } }}
                exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
              />
            </Dialog.Overlay>
            <Dialog.Content
              asChild
              forceMount
              aria-describedby={undefined}
              onOpenAutoFocus={focusPrimary}
            >
              <motion.div
                data-actor-inspector=""
                data-sheet=""
                // `y` (not a transform string): Reduced drops it and only fades.
                initial={{ opacity: 0, y: '100%' }}
                animate={{ opacity: 1, y: 0, transition: spring.smooth }}
                exit={{ opacity: 0, y: '100%', transition: { duration: dur.fast, ease: ease.out } }}
                drag="y"
                dragListener={false}
                dragControls={drag}
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={{ top: 0, bottom: 0.7 }}
                onDragEnd={(_, info) => {
                  if (info.offset.y > PULL_CLOSE_PX || info.velocity.y > PULL_CLOSE_VELOCITY) {
                    onOpenChange(false);
                  }
                }}
                className="palette fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-modal border border-line-strong border-b-0 px-4 pb-[max(16px,env(safe-area-inset-bottom))] shadow-raised outline-none"
              >
                {/* The handle: pulling it (or the top of the sheet) down closes it. */}
                <div
                  onPointerDown={(e) => drag.start(e)}
                  className="-mx-4 flex h-6 shrink-0 cursor-grab touch-none select-none items-center justify-center active:cursor-grabbing"
                >
                  <span aria-hidden className="h-1 w-10 rounded-full bg-line-strong" />
                </div>
                <Dialog.Title className="sr-only">{label}</Dialog.Title>
                <div className="min-h-0 overflow-y-auto pb-1">{children}</div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function InspectorBody({
  projectId,
  actorId,
  close,
}: {
  projectId: string;
  actorId: string;
  close(): void;
}) {
  const scene = useSceneProject(projectId);
  const actor = scene?.actors.find((a) => a.id === actorId);
  if (!scene || !actor) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-body-sm text-text-2">This has finished or closed.</p>
        {scene && (
          <Link
            href={projectHref(projectId)}
            onClick={close}
            className={buttonClass('secondary', 'sm')}
          >
            Open {scene.name}
          </Link>
        )}
      </div>
    );
  }
  return (
    <div
      data-actor={actor.id}
      data-actor-state={actor.state}
      className="flex min-w-0 flex-col gap-3"
    >
      <header className="flex min-w-0 flex-col gap-1">
        <p className="truncate text-meta text-text-2">
          {actorKindName(actor.kind)} · {scene.name}
        </p>
        <h2 className="truncate font-medium text-text-1 text-title-sm" title={actor.label}>
          {actor.label}
        </h2>
        <StatusDot
          tone={actor.tone}
          label={actorStateLabel(actor)}
          showLabel
          className="text-label text-text-2"
        />
      </header>
      <LiveCaption caption={actor.caption} className="text-body-sm" />
      <ActorOutput actor={actor} />
      <ActorFacts actor={actor} />
      <ActorActions actor={actor} close={close} />
    </div>
  );
}

const outputBox =
  'rounded-control border border-line bg-bg-0 px-2.5 py-2 font-mono text-meta text-text-2';

/** The last six output lines of a terminal or task, or the session's last assistant line. */
function ActorOutput({ actor }: { actor: SceneActor }) {
  const session = useBoard(selectSession(actor.links.sessionId ?? ''));
  if (actor.kind === 'terminal' && actor.links.terminalId) {
    return (
      <TerminalPeek
        terminalId={actor.links.terminalId}
        label={`Latest output of ${actor.label}`}
        className="pointer-events-auto"
      />
    );
  }
  if (actor.kind === 'claude') {
    const line = lastLine(session?.lastAssistantText ?? null);
    if (!line) return null;
    return (
      <p dir="auto" className="line-clamp-3 text-body-sm text-text-2" title={line}>
        {line}
      </p>
    );
  }
  const tail = session
    ? backgroundItems(session).find((i) => actorId.task(session.id, i.id) === actor.id)?.tail
    : null;
  const lines = (tail ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-TAIL_LINES);
  if (lines.length === 0) return null;
  return (
    <pre role="log" aria-label={`Latest output of ${actor.label}`} className={outputBox}>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed window of lines
        <span key={i} className="block truncate">
          {line}
        </span>
      ))}
    </pre>
  );
}

function ActorFacts({ actor }: { actor: SceneActor }) {
  const ports = useBoardList(
    selectPortsByTerminal(actor.kind === 'terminal' ? (actor.links.terminalId ?? '') : ''),
  );
  const session = useBoard(
    selectSession(actor.kind === 'claude' ? (actor.links.sessionId ?? '') : ''),
  );
  const now = useNow(15_000);
  const tokens = session ? totalTokens(session) : 0;
  const [port, ...more] = ports;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-meta text-text-2 tabular">
      {port && <PortChip port={port} others={more} />}
      <span title={new Date(actor.since).toLocaleString()}>
        {actor.state === 'exited' ? 'Opened' : 'Up'} {formatUptime(now - actor.since)}
      </span>
      {tokens > 0 && (
        <span title={`${tokens.toLocaleString('en-US')} tokens`}>{formatCount(tokens)} tok</span>
      )}
    </div>
  );
}

function ActorActions({ actor, close }: { actor: SceneActor; close(): void }) {
  const client = useBoardClient();
  const editor = useBoard((s) => editorName(s.board, actor.projectId));
  const [busy, setBusy] = useState(false);
  const { terminalId, approvalId } = actor.links;
  const interruptible =
    actor.kind === 'terminal' && (actor.state === 'running' || actor.state === 'serving');

  const run = async (work: () => Promise<RequestResult>, failed: string) => {
    setBusy(true);
    const result = await work();
    setBusy(false);
    if (!result.ok) toast.error(actionErrorText(result.error, failed));
  };
  const focusInEditor = () =>
    run(
      () =>
        client.action(
          terminalId
            ? { kind: 'terminal.focus', terminalId }
            : { kind: 'project.openInEditor', projectId: actor.projectId },
        ),
      `Couldn't reach ${editor}`,
    );
  const interrupt = () =>
    terminalId &&
    run(
      () => client.action({ kind: 'terminal.interrupt', terminalId }),
      'Ctrl+C did not go through',
    );
  const decide = (decision: 'allow' | 'deny') =>
    approvalId &&
    run(
      () => client.request('approval.decide', { approvalId, decision }),
      'The decision did not go through',
    );

  return (
    <div className="flex flex-wrap items-center gap-2 border-line border-t pt-3">
      {approvalId && (
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => decide('allow')}
            data-primary
          >
            <Check aria-hidden className="size-3.5" strokeWidth={2} />
            Allow
          </Button>
          <Button size="sm" disabled={busy} onClick={() => decide('deny')}>
            <X aria-hidden className="size-3.5" strokeWidth={2} />
            Deny
          </Button>
        </>
      )}
      <Link
        href={actor.links.href}
        onClick={close}
        data-primary={approvalId ? undefined : ''}
        className={buttonClass(approvalId ? 'secondary' : 'primary', 'sm')}
      >
        <SquareArrowOutUpRight aria-hidden className="size-3.5" strokeWidth={1.75} />
        Open
      </Link>
      <Button size="sm" variant="ghost" disabled={busy} onClick={focusInEditor}>
        <ExternalLink aria-hidden className="size-3.5" strokeWidth={1.75} />
        Focus in {editor}
      </Button>
      {interruptible && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={interrupt}
          className={cx('text-st-err-ink')}
        >
          <OctagonX aria-hidden className="size-3.5" strokeWidth={1.75} />
          Ctrl+C
        </Button>
      )}
    </div>
  );
}
