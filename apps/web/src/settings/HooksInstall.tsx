import type { HooksInstallResponse, HooksPlanResponse } from '@c-board/protocol';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { dur, ease, spring } from '../motion.js';
import { Button, type ButtonProps } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { ApiRequestError, api } from './api.js';

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-text-3';
  if (line.startsWith('@@')) return 'text-text-3';
  if (line.startsWith('+')) return 'diff-add text-st-ok-ink';
  if (line.startsWith('-')) return 'diff-del text-st-err-ink';
  return 'text-text-2';
}

/** The settings.json diff, line by line; long lines scroll rather than wrap, like a terminal. */
function PlanDiff({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, '').split('\n');
  return (
    <pre
      data-hooks-diff
      className="max-h-[min(420px,50vh)] overflow-auto rounded-control border border-line bg-bg-0 py-2 font-mono text-label"
    >
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
        <div key={i} className={cx('min-w-max px-3', lineClass(line))}>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError && err.code === 'invalid_settings') {
    return `Claude's settings.json ${err.message}.`;
  }
  return 'Could not reach c-board. Try again in a moment.';
}

/**
 * "Install hooks": asks the server what would change, shows that diff in a confirm dialog and
 * only then writes it. The install is refused if settings.json changed in between.
 */
export function InstallHooksButton({
  onInstalled,
  children = 'Install hooks',
  ...props
}: Omit<ButtonProps, 'onClick'> & { onInstalled(result: HooksInstallResponse): void }) {
  const [plan, setPlan] = useState<HooksPlanResponse | null>(null);
  const [busy, setBusy] = useState<'plan' | 'install' | null>(null);
  const [stale, setStale] = useState(false);

  const openPlan = async () => {
    setBusy('plan');
    try {
      const next = await api.planHooks();
      if (!next.changed) {
        toast.success('Hooks are already installed');
        onInstalled({ ok: true, changed: false, backup: null, status: await currentStatus() });
        return;
      }
      setStale(false);
      setPlan(next);
    } catch (err) {
      toast.error('Could not plan the install', { description: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    if (!plan) return;
    setBusy('install');
    try {
      const result = await api.installHooks(plan.fingerprint);
      setPlan(null);
      toast.success('Hooks installed', {
        description: result.backup
          ? `Backed up the previous file to ${result.backup}.`
          : 'Claude Code sessions report to c-board from now on.',
      });
      onInstalled(result);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'changed') {
        // Show the fresh diff instead of writing something the user didn't see.
        setStale(true);
        setPlan(await api.planHooks().catch(() => null));
      } else {
        toast.error('Install failed', { description: errorMessage(err) });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Button {...props} disabled={busy !== null || props.disabled} onClick={() => void openPlan()}>
        {children}
      </Button>
      <Dialog.Root open={plan !== null} onOpenChange={(open) => !open && setPlan(null)}>
        <AnimatePresence>
          {plan && (
            <Dialog.Portal forceMount>
              <Dialog.Overlay asChild forceMount>
                <motion.div
                  className="palette-overlay fixed inset-0 z-50"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { duration: dur.base, ease: ease.out } }}
                  exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
                />
              </Dialog.Overlay>
              <Dialog.Content asChild forceMount>
                <motion.div
                  data-hooks-dialog
                  className="palette fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-32px)] w-[min(640px,calc(100vw-32px))] flex-col gap-4 overflow-hidden rounded-modal border border-line-strong p-5 shadow-raised outline-none"
                  style={{ x: '-50%', y: '-50%' }}
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1, transition: spring.smooth }}
                  exit={{
                    opacity: 0,
                    scale: 0.98,
                    transition: { duration: dur.fast, ease: ease.out },
                  }}
                >
                  <div className="flex flex-col gap-1">
                    <Dialog.Title className="font-medium text-text-1 text-title-sm">
                      Install the c-board hooks?
                    </Dialog.Title>
                    <Dialog.Description className="text-body-sm text-text-2">
                      {stale
                        ? 'The file changed while this was open. Here is what would change now.'
                        : 'This is the exact change to Claude’s settings. Other hooks stay as they are, and the current file is backed up first.'}
                    </Dialog.Description>
                  </div>
                  <PlanDiff diff={plan.diff} />
                  <div className="flex justify-end gap-2">
                    <Dialog.Close asChild>
                      <Button variant="ghost">Cancel</Button>
                    </Dialog.Close>
                    <Button
                      variant="primary"
                      disabled={busy !== null}
                      onClick={() => void install()}
                      data-hooks-confirm
                    >
                      {busy === 'install' ? 'Installing…' : 'Install'}
                    </Button>
                  </div>
                </motion.div>
              </Dialog.Content>
            </Dialog.Portal>
          )}
        </AnimatePresence>
      </Dialog.Root>
    </>
  );
}

async function currentStatus(): Promise<HooksInstallResponse['status']> {
  const { status } = await api.hooks();
  return status ?? { installed: [], missing: [], outdated: [] };
}
