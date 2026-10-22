import { Monitor, Moon, Sun } from 'lucide-react';
import { Link } from 'wouter';
import { type ConnectionState, selectConnection, useBoard } from '../data/index.js';
import { routes } from '../routes.js';
import type { Tone } from '../status.js';
import { type ThemeSetting, useTheme } from '../theme/theme.js';
import { IconButton } from '../ui/IconButton.js';
import { StatusDot } from '../ui/StatusDot.js';

const NEXT_THEME: Record<ThemeSetting, ThemeSetting> = {
  dark: 'light',
  light: 'system',
  system: 'dark',
};
const THEME_ICON = { dark: Moon, light: Sun, system: Monitor } as const;
const THEME_NAME: Record<ThemeSetting, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System',
};

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

/** Top bar. The HUD counters, ⌘K hint and motion toggle land with 7.5. */
export function Hud() {
  const connection = useBoard(selectConnection);
  const { setting, setTheme } = useTheme();
  const status = connectionView(connection);
  const nextTheme = NEXT_THEME[setting];
  const ThemeIcon = THEME_ICON[setting];

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-line border-b bg-bg-1 px-4">
      <Link
        href={routes.overview}
        className="rounded-chip font-medium font-mono text-body text-text-1"
      >
        c-board
      </Link>
      <div className="flex-1" />
      <output aria-live="polite" className="flex items-center text-label text-text-2">
        <StatusDot tone={status.tone} label={status.label} showLabel />
      </output>
      <IconButton
        label={`Theme: ${THEME_NAME[setting]} (switch to ${THEME_NAME[nextTheme]})`}
        size="sm"
        onClick={() => setTheme(nextTheme)}
        icon={<ThemeIcon className="size-4" strokeWidth={1.5} />}
      />
    </header>
  );
}
