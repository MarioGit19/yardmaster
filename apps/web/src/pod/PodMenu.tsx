import type { Project } from '@c-board/protocol';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { ArrowUpRight, ExternalLink, SquareTerminal } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { useBoard, useBoardClient } from '../data/index.js';
import { projectHref } from '../routes.js';
import { newTerminalRequest } from '../terminal/newTerminal.js';
import { actionErrorText } from '../terminal/stack.js';

/**
 * A pod's context menu (right click, or the context-menu key on its link): open it, open a new
 * terminal in it (the focus view's popover), or open it in the editor.
 */
export function PodMenu({ project, children }: { project: Project; children: ReactElement }) {
  const [, navigate] = useLocation();
  const client = useBoardClient();
  const editor = useBoard(
    (s) =>
      Object.values(s.board.windows).find((w) => w.projectIds.includes(project.id))?.appName ||
      'Cursor',
  );
  const href = projectHref(project.id);
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
