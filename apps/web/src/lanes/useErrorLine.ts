import type { StreamId } from '@yardmaster/protocol';
import { redact } from '@yardmaster/protocol';
import { useEffect, useRef, useState } from 'react';
import { useStream } from '../data/index.js';
import { useRedactOn } from '../redact/reveal.js';
import { TerminalTail } from './ansi.js';
import { errorLine } from './lane.js';

/** Output lines searched for the error. */
const TAIL_LINES = 24;
const FLUSH_MS = 150;

/**
 * The error line of a failed execution (null = none), read from its own output stream. Only
 * subscribes while `execId` is set, i.e. while the lane shows a crash.
 */
export function useErrorLine(execId: string | null): string | null {
  const tail = useRef<TerminalTail | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    tail.current = execId ? new TerminalTail(TAIL_LINES) : null;
    setLine(null);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [execId]);

  useStream(execId ? (`exec:${execId}` as StreamId) : null, (chunk) => {
    tail.current?.feed(chunk);
    timer.current ??= setTimeout(() => {
      timer.current = null;
      const lines = tail.current?.snapshot() ?? [];
      setLine(errorLine(lines.map((l) => l.map((s) => s.text).join(''))));
    }, FLUSH_MS);
  });

  const redactOn = useRedactOn();
  return redactOn && line !== null ? redact(line) : line;
}
