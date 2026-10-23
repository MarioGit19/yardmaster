import { cx } from '../../ui/cx.js';

/** The port sign by the door (DESIGN.md §10.3): the room's listening ports as small chips. */
export function PortSign({ ports, className }: { ports: readonly number[]; className?: string }) {
  if (ports.length === 0) return null;
  const label = `Listening on ${ports.map((p) => `:${p}`).join(', ')}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-kit="port-sign"
      className={cx(
        'kit inline-flex max-w-full flex-wrap items-center gap-1 rounded-control border border-line bg-bg-1 p-1 shadow-raised',
        className,
      )}
    >
      {ports.slice(0, 3).map((port) => (
        <span
          key={port}
          className="inline-flex items-center gap-1 rounded-chip bg-bg-2 px-1.5 font-mono text-label leading-5 text-text-2 tabular"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-st-ok" />:{port}
        </span>
      ))}
      {ports.length > 3 && (
        <span className="px-1 font-mono text-label text-text-3 tabular">+{ports.length - 3}</span>
      )}
    </span>
  );
}
