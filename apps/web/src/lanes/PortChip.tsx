import type { PortBinding } from '@c-board/protocol';
import { toast } from 'sonner';
import { cx } from '../ui/cx.js';
import { Tooltip } from '../ui/Tooltip.js';

export const portUrl = (port: Pick<PortBinding, 'port'>) => `localhost:${port.port}`;

/** "node · pid 4821 · 127.0.0.1:3000" */
export function portProcess(port: PortBinding): string {
  return [port.command, `pid ${port.pid}`, `${port.address}:${port.port}`]
    .filter(Boolean)
    .join(' · ');
}

/** A listening port. Click copies `localhost:<port>`; hover names the process behind it. */
export function PortChip({
  port,
  others = [],
  className,
}: {
  port: PortBinding;
  /** More ports of the same terminal: counted on the chip and listed in the tooltip. */
  others?: readonly PortBinding[];
  className?: string;
}) {
  const copy = async () => {
    const url = portUrl(port);
    try {
      await navigator.clipboard.writeText(url);
      toast.success(`Copied ${url}`);
    } catch {
      toast.error(`Couldn't copy ${url}`);
    }
  };

  return (
    <Tooltip
      content={
        <span className="flex flex-col font-mono">
          {[port, ...others].map((p) => (
            <span key={p.id}>{portProcess(p)}</span>
          ))}
        </span>
      }
      side="top"
    >
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${portUrl(port)}`}
        data-port={port.port}
        className={cx(
          'inline-flex h-5 min-w-0 max-w-full items-center rounded-chip border border-line bg-bg-2 px-1.5 font-mono text-meta tabular text-text-2',
          'transition-colors duration-150 ease-out hover:border-line-strong hover:text-text-1',
          className,
        )}
      >
        <span className="truncate">:{port.port}</span>
        {others.length > 0 && <span className="ml-0.5 text-text-3">+{others.length}</span>}
      </button>
    </Tooltip>
  );
}
