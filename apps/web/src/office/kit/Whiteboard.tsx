import { cx } from '../../ui/cx.js';
import { DrawnCheck } from '../../ui/DrawnCheck.js';
import { KitArt } from './art.js';

export interface WhiteboardItem {
  text: string;
  done: boolean;
}

export const WHITEBOARD_LINES = 3;

/**
 * The room's whiteboard (DESIGN.md §10.3): the main session's todo list, up to 3 lines whose
 * checks draw in as they finish, or the last turn's summary when there is no list. A session in
 * plan mode stands beside it drawing (`CrewMascot pose="drawing"`, on its left).
 */
export function Whiteboard({
  items = [],
  summary = null,
  scale = 1,
  className,
}: {
  items?: readonly WhiteboardItem[];
  summary?: string | null;
  scale?: number;
  className?: string;
}) {
  const W = 136;
  const H = 80;
  const shown = items.slice(0, WHITEBOARD_LINES);
  return (
    <KitArt
      kind="whiteboard"
      w={W}
      h={H}
      scale={scale}
      className={className}
      layers={
        <div
          className="absolute flex flex-col justify-center gap-0.5 overflow-hidden"
          style={{ left: '8%', right: '7%', top: '9%', bottom: '19%' }}
        >
          {shown.length > 0
            ? shown.map((item, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: todo lines are positional.
                  key={i}
                  data-kit-todo={item.done ? 'done' : 'open'}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none">
                    {item.done ? (
                      <DrawnCheck key="done" draw />
                    ) : (
                      <circle cx="8" cy="8" r="6" className="stroke-text-3" strokeWidth="1.2" />
                    )}
                  </svg>
                  <span
                    title={item.text}
                    className={cx(
                      'min-w-0 truncate text-label',
                      item.done ? 'text-text-3' : 'text-text-2',
                    )}
                  >
                    {item.text}
                  </span>
                </div>
              ))
            : summary && (
                <p className="line-clamp-3 text-label text-text-2" title={summary}>
                  {summary}
                </p>
              )}
        </div>
      }
    >
      <rect x="0" y="0" width={W} height={H - 8} rx="3" className="kit-board" />
      <rect x="4" y="4" width={W - 8} height={H - 16} rx="2" className="kit-line" fill="none" />
      <rect x="10" y={H - 9} width={W - 20} height="4" rx="1.5" className="kit-top" />
      <rect x="20" y={H - 12} width="12" height="3" rx="1.2" fill="var(--text-3)" />
      <rect x="36" y={H - 12} width="10" height="3" rx="1.2" fill="var(--st-work)" opacity="0.7" />
      <line x1="30" y1={H - 5} x2="22" y2={H} className="kit-line-strong" />
      <line x1={W - 30} y1={H - 5} x2={W - 22} y2={H} className="kit-line-strong" />
    </KitArt>
  );
}
