import { Check } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Logomark } from '../brand/Logo.js';
import { selectConnection, selectWindowCount, useBoard } from '../data/index.js';
import { dur, ease, move, spring, useMotionLevel } from '../motion.js';
import { InstallHooksButton } from '../settings/HooksInstall.js';
import { useHooksStatus, useServerStatus } from '../settings/useServerStatus.js';
import { Button } from '../ui/Button.js';
import { CopyCommand } from '../ui/CopyCommand.js';
import { cx } from '../ui/cx.js';
import { activeStep, hooksInstalled, SETUP_COMMANDS, type StepId, setupSteps } from './model.js';

/** While the guide is open the status is polled, so steps tick within a second. */
const POLL_MS = 1000;

const TITLE: Record<StepId, string> = {
  server: 'Server',
  hooks: 'Claude Code hooks',
  extension: 'Editor extension',
};

type MarkState = 'done' | 'active' | 'pending';

function StepMark({ state, index }: { state: MarkState; index: number }) {
  return (
    <span className="relative grid size-6 shrink-0 place-items-center" aria-hidden>
      <AnimatePresence initial={false} mode="popLayout">
        {state === 'done' ? (
          <motion.span
            key="done"
            className="absolute inset-0 grid place-items-center rounded-full bg-st-ok text-bg-0"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1, transition: spring.snappy }}
            exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
          >
            <Check className="size-3.5" strokeWidth={2.5} />
          </motion.span>
        ) : (
          <motion.span
            key="todo"
            className={cx(
              'absolute inset-0 grid place-items-center rounded-full border font-mono text-label tabular-nums',
              state === 'active' ? 'border-st-work text-text-1' : 'border-line-strong text-text-3',
            )}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: dur.base, ease: ease.out } }}
            exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
          >
            {/* The ring breathes while the board listens for this step's first signal. */}
            {state === 'active' && (
              <span className="onboarding-listen absolute inset-0 rounded-full" />
            )}
            {index + 1}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function Step({
  id,
  index,
  state,
  detail,
  children,
}: {
  id: StepId;
  index: number;
  state: MarkState;
  detail: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li data-step={id} data-done={state === 'done'} className="flex gap-3">
      <StepMark state={state} index={index} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
        <h2
          className={cx(
            'font-medium text-body',
            state === 'pending' ? 'text-text-2' : 'text-text-1',
          )}
        >
          {TITLE[id]}
          <span className="sr-only">{state === 'done' ? ', done' : ', not done yet'}</span>
        </h2>
        <p className="text-body-sm text-text-2">{detail}</p>
        {children && state !== 'done' && <div className="mt-2 flex flex-col gap-2">{children}</div>}
      </div>
    </li>
  );
}

/**
 * The first-run guide (DESIGN.md §6): Server, Hooks, Extension, each ticking itself the moment
 * the board sees a hook event or an editor connection.
 */
export function OnboardingWizard({ onDone }: { onDone(): void }) {
  const still = useMotionLevel() !== 'full';
  const connection = useBoard(selectConnection);
  const windows = useBoard(selectWindowCount);
  const status = useServerStatus(POLL_MS);
  const hooks = useHooksStatus();
  const steps = setupSteps({
    connected: connection.status === 'live',
    status: status === 'error' ? null : status,
    windows,
  });
  const active = activeStep(steps);
  const doneCount = steps.filter((step) => step.done).length;
  const complete = active === null;
  const stateOf = (id: StepId): MarkState =>
    steps.find((step) => step.id === id)?.done ? 'done' : active === id ? 'active' : 'pending';

  const hookFile = hooks.state.status === 'ready' ? hooks.state.hooks : null;
  const installed = hooksInstalled(hookFile?.status ?? null);
  const settingsPath = hookFile?.path ?? '~/.claude/settings.json';

  return (
    <div className="flex min-h-[calc(100dvh-160px)] items-center justify-center py-8">
      <motion.section
        data-onboarding
        data-complete={complete}
        aria-labelledby="onboarding-title"
        className="onboarding-card flex w-full max-w-lg flex-col gap-6 rounded-modal border border-line p-6 shadow-raised"
        initial={{ opacity: 0, transform: move(still, 'translateY(8px)'), filter: 'blur(4px)' }}
        animate={{
          opacity: 1,
          transform: move(still, 'translateY(0px)'),
          filter: 'blur(0px)',
          transition: spring.smooth,
          transitionEnd: { filter: 'none' },
        }}
      >
        <header className="flex flex-col gap-3">
          <Logomark className="size-8 text-text-2" />
          <div className="flex flex-col gap-1">
            <h1 id="onboarding-title" className="font-medium text-text-1 text-title">
              {complete ? 'You’re all set' : 'Set up c-board'}
            </h1>
            <p className="text-body-sm text-text-2">
              {complete
                ? 'Claude Code sessions and editor terminals now report to the board.'
                : 'Three steps. Each one ticks itself as soon as c-board sees it working.'}
            </p>
          </div>
        </header>

        <ol className="flex flex-col gap-5">
          <Step
            id="server"
            index={0}
            state={stateOf('server')}
            detail={
              stateOf('server') === 'done'
                ? `Running on ${window.location.host}.`
                : 'Connecting to the board…'
            }
          />
          <Step
            id="hooks"
            index={1}
            state={stateOf('hooks')}
            detail={
              stateOf('hooks') === 'done'
                ? 'Receiving events from Claude Code.'
                : installed
                  ? 'Installed. Start or continue a Claude Code session in any project to send the first event.'
                  : `Adds c-board’s observer hooks to ${settingsPath}. They run in the background and never block Claude.`
            }
          >
            {!installed && (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <InstallHooksButton size="sm" variant="primary" onInstalled={hooks.reload} />
                  <span className="text-meta text-text-3">or run it yourself</span>
                </div>
                <CopyCommand command={SETUP_COMMANDS.hooks} />
              </>
            )}
          </Step>
          <Step
            id="extension"
            index={2}
            state={stateOf('extension')}
            detail={
              stateOf('extension') === 'done'
                ? windows === 1
                  ? 'One editor window connected.'
                  : windows > 1
                    ? `${windows} editor windows connected.`
                    : 'An editor has connected before.'
                : 'Streams your Cursor or VS Code terminals to the board. Build and install it from the c-board checkout, then reload the editor window.'
            }
          >
            {SETUP_COMMANDS.extension.map((command) => (
              <CopyCommand key={command} command={command} />
            ))}
          </Step>
        </ol>

        <footer className="flex items-center justify-between gap-3 border-line border-t pt-4">
          <span className="text-meta text-text-3 tabular-nums" aria-live="polite" data-progress>
            {doneCount} of {steps.length} done
          </span>
          {complete ? (
            <Button variant="primary" onClick={onDone} data-onboarding-done>
              Open the board
            </Button>
          ) : (
            <Button variant="ghost" onClick={onDone}>
              Skip for now
            </Button>
          )}
        </footer>
      </motion.section>
    </div>
  );
}
