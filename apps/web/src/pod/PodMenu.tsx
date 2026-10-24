import * as ContextMenu from '@radix-ui/react-context-menu';
import type { Project } from '@yardmaster/protocol';
import {
  ArrowUpRight,
  Bell,
  BellOff,
  ExternalLink,
  FolderX,
  Pin,
  PinOff,
  SquareTerminal,
  Trash2,
} from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { useBoard, useBoardClient } from '../data/index.js';
import { requestClose } from '../library/closing.js';
import { usePin } from '../library/useActive.js';
import { useMute } from '../push/mute.js';
import { projectHref } from '../routes.js';
import { newTerminalRequest } from '../terminal/newTerminal.js';
import { actionErrorText } from '../terminal/stack.js';

/**
 * A project's context menu on the overview (right click, or the context-menu key): on a pod, an
 * Office room, a Grid node or a Transit line. Open it, open a new terminal in it (the focus
 * view's popover), open it in the editor, pin it to the overview, or close or forget it.
 */
export function PodMenu({
  project,
  children,
}: {
  project: Pick<Project, 'id' | 'name'>;
  children: ReactElement;
}) {
  const [, navigate] = useLocation();
  const client = useBoardClient();
  const editor = useBoard(
    (s) =>
      Object.values(s.board.windows).find((w) => w.projectIds.includes(project.id))?.appName ||
      'Cursor',
  );
  const href = projectHref(project.id);
  const pin = usePin(project.id);
  const mute = useMute(project.id);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          collisionPadding={16}
          aria-label={`${project.name} actions`}
          data-pod-menu={project.id}
          className="context-menu palette z-50 flex min-w-56 flex-col rounded-panel border border-line-strong p-1 shadow-raised outline-none"
        >
          <MenuItem icon={<ArrowUpRight />} onSelect={() => navigate(href)}>
            Open {project.name}
          </MenuItem>
          <MenuItem
            icon={<SquareTerminal />}
            onSelect={() => {
              newTerminalRequest.set(project.id);
              navigate(href);
            }}
          >
            New terminal…
          </MenuItem>
          <ContextMenu.Separator className="mx-2 my-1 h-px bg-line" />
          <MenuItem
            icon={<ExternalLink />}
            onSelect={async () => {
              const result = await client.action({
                kind: 'project.openInEditor',
                projectId: project.id,
              });
              if (!result.ok) toast.error(actionErrorText(result.error, 'Could not open it'));
            }}
          >
            Open in {editor}
          </MenuItem>
          <MenuItem icon={pin.pinned ? <PinOff /> : <Pin />} onSelect={pin.toggle}>
            {pin.pinned ? 'Unpin from the overview' : 'Pin to the overview'}
          </MenuItem>
          <MenuItem icon={mute.muted ? <Bell /> : <BellOff />} onSelect={mute.toggle}>
            {mute.muted ? 'Unmute notifications' : 'Mute notifications'}
          </MenuItem>
          <ContextMenu.Separator className="mx-2 my-1 h-px bg-line" />
          <MenuItem icon={<FolderX />} onSelect={() => requestClose(project.id)}>
            Close project…
          </MenuItem>
          <MenuItem icon={<Trash2 />} onSelect={() => requestClose(project.id, true)}>
            Forget project…
          </MenuItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function MenuItem({
  icon,
  onSelect,
  children,
}: {
  icon: ReactNode;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className="flex h-8 min-w-0 select-none items-center gap-2.5 rounded-control px-2.5 text-body-sm text-text-2 outline-none data-highlighted:bg-bg-2 data-highlighted:text-text-1"
    >
      <span aria-hidden className="flex shrink-0 text-text-3 [&_svg]:size-4 [&_svg]:stroke-[1.5]">
        {icon}
      </span>
      <span className="truncate">{children}</span>
    </ContextMenu.Item>
  );
}
