import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../../ui/cx.js';

// Office kit pieces (DESIGN.md §10.3) are drawn in room units: 1 unit is 1 CSS px at scale 1,
// where characters stand 56 px tall. Each piece is static SVG art plus optional HTML layers on
// top for anything that moves or holds text, positioned in % of the piece with `at`.

export interface KitArtProps {
  /** Natural size in room units. */
  w: number;
  h: number;
  /** 2 in the room view, where characters grow to 120 px. */
  scale?: number;
  /** Which piece, for tests and the kit sheet (`data-kit`). */
  kind: string;
  className?: string;
  style?: CSSProperties;
  /** SVG content in the piece's viewBox. */
  children: ReactNode;
  /** HTML layers over the art. */
  layers?: ReactNode;
}

export function KitArt({ w, h, scale = 1, kind, className, style, children, layers }: KitArtProps) {
  return (
    <span
      aria-hidden
      data-kit={kind}
      className={cx('kit relative inline-block shrink-0 align-bottom', className)}
      style={{ width: w * scale, height: h * scale, ...style }}
    >
      <svg
        aria-hidden
        viewBox={`0 0 ${w} ${h}`}
        className="absolute inset-0 size-full overflow-visible"
      >
        {children}
      </svg>
      {layers}
    </span>
  );
}

/** A layer's box over a `w × h` piece, from room units to %. */
export const at = (
  w: number,
  h: number,
  x: number,
  y: number,
  width: number,
  height: number,
): CSSProperties => ({
  left: `${(x / w) * 100}%`,
  top: `${(y / h) * 100}%`,
  width: `${(width / w) * 100}%`,
  height: `${(height / h) * 100}%`,
});
