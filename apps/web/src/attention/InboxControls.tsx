import type { Approval, ClaudeSession, HookPermissionMode } from '@yardmaster/protocol';
import { CornerDownLeft, ShieldCheck, Square } from 'lucide-react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import { Pill } from '../claude/Composer.js';
import { PERMISSION_OPTIONS, permissionLabel } from '../claude/composerModel.js';
import { useBoardClient } from '../data/index.js';
import { sessionHref } from '../routes.js';
import { actionErrorText } from '../terminal/stack.js';
import { Button, buttonClass } from '../ui/Button.js';
import { inboxInterrupt, inboxModeSwitch } from './attention.js';

/** The hook's pill rests on this; picking a real mode is the change that allows the request. */
const KEEP = 'keep';

/**
 * What else can be done from an inbox item: open the session (Enter), interrupt it, or switch its
 * permission mode, as far as its kind of session allows (`inboxInterrupt`, `inboxModeSwitch`).
 */
export function InboxControls({
  session,
  approval,
  busy,
  selected,
  onOpen,
  onStopRequest,
  onAllowWithMode,
}: {
  session: ClaudeSession;
  approval: Approval | null;
  busy: boolean;
  selected: boolean;
  onOpen(): void;
  onStopRequest?(): void;
  onAllowWithMode?(mode: HookPermissionMode): void;
}) {
  const client = useBoardClient();
  const interrupt = inboxInterrupt(session, approval);
  const modes = inboxModeSwitch(session, approval);

  const run = async (action: Parameters<typeof client.action>[0], failure: string) => {
    const result = await client.action(action);
    if (!result.ok) toast.error(actionErrorText(result.error, failure));
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {session.projectId && (
        <Link
          href={sessionHref(session.projectId, session.id)}
          onClick={onOpen}
          data-inbox-open
          className={buttonClass('ghost', 'sm')}
        >
          Open
          {selected && <CornerDownLeft aria-hidden className="size-3" strokeWidth={1.5} />}
        </Link>
      )}
      {interrupt && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          data-inbox-interrupt
          onClick={() =>
            interrupt.kind === 'stopRequest'
              ? onStopRequest?.()
              : void run(interrupt.action, 'Could not interrupt Claude')
          }
        >
          <Square aria-hidden className="size-3" strokeWidth={1.5} />
          Interrupt
        </Button>
      )}
      {modes?.kind === 'session' && (
        <Pill
          name="Permission mode"
          icon={<ShieldCheck />}
          label={permissionLabel(session.permissionMode)}
          value={session.permissionMode ?? 'default'}
          options={PERMISSION_OPTIONS}
          disabled={busy}
          onChange={(permissionMode) =>
            void run(
              { kind: 'session.setPermissionMode', sessionId: session.id, permissionMode },
              'Could not switch the mode',
            )
          }
        />
      )}
      {modes?.kind === 'allowWith' && modes.modes.length > 0 && (
        <Pill
          name="Allow and switch mode"
          icon={<ShieldCheck />}
          label="Allow and switch"
          value={KEEP}
          options={[
            { value: KEEP, label: `Keep ${permissionLabel(session.permissionMode)}` },
            ...PERMISSION_OPTIONS.filter((o) =>
              (modes.modes as readonly string[]).includes(o.value),
            ),
          ]}
          disabled={busy}
          onChange={(mode) => {
            if (mode !== KEEP) onAllowWithMode?.(mode as HookPermissionMode);
          }}
        />
      )}
    </div>
  );
}
