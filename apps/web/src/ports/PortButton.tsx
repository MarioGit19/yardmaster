import { CircleStop, Copy, Smartphone } from 'lucide-react';
import { type ComponentPropsWithRef, forwardRef, type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { useMediaQuery } from '../prefs.js';
import { onRemoteHost } from '../settings/remoteHost.js';
import { cx } from '../ui/cx.js';
import { Popover } from '../ui/Popover.js';
import { Tooltip } from '../ui/Tooltip.js';
import {
  copyText,
  openOnPhone,
  portShareRequest,
  stopSharing,
  useCanShare,
  usePortShare,
} from './shares.js';

/** The `touch:` variant's query (DESIGN.md §11). */
const TOUCH_QUERY = '(pointer: coarse), (max-width: 767px)';

export const localUrl = (port: number) => `localhost:${port}`;

/** The small "on phone" mark of a port shared on the tailnet. */
export function OnPhoneMark({ className }: { className?: string }) {
  return (
    <span data-on-phone="" title="On phone" className={cx('inline-flex shrink-0', className)}>
      <Smartphone aria-hidden className="size-3 stroke-[1.75]" />
      <span className="sr-only">, on phone</span>
    </span>
  );
}

type ButtonProps = Omit<ComponentPropsWithRef<'button'>, 'children'> & {
  tooltip?: ReactNode;
  children: ReactNode;
};

const TipButton = forwardRef<HTMLButtonElement, ButtonProps>(function TipButton(
  { tooltip, children, type = 'button', ...props },
  ref,
) {
  const button = (
    <button ref={ref} type={type} {...props}>
      {children}
    </button>
  );
  return tooltip ? (
    <Tooltip content={tooltip} side="top">
      {button}
    </Tooltip>
  ) : (
    button
  );
});

/**
 * A listening port as a button (12.6e2). Without Tailscale it copies `localhost:<port>`. With
 * it, on the Mac it opens a small menu (Copy, Open on phone); on the phone it opens the port's
 * tailnet URL right away, sharing it first. A shared port carries the "on phone" mark.
 */
export function PortButton({
  port,
  tooltip,
  className,
  children,
  tabIndex,
  mark = true,
  fineOnly = false,
}: {
  port: number;
  tooltip?: ReactNode;
  className?: string;
  children: ReactNode;
  tabIndex?: number;
  /** Show the "on phone" mark inside the button. */
  mark?: boolean;
  /**
   * A small label that can't grow to a 44 px target: plain text on touch screens, where the
   * Actor inspector's sheet carries the same port chip.
   */
  fineOnly?: boolean;
}) {
  const share = usePortShare(port);
  const canShare = useCanShare();
  const [open, setOpen] = useState(false);
  const touch = useMediaQuery(TOUCH_QUERY);
  const phone = onRemoteHost();
  const content = (
    <>
      {children}
      {mark && share && <OnPhoneMark />}
    </>
  );
  if (fineOnly && touch) {
    return (
      <span data-port={port} data-port-shared={share ? '' : undefined} className={className}>
        {content}
      </span>
    );
  }
  const common = {
    tooltip,
    tabIndex,
    className,
    'data-port': port,
    'data-port-shared': share ? '' : undefined,
  };

  if (!canShare || phone) {
    return (
      <TipButton
        {...common}
        aria-label={
          canShare
            ? `Open :${port} on this phone`
            : `Copy ${localUrl(port)}${share ? ', on phone' : ''}`
        }
        onClick={(event) => {
          event.stopPropagation();
          if (canShare) void openOnPhone(port, share);
          else void copyText(localUrl(port));
        }}
      >
        {content}
      </TipButton>
    );
  }

  const stop = async () => {
    setOpen(false);
    try {
      await stopSharing(port);
      toast.success(`Stopped sharing :${port}`);
    } catch {
      toast.error(`Could not stop sharing :${port}`);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={`:${port}`}
      side="top"
      align="start"
      className="flex w-60 max-w-[calc(100vw-32px)] flex-col p-1"
      data-port-menu={port}
      trigger={
        <TipButton
          {...common}
          aria-label={`:${port}${share ? ', on phone' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={(event) => event.stopPropagation()}
        >
          {content}
        </TipButton>
      }
    >
      <MenuButton
        icon={<Copy />}
        onClick={() => {
          setOpen(false);
          void copyText(localUrl(port));
        }}
      >
        Copy <span className="font-mono">{localUrl(port)}</span>
      </MenuButton>
      <MenuButton
        icon={<Smartphone />}
        data-open-on-phone={port}
        onClick={() => {
          setOpen(false);
          portShareRequest.set(port);
        }}
      >
        {share ? 'Phone link…' : 'Open on phone…'}
      </MenuButton>
      {share?.mine && (
        <MenuButton icon={<CircleStop />} onClick={() => void stop()}>
          Stop sharing
        </MenuButton>
      )}
    </Popover>
  );
}

function MenuButton({
  icon,
  children,
  onClick,
  ...data
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  [data: `data-${string}`]: string | number | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...data}
      className="flex h-8 min-w-0 items-center gap-2 rounded-control px-2 text-left text-body-sm text-text-1 transition-colors duration-fast hover:bg-bg-2 touch:h-11 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.5] [&_svg]:text-text-2"
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}
