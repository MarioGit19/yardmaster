import { sessionDisplayName } from '@yardmaster/protocol';
import {
  type ComponentPropsWithoutRef,
  forwardRef,
  type ReactNode,
  useMemo,
  useState,
} from 'react';
import { Link, useLocation } from 'wouter';
import { useBoardShallow, useBoardStore } from '../data/index.js';
import { selectLaneExecution, terminalDisplay } from '../lanes/lane.js';
import { sessionHref, terminalHref } from '../routes.js';
import { sessionStatusView, type Tone } from '../status.js';
import { cx } from '../ui/cx.js';
import { Popover } from '../ui/Popover.js';
import { TONE_MARK } from '../ui/StatusDot.js';
import { Tooltip } from '../ui/Tooltip.js';
import { type HudCounts, type HudItem, selectHudCounts, selectHudItems } from './counts.js';
import { useSeenFailures } from './seenFailures.js';

export const COUNTER_HINT = {
  needsYou: 'Approvals, questions and sessions waiting for a reply',
  failed: 'Failed sessions, and terminals that exited non-zero since you last opened them',
  active: 'Busy sessions and terminals with a command running',
} as const;

/** The ring around the counter group, in the colour of its most severe non-zero member. */
export const SEVERITY_RING: Record<Tone, string> = {
  wait: 'shadow-[inset_0_0_0_1px_var(--st-wait-glow)]',
  err: 'shadow-[inset_0_0_0_1px_var(--st-err-glow)]',
  work: 'shadow-[inset_0_0_0_1px_var(--st-work-glow)]',
  tool: 'shadow-[inset_0_0_0_1px_var(--st-tool-glow)]',
  ok: 'shadow-[inset_0_0_0_1px_var(--st-ok-glow)]',
  idle: '',
};

export const COUNTER_BUTTON =
  'flex items-center rounded-control transition-[background-color,scale] duration-fast ease-out aria-disabled:hover:bg-transparent hover:bg-bg-2 moving:active:scale-[0.97]';

/** The HUD's counts, leaving out the terminal failures this browser has already opened. */
export function useHudCounts(): HudCounts {
  const seen = useSeenFailures();
  const select = useMemo(() => selectHudCounts(Date.now, seen), [seen]);
  return useBoardShallow(select);
}

interface TipButtonProps extends ComponentPropsWithoutRef<'button'> {
  tip: string;
}

/** A popover trigger with a tooltip: the two share the one button. */
const TipButton = forwardRef<HTMLButtonElement, TipButtonProps>(function TipButton(
  { tip, ...props },
  ref,
) {
  return (
    <Tooltip content={tip}>
      <button ref={ref} type="button" {...props} />
    </Tooltip>
  );
});

/** Where an item opens. One no project has claimed has no page yet. */
function itemHref(item: HudItem): string | null {
  if (item.kind === 'session') {
    const { projectId, id } = item.session;
    return projectId ? sessionHref(projectId, id) : null;
  }
  const { projectId, id } = item.terminal;
  return projectId ? terminalHref(projectId, id) : null;
}

/**
 * The Failed and Active counters. One item jumps straight to it; several open a list of them, and
 * at zero there is nothing to go to.
 */
export function JumpCounter({
  bucket,
  label,
  value,
  children,
}: {
  bucket: 'failed' | 'active';
  label: string;
  value: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const store = useBoardStore();
  const seen = useSeenFailures();
  const items = () => selectHudItems(bucket, seen)(store.getState());
  const empty = value === 0;
  return (
    <Popover
      open={open && !empty}
      onOpenChange={(next) => {
        if (!next) return setOpen(false);
        const [only, ...rest] = items();
        const href = only && rest.length === 0 ? itemHref(only) : null;
        if (href) navigate(href);
        else if (only) setOpen(true);
      }}
      label={label}
      align="start"
      className="flex max-h-80 w-72 max-w-[calc(100vw-32px)] flex-col overflow-y-auto p-1"
      data-hud-list={bucket}
      trigger={
        <TipButton
          tip={COUNTER_HINT[bucket]}
          data-hud={bucket}
          aria-label={`${value} ${label}. ${COUNTER_HINT[bucket]}`}
          aria-disabled={empty || undefined}
          aria-haspopup={value > 1 ? 'dialog' : undefined}
          aria-expanded={value > 1 ? open : undefined}
          className={COUNTER_BUTTON}
        >
          {children}
        </TipButton>
      }
    >
      <HudItems bucket={bucket} onPick={() => setOpen(false)} />
    </Popover>
  );
}

function HudItems({ bucket, onPick }: { bucket: 'failed' | 'active'; onPick: () => void }) {
  const store = useBoardStore();
  const seen = useSeenFailures();
  const state = store.getState();
  const projects = state.board.projects;
  return (
    <ul>
      {selectHudItems(
        bucket,
        seen,
      )(state).map((item) => {
        const id = item.kind === 'session' ? item.session.id : item.terminal.id;
        const projectId =
          item.kind === 'session' ? item.session.projectId : item.terminal.projectId;
        const name =
          item.kind === 'session'
            ? sessionDisplayName(item.session)
            : terminalDisplay(item.terminal, selectLaneExecution(item.terminal)(state)).name;
        const detail =
          item.kind === 'session'
            ? sessionStatusView(item.session.status).label
            : item.lane.running
              ? 'Running'
              : `Exit ${item.lane.exit?.code}`;
        const row = 'flex items-start gap-2 rounded-control px-2 py-1.5 touch:min-h-11';
        const body = (
          <>
            <span aria-hidden className="grid h-4.5 w-2 shrink-0 place-items-center">
              <span className={TONE_MARK[bucket === 'failed' ? 'err' : 'work']} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body-sm text-text-1">{name}</span>
              <span className="block truncate text-label text-text-2">
                {(projectId && projects[projectId]?.name) || 'No project'} · {detail}
              </span>
            </span>
          </>
        );
        const href = itemHref(item);
        return (
          <li key={id}>
            {href ? (
              <Link
                href={href}
                onClick={onPick}
                data-hud-item={id}
                className={cx(row, 'hover:bg-bg-2')}
              >
                {body}
              </Link>
            ) : (
              <div data-hud-item={id} className={row}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
