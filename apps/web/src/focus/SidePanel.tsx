import { FileDiff, PanelRightClose, TerminalSquare } from 'lucide-react';
import { motion } from 'motion/react';
import { type ComponentType, type ReactNode, type Ref, useRef, useState } from 'react';
import { tabGlide } from '../motion.js';
import { cx } from '../ui/cx.js';
import { IconButton } from '../ui/IconButton.js';
import type { SideTab } from './panels.js';

const TABS: readonly {
  id: SideTab;
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
}[] = [
  { id: 'terminals', label: 'Terminals', icon: TerminalSquare },
  { id: 'changes', label: 'Changes', icon: FileDiff },
];

export interface SidePanelProps {
  tab: SideTab;
  counts: Record<SideTab, number>;
  onTab: (tab: SideTab) => void;
  /** Folds the panel; `byKeyboard` when Enter or Space did it. */
  onClose: (byKeyboard: boolean) => void;
  /** Where the active tab's own actions go, beside the tabs. */
  actionsRef: Ref<HTMLDivElement>;
  terminals: ReactNode;
  changes: ReactNode;
}

/**
 * The panel beside the chat (DESIGN.md §4.6): terminals and changes as tabs. Both stay mounted, so
 * a terminal keeps its screen while the changes are on top.
 */
export function SidePanel({
  tab,
  counts,
  onTab,
  onClose,
  actionsRef,
  terminals,
  changes,
}: SidePanelProps) {
  const [byKeyboard, setByKeyboard] = useState(false);
  const tabRefs = useRef<Partial<Record<SideTab, HTMLButtonElement | null>>>({});
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = tab === 'terminals' ? 'changes' : 'terminals';
    setByKeyboard(true);
    onTab(next);
    tabRefs.current[next]?.focus();
  };
  return (
    <div data-side-panel={tab} className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex h-7 min-w-0 shrink-0 items-center gap-1">
        <div
          role="tablist"
          aria-label="Side panel"
          onKeyDown={onKeyDown}
          className="flex min-w-0 flex-1 items-center gap-2.5"
        >
          {TABS.map(({ id, label }) => {
            const selected = id === tab;
            return (
              <button
                key={id}
                ref={(el) => {
                  tabRefs.current[id] = el;
                }}
                type="button"
                role="tab"
                id={`side-tab-${id}`}
                aria-selected={selected}
                aria-controls={`side-panel-${id}`}
                tabIndex={selected ? 0 : -1}
                data-side-tab={id}
                onClick={(e) => {
                  setByKeyboard(e.detail === 0);
                  onTab(id);
                }}
                className={cx(
                  'relative flex h-7 min-w-0 items-baseline gap-1.5 pt-1 font-medium text-body-sm transition-colors duration-fast',
                  selected ? 'text-text-1' : 'text-text-3 hover:text-text-2',
                )}
              >
                <span className="truncate">{label}</span>
                {counts[id] > 0 && (
                  <span className="tabular font-normal text-meta text-text-2">{counts[id]}</span>
                )}
                {selected && (
                  <motion.span
                    layoutId="focus-side-indicator"
                    transition={tabGlide(byKeyboard)}
                    aria-hidden
                    data-tab-indicator
                    className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-text-1"
                  />
                )}
              </button>
            );
          })}
        </div>
        <div ref={actionsRef} className="flex shrink-0 items-center gap-1 empty:hidden" />
        <IconButton
          size="sm"
          label="Fold the side panel"
          data-panel-toggle
          icon={<PanelRightClose className="size-4" strokeWidth={1.5} />}
          onClick={(e) => onClose(e.detail === 0)}
        />
      </div>
      <div
        role="tabpanel"
        id="side-panel-terminals"
        aria-labelledby="side-tab-terminals"
        hidden={tab !== 'terminals'}
        className="min-h-0 flex-1"
      >
        {terminals}
      </div>
      <div
        role="tabpanel"
        id="side-panel-changes"
        aria-labelledby="side-tab-changes"
        hidden={tab !== 'changes'}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {changes}
      </div>
    </div>
  );
}

/** The folded side panel: one button per tab, each with its count, that opens it. */
export function SideRail({
  counts,
  onOpen,
}: {
  counts: Record<SideTab, number>;
  onOpen: (tab: SideTab, byKeyboard: boolean) => void;
}) {
  return (
    <nav aria-label="Side panel" data-side-rail className="focus-rail">
      {TABS.map(({ id, label, icon: Icon }, i) => (
        <span key={id} className="relative flex">
          <IconButton
            label={counts[id] > 0 ? `${label}, ${counts[id]}` : label}
            tooltipSide="left"
            data-panel-toggle={i === 0 ? '' : undefined}
            data-side-open={id}
            icon={<Icon className="size-4" strokeWidth={1.5} />}
            onClick={(e) => onOpen(id, e.detail === 0)}
          />
          {counts[id] > 0 && (
            <span
              aria-hidden
              className="tabular pointer-events-none absolute -top-1 -right-1 rounded-full bg-bg-2 px-1 text-[11px] text-text-2 leading-4"
            >
              {counts[id] > 99 ? '99+' : counts[id]}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
