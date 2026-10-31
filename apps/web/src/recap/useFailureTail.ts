import { redact, type StreamId } from '@yardmaster/protocol';
import { useEffect, useRef, useState } from 'react';
import { useStream } from '../data/index.js';
import { TerminalTail } from '../lanes/ansi.js';
import { useRedactOn } from '../redact/reveal.js';

const TAIL_LINES = 3;
const FLUSH_MS = 150;

/** The last lines of a failed command, read from its own output stream. */
export function useFailureTail(execId: string | null): string[] {
  const tail = useRef<TerminalTail | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    tail.current = execId ? new TerminalTail(TAIL_LINES) : null;
    setLines([]);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [execId]);

  useStream(execId ? (`exec:${execId}` as StreamId) : null, (chunk) => {
    tail.current?.feed(chunk);
    timer.current ??= setTimeout(() => {
      timer.current = null;
      const snapshot = tail.current?.snapshot() ?? [];
      setLines(snapshot.map((line) => line.map((segment) => segment.text).join('')));
    }, FLUSH_MS);
  });

  const redactOn = useRedactOn();
  const shown = lines.filter((line) => line.trim() !== '');
  return redactOn ? shown.map((line) => redact(line)) : shown;
}
