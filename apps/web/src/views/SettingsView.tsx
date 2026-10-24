import {
  EditorCliPath,
  IDLE_HIDE_MIN,
  type IdleHideMin,
  LIBRARY_MAX_ROOTS,
  LibraryRootPath,
  type LibraryRootStatus,
  RETENTION_DAYS,
  type RetentionDays,
} from '@c-board/protocol';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import { AMBIENT_STYLE_LABEL, AMBIENT_STYLES, ambientStylePreference } from '../ambient/style.js';
import { Wordmark } from '../brand/Logo.js';
import { TAGLINE } from '../brand/name.js';
import { selectWindows, useBoardList } from '../data/index.js';
import { LAYOUT_NAME, LAYOUTS, layoutPreference } from '../layouts/registry.js';
import { MOTION_SETTINGS, type MotionSetting, motionPreference } from '../motion.js';
import { hooksInstalled } from '../onboarding/model.js';
import { usePreference } from '../prefs.js';
import { PHOSPHOR_LABEL, PHOSPHORS, phosphorPreference } from '../retro/phosphor.js';
import { routes } from '../routes.js';
import { api } from '../settings/api.js';
import {
  type ServerSettings,
  SUGGESTED_ROOT,
  useBoardSettings,
} from '../settings/boardSettings.js';
import { InstallHooksButton } from '../settings/HooksInstall.js';
import { NotificationSettings } from '../settings/NotificationSettings.js';
import { PhoneSettings } from '../settings/PhoneSettings.js';
import { redactPreference } from '../settings/prefs.js';
import { useHooksStatus, useServerStatus } from '../settings/useServerStatus.js';
import { THEME_SETTINGS, type ThemeSetting, useTheme } from '../theme/theme.js';
import { formatDateTime, formatWhen } from '../time.js';
import { Button, buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { SegmentThumb, useSegmentThumb } from '../ui/SegmentThumb.js';
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
  const layout = usePreference(layoutPreference);
  const ambient = usePreference(ambientStylePreference);
  const phosphor = usePreference(phosphorPreference);
  const redact = usePreference(redactPreference);
  const status = useServerStatus(null);
  const demo = status !== null && status !== 'error' && status.demo;
  const server = useBoardSettings();
  return (
    <Page width="narrow">
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-8">
        <SettingsSection title="Appearance">
          <SettingRow
            title="Layout"
            data="layout"
            description="How the overview draws your projects. Same data and actions in each. ⌥1 to ⌥5 switch from anywhere."
          >
            <Segmented
              label="Layout"
              options={LAYOUTS}
              labels={LAYOUT_NAME}
              value={layout}
              onChange={layoutPreference.set}
            />
          </SettingRow>
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
          <SettingRow
            title="Ambient"
            description="The light behind the board. Every style brightens and flows faster as work picks up."
          >
            <Segmented
              label="Ambient"
              options={AMBIENT_STYLES}
              labels={AMBIENT_STYLE_LABEL}
              value={ambient}
              onChange={ambientStylePreference.set}
            />
          </SettingRow>
          <SettingRow
            title="Retro phosphor"
            data="phosphor"
            description="The Retro layout's screen color. In the light theme it prints as ink on paper."
          >
            <Segmented
              label="Retro phosphor"
              options={PHOSPHORS}
              labels={PHOSPHOR_LABEL}
              value={phosphor}
              onChange={phosphorPreference.set}
            />
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="Notifications">
          <NotificationSettings server={server} />
        </SettingsSection>

        <SettingsSection title="Privacy and approvals">
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
          <AwayRow server={server} />
        </SettingsSection>

        <SettingsSection title="Projects">
          <LibraryRootsRow server={server} />
          <IdleHideRow server={server} />
          <EditorCliRow server={server} />
        </SettingsSection>

        <SettingsSection title="Claude">
          <TerminalReplyRow server={server} />
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

        <SettingsSection title="Phone">
          <PhoneSettings server={server} />
        </SettingsSection>

        <SettingsSection title="Data and security">
          <RetentionRow server={server} />
          <TokenRow demo={demo} />
        </SettingsSection>

        <SettingsSection title="About">
          <AboutRow version={status !== null && status !== 'error' ? status.version : null} />
        </SettingsSection>
      </div>
    </Page>
  );
}

function AboutRow({ version }: { version: string | null }) {
  return (
    <div className="flex flex-col gap-3 p-5" data-setting="about">
      <Wordmark className="text-title" markClassName="size-7" />
      <p className="text-body-sm text-text-2">
        {TAGLINE} Runs on this machine with your own Claude Code login.
      </p>
      <p className="font-mono text-label text-text-3 tabular-nums">
        {version ? `Version ${version}` : 'Version unknown'}
      </p>
    </div>
  );
}

export function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
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

const AWAY_INSTALL = 'c-board hooks install --away';

/** Routes permission prompts from terminal sessions to the board (F13). */
function AwayRow({ server: { settings, update } }: { server: ServerSettings }) {
  return (
    <SettingRow
      title="Away mode"
      description={
        <>
          Answer Claude Code permission prompts from the board while you are away from the terminal.
          Needs the permission hook: run{' '}
          <code className="whitespace-nowrap font-mono text-text-1">{AWAY_INSTALL}</code>.
        </>
      }
    >
      <Segmented
        label="Away mode"
        options={ON_OFF}
        labels={ON_OFF_LABEL}
        value={settings?.awayMode ? 'on' : 'off'}
        onChange={(value) => void update({ awayMode: value === 'on' }, 'Could not save away mode')}
        disabled={settings === null}
      />
    </SettingRow>
  );
}

/** F14: a terminal session's composer types into its terminal (`claude.terminalReply`). */
function TerminalReplyRow({ server: { settings, update } }: { server: ServerSettings }) {
  return (
    <SettingRow
      title="Reply to terminal sessions from the board"
      description="A Claude session running in a terminal takes your messages from the board when Claude is idle or waiting for you. Each one is typed at its prompt. Off: the board offers a fork instead."
      data="terminal-reply"
    >
      <Segmented
        label="Reply to terminal sessions from the board"
        options={ON_OFF}
        labels={ON_OFF_LABEL}
        value={settings?.terminalReply === false ? 'off' : 'on'}
        onChange={(value) =>
          void update(
            { terminalReply: value === 'on' },
            'Could not save the terminal reply setting',
          )
        }
        disabled={settings === null}
      />
    </SettingRow>
  );
}

/** `GET /api/library`'s per-root status, refetched whenever the roots change. */
function useLibraryRoots(roots: readonly string[] | null): Map<string, LibraryRootStatus> | null {
  const [statuses, setStatuses] = useState<Map<string, LibraryRootStatus> | null>(null);
  const key = roots?.join('\n') ?? null;
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    api.library(controller.signal).then(
      (library) => setStatuses(new Map(library.roots.map((r) => [r.root, r]))),
      () => {},
    );
    return () => controller.abort();
  }, [key]);
  return statuses;
}

/** `library.roots` (F25): the folders the "Open project" picker lists. */
function LibraryRootsRow({ server: { settings, update } }: { server: ServerSettings }) {
  const roots = settings?.libraryRoots ?? null;
  const statuses = useLibraryRoots(roots);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const full = (roots?.length ?? 0) >= LIBRARY_MAX_ROOTS;

  const add = async (value: string) => {
    const parsed = LibraryRootPath.safeParse(value);
    if (!parsed.success) {
      setError('Use a full path, like /Users/you/code, or one starting with ~/.');
      return;
    }
    setError(null);
    if (!roots || roots.includes(parsed.data)) {
      setDraft('');
      return;
    }
    await update({ libraryRoots: [...roots, parsed.data] }, 'Could not add the folder');
    setDraft('');
  };
  const remove = (root: string) =>
    void update(
      { libraryRoots: (roots ?? []).filter((r) => r !== root) },
      'Could not remove the folder',
    );

  return (
    <div className="flex flex-col gap-3 p-5" data-setting="library">
      <div className="flex flex-col gap-0.5">
        <h3 className="font-medium text-body text-text-1">Project folders</h3>
        <p className="text-label text-text-2">
          “Open project” lists the folders directly inside these. c-board only reads their names and
          whether they are git repositories.
        </p>
      </div>
      {roots && roots.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line bg-bg-0">
          {roots.map((root) => {
            const status = statuses?.get(root);
            return (
              <li
                key={root}
                data-library-root={root}
                className="flex min-w-0 items-start gap-3 py-2 pr-1.5 pl-3"
              >
                <span className="mt-1.5 flex shrink-0">
                  <StatusDot
                    tone={!status ? 'idle' : status.error ? 'err' : 'ok'}
                    label={!status ? 'Checking' : status.error ? 'Not readable' : 'Readable'}
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
                  <span className="truncate font-mono text-label text-text-1" title={root}>
                    {root}
                  </span>
                  {status && (
                    <span
                      className={cx('text-meta', status.error ? 'text-st-err-ink' : 'text-text-3')}
                      data-library-status={status.error ?? 'ok'}
                    >
                      {status.error
                        ? status.message
                        : `${status.count} ${status.count === 1 ? 'folder' : 'folders'}`}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${root}`}
                  title="Remove"
                  onClick={() => remove(root)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-control text-text-3 transition-colors duration-fast hover:bg-bg-2 hover:text-text-1 touch:size-11 [&_svg]:size-4 [&_svg]:stroke-[1.5]"
                >
                  <X aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add(draft);
        }}
        className="flex min-w-0 flex-col gap-2 sm:flex-row"
      >
        <label className="flex h-8 min-w-0 items-center rounded-control border sm:flex-1 touch:h-11 border-line bg-bg-0 px-3 transition-colors duration-fast focus-within:border-line-strong focus-within:shadow-[var(--focus-ring)]">
          <input
            aria-label="Folder to add"
            placeholder={roots?.length ? 'Another folder, such as ~/code' : SUGGESTED_ROOT}
            value={draft}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            disabled={settings === null || full}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            className="h-full min-w-0 flex-1 bg-transparent font-mono text-label text-text-1 outline-none placeholder:font-sans placeholder:text-text-3 focus-visible:shadow-none disabled:opacity-50"
          />
        </label>
        <div className="flex shrink-0 gap-2">
          <Button type="submit" disabled={settings === null || full || !draft.trim()}>
            Add folder
          </Button>
          {roots !== null && roots.length === 0 && (
            <Button variant="secondary" onClick={() => void add(SUGGESTED_ROOT)}>
              Use {SUGGESTED_ROOT}
            </Button>
          )}
        </div>
      </form>
      {error && (
        <p role="alert" className="text-meta text-st-err-ink">
          {error}
        </p>
      )}
    </div>
  );
}

const IDLE_HIDE_LABEL = Object.fromEntries(
  IDLE_HIDE_MIN.map((min) => [String(min), min < 60 ? `${min} min` : `${min / 60} h`]),
) as Record<`${IdleHideMin}`, string>;
const IDLE_HIDE_OPTIONS = IDLE_HIDE_MIN.map((min) => `${min}` as const);

/** `library.idleHideMin` (F26): how long a quiet project stays on the overview. */
function IdleHideRow({ server: { settings, update } }: { server: ServerSettings }) {
  return (
    <SettingRow
      title="Hide quiet projects after"
      description="The overview shows projects with an editor window, a terminal or a Claude session, or recent activity. Pinned projects always stay."
      data="idle-hide"
    >
      <Segmented
        label="Hide quiet projects after"
        options={IDLE_HIDE_OPTIONS}
        labels={IDLE_HIDE_LABEL}
        value={settings ? (`${settings.libraryIdleHideMin}` as const) : '30'}
        onChange={(value) =>
          void update(
            { libraryIdleHideMin: Number(value) as IdleHideMin },
            'Could not save the setting',
          )
        }
        disabled={settings === null}
      />
    </SettingRow>
  );
}

/** `editor.cli` (12.3): the Cursor or VS Code CLI that "Open in Cursor" runs. */
function EditorCliRow({ server: { settings, update } }: { server: ServerSettings }) {
  const saved = settings?.editorCli ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? saved ?? '';

  const save = async (next: string | null) => {
    if (next !== null) {
      const parsed = EditorCliPath.safeParse(next);
      if (!parsed.success) {
        setError('Use the full path to the command, like /usr/local/bin/cursor.');
        return;
      }
      next = parsed.data;
    }
    setError(null);
    await update({ editorCli: next }, 'Could not save the editor command');
    setDraft(null);
  };

  return (
    <div className="flex flex-col gap-3 p-5" data-setting="editor-cli">
      <div className="flex flex-col gap-0.5">
        <h3 className="font-medium text-body text-text-1">Editor command</h3>
        <p className="text-label text-text-2">
          “Open in Cursor” runs this with the project folder. Leave it empty to use{' '}
          <code className="font-mono">cursor</code>, or else <code className="font-mono">code</code>
          , from your PATH or the app.
        </p>
        {settings && <EditorCliFound key={saved ?? ''} />}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(value.trim() === '' ? null : value);
        }}
        className="flex min-w-0 flex-col gap-2 sm:flex-row"
      >
        <label className="flex h-8 min-w-0 items-center rounded-control border sm:flex-1 touch:h-11 border-line bg-bg-0 px-3 transition-colors duration-fast focus-within:border-line-strong focus-within:shadow-[var(--focus-ring)]">
          <input
            aria-label="Editor command path"
            placeholder="Found automatically"
            value={value}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            disabled={settings === null}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            className="h-full min-w-0 flex-1 bg-transparent font-mono text-label text-text-1 outline-none placeholder:font-sans placeholder:text-text-3 focus-visible:shadow-none disabled:opacity-50"
          />
        </label>
        <div className="flex shrink-0 gap-2">
          <Button
            type="submit"
            disabled={settings === null || draft === null || draft.trim() === (saved ?? '')}
          >
            Save
          </Button>
          {saved !== null && (
            <Button variant="secondary" onClick={() => void save(null)}>
              Find automatically
            </Button>
          )}
        </div>
      </form>
      {error && (
        <p role="alert" className="text-meta text-st-err-ink">
          {error}
        </p>
      )}
    </div>
  );
}

/** What the server found for the editor command, checked again whenever the setting changes. */
function EditorCliFound() {
  const status = useServerStatus(null);
  if (status === null || status === 'error' || status.editorCli === undefined) return null;
  const cli = status.editorCli;
  return (
    <p
      className={cx('min-w-0 truncate text-meta', cli ? 'text-text-3' : 'text-st-err-ink')}
      data-editor-cli={cli ? cli.app : 'missing'}
      title={cli?.path}
    >
      {cli
        ? `Using ${cli.app}: ${cli.path}`
        : 'Not found. Install the shell command from Cursor, or enter its path.'}
    </p>
  );
}

/** How long the Pulse activity history is kept in the local database. */
function RetentionRow({ server: { settings, update } }: { server: ServerSettings }) {
  const change = (value: `${RetentionDays}`) =>
    update({ retentionDays: Number(value) as RetentionDays }, 'Could not save the retention');

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

export function SettingRow({
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

export function Segmented<T extends string>({
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
  const thumb = useSegmentThumb();
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
          onClick={(e) => {
            thumb.pick(e);
            onChange(option);
          }}
          className={cx(
            'relative h-7 rounded-chip px-3 text-label transition-colors duration-fast touch:h-11 touch:min-w-11',
            option === value ? 'text-text-1' : 'text-text-2 hover:text-text-1',
          )}
        >
          {option === value && (
            <SegmentThumb
              layoutId={thumb.layoutId}
              byKeyboard={thumb.byKeyboard}
              className="bg-bg-2"
            />
          )}
          <span className="relative">{labels[option]}</span>
        </button>
      ))}
    </fieldset>
  );
}
