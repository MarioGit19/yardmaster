import type { Project } from '@c-board/protocol';
import { FolderOpen, LayoutGrid, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react';
import { forwardRef, type KeyboardEvent, type ReactNode, useMemo, useRef } from 'react';
import { Link, useRoute } from 'wouter';
import {
  selectProjects,
  selectSessionsByProject,
  selectTerminalsByProject,
  useBoard,
  useBoardList,
} from '../data/index.js';
import { pickerOpen } from '../library/OpenProject.js';
import { useClosedProjects } from '../library/useActive.js';
import { projectHref, routes } from '../routes.js';
import { projectTone, toneLabel } from '../status.js';
import { cx } from '../ui/cx.js';
import { IconButton } from '../ui/IconButton.js';
import { Skeleton } from '../ui/Skeleton.js';
import { StatusDot, TONE_MARK } from '../ui/StatusDot.js';
import { Tooltip } from '../ui/Tooltip.js';
import { ProjectAvatar } from './ProjectAvatar.js';
import { railKeyTarget } from './railNav.js';

export interface ProjectRailProps {
  collapsed: boolean;
  /** Absent when the rail can't expand (narrow screens). */
  onToggle?: () => void;
}

export function ProjectRail({ collapsed, onToggle }: ProjectRailProps) {
  const all = useBoardList(selectProjects);
  const closed = useClosedProjects();
  const projects = useMemo(() => all.filter((p) => !closed.has(p.id)), [all, closed]);
  const hydrated = useBoard((s) => s.hydrated);
  const listRef = useRef<HTMLUListElement>(null);
  const [onOverview] = useRoute(routes.overview);
  const [onSettings] = useRoute(routes.settings);
  const [, projectMatch] = useRoute<{ projectId: string }>('/p/:projectId/*?');
  const activeProjectId = projectMatch?.projectId ?? null;

  // One tab stop for the whole rail: the current page's item, else the first.
  const tabStop = onSettings
    ? projects.length + 1
    : projects.findIndex((p) => p.id === activeProjectId) + 1;

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-rail-item]') ?? [],
    );
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = railKeyTarget(event.key, current, items.length);
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <nav
      aria-label="Projects"
      data-collapsed={collapsed || undefined}
      className={cx(
        'flex shrink-0 flex-col border-line border-r bg-bg-1',
        collapsed ? 'w-14 touch:w-16' : 'w-60',
      )}
    >
      <ul
        ref={listRef}
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2"
      >
        <li>
          <RailLink
            href={routes.overview}
            label="Overview"
            collapsed={collapsed}
            active={onOverview}
            tabStop={tabStop === 0}
            icon={<LayoutGrid className="size-4" strokeWidth={1.5} />}
          />
        </li>
        <li>
          <RailOpenProject collapsed={collapsed} />
        </li>
        <li aria-hidden className="mx-2 my-1.5 h-px bg-line" />
        {!hydrated && projects.length === 0 && <RailSkeleton collapsed={collapsed} />}
        {hydrated && projects.length === 0 && !collapsed && (
          <li className="px-2 py-1.5 text-meta text-text-2">No projects yet</li>
        )}
        {projects.map((project, i) => (
          <li key={project.id}>
            <ProjectRailItem
              project={project}
              collapsed={collapsed}
              active={project.id === activeProjectId}
              tabStop={tabStop === i + 1}
            />
          </li>
        ))}
        <li className="mt-auto pt-2">
          <RailLink
            href={routes.settings}
            label="Settings"
            collapsed={collapsed}
            active={onSettings}
            tabStop={tabStop === projects.length + 1}
            icon={<Settings className="size-4" strokeWidth={1.5} />}
          />
        </li>
      </ul>
      {onToggle && (
        <div className={cx('flex border-line border-t p-2', collapsed && 'justify-center')}>
          <IconButton
            label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            shortcut="["
            tooltipSide="right"
            size="sm"
            onClick={onToggle}
            icon={
              collapsed ? (
                <PanelLeftOpen className="size-4" strokeWidth={1.5} />
              ) : (
                <PanelLeftClose className="size-4" strokeWidth={1.5} />
              )
            }
          />
        </div>
      )}
    </nav>
  );
}

function ProjectRailItem({
  project,
  collapsed,
  active,
  tabStop,
}: {
  project: Project;
  collapsed: boolean;
  active: boolean;
  tabStop: boolean;
}) {
  const sessions = useBoardList(selectSessionsByProject(project.id));
  const terminals = useBoardList(selectTerminalsByProject(project.id));
  const tone = projectTone(sessions, terminals);
  return (
    <RailLink
      href={projectHref(project.id)}
      label={project.name}
      description={`${project.name}, ${toneLabel(tone)}`}
      collapsed={collapsed}
      active={active}
      tabStop={tabStop}
      icon={<ProjectAvatar project={project} />}
      trailing={tone !== 'idle' && <StatusDot tone={tone} label={toneLabel(tone)} />}
      badge={collapsed && tone !== 'idle' ? tone : undefined}
    />
  );
}

interface RailLinkProps {
  href: string;
  label: string;
  /** Accessible name when it says more than the label (e.g. the status). */
  description?: string;
  icon: ReactNode;
  trailing?: ReactNode;
  /** Collapsed rails show status as a dot on the icon. */
  badge?: 'work' | 'tool' | 'wait' | 'ok' | 'err';
  collapsed: boolean;
  active: boolean;
  tabStop: boolean;
}

function RailLink({
  href,
  label,
  description,
  icon,
  trailing,
  badge,
  collapsed,
  active,
  tabStop,
}: RailLinkProps) {
  const link = (
    <RailAnchor
      href={href}
      aria-label={collapsed || description ? (description ?? label) : undefined}
      aria-current={active ? 'page' : undefined}
      tabIndex={tabStop ? 0 : -1}
      data-rail-item=""
      className={cx(
        'relative flex h-9 items-center gap-2 rounded-control px-2 text-body-sm outline-none touch:h-11',
        'transition-colors duration-fast ease-out',
        collapsed && 'justify-center px-0',
        active
          ? 'bg-bg-2 text-text-1 shadow-raised'
          : 'text-text-2 hover:bg-bg-2/60 hover:text-text-1',
      )}
    >
      <span className="relative flex shrink-0 text-text-2">
        {icon}
        {badge && (
          // The same shaped mark as the expanded rail, on a plate that cuts it out of the icon.
          <span
            aria-hidden
            data-mark={badge}
            className="absolute -top-1 -right-1 grid size-3 place-items-center rounded-full bg-bg-1"
          >
            <span className={cx('block', TONE_MARK[badge])} />
          </span>
        )}
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {trailing}
        </>
      )}
    </RailAnchor>
  );
  if (!collapsed) return link;
  return (
    <Tooltip content={label} side="right">
      {link}
    </Tooltip>
  );
}

/** "Open project" (F25): opens the picker, so it's a button among the rail's links. */
function RailOpenProject({ collapsed }: { collapsed: boolean }) {
  const button = (
    <button
      type="button"
      aria-label={collapsed ? 'Open project' : undefined}
      tabIndex={-1}
      data-rail-item=""
      data-rail-open-project=""
      onClick={() => pickerOpen.set('open')}
      className={cx(
        'relative flex h-9 w-full items-center gap-2 rounded-control px-2 text-body-sm text-text-2 outline-none touch:h-11',
        'transition-colors duration-fast ease-out hover:bg-bg-2/60 hover:text-text-1',
        collapsed && 'justify-center px-0',
      )}
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-text-2">
        <FolderOpen className="size-4" strokeWidth={1.5} />
      </span>
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">Open project</span>}
    </button>
  );
  if (!collapsed) return button;
  return (
    <Tooltip content="Open project" side="right">
      {button}
    </Tooltip>
  );
}

// wouter's Link forwards its ref, which Radix Tooltip needs for positioning.
const RailAnchor = forwardRef<
  HTMLAnchorElement,
  React.ComponentPropsWithoutRef<'a'> & { href: string; 'data-rail-item': string }
>(function RailAnchor(props, ref) {
  return <Link ref={ref} {...props} />;
});

function RailSkeleton({ collapsed }: { collapsed: boolean }) {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <li key={i} aria-hidden className="flex h-9 items-center gap-2 px-2">
          <Skeleton className="size-6 rounded-full" />
          {!collapsed && <Skeleton className={cx('h-3', i === 1 ? 'w-20' : 'w-28')} />}
        </li>
      ))}
    </>
  );
}
