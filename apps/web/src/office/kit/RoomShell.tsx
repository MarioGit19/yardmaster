import type { Project } from '@c-board/protocol';
import { type CSSProperties, type ReactNode, useId, useRef } from 'react';
import { ProjectAvatar } from '../../shell/ProjectAvatar.js';
import { cx } from '../../ui/cx.js';
import { at } from './art.js';
import { useKitLive } from './loops.js';

/** Off, amber when something in the room waits for you, rose on an error. */
export type DoorLight = 'off' | 'wait' | 'err';

export interface RoomShellProps {
  project: Pick<Project, 'name' | 'accent'>;
  branch?: string | null;
  /** Uncommitted files, shown after the branch. */
  dirty?: number;
  doorLight?: DoorLight;
  /** 0..1, the room's activity level: the ceiling light's brightness. */
  light?: number;
  /** Nothing for 5 min: the light dims, like the 70 % pod dim. */
  dim?: boolean;
  /** Room units; every room shares one footprint so the building's grid stays even. */
  w?: number;
  h?: number;
  className?: string;
  /** The stations and characters, positioned in room units by the layout. */
  children?: ReactNode;
}

export const ROOM = { w: 360, h: 220, floor: 184 } as const;

const DOOR = { x: 14, y: 96, w: 40, h: ROOM.floor - 96 };

/**
 * One project's room (DESIGN.md §10.3): back wall and floor, the door with its nameplate and
 * door light on the left, a window, and the ceiling light whose glow follows the activity level.
 */
export function RoomShell({
  project,
  branch = null,
  dirty = 0,
  doorLight = 'off',
  light = 0,
  dim = false,
  w = ROOM.w,
  h = ROOM.h,
  className,
  children,
}: RoomShellProps) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useKitLive(ref);
  const lamp = dim ? 0.06 : 0.14 + 0.5 * Math.min(1, Math.max(0, light));
  const accent = `var(--accent-${project.accent})`;
  const floor = (ROOM.floor / ROOM.h) * h;

  return (
    <div
      ref={ref}
      data-kit="room"
      data-kit-door={doorLight}
      data-kit-paused={live ? undefined : ''}
      className={cx('kit relative overflow-hidden', className)}
      style={{ width: w, height: h, '--room-accent': accent } as CSSProperties}
    >
      <svg
        aria-hidden
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="absolute inset-0 size-full"
      >
        <rect width={w} height={floor} className="kit-wall" />
        <rect y={floor} width={w} height={h - floor} className="kit-floor" />
        <line x1="0" y1={floor} x2={w} y2={floor} className="kit-line-strong" />
        <line x1="0" y1={floor - 6} x2={w} y2={floor - 6} className="kit-line" />
        {/* Ceiling and the lamp's cord. */}
        <line x1="0" y1="0.5" x2={w} y2="0.5" className="kit-line-strong" />
        <line x1={w / 2} y1="0" x2={w / 2} y2="14" className="kit-line-strong" />
        <path d={`M${w / 2 - 14} 24 Q${w / 2} 10 ${w / 2 + 14} 24 Z`} className="kit-top" />
        <ellipse cx={w / 2} cy="24" rx="6" ry="2" fill="var(--office-lamp)" opacity={0.3 + lamp} />
      </svg>

      {/* The lamp's warm glow: one radial gradient whose opacity follows the activity level. */}
      <span
        aria-hidden
        data-kit-lamp={lamp.toFixed(2)}
        className="kit-lamp pointer-events-none absolute"
        style={{ ...at(w, h, w / 2 - 150, 0, 300, floor + 20), opacity: lamp }}
      />

      <Window x={w - 104} y={36} />

      {/* The door, in the project's accent: the only accent in the room besides the main visor. */}
      <svg
        aria-hidden
        className="absolute overflow-visible"
        style={at(w, h, DOOR.x, DOOR.y, DOOR.w, DOOR.h)}
        viewBox={`0 0 ${DOOR.w} ${DOOR.h}`}
      >
        <rect x="0" y="0" width={DOOR.w} height={DOOR.h} rx="2" className="kit-door" />
        <rect
          x="5"
          y="6"
          width={DOOR.w - 10}
          height={DOOR.h * 0.42}
          rx="1.5"
          className="kit-line-strong"
          fill="none"
        />
        <rect
          x="5"
          y={DOOR.h * 0.52}
          width={DOOR.w - 10}
          height={DOOR.h * 0.4}
          rx="1.5"
          className="kit-line-strong"
          fill="none"
        />
        <circle cx={DOOR.w - 8} cy={DOOR.h * 0.5} r="2" fill="var(--room-accent)" />
      </svg>

      <span
        aria-hidden
        data-kit-door-light={doorLight}
        className={cx('kit-door-light absolute rounded-full', doorLight !== 'off' && 'kit-anim')}
        style={at(w, h, DOOR.x + DOOR.w / 2 - 4, DOOR.y - 14, 8, 8)}
      />

      <div
        data-kit-nameplate
        className="absolute flex min-w-0 items-center gap-2 rounded-control border border-line bg-bg-1/90 px-2 py-1 shadow-raised"
        style={{ left: (DOOR.x / ROOM.w) * w, top: 12, maxWidth: w * 0.52 }}
      >
        <ProjectAvatar project={project} size="sm" />
        <span className="min-w-0">
          <span className="block truncate text-label font-medium text-text-1" title={project.name}>
            {project.name}
          </span>
          {branch && (
            <span className="flex min-w-0 items-center gap-1 font-mono text-label text-text-3">
              <span className="truncate" title={branch}>
                {branch}
              </span>
              {dirty > 0 && <span className="shrink-0 text-st-wait-ink tabular">●{dirty}</span>}
            </span>
          )}
        </span>
      </div>

      {children && <div className="absolute inset-0">{children}</div>}
    </div>
  );
}

/** The back-wall window: night sky with a few stars, or a bright day with a cloud. */
function Window({ x, y }: { x: number; y: number }) {
  const sky = useId();
  return (
    <svg
      aria-hidden
      className="absolute overflow-visible"
      style={{ left: x, top: y, width: 80, height: 64 }}
      viewBox="0 0 80 64"
    >
      <defs>
        <linearGradient id={sky} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--office-sky)" />
          <stop offset="1" stopColor="var(--office-sky-low)" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="80" height="64" rx="2" fill={`url(#${sky})`} />
      <g className="kit-night" fill="var(--text-1)">
        <circle cx="14" cy="12" r="0.9" opacity="0.7" />
        <circle cx="52" cy="9" r="0.7" opacity="0.5" />
        <circle cx="66" cy="22" r="1" opacity="0.6" />
        <circle cx="30" cy="40" r="0.6" opacity="0.4" />
        <path d="M60 46 a8 8 0 1 1 -6 -12 a6 6 0 0 0 6 12 Z" opacity="0.55" />
      </g>
      <g className="kit-day" fill="var(--bg-1)" opacity="0.9">
        <ellipse cx="22" cy="20" rx="10" ry="4.5" />
        <ellipse cx="30" cy="17" rx="7" ry="5" />
        <ellipse cx="60" cy="44" rx="8" ry="3.5" opacity="0.7" />
      </g>
      <rect x="0" y="0" width="80" height="64" rx="2" className="kit-frame" />
      <line x1="40" y1="0" x2="40" y2="64" className="kit-frame" />
      <line x1="0" y1="32" x2="80" y2="32" className="kit-frame" />
      <rect x="-4" y="63" width="88" height="4" rx="1.5" className="kit-top" />
    </svg>
  );
}
