import {
  CirclePause,
  FolderOpen,
  Monitor,
  MonitorCog,
  Moon,
  Sparkle,
  Sparkles,
  Sun,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { attentionOpen } from '../attention/attention.js';
import { Wordmark } from '../brand/Logo.js';
import {
  type ConnectionState,
  selectConnection,
  selectHydrated,
  useBoard,
  useBoardShallow,
} from '../data/index.js';
import { pickerOpen } from '../library/OpenProject.js';
import { type MotionSetting, motionPreference, nextMotion, useMotionLevel } from '../motion.js';
import { paletteOpen } from '../palette/palette.js';
import { usePreference } from '../prefs.js';
import { routes } from '../routes.js';
import { formatCount, type Tone } from '../status.js';
import { NEXT_THEME, type ThemeSetting, useTheme } from '../theme/theme.js';
import { buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { IconButton } from '../ui/IconButton.js';
import { Kbd } from '../ui/Kbd.js';
import { NumberTicker } from '../ui/NumberTicker.js';
import { TONE_MARK } from '../ui/StatusDot.js';
import { Tooltip } from '../ui/Tooltip.js';
import { selectHudCounts } from './counts.js';

const THEME_ICON = { dark: Moon, light: Sun, system: Monitor } as const;
const THEME_NAME: Record<ThemeSetting, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System',
};

const MOTION_ICON = {
  system: MonitorCog,
  full: Sparkles,
  reduced: Sparkle,
  off: CirclePause,
} as const;
const MOTION_NAME: Record<MotionSetting, string> = {
  system: 'System',
  full: 'Full',
  reduced: 'Reduced',
  off: 'Off',
};

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function connectionView(connection: ConnectionState): { tone: Tone; label: string } {
  switch (connection.status) {
    case 'live':
      return { tone: 'ok', label: 'Live' };
    case 'connecting':
    case 'syncing':
      return { tone: 'idle', label: 'Connecting…' };
    case 'reconnecting':
      return { tone: 'err', label: 'Reconnecting…' };
    case 'stopped':
      return { tone: 'idle', label: 'Offline' };
  }
}

const selectCounts = selectHudCounts();

/** Top bar, DESIGN.md §4.4: live counters, connection, ⌘K hint, motion and theme. */
export function Hud() {
  const counts = useBoardShallow(selectCounts);
  const sheetOpen = usePreference(attentionOpen) === 'open';
  const { setting: theme, setTheme } = useTheme();
  const motion = usePreference(motionPreference);
  const stale = useBoard(selectConnection).status === 'reconnecting';
  // Counts arriving with the first snapshot aren't news; only later rises flare.
  const armed = useBoard(selectHydrated);
  const ThemeIcon = THEME_ICON[theme];
  const MotionIcon = MOTION_ICON[motion];

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-line border-b bg-bg-1 px-4 md:gap-3">
      <Link
        href={routes.overview}
        aria-label="c-board overview"
        className="shrink-0 whitespace-nowrap rounded-chip text-body text-text-1"
      >
        {/* The smallest phones need the room for the counters; the link keeps its label. */}
        <Wordmark nameClassName="max-[23rem]:sr-only" />
      </Link>
      <ul
        aria-label="Activity"
        className={cx(
          'flex min-w-0 items-center gap-0.5 transition-opacity duration-base md:ml-3',
          stale && 'opacity-60',
        )}
      >
        <li>
          <Counter tone="work" label="Working" value={counts.working} />
        </li>
        <li>
          <Tooltip content="Open the Attention Center">
            <button
              type="button"
              data-hud="waiting"
              aria-expanded={sheetOpen}
              onClick={() => attentionOpen.set(sheetOpen ? 'closed' : 'open')}
              className={cx(
                'rounded-control transition-[background-color,box-shadow,scale] duration-fast ease-out hover:bg-bg-2 moving:active:scale-[0.97]',
                counts.waiting > 0 && 'shadow-[inset_0_0_0_1px_var(--st-wait-glow)]',
              )}
            >
              <Counter
                tone="wait"
                label="Waiting"
                value={counts.waiting}
                flare="ripple"
                armed={armed}
              />
            </button>
          </Tooltip>
        </li>
        <li className="max-sm:hidden">
          <Counter tone="ok" label="Running" value={counts.running} />
        </li>
        <li>
          <Counter tone="err" label="Errors" value={counts.errors} flare="flash" armed={armed} />
        </li>
        <li aria-hidden className="mx-1.5 h-4 w-px bg-line max-md:hidden" />
        <li className="max-md:hidden">
          <Counter label="tokens today" value={counts.tokensToday} format={formatCount} />
        </li>
      </ul>
      <div className="flex-1" />
      <Tooltip content="Open project" shortcut={IS_MAC ? '⌘O' : 'Ctrl+O'}>
        <button
          type="button"
          data-hud="open-project"
          aria-label="Open project"
          aria-keyshortcuts={IS_MAC ? 'Meta+O' : 'Control+O'}
          onClick={() => pickerOpen.set('open')}
          className={cx(buttonClass('ghost', 'sm'), 'max-lg:size-7 max-lg:px-0 max-md:size-11')}
        >
          <FolderOpen aria-hidden className="size-4" strokeWidth={1.5} />
          <span className="max-lg:sr-only">Open project</span>
        </button>
      </Tooltip>
      <Connection />
      <Tooltip content="Command palette">
        <button
          type="button"
          aria-label="Open the command palette"
          aria-keyshortcuts={IS_MAC ? 'Meta+K' : 'Control+K'}
          onClick={() => paletteOpen.set('open')}
          className="flex items-center gap-0.5 rounded-control p-1 transition-[background-color,scale] duration-fast ease-out hover:bg-bg-2 moving:active:scale-[0.97] max-md:hidden"
          data-hud="palette-hint"
        >
          <Kbd>{IS_MAC ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd>K</Kbd>
        </button>
      </Tooltip>
      <div className="flex items-center gap-1">
        <IconButton
          label={`Motion: ${MOTION_NAME[motion]} (switch to ${MOTION_NAME[nextMotion(motion)]})`}
          size="sm"
          data-hud="motion"
          onClick={() => motionPreference.set(nextMotion(motion))}
          icon={<MotionIcon className="size-4" strokeWidth={1.5} />}
        />
        <IconButton
          label={`Theme: ${THEME_NAME[theme]} (switch to ${THEME_NAME[NEXT_THEME[theme]]})`}
          size="sm"
          onClick={() => setTheme(NEXT_THEME[theme])}
          icon={<ThemeIcon className="size-4" strokeWidth={1.5} />}
        />
      </div>
    </header>
  );
}

interface CounterProps {
  /** Without a tone the counter has no dot (tokens). */
  tone?: Tone;
  label: string;
  value: number;
  format?: (value: number) => string;
  /**
   * Played once each time the value rises: the amber attention ripple (DESIGN.md §3 rule 4) or
   * a short rose flash ring.
   */
  flare?: 'ripple' | 'flash';
  armed?: boolean;
}

export function Counter({ tone, label, value, format, flare, armed = false }: CounterProps) {
  const active = value > 0;
  const level = useMotionLevel();
  const [flares, setFlares] = useState(0);
  const previous = useRef(value);
  useEffect(() => {
    const rose = value > previous.current;
    previous.current = value;
    if (rose && flare && armed && level !== 'off') setFlares((n) => n + 1);
  }, [value, flare, armed, level]);
  return (
    <span
      data-counter={label}
      className="flex h-7 items-center gap-1.5 px-2 text-body-sm"
      title={`${format ? format(value) : value} ${label}`}
    >
      {tone && (
        // Shaped like the board's status marks, so the counters read without color or labels
        // (labels hide below lg). Zero keeps the shape, greyed out.
        <span
          aria-hidden
          data-mark={tone}
          className="relative grid size-2 shrink-0 place-items-center"
        >
          {flares > 0 && (
            <span
              key={flares}
              data-hud-flare={flare}
              className={cx('hud-flare', `hud-flare-${flare}`)}
              onAnimationEnd={() => setFlares(0)}
            />
          )}
          <span
            className={cx(
              'block shrink-0 transition-opacity duration-base',
              TONE_MARK[tone],
              !active && 'opacity-40 grayscale',
            )}
          />
        </span>
      )}
      <NumberTicker
        value={value}
        format={format}
        className={cx('transition-colors duration-base', active ? 'text-text-1' : 'text-text-2')}
      />
      <span className="text-label text-text-2 max-lg:sr-only">{label}</span>
    </span>
  );
}

export function Connection() {
  const connection = useBoard(selectConnection);
  const view = connectionView(connection);
  const reconnecting = connection.status === 'reconnecting';
  return (
    <output
      aria-live="polite"
      data-connection={connection.status}
      className="flex items-center gap-2 text-label text-text-2"
      title={view.label}
    >
      <span aria-hidden className="relative grid size-3.5 place-items-center">
        <span data-mark={view.tone} className={cx('block', TONE_MARK[view.tone])} />
        {reconnecting && (
          <span className="hud-spin absolute inset-0 rounded-full border border-st-err border-r-transparent border-b-transparent" />
        )}
      </span>
      <span className={cx('max-md:sr-only', reconnecting && 'text-st-err-ink')}>{view.label}</span>
    </output>
  );
}
