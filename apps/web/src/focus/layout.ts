import type { KeyValueStorage } from '../prefs.js';

/** Widths in px of the focus view's side columns; the Claude panel takes the rest. */
export interface ColumnSizes {
  left: number;
  right: number;
}

export type SideColumn = keyof ColumnSizes;

interface ColumnLimit {
  min: number;
  max: number;
  /** Widths a released handle springs to when it lands near one. */
  snaps: readonly number[];
}

export const COLUMN_LIMITS: Record<SideColumn, ColumnLimit> = {
  left: { min: 220, max: 420, snaps: [240, 280, 340, 400] },
  right: { min: 300, max: 640, snaps: [340, 420, 520, 620] },
};

export const DEFAULT_SIZES: ColumnSizes = { left: 280, right: 420 };

/** Without a saved size the terminal column takes this share of the body. */
const RIGHT_SHARE = 0.3;
/** Bodies narrower than this start with the slimmer left column. */
const NARROW_BODY = 1280;

/**
 * Sizes for a project nobody resized yet, relative to a body `width` px wide (0: not measured),
 * so the Claude panel keeps most of the room on laptop screens.
 */
export function defaultSizes(width: number): ColumnSizes {
  if (width <= 0) return DEFAULT_SIZES;
  const right = COLUMN_LIMITS.right;
  return {
    left: width < NARROW_BODY ? 240 : DEFAULT_SIZES.left,
    right: Math.round(clamp(width * RIGHT_SHARE, right.min, right.snaps[2] ?? right.max)),
  };
}

/** The Claude panel never gets narrower than this while the side columns can still give way. */
export const CENTER_MIN = 360;
/** Each resize handle is its own grid track. */
export const HANDLE_PX = 12;
/** How close (px) a release must be to a snap width to land on it. */
export const SNAP_RADIUS = 28;
/** Keyboard steps: arrows, and arrows with Shift. */
export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The widest `column` may be next to `other` in a body `width` px wide (0: not measured yet). */
export function maxWidth(column: SideColumn, other: number, width: number): number {
  const { min, max } = COLUMN_LIMITS[column];
  if (width <= 0) return max;
  const room = width - other - 2 * HANDLE_PX - CENTER_MIN;
  return Math.max(min, Math.min(max, room));
}

/**
 * Fits stored sizes into a body `width` px wide: each column within its limits, then the right
 * and then the left column give way until the Claude panel has `CENTER_MIN`.
 */
export function fitSizes(sizes: ColumnSizes, width: number): ColumnSizes {
  let left = clamp(sizes.left, COLUMN_LIMITS.left.min, COLUMN_LIMITS.left.max);
  let right = clamp(sizes.right, COLUMN_LIMITS.right.min, COLUMN_LIMITS.right.max);
  right = Math.min(right, maxWidth('right', left, width));
  left = Math.min(left, maxWidth('left', right, width));
  return { left: Math.round(left), right: Math.round(right) };
}

/** Where a released handle settles: the nearest snap width within `SNAP_RADIUS`, else in place. */
export function snapWidth(column: SideColumn, value: number, max: number): number {
  const { min, snaps } = COLUMN_LIMITS[column];
  let best = value;
  let distance = SNAP_RADIUS;
  for (const snap of snaps) {
    const d = Math.abs(snap - value);
    if (d <= distance && snap <= max) {
      best = snap;
      distance = d;
    }
  }
  return Math.round(clamp(best, min, max));
}

const storageKey = (projectId: string) => `yardmaster.focus.${projectId}`;

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const isWidth = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * The project's saved column sizes, each one only if it was saved and is valid. Missing,
 * corrupt or blocked storage gives `{}` (the caller fills in `defaultSizes`).
 */
export function loadSizes(
  projectId: string,
  storage: KeyValueStorage | undefined = defaultStorage(),
): Partial<ColumnSizes> {
  try {
    const raw = storage?.getItem(storageKey(projectId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { left, right } = parsed as Record<string, unknown>;
    return {
      ...(isWidth(left) ? { left: clampColumn('left', left) } : {}),
      ...(isWidth(right) ? { right: clampColumn('right', right) } : {}),
    };
  } catch {
    return {};
  }
}

const clampColumn = (column: SideColumn, value: number) =>
  Math.round(clamp(value, COLUMN_LIMITS[column].min, COLUMN_LIMITS[column].max));

/** Saves the columns the user sized; the others keep following `defaultSizes`. */
export function saveSizes(
  projectId: string,
  sizes: Partial<ColumnSizes>,
  storage: KeyValueStorage | undefined = defaultStorage(),
): void {
  const rounded: Partial<ColumnSizes> = {};
  if (sizes.left !== undefined) rounded.left = Math.round(sizes.left);
  if (sizes.right !== undefined) rounded.right = Math.round(sizes.right);
  try {
    storage?.setItem(storageKey(projectId), JSON.stringify(rounded));
  } catch {
    // Full or disabled storage: the sizes still apply until the page reloads.
  }
}
