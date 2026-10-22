import { animate, type MotionValue, motion, useMotionTemplate, useMotionValue } from 'motion/react';
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { spring, useMotionLevel } from '../motion.js';
import { cx } from '../ui/cx.js';
import {
  COLUMN_LIMITS,
  type ColumnSizes,
  defaultSizes,
  fitSizes,
  HANDLE_PX,
  KEY_STEP,
  KEY_STEP_LARGE,
  loadSizes,
  maxWidth,
  type SideColumn,
  saveSizes,
  snapWidth,
} from './layout.js';

export interface ResizableColumnsProps {
  projectId: string;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  labels: Record<SideColumn | 'center', string>;
  /** The right column covers the others (the maximized terminal stack). */
  rightMaximized?: boolean;
}

/**
 * Three columns with two drag handles (mount one per project: sizes load once). Widths follow the pointer while dragging, spring to the
 * nearest snap width on release, and persist per project. The handles are keyboard separators.
 */
export function ResizableColumns({
  projectId,
  left,
  center,
  right,
  labels,
  rightMaximized = false,
}: ResizableColumnsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // What the user chose (unsized columns follow the body width); the rendered widths are this
  // fitted to the current body width.
  const [initial] = useState(() => loadSizes(projectId));
  const chosen = useRef<Partial<ColumnSizes>>(initial);
  const start = { ...defaultSizes(0), ...initial };
  const leftWidth = useMotionValue(start.left);
  const rightWidth = useMotionValue(start.right);
  const columns = useMotionTemplate`${leftWidth}px ${HANDLE_PX}px minmax(0, 1fr) ${HANDLE_PX}px ${rightWidth}px`;

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const fitted = fitSizes({ ...defaultSizes(width), ...chosen.current }, width);
    leftWidth.jump(fitted.left);
    rightWidth.jump(fitted.right);
  }, [width, leftWidth, rightWidth]);

  const commit = (column: SideColumn, value: number) => {
    chosen.current = { ...chosen.current, [column]: value };
    saveSizes(projectId, chosen.current);
  };

  const ids = { left: `${projectId}-col-left`, right: `${projectId}-col-right` };
  return (
    <motion.div
      ref={rootRef}
      style={{ gridTemplateColumns: columns }}
      className="relative grid min-h-0 flex-1"
    >
      <section id={ids.left} aria-label={labels.left} className="focus-col" inert={rightMaximized}>
        {left}
      </section>
      <Handle
        column="left"
        controls={ids.left}
        label={`Resize ${labels.left.toLowerCase()}`}
        value={leftWidth}
        other={rightWidth}
        width={width}
        onCommit={commit}
      />
      <section aria-label={labels.center} className="focus-col" inert={rightMaximized}>
        {center}
      </section>
      <Handle
        column="right"
        controls={ids.right}
        label={`Resize ${labels.right.toLowerCase()}`}
        value={rightWidth}
        other={leftWidth}
        width={width}
        onCommit={commit}
      />
      <section
        id={ids.right}
        aria-label={labels.right}
        className={cx('focus-col', rightMaximized && 'focus-col-max')}
      >
        {right}
      </section>
    </motion.div>
  );
}

function Handle({
  column,
  controls,
  label,
  value,
  other,
  width,
  onCommit,
}: {
  column: SideColumn;
  controls: string;
  label: string;
  value: MotionValue<number>;
  other: MotionValue<number>;
  width: number;
  onCommit: (column: SideColumn, value: number) => void;
}) {
  const level = useMotionLevel();
  const drag = useRef<{ x: number; start: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(() => Math.round(value.get()));
  useEffect(() => value.on('change', (v) => setNow(Math.round(v))), [value]);

  const { min } = COLUMN_LIMITS[column];
  const max = maxWidth(column, other.get(), width);
  // The left handle grows its column to the right; the right handle grows its column leftwards.
  const direction = column === 'left' ? 1 : -1;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const settle = (target: number) => {
    const to = Math.round(clamp(target));
    // A width change is movement: Reduced and Off land on it directly.
    if (level === 'full') animate(value, to, spring.snappy);
    else value.jump(to);
    onCommit(column, to);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    value.stop();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, start: value.get() };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    value.jump(clamp(d.start + (e.clientX - d.x) * direction));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    settle(snapWidth(column, value.get(), max));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const current = value.get();
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = current + step * direction;
    else if (e.key === 'ArrowLeft') next = current - step * direction;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else if (e.key === 'Enter') next = defaultSizes(width)[column];
    if (next === null) return;
    e.preventDefault();
    settle(next);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable separator has no element.
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={now}
      data-resize={column}
      data-dragging={dragging || undefined}
      title="Drag to resize, double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => settle(defaultSizes(width)[column])}
      onKeyDown={onKeyDown}
      className={cx('focus-handle group', dragging && 'cursor-col-resize')}
    >
      <span aria-hidden className="focus-handle-line" />
      <span aria-hidden className="focus-handle-grip" />
    </div>
  );
}
