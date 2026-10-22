import type { Project } from '@c-board/protocol';
import { LayoutGrid, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react';
import { forwardRef, type KeyboardEvent, type ReactNode, useRef } from 'react';
import { Link, useRoute } from 'wouter';
import {
  selectProjects,
  selectSessionsByProject,
  selectTerminalsByProject,
  useBoard,
  useBoardList,
} from '../data/index.js';
import { projectHref, routes } from '../routes.js';
import { projectTone, toneLabel } from '../status.js';
import { cx } from '../ui/cx.js';
import { IconButton } from '../ui/IconButton.js';
import { Skeleton } from '../ui/Skeleton.js';
import { StatusDot } from '../ui/StatusDot.js';
import { Tooltip } from '../ui/Tooltip.js';
import { ProjectAvatar } from './ProjectAvatar.js';
import { railKeyTarget } from './railNav.js';

export interface ProjectRailProps {
  collapsed: boolean;
  /** Absent when the rail can't expand (narrow screens). */
  onToggle?: () => void;
}

export function ProjectRail({ collapsed, onToggle }: ProjectRailProps) {
  const projects = useBoardList(selectProjects);
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
        collapsed ? 'w-14' : 'w-60',
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
        <li aria-hidden className="mx-2 my-1.5 h-px bg-line" />
        {!hydrated && projects.length === 0 && <RailSkeleton collapsed={collapsed} />}
        {hydrated && projects.length === 0 && !collapsed && (
          <li className="px-2 py-1.5 text-meta text-text-3">No projects yet</li>
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

const BADGE = {
  work: 'bg-st-work',
  tool: 'bg-st-tool',
  wait: 'bg-st-wait',
  ok: 'bg-st-ok',
  err: 'bg-st-err',
} as const;

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
        'relative flex h-9 items-center gap-2.5 rounded-control px-2 text-body-sm outline-none',
        'transition-colors duration-150 ease-out',
        collapsed && 'justify-center px-0',
        active
          ? 'bg-bg-2 text-text-1 shadow-raised'
          : 'text-text-2 hover:bg-bg-2/60 hover:text-text-1',
      )}
    >
      <span className="relative flex shrink-0 text-text-2">
        {icon}
        {badge && (
          <span
            aria-hidden
            className={cx(
              'absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-bg-1',
              BADGE[badge],
            )}
          />
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
        <li key={i} aria-hidden className="flex h-9 items-center gap-2.5 px-2">
          <Skeleton className="size-6 rounded-full" />
          {!collapsed && <Skeleton className={cx('h-3', i === 1 ? 'w-20' : 'w-28')} />}
        </li>
      ))}
    </>
  );
}
