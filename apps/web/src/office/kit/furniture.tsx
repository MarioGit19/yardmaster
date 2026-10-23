import { motion } from 'motion/react';
import { useRef } from 'react';
import { spring, useMotionLevel } from '../../motion.js';
import { at, KitArt } from './art.js';
import { LedRow, ScrollingLines, useKitLive } from './loops.js';

// The office's stations and furniture (DESIGN.md §10.3). Flat vector, soft shading: furniture in
// the office tokens with 1 px `--line` outlines (the `kit-*` classes in index.css), no accent.

interface PieceProps {
  scale?: number;
  className?: string;
}

/** A Claude session's desk. The monitor shows the tool-family color and the action's glyph. */
export function Desk({
  screen = null,
  glyph = null,
  scale,
  className,
}: PieceProps & {
  /** Screen color, e.g. `var(--orb-edit)`; null is a dark screen. */
  screen?: string | null;
  /** The current action's glyph (✎ ⌕ ▶ …). */
  glyph?: string | null;
}) {
  const W = 88;
  const H = 50;
  return (
    <KitArt
      kind="desk"
      w={W}
      h={H}
      scale={scale}
      className={className}
      layers={
        glyph && (
          <span
            className="absolute grid place-items-center font-mono leading-none"
            style={{
              ...at(W, H, 26, 2, 36, 18),
              color: screen ?? 'var(--text-3)',
              fontSize: `${11 * (scale ?? 1)}px`,
            }}
          >
            {glyph}
          </span>
        )
      }
    >
      <rect x="40" y="22" width="8" height="5" className="kit-wood" />
      <rect x="32" y="26" width="24" height="2" rx="1" className="kit-wood" />
      <rect x="24" y="0" width="40" height="22" rx="2.5" className="kit-screen" />
      {screen && <rect x="26" y="2" width="36" height="18" rx="1.5" fill={screen} opacity="0.22" />}
      <rect x="0" y="28" width="88" height="5" rx="1.5" className="kit-top" />
      <rect x="4" y="33" width="4" height="17" className="kit-wood" />
      <rect x="62" y="33" width="22" height="17" rx="1" className="kit-wood" />
      <line x1="65" y1="41" x2="81" y2="41" className="kit-line" />
      <rect x="71" y="36" width="4" height="1.5" rx="0.75" fill="var(--line-strong)" />
      <rect x="71" y="44" width="4" height="1.5" rx="0.75" fill="var(--line-strong)" />
    </KitArt>
  );
}

/** Where subagents work: a smaller desk with a laptop. */
export function SideDesk({ scale, className }: PieceProps) {
  return (
    <KitArt kind="side-desk" w={56} h={36} scale={scale} className={className}>
      <path d="M17 13 L21 4 H37 L35 13 Z" className="kit-screen" />
      <rect x="14" y="13" width="26" height="2" rx="1" className="kit-wood" />
      <rect x="0" y="15" width="56" height="4" rx="1.5" className="kit-top" />
      <rect x="4" y="19" width="3.5" height="17" className="kit-wood" />
      <rect x="48.5" y="19" width="3.5" height="17" className="kit-wood" />
    </KitArt>
  );
}

/** A long-running terminal's station. Its lights blink with the output rate; ports show on top. */
export function ServerRack({
  rate = 0,
  ports = [],
  scale,
  className,
}: PieceProps & {
  /** 0..1 output rate: still lights at 0, quick blinking at 1. */
  rate?: number;
  ports?: readonly number[];
}) {
  const W = 44;
  const H = 92;
  const units = [0, 1, 2, 3, 4];
  return (
    <KitArt
      kind="server-rack"
      w={W}
      h={H}
      scale={scale}
      className={className}
      layers={
        <>
          {units.map((u) => (
            <LedRow
              key={u}
              count={3}
              color={u === 4 ? 'var(--st-tool)' : 'var(--st-ok)'}
              rate={rate}
              seed={u + 1}
              style={at(W, H, 7, 13.5 + u * 14, 11, 3)}
            />
          ))}
          {ports.length > 0 && (
            <span
              data-kit-ports
              className="absolute flex justify-center gap-0.5"
              style={{ ...at(W, H, -10, -14, 64, 12) }}
            >
              {ports.slice(0, 2).map((port) => (
                <span
                  key={port}
                  className="rounded-chip border border-line bg-bg-1 px-1 font-mono text-meta leading-tight text-text-2 tabular"
                >
                  :{port}
                </span>
              ))}
            </span>
          )}
        </>
      }
    >
      <rect x="0" y="0" width="44" height="88" rx="3" className="kit-wood" />
      <rect x="0" y="0" width="44" height="4" rx="2" className="kit-top" />
      {units.map((u) => (
        <g key={u}>
          <rect x="4" y={8 + u * 14} width="36" height="12" rx="1.5" className="kit-screen" />
          {[0, 1, 2, 3].map((v) => (
            <line
              key={v}
              x1={24 + v * 4}
              y1={11 + u * 14}
              x2={24 + v * 4}
              y2={17 + u * 14}
              className="kit-line-strong"
            />
          ))}
        </g>
      ))}
      <rect x="3" y="88" width="6" height="4" className="kit-wood" />
      <rect x="35" y="88" width="6" height="4" className="kit-wood" />
    </KitArt>
  );
}

/**
 * A one-shot command's station: a bench with a progress screen whose lines scroll with the
 * output rate, and a bar for the command's progress when it's known.
 */
export function Workbench({
  running = false,
  rate = 0,
  progress = null,
  scale,
  className,
}: PieceProps & {
  /** A command runs: the screen is lit and scrolls. */
  running?: boolean;
  rate?: number;
  /** 0..1, or null when unknown. */
  progress?: number | null;
}) {
  const W = 96;
  const H = 56;
  const ref = useRef<HTMLSpanElement>(null);
  const still = useMotionLevel() !== 'full';
  const live = useKitLive(ref, running);
  return (
    <KitArt
      kind="workbench"
      w={W}
      h={H}
      scale={scale}
      className={className}
      layers={
        <span ref={ref} className="absolute inset-0" data-kit-live={live ? '' : undefined}>
          {running && (
            <ScrollingLines
              lines={[70, 40, 85, 55, 30, 75]}
              color="var(--st-tool)"
              rate={rate}
              running={live}
              style={at(W, H, 13, 5, 30, 16)}
            />
          )}
          {progress !== null && (
            <span
              className="absolute overflow-hidden rounded-full bg-bg-0"
              style={at(W, H, 13, 23, 30, 2)}
            >
              <motion.span
                data-kit-progress
                className="absolute inset-0 origin-left rounded-full bg-st-tool"
                initial={false}
                animate={{ scaleX: Math.min(1, Math.max(0, progress)) }}
                transition={still ? { duration: 0 } : spring.smooth}
              />
            </span>
          )}
        </span>
      }
    >
      <rect x="25" y="26" width="6" height="6" className="kit-wood" />
      <rect x="10" y="2" width="36" height="25" rx="2.5" className="kit-screen" />
      {running && (
        <rect x="12" y="4" width="32" height="21" rx="1.5" fill="var(--st-tool)" opacity="0.08" />
      )}
      <rect x="58" y="22" width="16" height="10" rx="1.5" className="kit-wood" />
      <rect x="77" y="26" width="10" height="6" rx="1" className="kit-wood" />
      <rect x="0" y="32" width="96" height="6" rx="1.5" className="kit-top" />
      <rect x="5" y="38" width="5" height="18" className="kit-wood" />
      <rect x="86" y="38" width="5" height="18" className="kit-wood" />
      <line x1="10" y1="49" x2="86" y2="49" className="kit-line-strong" />
    </KitArt>
  );
}

/** Where idle terminal shells rest. */
export function Couch({ scale, className }: PieceProps) {
  return (
    <KitArt kind="couch" w={96} h={44} scale={scale} className={className}>
      <rect x="8" y="2" width="80" height="22" rx="6" className="kit-wood" />
      <rect x="10" y="20" width="37" height="12" rx="4" className="kit-top" />
      <rect x="49" y="20" width="37" height="12" rx="4" className="kit-top" />
      <rect x="0" y="12" width="12" height="26" rx="5" className="kit-wood" />
      <rect x="84" y="12" width="12" height="26" rx="5" className="kit-wood" />
      <rect x="8" y="30" width="80" height="8" rx="2" className="kit-wood" />
      <rect x="10" y="38" width="4" height="6" rx="1" className="kit-wood" />
      <rect x="82" y="38" width="4" height="6" rx="1" className="kit-wood" />
    </KitArt>
  );
}

// Spines in neutral tones only: accents are identity, never decoration (§10.3 "Look").
const BOOKS = [
  [3, 22, 0.55],
  [5, 18, 0.35],
  [4, 24, 0.7],
  [6, 20, 0.45],
  [3, 16, 0.3],
  [5, 23, 0.6],
] as const;

/** A shared station: a reading or searching session walks over to it. */
export function Bookshelf({ scale, className }: PieceProps) {
  const shelves = [30, 58, 86];
  return (
    <KitArt kind="bookshelf" w={52} h={92} scale={scale} className={className}>
      <rect x="0" y="0" width="52" height="92" rx="2" className="kit-wood" />
      <rect x="3" y="3" width="46" height="86" rx="1" fill="var(--bg-1)" opacity="0.6" />
      {shelves.map((y, row) => {
        let x = 5 + row * 3;
        return (
          <g key={y}>
            {BOOKS.map(([w, h, o], i) => {
              const book = { x, w, h, o };
              x += w + 1.2;
              const lean = row === 1 && i === BOOKS.length - 1;
              return (
                <rect
                  // biome-ignore lint/suspicious/noArrayIndexKey: books are positional.
                  key={i}
                  x={book.x}
                  y={y - book.h}
                  width={book.w}
                  height={book.h}
                  rx="0.8"
                  fill="var(--text-3)"
                  opacity={book.o}
                  transform={lean ? `rotate(14 ${book.x + book.w} ${y})` : undefined}
                />
              );
            })}
            <rect x="0" y={y} width="52" height="3" className="kit-top" />
          </g>
        );
      })}
    </KitArt>
  );
}

/** A potted plant, to soften a corner. Still: it does no work. */
export function Plant({ scale, className }: PieceProps) {
  return (
    <KitArt kind="plant" w={28} h={48} scale={scale} className={className}>
      <g fill="var(--office-leaf)">
        <path d="M14 30 C6 26 2 16 5 8 C11 12 14 20 14 30 Z" />
        <path d="M14 30 C22 25 26 14 23 5 C17 10 13 19 14 30 Z" opacity="0.85" />
        <path d="M14 30 C12 20 13 8 15 1 C18 9 17 21 14 30 Z" opacity="0.7" />
      </g>
      <path d="M5 30 H23 L20.5 48 H7.5 Z" className="kit-wood" />
      <rect x="4" y="29" width="20" height="4" rx="1.5" className="kit-top" />
    </KitArt>
  );
}
