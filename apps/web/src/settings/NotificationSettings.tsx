import {
  DEFAULT_NOTIFY_EVENTS,
  NOTIFY_EVENTS,
  type NotifyEvent,
  type PushDevice,
} from '@yardmaster/protocol';
import { BellRing } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { notificationsPreference } from '../attention/attention.js';
import { usePreference } from '../prefs.js';
import {
  browserPushEnvironment,
  disablePush,
  enablePush,
  type PushSupport,
  pushSupport,
  usePushId,
} from '../push/push.js';
import { formatDateTime, formatWhen } from '../time.js';
import { Button } from '../ui/Button.js';
import { StatusDot } from '../ui/StatusDot.js';
import { Segmented, SettingRow } from '../views/SettingsView.js';
import { ApiRequestError, api } from './api.js';
import type { ServerSettings } from './boardSettings.js';

const ON_OFF = ['off', 'on'] as const;
const ON_OFF_LABEL = { off: 'Off', on: 'On' } as const;

const EVENT_COPY: Record<NotifyEvent, { title: string; description: string }> = {
  needs_you: {
    title: 'Claude needs you',
    description:
      'An approval or a question. In away mode, approvals can be answered from the notification.',
  },
  claude_finished: {
    title: 'Claude finished',
    description: 'A turn that ran for more than 30 seconds.',
  },
  command_finished: {
    title: 'Command finished',
    description: 'A command that ran for more than 30 seconds, with ✓ or its exit code.',
  },
  crashed: {
    title: 'Something crashed',
    description: 'A dev server went down, or a process was killed by a signal.',
  },
  background: {
    title: 'Background work finished',
    description: 'A background task or a subagent.',
  },
};

function usePushDevices() {
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await api.push(signal);
      setDevices(res.devices);
      setFailed(false);
    } catch {
      if (!signal?.aborted) setFailed(true);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);
  return { devices, failed, reload };
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Settings → Notifications (12.6e3): Web Push on this device, the events, and the devices. */
export function NotificationSettings({ server }: { server: ServerSettings }) {
  const { devices, failed, reload } = usePushDevices();
  return (
    <>
      <ThisDeviceRow reload={reload} />
      {NOTIFY_EVENTS.map((event) => (
        <EventRow key={event} event={event} server={server} />
      ))}
      <HideDetailsRow server={server} />
      <PushDevicesRow devices={devices} failed={failed} reload={reload} />
    </>
  );
}

const SUPPORT_TEXT: Record<Exclude<PushSupport, 'ok'>, string> = {
  insecure:
    'Notifications need a secure connection. Open the board on this machine, or on your phone over its https:// Tailscale address.',
  ios_home_screen:
    'On iPhone and iPad, add the board to the home screen first (Share → Add to Home Screen, iOS 16.4 or later), then open it from there and turn notifications on.',
  unsupported: 'This browser can’t receive push notifications.',
};

function ThisDeviceRow({ reload }: { reload: () => Promise<void> }) {
  const support = pushSupport(browserPushEnvironment());
  const pushId = usePushId();
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState(() =>
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  );
  const on = pushId !== null && permission === 'granted';

  if (support !== 'ok') return <LocalNotificationsRow support={support} />;

  const turnOn = async () => {
    setBusy(true);
    const result = await enablePush();
    setPermission(Notification.permission);
    setBusy(false);
    if (result === 'denied') toast.error('Notifications are blocked for this site');
    else if (result === 'failed') toast.error('Could not turn on notifications');
    await reload();
  };
  const turnOff = async () => {
    setBusy(true);
    await disablePush();
    setBusy(false);
    await reload();
  };
  const sendTest = async () => {
    if (!pushId) return;
    setBusy(true);
    try {
      await api.testPush(pushId);
      toast.success('Test notification sent', {
        description: 'It shows once this tab is in the background or closed.',
      });
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : 'Could not send the test');
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const description =
    permission === 'denied'
      ? 'Blocked by the browser. Allow notifications for this site in its settings, then turn them on here.'
      : on
        ? 'This device gets a notification when something below happens, unless it is looking at the board.'
        : 'Get a notification on this device when Claude needs you or long work finishes, even with the board closed.';

  return (
    <SettingRow
      title="This device"
      data="push-device"
      description={
        <span className="flex flex-col gap-1.5">
          <StatusDot
            tone={on ? 'ok' : 'idle'}
            label={on ? 'Notifications on' : 'Notifications off'}
            showLabel
            className="text-label text-text-1"
          />
          <span>{description}</span>
        </span>
      }
    >
      <div className="flex shrink-0 gap-2 self-start sm:self-auto">
        {on ? (
          <>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void sendTest()}>
              Send a test
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void turnOff()}>
              Turn off
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={busy || permission === 'denied'}
            onClick={() => void turnOn()}
          >
            {busy ? 'Turning on…' : 'Turn on'}
          </Button>
        )}
      </div>
    </SettingRow>
  );
}

/** Without Web Push: say why, and offer the tab's own notifications where the browser has them. */
function LocalNotificationsRow({ support }: { support: Exclude<PushSupport, 'ok'> }) {
  const supported = typeof Notification !== 'undefined' && support !== 'ios_home_screen';
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
  return (
    <SettingRow
      title="This device"
      data="push-device"
      description={
        <>
          {SUPPORT_TEXT[support]}
          {supported &&
            ' Until then, this tab can notify you about approvals while it is open in the background.'}
        </>
      }
    >
      {supported && (
        <Segmented
          label="Notify from this tab"
          options={ON_OFF}
          labels={ON_OFF_LABEL}
          value={enabled ? 'on' : 'off'}
          onChange={(next) => void change(next)}
          disabled={permission === 'denied'}
        />
      )}
    </SettingRow>
  );
}

function EventRow({
  event,
  server: { settings, update },
}: {
  event: NotifyEvent;
  server: ServerSettings;
}) {
  const events = settings?.notifyEvents ?? DEFAULT_NOTIFY_EVENTS;
  const on = events.includes(event);
  const copy = EVENT_COPY[event];
  return (
    <SettingRow title={copy.title} description={copy.description} data={`notify-${event}`}>
      <Segmented
        label={copy.title}
        options={ON_OFF}
        labels={ON_OFF_LABEL}
        value={on ? 'on' : 'off'}
        onChange={(value) => {
          const next = value === 'on' ? [...events, event] : events.filter((e) => e !== event);
          void update(
            { notifyEvents: NOTIFY_EVENTS.filter((e) => next.includes(e)) },
            'Could not save the notification setting',
          );
        }}
        disabled={settings === null}
      />
    </SettingRow>
  );
}

function HideDetailsRow({ server: { settings, update } }: { server: ServerSettings }) {
  return (
    <SettingRow
      title="Hide details"
      description="Details show on the lock screen: the command, the tool Claude wants to run and what it wrote, with known secrets masked. Turn this on to say only which project needs you, such as “acme-shop needs you”."
      data="notify-hide-details"
    >
      <Segmented
        label="Hide details"
        options={ON_OFF}
        labels={ON_OFF_LABEL}
        value={settings?.notifyHideDetails ? 'on' : 'off'}
        onChange={(value) =>
          void update({ notifyHideDetails: value === 'on' }, 'Could not save the setting')
        }
        disabled={settings === null}
      />
    </SettingRow>
  );
}

function PushDevicesRow({
  devices,
  failed,
  reload,
}: {
  devices: PushDevice[] | null;
  failed: boolean;
  reload: () => Promise<void>;
}) {
  const now = useNow(30_000);
  const pushId = usePushId();
  const [removing, setRemoving] = useState<string | null>(null);

  const remove = async (device: PushDevice) => {
    setRemoving(device.id);
    try {
      if (device.id === pushId) await disablePush();
      else await api.removePushDevice(device.id);
    } catch {
      toast.error('Could not remove the device');
    } finally {
      setRemoving(null);
      await reload();
    }
  };

  let summary: string;
  if (failed) summary = 'Could not load the devices.';
  else if (devices === null) summary = 'Loading…';
  else if (devices.length === 0) summary = 'No device gets notifications yet.';
  else
    summary = `${devices.length} ${devices.length === 1 ? 'device gets' : 'devices get'} notifications. Mute a project from its menu.`;

  return (
    <div className="flex flex-col gap-3 p-5" data-setting="push-devices">
      <div className="flex flex-col gap-0.5">
        <h3 className="font-medium text-body text-text-1">Devices</h3>
        <p className="text-label text-text-2">{summary}</p>
      </div>
      {devices && devices.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line bg-bg-0">
          {devices.map((device) => (
            <li
              key={device.id}
              data-push-device={device.id}
              className="flex min-w-0 items-center gap-3 py-2 pr-2 pl-3"
            >
              <BellRing aria-hidden className="size-4 shrink-0 stroke-[1.5] text-text-3" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="min-w-0 break-words text-body-sm text-text-1">
                    {device.name}
                  </span>
                  {device.id === pushId && (
                    <span className="shrink-0 rounded-chip bg-bg-2 px-1.5 text-meta text-text-2">
                      This device
                    </span>
                  )}
                </span>
                <span className="text-meta text-text-3 tabular-nums">
                  <span title={formatDateTime(device.createdAt)}>
                    Added {formatWhen(device.createdAt, now)}
                  </span>
                  {device.lastSentAt !== null && (
                    <>
                      {' · '}
                      <span title={formatDateTime(device.lastSentAt)}>
                        last notified {formatWhen(device.lastSentAt, now)}
                      </span>
                    </>
                  )}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={removing === device.id}
                onClick={() => void remove(device)}
              >
                {removing === device.id ? 'Removing…' : 'Remove'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
