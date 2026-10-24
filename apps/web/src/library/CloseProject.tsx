import * as Dialog from '@radix-ui/react-dialog';
import { Check, CircleStop, EyeOff, PauseCircle } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { useBoard, useBoardClient, useBoardStore } from '../data/index.js';
import { dur, ease } from '../motion.js';
import { useMediaQuery } from '../prefs.js';
import { inProject, routes } from '../routes.js';
import { boardSettings } from '../settings/boardSettings.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { NARROW_QUERY } from '../shell/prefs.js';
import { actionErrorText } from '../terminal/stack.js';
import { SheetPanel } from '../ui/BottomSheet.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import {
  type ClosePlan,
  type CloseRequest,
  closePlan,
  closeRequest,
  waitForClosed,
} from './closing.js';

const dismiss = () => closeRequest.set(null);

/**
 * The confirm before closing or forgetting a project (12.6e): what still runs there and what
 * happens to it, and a checkbox to close its editor window too. A small glass modal on wide
 * screens, a bottom sheet on phones.
 */
export function CloseProjectDialog() {
  const request = useSyncExternalStore(closeRequest.subscribe, closeRequest.get);
  const exists = useBoard((s) => (request ? s.board.projects[request.projectId] : undefined));
  const narrow = useMediaQuery(NARROW_QUERY);
  const open = request !== null && exists !== undefined;

  // The project left the board some other way: nothing to confirm any more.
  useEffect(() => {
    if (request && !exists) dismiss();
  }, [request, exists]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && dismiss()}>
      <AnimatePresence>
        {open && request && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="palette-overlay fixed inset-0 z-50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: dur.fast, ease: ease.out } }}
                exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount>
              {narrow ? (
                <SheetPanel data-close-project={request.projectId} onDismiss={dismiss}>
                  <CloseBody request={request} />
                </SheetPanel>
              ) : (
                <motion.div
                  data-close-project={request.projectId}
                  className="palette fixed top-[18vh] left-1/2 z-50 flex max-h-[min(560px,76vh)] w-[min(440px,calc(100vw-32px))] flex-col overflow-hidden rounded-modal border border-line-strong shadow-raised outline-none"
                  style={{ x: '-50%' }}
                  initial={{ opacity: 0, scale: 0.96, filter: 'blur(4px)' }}
                  animate={{
                    opacity: 1,
                    scale: 1,
                    filter: 'blur(0px)',
                    transition: { duration: dur.fast, ease: ease.out },
                    transitionEnd: { filter: 'none' },
                  }}
                  exit={{
                    opacity: 0,
                    scale: 0.98,
                    transition: { duration: dur.fast, ease: ease.out },
                  }}
                >
                  <CloseBody request={request} />
                </motion.div>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function CloseBody({ request }: { request: CloseRequest }) {
  const { projectId, forget } = request;
  const client = useBoardClient();
  const store = useBoardStore();
  const [location, navigate] = useLocation();
  const project = useBoard((s) => s.board.projects[projectId]);
  const terminals = useBoard((s) => s.board.terminals);
  const sessions = useBoard((s) => s.board.sessions);
  const windows = useBoard((s) => s.board.windows);
  const plan = useMemo(
    () => closePlan({ terminals, sessions, windows }, projectId),
    [terminals, sessions, windows, projectId],
  );
  const [closeWindow, setCloseWindow] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!project) return null;

  const verb = forget ? 'Forget' : 'Close';
  const editor = plan.windows[0]?.appName ?? 'Cursor';
  const confirm = async () => {
    setBusy(true);
    const withWindow = closeWindow && plan.windows.length > 0;
    const result = await client.action({
      kind: forget ? 'project.forget' : 'project.close',
      projectId,
      ...(withWindow ? { closeWindow: true } : {}),
    });
    // The server unpinned it; the overview's copy of the pins catches up.
    void boardSettings.load();
    if (!result.ok && result.error !== 'window_not_closed') {
      setBusy(false);
      toast.error(actionErrorText(result.error, `Could not ${verb.toLowerCase()} it`));
      return;
    }
    // Leaving its focus view must not count as opening it again.
    await waitForClosed(
      { get: () => store.getState().board, subscribe: store.subscribe },
      projectId,
    );
    setBusy(false);
    dismiss();
    if (inProject(location, projectId)) navigate(routes.overview);
    if (result.ok) toast.success(`${forget ? 'Forgot' : 'Closed'} ${project.name}`);
    else toast.warning(`Closed ${project.name}, but the ${editor} window did not close`);
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void confirm();
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-5">
        <div className="flex min-w-0 items-center gap-3">
          <ProjectAvatar project={project} size="lg" />
          <div className="min-w-0 flex-1">
            <Dialog.Title className="truncate font-medium text-text-1 text-title-sm">
              {verb} {project.name}?
            </Dialog.Title>
            <Dialog.Description className="text-body-sm text-text-2">
              {forget
                ? 'It leaves the board and your recent projects. It comes back if you open it again or something runs there.'
                : 'It leaves the overview and the project list until something new happens there.'}
            </Dialog.Description>
          </div>
        </div>
        <PlanList plan={plan} />
        {plan.windows.length > 0 && (
          <WindowCheckbox
            checked={closeWindow}
            onChange={setCloseWindow}
            label={
              plan.windows.length === 1
                ? `Also close the ${editor} window`
                : `Also close its ${plan.windows.length} ${editor} windows`
            }
          />
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-line border-t px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Dialog.Close asChild>
          <Button variant="ghost">Cancel</Button>
        </Dialog.Close>
        <Button type="submit" variant="primary" disabled={busy} data-close-confirm="">
          {verb} project
        </Button>
      </footer>
    </form>
  );
}

function PlanList({ plan }: { plan: ClosePlan }) {
  const empty = plan.stop.length + plan.interrupt.length + plan.keep.length === 0;
  if (empty) {
    return (
      <p data-close-plan="empty" className="text-body-sm text-text-3">
        Nothing is running there.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-close-plan="">
      {plan.stop.length > 0 && (
        <PlanGroup
          kind="stop"
          icon={<CircleStop />}
          title="Stopped"
          note="Board terminals get Ctrl+C, then end after 3 s."
          items={plan.stop}
        />
      )}
      {plan.interrupt.length > 0 && (
        <PlanGroup
          kind="interrupt"
          icon={<PauseCircle />}
          title="Interrupted"
          note="Board Claude sessions. Resume them from History."
          items={plan.interrupt}
        />
      )}
      {plan.keep.length > 0 && (
        <PlanGroup
          kind="keep"
          icon={<EyeOff />}
          title="Left running, hidden"
          note="Claude in a terminal and editor terminals carry on."
          items={plan.keep}
        />
      )}
    </div>
  );
}

function PlanGroup({
  kind,
  icon,
  title,
  note,
  items,
}: {
  kind: string;
  icon: ReactNode;
  title: string;
  note: string;
  items: readonly { id: string; name: string }[];
}) {
  return (
    <section data-close-group={kind} className="rounded-panel border border-line bg-bg-2/40 p-3">
      <h3 className="flex items-center gap-2 font-medium text-body-sm text-text-1">
        <span aria-hidden className="flex text-text-3 [&_svg]:size-4 [&_svg]:stroke-[1.5]">
          {icon}
        </span>
        {title}
      </h3>
      <p className="mt-0.5 text-meta text-text-3">{note}</p>
      <ul className="mt-2 flex flex-col gap-1">
        {items.map((item) => (
          <li
            key={item.id}
            data-close-item={item.id}
            className="truncate font-mono text-label text-text-2"
            title={item.name}
          >
            {item.name}
          </li>
        ))}
      </ul>
    </section>
  );
}

function WindowCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label
      data-close-window=""
      className="flex min-h-11 cursor-pointer items-center gap-3 rounded-panel border border-line px-3 py-2 hover:border-line-strong"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={cx(
          'grid size-4 shrink-0 place-items-center rounded-[5px] border transition-[background-color,border-color] duration-fast peer-focus-visible:shadow-[var(--focus-ring)]',
          checked ? 'border-text-1 bg-text-1 text-bg-0' : 'border-line-strong bg-bg-0',
        )}
      >
        <Check
          className={cx(
            'size-3 transition-[opacity,scale] duration-fast ease-out',
            checked ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
          )}
          strokeWidth={2.5}
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-body-sm text-text-1">{label}</span>
    </label>
  );
}
