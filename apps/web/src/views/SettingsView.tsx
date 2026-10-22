import { type BoardSettings, RETENTION_DAYS, type RetentionDays } from '@c-board/protocol';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import { notificationsPreference } from '../attention/attention.js';
import { selectWindows, useBoardList } from '../data/index.js';
import { MOTION_SETTINGS, type MotionSetting, motionPreference } from '../motion.js';
import { hooksInstalled } from '../onboarding/model.js';
import { usePreference } from '../prefs.js';
import { routes } from '../routes.js';
import { api } from '../settings/api.js';
import { InstallHooksButton } from '../settings/HooksInstall.js';
import { redactPreference } from '../settings/prefs.js';
import { useHooksStatus, useServerStatus } from '../settings/useServerStatus.js';
import { THEME_SETTINGS, type ThemeSetting, useTheme } from '../theme/theme.js';
import { formatDateTime, formatWhen } from '../time.js';
import { Button, buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { StatusDot } from '../ui/StatusDot.js';
import { Page, PageHeader } from './Page.js';

const THEME_LABEL: Record<ThemeSetting, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System',
};

const MOTION_LABEL: Record<MotionSetting, string> = {
  system: 'System',
  full: 'Full',
  reduced: 'Reduced',
  off: 'Off',
};

const ON_OFF = ['off', 'on'] as const;
const ON_OFF_LABEL = { off: 'Off', on: 'On' } as const;

export function SettingsView() {
  const { setting: theme, setTheme } = useTheme();
  const motion = usePreference(motionPreference);
  const redact = usePreference(redactPreference);
  const status = useServerStatus(null);
  const demo = status !== null && status !== 'error' && status.demo;
  return (
    <Page width="narrow">
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-8">
        <SettingsSection title="Appearance">
          <SettingRow title="Theme" description="Dark, light, or follow your OS.">
            <Segmented
              label="Theme"
              options={THEME_SETTINGS}
              labels={THEME_LABEL}
              value={theme}
              onChange={setTheme}
            />
          </SettingRow>
          <SettingRow
            title="Motion"
            description="Reduced keeps cross-fades only. Off stops every animation. System follows your OS."
          >
            <Segmented
              label="Motion"
              options={MOTION_SETTINGS}
              labels={MOTION_LABEL}
              value={motion}
              onChange={motionPreference.set}
            />
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="Alerts and privacy">
          <NotificationsRow />
          <SettingRow
            title="Redact secrets"
            description="Mask API keys, tokens and private keys in terminals, tool cards and messages. Click a masked value to reveal it."
          >
            <Segmented
              label="Redact secrets"
              options={ON_OFF}
              labels={ON_OFF_LABEL}
              value={redact}
              onChange={redactPreference.set}
            />
          </SettingRow>
          <SettingRow
            title="Away mode"
            description="Answer Claude Code permission prompts from the board while you are away from the terminal. Coming with the away-mode hook."
          >
            <Segmented
              label="Away mode"
              options={ON_OFF}
              labels={ON_OFF_LABEL}
              value="off"
              onChange={() => {}}
              disabled
            />
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="Connections">
          <HooksRow />
          <EditorsRow />
          <SettingRow
            title="Setup guide"
            description="The first-run checklist for the server, hooks and extension, with live checks."
          >
            <Link href={routes.welcome} className={buttonClass('secondary', 'sm')}>
              Open guide
            </Link>
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="Data and security">
          <RetentionRow />
          <TokenRow demo={demo} />
        </SettingsSection>
      </div>
    </Page>
  );
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h2 className="px-1 font-medium text-body-sm text-text-2">{title}</h2>
      <div className="flex flex-col divide-y divide-line rounded-panel border border-line bg-bg-1 shadow-raised">
        {children}
      </div>
    </section>
  );
}

/** Claude Code hooks: how many events are installed, plus the confirm-first installer. */
function HooksRow() {
  const { state, reload } = useHooksStatus();
  const hooks = state.status === 'ready' ? state.hooks : null;
  const installed = hooksInstalled(hooks?.status ?? null);
  const total = hooks?.status
    ? hooks.status.installed.length + hooks.status.missing.length + hooks.status.outdated.length
    : 0;

  let summary: React.ReactNode;
  if (state.status === 'loading') summary = 'Checking Claude’s settings…';
  else if (state.status === 'error') summary = 'Could not check the hooks.';
  else if (hooks?.error) summary = `${hooks.path} ${hooks.error}. Fix the file, then check again.`;
  else if (installed) summary = `All ${total} events report to c-board, from ${hooks?.path}.`;
  else {
    const count = hooks?.status?.installed.length ?? 0;
    const outdated = hooks?.status?.outdated.length ?? 0;
    summary = `${count} of ${total} events installed${outdated ? `, ${outdated} outdated` : ''}, in ${hooks?.path}.`;
  }

  return (
    <SettingRow
      title="Claude Code hooks"
      description={
        <span className="flex flex-col gap-1.5">
          {hooks?.status && (
            <StatusDot
              tone={installed ? 'ok' : 'wait'}
              label={installed ? 'Installed' : 'Not installed'}
              showLabel
              className="text-label text-text-1"
            />
          )}
          <span>{summary}</span>
        </span>
      }
      data="hooks"
    >
      {state.status === 'error' || hooks?.error ? (
        <Button size="sm" onClick={reload}>
          Check again
        </Button>
      ) : (
        <InstallHooksButton
          size="sm"
          variant={installed ? 'secondary' : 'primary'}
          disabled={!hooks?.status}
          onInstalled={reload}
        >
          {installed ? 'Reinstall' : 'Install hooks'}
        </InstallHooksButton>
      )}
    </SettingRow>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Connected Cursor / VS Code windows, live from the board. */
function EditorsRow() {
  const windows = useBoardList(selectWindows);
  const now = useNow(30_000);
  return (
    <div className="flex flex-col gap-3 p-5" data-setting="editors">
      <div className="flex flex-col gap-0.5">
        <h3 className="font-medium text-body text-text-1">Editor windows</h3>
        <p className="text-label text-text-2">
          {windows.length === 0
            ? 'No editor is connected. Install the extension from the setup guide, then reload the editor window.'
            : `${windows.length} connected, streaming their terminals to the board.`}
        </p>
      </div>
      {windows.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line bg-bg-0">
          {windows.map((w) => {
            const folders = w.workspaceFolders.map(basename);
            const name = folders.length > 0 ? folders.join(', ') : 'No folder open';
            return (
              <li
                key={w.id}
                className="flex min-w-0 items-center gap-3 px-3 py-2"
                data-window={w.id}
              >
                <StatusDot tone="ok" label="Connected" />
                <span className="min-w-0 flex-1 truncate text-body-sm text-text-1" title={name}>
                  {name}
                </span>
                <span
                  className="shrink-0 truncate font-mono text-meta text-text-3 tabular-nums max-sm:hidden"
                  title={`Extension ${w.extensionVersion}`}
                >
                  {w.appName} {w.appVersion}
                </span>
                <span
                  className="shrink-0 text-meta text-text-3 tabular-nums"
                  title={`Connected ${formatDateTime(w.connectedAt)}`}
                >
                  {formatWhen(w.connectedAt, now)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const RETENTION_LABEL = Object.fromEntries(
  RETENTION_DAYS.map((days) => [String(days), days === 1 ? '1 day' : `${days} days`]),
) as Record<`${RetentionDays}`, string>;
const RETENTION_OPTIONS = RETENTION_DAYS.map((days) => `${days}` as const);

/** How long the Pulse activity history is kept in the local database. */
function RetentionRow() {
  const [settings, setSettings] = useState<BoardSettings | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.settings(controller.signal).then(setSettings, () => {});
    return () => controller.abort();
  }, []);

  const change = async (value: `${RetentionDays}`) => {
    const retentionDays = Number(value) as RetentionDays;
    const previous = settings;
    if (previous) setSettings({ ...previous, retentionDays });
    try {
      setSettings(await api.updateSettings({ retentionDays }));
    } catch {
      setSettings(previous);
      toast.error('Could not save the retention');
    }
  };

  return (
    <SettingRow
      title="Activity history"
      description="How long the Pulse timeline is kept in the local database. Older events are deleted."
    >
      <Segmented
        label="Activity history"
        options={RETENTION_OPTIONS}
        labels={RETENTION_LABEL}
        value={settings ? (`${settings.retentionDays}` as const) : '7'}
        onChange={(value) => void change(value)}
        disabled={settings === null}
      />
    </SettingRow>
  );
}

/** Replaces the install token: this browser stays signed in, everything else signs in again. */
function TokenRow({ demo }: { demo: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const rotate = async () => {
    setBusy(true);
    try {
      await api.rotateToken();
      toast.success('Token rotated', {
        description:
          'Other browsers sign in again with `c-board start`. Editors reconnect on their own.',
      });
    } catch {
      toast.error('Could not rotate the token');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <SettingRow
      title="Access token"
      description={
        demo
          ? 'The demo board never changes the token.'
          : 'Rotate it if it may have leaked. Other browsers are signed out; this one stays signed in.'
      }
      data="token"
    >
      {confirming ? (
        <div className="flex shrink-0 gap-2 self-start sm:self-auto">
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void rotate()}>
            {busy ? 'Rotating…' : 'Rotate now'}
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          className="self-start sm:self-auto"
          disabled={demo}
          onClick={() => setConfirming(true)}
        >
          Rotate token
        </Button>
      )}
    </SettingRow>
  );
}

const NOTIFICATION_OPTIONS = ['off', 'on'] as const;
const NOTIFICATION_LABEL = { off: 'Off', on: 'On' } as const;

/** Browser notifications for new approvals; turning them on asks the browser for permission. */
function NotificationsRow() {
  const supported = typeof Notification !== 'undefined';
  const setting = usePreference(notificationsPreference);
  const [permission, setPermission] = useState(() =>
    supported ? Notification.permission : 'denied',
  );
  const enabled = setting === 'on' && permission === 'granted';

  const change = async (next: 'on' | 'off') => {
    if (next === 'off' || !supported) {
      notificationsPreference.set('off');
      return;
    }
    const result =
      Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
    setPermission(result);
    notificationsPreference.set(result === 'granted' ? 'on' : 'off');
  };

  const description = !supported
    ? 'This browser does not support notifications.'
    : permission === 'denied'
      ? 'Blocked by the browser. Allow notifications for this site in its settings to turn them on.'
      : 'Notify me about new approvals while c-board is in the background.';

  return (
    <SettingRow title="Notifications" description={description}>
      <Segmented
        label="Notifications"
        options={NOTIFICATION_OPTIONS}
        labels={NOTIFICATION_LABEL}
        value={enabled ? 'on' : 'off'}
        onChange={(next) => void change(next)}
        disabled={!supported || permission === 'denied'}
      />
    </SettingRow>
  );
}

function SettingRow({
  title,
  description,
  data,
  children,
}: {
  title: string;
  description: React.ReactNode;
  /** `data-setting`, for tests. */
  data?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"
      data-setting={data}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="font-medium text-body text-text-1">{title}</h3>
        <div className="text-label text-text-2">{description}</div>
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange(value: T): void;
  disabled?: boolean;
}) {
  return (
    <fieldset
      disabled={disabled}
      className="flex shrink-0 self-start rounded-control border border-line bg-bg-0 p-0.5 disabled:opacity-50 sm:self-auto"
    >
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
          className={cx(
            'h-7 rounded-chip px-3 text-label transition-colors duration-150',
            option === value
              ? 'bg-bg-2 text-text-1 shadow-raised'
              : 'text-text-2 hover:text-text-1',
          )}
        >
          {labels[option]}
        </button>
      ))}
    </fieldset>
  );
}
