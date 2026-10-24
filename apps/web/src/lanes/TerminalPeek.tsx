import type { StreamId } from '@yardmaster/protocol';
import { useEffect, useRef, useState } from 'react';
import { useStream } from '../data/index.js';
import { redact } from '../redact/redact.js';
import { useRedactOn } from '../redact/reveal.js';
import { cx } from '../ui/cx.js';
import { type Line, segmentCss, TerminalTail } from './ansi.js';

export const PEEK_LINES = 6;

/** A line with its secrets masked. A masked line loses its colors, which only it can show. */
export function maskLine(line: Line): Line {
  const text = line.map((s) => s.text).join('');
  const masked = redact(text);
  return masked === text || !line[0] ? line : [{ text: masked, style: line[0].style }];
}
/** At most 10 renders a second, however fast the terminal writes. */
const FLUSH_MS = 100;

export interface TerminalPeekProps {
  terminalId: string;
  id?: string;
  label: string;
  className?: string;
}

/**
 * The last six lines of a terminal, live, DESIGN.md §4.3. Subscribes to the terminal's stream
 * only while mounted, so closed peeks cost nothing.
 */
export function TerminalPeek({ terminalId, id, label, className }: TerminalPeekProps) {
  const tail = useRef<TerminalTail | null>(null);
  tail.current ??= new TerminalTail(PEEK_LINES);
  const [raw, setLines] = useState<Line[]>([]);
  const redactOn = useRedactOn();
  const lines = redactOn ? raw.map(maskLine) : raw;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useStream(`term:${terminalId}` as StreamId, (chunk) => {
    tail.current?.feed(chunk);
    timer.current ??= setTimeout(() => {
      timer.current = null;
      setLines(tail.current?.snapshot() ?? []);
    }, FLUSH_MS);
  });

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <div
      id={id}
      role="log"
      aria-label={label}
      data-peek={terminalId}
      className={cx(
        'overflow-hidden rounded-control border border-line-strong bg-bg-2 px-3 py-2 font-mono text-meta text-text-2 shadow-raised',
        className,
      )}
    >
      {/* Fixed height: the peek never changes size while output streams in. */}
      <div className="flex h-24 flex-col justify-end">
        {lines.length === 0 ? (
          <p className="text-text-2">No recent output</p>
        ) : (
          lines.map((line, i) => (
            // Lines have no identity of their own; the newest is always last.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature.
            <p key={i} className="truncate whitespace-pre">
              {line.length === 0
                ? ' '
                : line.map((segment, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature.
                    <span key={j} style={segmentCss(segment.style)}>
                      {segment.text}
                    </span>
                  ))}
            </p>
          ))
        )}
      </div>
    </div>
  );
}
