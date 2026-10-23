import {
  animate,
  type HTMLMotionProps,
  type MotionValue,
  motion,
  useMotionTemplate,
  useMotionValue,
} from 'motion/react';
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createResizeMark, type ResizeMark } from '../anim/resizing.js';
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
  /** How each column enters (the focus view's settle after the morph). */
  settle?: HTMLMotionProps<'section'>;
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
  settle,
}: ResizableColumnsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Drags and settle springs mark the grid, so the terminals refit once when it lands.
  const [mark] = useState(() => createResizeMark(() => rootRef.current));
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
      <motion.section
        {...settle}
        id={ids.left}
        aria-label={labels.left}
        className="focus-col"
        inert={rightMaximized}
      >
        {left}
      </motion.section>
      <Handle
        column="left"
        controls={ids.left}
        label={`Resize ${labels.left.toLowerCase()}`}
        value={leftWidth}
        other={rightWidth}
        width={width}
        mark={mark}
        onCommit={commit}
      />
      <motion.section
        {...settle}
        aria-label={labels.center}
        className="focus-col"
        inert={rightMaximized}
      >
        {center}
      </motion.section>
      <Handle
        column="right"
        controls={ids.right}
        label={`Resize ${labels.right.toLowerCase()}`}
        value={rightWidth}
        other={leftWidth}
        width={width}
        mark={mark}
        onCommit={commit}
      />
      <motion.section
        {...settle}
        id={ids.right}
        aria-label={labels.right}
        className={cx('focus-col', rightMaximized && 'focus-col-max')}
      >
        {right}
      </motion.section>
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
  mark,
  onCommit,
}: {
  column: SideColumn;
  controls: string;
  label: string;
  value: MotionValue<number>;
  other: MotionValue<number>;
  width: number;
  mark: ResizeMark;
  onCommit: (column: SideColumn, value: number) => void;
}) {
  const level = useMotionLevel();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; start: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const { min } = COLUMN_LIMITS[column];
  const currentMax = () => maxWidth(column, other.get(), width);
  // The widths move every frame of a drag or spring: their ARIA values are written straight to
  // the DOM, so the handles don't re-render per frame.
  useEffect(() => {
    const set = (name: string, v: number) => ref.current?.setAttribute(name, String(Math.round(v)));
    const offValue = value.on('change', (v) => set('aria-valuenow', v));
    const offOther = other.on('change', (v) => set('aria-valuemax', maxWidth(column, v, width)));
    return () => {
      offValue();
      offOther();
    };
  }, [value, other, column, width]);
  // A settle spring holds the grid's resize mark until it lands or something stops it (a new
  // drag, a key, the body resizing). Both events fire before the value lets go of the animation,
  // and a replacing spring cancels the old one first, so look once the current call is done.
  useEffect(() => {
    const end = () =>
      queueMicrotask(() => {
        if (!drag.current && !value.isAnimating()) mark.end(column);
      });
    const offComplete = value.on('animationComplete', end);
    const offCancel = value.on('animationCancel', end);
    return () => {
      offComplete();
      offCancel();
      mark.end(column);
    };
  }, [value, mark, column]);
  // The left handle grows its column to the right; the right handle grows its column leftwards.
  const direction = column === 'left' ? 1 : -1;
  const clamp = (v: number) => Math.min(currentMax(), Math.max(min, v));

  const settle = (target: number, byKeyboard = false) => {
    const to = Math.round(clamp(target));
    // A width change is movement: Reduced and Off land on it directly. Keys land at once too
    // (DESIGN.md §3 rule 11): a spring per arrow press lags behind a held key.
    if (level === 'full' && !byKeyboard && value.get() !== to) {
      mark.start(column);
      animate(value, to, spring.snappy);
    } else {
      value.jump(to);
      mark.end(column);
    }
    onCommit(column, to);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { x: e.clientX, start: value.get() };
    mark.start(column);
    value.stop();
    e.currentTarget.setPointerCapture(e.pointerId);
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
    settle(snapWidth(column, value.get(), currentMax()));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const current = value.get();
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = current + step * direction;
    else if (e.key === 'ArrowLeft') next = current - step * direction;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = currentMax();
    else if (e.key === 'Enter') next = defaultSizes(width)[column];
    if (next === null) return;
    e.preventDefault();
    settle(next, true);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable separator has no element.
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={currentMax()}
      aria-valuenow={Math.round(value.get())}
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
