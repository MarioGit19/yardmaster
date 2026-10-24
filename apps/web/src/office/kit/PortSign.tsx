import { PortButton } from '../../ports/PortButton.js';
import { usePortShares } from '../../ports/shares.js';
import { cx } from '../../ui/cx.js';

const chip =
  'inline-flex items-center gap-1 rounded-chip bg-bg-2 px-1.5 font-mono text-label leading-5 text-text-2 tabular';

/**
 * The port sign by the door (DESIGN.md §10.3): the room's listening ports as small chips.
 * `interactive` makes each one a port button (copy, Open on phone); off the Tab order, since
 * the room is one Tab stop and the inspector carries the same chip.
 */
export function PortSign({
  ports,
  interactive = false,
  className,
}: {
  ports: readonly number[];
  interactive?: boolean;
  className?: string;
}) {
  const shares = usePortShares();
  if (ports.length === 0) return null;
  const shared = new Set(shares?.shares.map((s) => s.port));
  const label = `Listening on ${ports
    .map((p) => `:${p}${shared.has(p) ? ' (on phone)' : ''}`)
    .join(', ')}`;
  const frame = cx(
    'kit inline-flex max-w-full flex-wrap items-center gap-1 rounded-control border border-line bg-bg-1 p-1 shadow-raised',
    className,
  );
  const chips = (
    <>
      {ports.slice(0, 3).map((port) =>
        interactive ? (
          <PortButton
            key={port}
            port={port}
            tabIndex={-1}
            fineOnly
            className={cx(
              chip,
              'cursor-pointer transition-colors duration-fast hover:bg-bg-3 hover:text-text-1',
            )}
          >
            <span aria-hidden className="size-1.5 rounded-full bg-st-ok" />:{port}
          </PortButton>
        ) : (
          <span key={port} className={chip}>
            <span aria-hidden className="size-1.5 rounded-full bg-st-ok" />:{port}
          </span>
        ),
      )}
      {ports.length > 3 && (
        <span className="px-1 font-mono text-label text-text-3 tabular">+{ports.length - 3}</span>
      )}
    </>
  );
  return interactive ? (
    <fieldset aria-label={label} data-kit="port-sign" className={cx(frame, 'm-0 min-w-0')}>
      {chips}
    </fieldset>
  ) : (
    <span role="img" aria-label={label} title={label} data-kit="port-sign" className={frame}>
      {chips}
    </span>
  );
}
