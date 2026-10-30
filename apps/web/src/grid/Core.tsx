import type { CSSProperties } from 'react';
import { countOf } from '../plural.js';
import { cx } from '../ui/cx.js';
import { CORE_R } from './map.js';

const R = CORE_R - 4;
/** A pointy-topped hexagon with its three facets: the faceted core of §10.4. */
const OUTER = Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 3) * i - Math.PI / 2;
  return [R * Math.cos(a), R * Math.sin(a)] as const;
});
const POINTS = OUTER.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
const FACETS = [0, 2, 4]
  .map((i) => `M0 0 L${OUTER[i]?.[0].toFixed(2)} ${OUTER[i]?.[1].toFixed(2)}`)
  .join(' ');

export interface CoreProps {
  /** 0..1, the whole board's activity: the core brightens with it. */
  energy: number;
  count: number;
  /** Its center, in the map's coordinates. */
  style?: CSSProperties;
  className?: string;
}

/** You, in the middle of the network (DESIGN.md §10.4): brighter the busier the board is. */
export function Core({ energy, count, style, className }: CoreProps) {
  const size = CORE_R * 2;
  return (
    <div
      role="img"
      aria-label={`You, ${countOf(count, 'project')}`}
      data-grid-core
      className={cx('grid-core pointer-events-none absolute', className)}
      style={{ width: size, height: size, ...style }}
    >
      <span aria-hidden className="grid-core-glow" style={{ opacity: 0.25 + 0.75 * energy }} />
      <svg
        aria-hidden
        width={size}
        height={size}
        viewBox={`${-CORE_R} ${-CORE_R} ${size} ${size}`}
        className="relative"
      >
        <polygon className="grid-core-body" points={POINTS} />
        <path className="grid-core-facets" d={FACETS} />
        <polygon
          className="grid-core-light"
          points={POINTS}
          style={{ opacity: 0.2 + 0.6 * energy }}
        />
      </svg>
    </div>
  );
}
