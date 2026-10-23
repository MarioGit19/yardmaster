import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cx } from './cx.js';

/** A shell command in mono with a copy button that confirms with a check for a moment. */
export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the command stays selectable.
    }
  };

  return (
    <div
      className={cx(
        'flex min-w-0 items-center gap-2 rounded-control border border-line bg-bg-0 py-1 pr-1 pl-3',
        className,
      )}
    >
      <span aria-hidden className="select-none font-mono text-label text-text-3">
        $
      </span>
      <code
        className="min-w-0 flex-1 truncate font-mono text-label text-text-1 select-all"
        title={command}
      >
        {command}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? 'Copied' : `Copy: ${command}`}
        data-copied={copied || undefined}
        className="grid size-7 shrink-0 place-items-center rounded-chip text-text-3 transition-[color,background-color,scale] duration-fast ease-out hover:bg-bg-2 hover:text-text-1 moving:active:scale-[0.97]"
      >
        <span className="copy-swap grid place-items-center" data-state={copied ? 'done' : 'idle'}>
          <Copy aria-hidden className="copy-swap-idle size-3.5" strokeWidth={1.5} />
          <Check aria-hidden className="copy-swap-done size-3.5 text-st-ok" strokeWidth={2} />
        </span>
      </button>
    </div>
  );
}
