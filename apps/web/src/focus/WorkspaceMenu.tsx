import type { Project } from '@c-board/protocol';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Copy,
  EllipsisVertical,
  ExternalLink,
  Pin,
  PinOff,
  Plus,
  SquareTerminal,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { useBoard, useBoardClient } from '../data/index.js';
import { usePin } from '../library/useActive.js';
import { dur, ease } from '../motion.js';
import { newTerminalRequest } from '../terminal/newTerminal.js';
import { actionErrorText } from '../terminal/stack.js';
import { SheetPanel } from '../ui/BottomSheet.js';

/**
 * The phone workspace's overflow menu (DESIGN.md §11), a bottom sheet: the full path and branch the
 * app bar truncates, then the project's actions.
 */
export function WorkspaceMenu({
  project,
  onNewSession,
}: {
  project: Project;
  onNewSession: () => void;
}) {
  const [open, setOpen] = useState(false);
  const client = useBoardClient();
  const editor = useBoard(
    (s) =>
      Object.values(s.board.windows).find((w) => w.projectIds.includes(project.id))?.appName ||
      'Cursor',
  );
  const pin = usePin(project.id);
  const run = (action: () => void | Promise<void>) => () => {
    setOpen(false);
    void action();
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label={`${project.name} actions`}
          data-workspace-menu-trigger=""
          className="grid size-11 shrink-0 place-items-center rounded-control text-text-2 transition-[background-color,color,scale] duration-fast ease-out hover:bg-bg-2 hover:text-text-1 moving:active:scale-[0.97]"
        >
          <EllipsisVertical aria-hidden className="size-5" strokeWidth={1.5} />
        </button>
      </Dialog.Trigger>
      <AnimatePresence>
        {open && (
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
              <SheetPanel
                data-workspace-menu=""
                onDismiss={() => setOpen(false)}
                className="pb-[max(8px,env(safe-area-inset-bottom))]"
              >
                <div className="flex min-w-0 flex-col gap-0.5 px-4 pb-3">
                  <Dialog.Title className="truncate font-medium text-body text-text-1">
                    {project.name}
                  </Dialog.Title>
                  <Dialog.Description className="break-all font-mono text-label text-text-2">
                    {project.path}
                    {project.git?.branch && ` · ${project.git.branch}`}
                  </Dialog.Description>
                </div>
                <div className="flex min-h-0 flex-col overflow-y-auto border-line border-t px-2 pt-2">
                  <Item icon={<Plus />} onSelect={run(onNewSession)}>
                    New session
                  </Item>
                  <Item
                    icon={<SquareTerminal />}
                    onSelect={run(() => newTerminalRequest.set(project.id))}
                  >
                    New terminal…
                  </Item>
                  <Item
                    icon={<ExternalLink />}
                    onSelect={run(async () => {
                      const result = await client.action({
                        kind: 'project.openInEditor',
                        projectId: project.id,
                      });
                      if (!result.ok)
                        toast.error(actionErrorText(result.error, 'Could not open it'));
                    })}
                  >
                    Open in {editor}
                  </Item>
                  <Item icon={pin.pinned ? <PinOff /> : <Pin />} onSelect={run(pin.toggle)}>
                    {pin.pinned ? 'Unpin from the overview' : 'Pin to the overview'}
                  </Item>
                  <Item
                    icon={<Copy />}
                    onSelect={run(async () => {
                      try {
                        await navigator.clipboard.writeText(project.path);
                        toast.success('Path copied');
                      } catch {
                        toast.error('Could not copy the path');
                      }
                    })}
                  >
                    Copy path
                  </Item>
                </div>
              </SheetPanel>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function Item({
  icon,
  onSelect,
  children,
}: {
  icon: ReactNode;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex h-12 min-w-0 items-center gap-3 rounded-control px-3 text-left text-body text-text-1 transition-colors duration-fast hover:bg-bg-2 active:bg-bg-2"
    >
      <span aria-hidden className="flex shrink-0 text-text-2 [&_svg]:size-5 [&_svg]:stroke-[1.5]">
        {icon}
      </span>
      <span className="truncate">{children}</span>
    </button>
  );
}
