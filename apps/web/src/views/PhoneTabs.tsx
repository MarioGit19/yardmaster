import type { ActivityEvent, Project } from '@yardmaster/protocol';
import { Check, ChevronRight, FolderOpen, FolderX, Settings } from 'lucide-react';
import { animate, motion, useMotionValue } from 'motion/react';
import { useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useNow } from '../anim/clock.js';
import {
  activityKey,
  selectApproval,
  selectConnection,
  selectProjects,
  selectSessionsByProject,
  selectTerminalsByProject,
  selectWindows,
  useBoard,
  useBoardList,
  useBoardStore,
  useLastActivity,
} from '../data/index.js';
import { LAYOUT_NAME, LAYOUTS, layoutPreference } from '../layouts/registry.js';
import { requestClose } from '../library/closing.js';
import { pickerOpen } from '../library/OpenProject.js';
import { useClosedProjects } from '../library/useActive.js';
import {
  MOTION_SETTINGS,
  type MotionSetting,
  motionPreference,
  spring,
  useMotionLevel,
} from '../motion.js';
import { countOf } from '../plural.js';
import { type Density, densityPreference, podForm, useQuietProjects } from '../pod/density.js';
import { CAPTION_COLOR } from '../pod/LiveCaption.js';
import { podSessions, sessionCaption } from '../pod/model.js';
import { PodCounts, PodWhen } from '../pod/PodLine.js';
import { usePreference } from '../prefs.js';
import {
  eventDetail,
  eventLabel,
  eventTone,
  formatAgo,
  matchesFilter,
  pulseTarget,
} from '../pulse/model.js';
import { FilterToggle } from '../pulse/PulseRail.js';
import { pulseFilterPreference } from '../pulse/prefs.js';
import { projectHref, routes } from '../routes.js';
import { connectionView } from '../shell/Hud.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { UsageList } from '../shell/UsageChip.js';
import { toneLabel } from '../status.js';
import { useProjectTone } from '../statusTokens.js';
import { terminalTarget } from '../terminal/target.js';
import { THEME_SETTINGS, type ThemeSetting, useTheme } from '../theme/theme.js';
import { cx } from '../ui/cx.js';
import { StatusDot } from '../ui/StatusDot.js';
import { EmptyState, Page, PageHeader } from './Page.js';
import { Segmented, SettingRow, SettingsSection } from './SettingsView.js';

/** Rows in the phone lists: a full-width tap target, at least 56 px tall. */
const ROW =
  'flex min-h-14 w-full min-w-0 items-center gap-3 px-4 py-2 text-left transition-colors duration-fast active:bg-bg-2 hover:bg-bg-2/60';

/** The Projects tab: the project rail as a list, with Open project at the top. */
export function ProjectsPage() {
  const all = useBoardList(selectProjects);
  const closed = useClosedProjects();
  const projects = useMemo(() => all.filter((p) => !closed.has(p.id)), [all, closed]);
  const ids = useMemo(() => projects.map((p) => p.id), [projects]);
  const quiet = useQuietProjects(ids);
  const density = usePreference(densityPreference);
  const hydrated = useBoard((s) => s.hydrated);
  return (
    <Page>
      <PageHeader
        title="Projects"
        meta={hydrated ? `${projects.length} on the board` : 'Loading…'}
      />
      <ul
        aria-label="Projects"
        data-phone-projects=""
        className="-mx-4 flex flex-col divide-y divide-line border-line border-y bg-bg-1"
      >
        <li>
          <button
            type="button"
            data-phone-open-project=""
            onClick={() => pickerOpen.set('open')}
            className={cx(ROW, 'text-text-1')}
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-bg-2 text-text-2">
              <FolderOpen aria-hidden className="size-5" strokeWidth={1.5} />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-body">Open project</span>
          </button>
        </li>
        {projects.map((project) => (
          <li key={project.id}>
            <ProjectRow project={project} density={density} quiet={quiet.has(project.id)} />
          </li>
        ))}
      </ul>
      {hydrated && projects.length === 0 && (
        <EmptyState title="No projects yet">
          Open a folder in your editor or start Claude Code in a project, and it shows up here.
        </EmptyState>
      )}
    </Page>
  );
}

/** How far a Projects row slides left to show its Close action. */
const REVEAL_PX = 88;
/** A flick this fast (px/s) opens or shuts the row whatever the distance. */
const FLICK_VELOCITY = 400;

/** A project in the list: tap to open it, swipe left for Close. */
function ProjectRow({
  project,
  density,
  quiet,
}: {
  project: Project;
  density: Density;
  quiet: boolean;
}) {
  const sessions = useBoardList(selectSessionsByProject(project.id));
  const terminals = useBoardList(selectTerminalsByProject(project.id));
  const tone = useProjectTone(sessions, terminals);
  const top = podSessions(sessions)[0];
  const approval = useBoard(
    selectApproval(top?.status.kind === 'waiting_permission' ? (top.status.approvalId ?? '') : ''),
  );
  const lead = top ? sessionCaption(top, approval) : null;
  const line = podForm(density, quiet) === 'row';
  const now = useNow(AGO_CLOCK_MS);
  const lastPulse = useLastActivity(activityKey.project(project.id));
  const lastActivity = Math.max(lastPulse ?? 0, project.lastActivityAt ?? 0) || null;
  const branch = project.git?.branch;
  const level = useMotionLevel();
  const x = useMotionValue(0);
  const [revealed, setRevealed] = useState(false);
  // A drag ends in a click on the link; that click only settles the row.
  const dragged = useRef(false);
  const snap = (open: boolean) => {
    setRevealed(open);
    animate(x, open ? -REVEAL_PX : 0, level === 'off' ? { duration: 0 } : spring.snappy);
  };
  return (
    <div className="relative overflow-hidden" data-phone-project-row={project.id}>
      <button
        type="button"
        data-phone-close={project.id}
        aria-label={`Close ${project.name}`}
        onFocus={() => snap(true)}
        onClick={() => {
          snap(false);
          requestClose(project.id);
        }}
        className="absolute inset-y-0 right-0 flex flex-col items-center justify-center gap-1 bg-bg-2 text-label text-text-1"
        style={{ width: REVEAL_PX }}
      >
        <FolderX aria-hidden className="size-5" strokeWidth={1.5} />
        Close
      </button>
      <motion.div
        style={{ x }}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: -REVEAL_PX, right: 0 }}
        dragElastic={0.08}
        dragMomentum={false}
        onDragStart={() => {
          dragged.current = true;
        }}
        onDragEnd={(_, info) => {
          const flick = Math.abs(info.velocity.x) > FLICK_VELOCITY;
          snap(flick ? info.velocity.x < 0 : x.get() < -REVEAL_PX / 2);
        }}
        className="relative bg-bg-1"
      >
        <Link
          href={projectHref(project.id)}
          data-phone-project={project.id}
          data-pod-form={line ? 'row' : 'card'}
          className={ROW}
          draggable={false}
          onClick={(event) => {
            if (!dragged.current && !revealed) return;
            event.preventDefault();
            if (!dragged.current) snap(false);
            dragged.current = false;
          }}
        >
          <ProjectAvatar project={project} size={line ? 'md' : 'lg'} />
          {line ? (
            <>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span
                  className="min-w-0 truncate font-medium text-body text-text-1"
                  title={project.name}
                >
                  {project.name}
                </span>
                {tone !== 'idle' && (
                  <StatusDot tone={tone} label={toneLabel(tone)} className="shrink-0" />
                )}
                {branch && (
                  <span
                    className="min-w-0 truncate font-mono text-label text-text-2 [flex-shrink:1000]"
                    title={branch}
                  >
                    {branch}
                  </span>
                )}
              </span>
              <PodWhen
                at={lastActivity}
                now={now}
                className="shrink-0 text-label text-text-2 tabular"
              />
              <PodCounts
                sessions={podSessions(sessions).length}
                terminals={terminals.filter((t) => t.state === 'open').length}
              />
            </>
          ) : (
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-medium text-body text-text-1" title={project.name}>
                {project.name}
              </span>
              <span className="flex min-w-0 items-center gap-2 text-label text-text-2">
                {tone !== 'idle' && (
                  <StatusDot tone={tone} label={toneLabel(tone)} showLabel className="shrink-0" />
                )}
                {branch && density !== 'compact' && (
                  <span className="min-w-0 truncate font-mono" title={branch}>
                    {tone !== 'idle' && '· '}
                    {branch}
                  </span>
                )}
              </span>
              {lead && (
                <span
                  dir="auto"
                  data-phone-lead
                  className={cx('truncate text-label', CAPTION_COLOR[lead.tone])}
                  title={lead.text}
                >
                  {lead.text}
                </span>
              )}
            </span>
          )}
          <ChevronRight aria-hidden className="size-4 shrink-0 text-text-3" strokeWidth={1.5} />
        </Link>
      </motion.div>
    </div>
  );
}

/** Rows rendered at most: the store keeps the last hour, which can be thousands on a busy board. */
const PULSE_ROWS = 200;
/** "12s ago" only needs to move every few seconds. */
const AGO_CLOCK_MS = 5_000;

/** The Pulse tab: the timeline as a vertical list, newest first; a tap opens where it happened. */
export function PulsePage() {
  const activity = useBoard((s) => s.activity);
  const filter = usePreference(pulseFilterPreference);
  const now = useNow(AGO_CLOCK_MS);
  const events = useMemo(() => {
    const rows: ActivityEvent[] = [];
    for (let i = activity.length - 1; i >= 0 && rows.length < PULSE_ROWS; i--) {
      const event = activity[i];
      if (event && matchesFilter(event, filter)) rows.push(event);
    }
    return rows;
  }, [activity, filter]);
  return (
    <Page>
      <PageHeader title="Pulse" meta="The last hour, newest first" />
      <div className="mb-3 flex">
        <FilterToggle />
      </div>
      {events.length === 0 ? (
        <EmptyState title="Nothing yet">
          {filter === 'all' ? 'Activity shows up here as it happens.' : 'No events of this kind.'}
        </EmptyState>
      ) : (
        <ol
          aria-label="Activity, newest first"
          data-phone-pulse=""
          className="-mx-4 flex flex-col divide-y divide-line border-line border-y bg-bg-1"
        >
          {events.map((event) => (
            <li key={event.id}>
              <PulseRow event={event} now={now} />
            </li>
          ))}
        </ol>
      )}
    </Page>
  );
}

function PulseRow({ event, now }: { event: ActivityEvent; now: number }) {
  const store = useBoardStore();
  const [, navigate] = useLocation();
  const project = useBoard((s) =>
    event.projectId ? s.board.projects[event.projectId] : undefined,
  );
  const tone = eventTone(event);
  const label = eventLabel(event);
  const detail = eventDetail(event);
  const open = () => {
    const target = pulseTarget(event, store.getState().board);
    if (!target) return;
    if (target.terminal) terminalTarget.set(target.terminal);
    navigate(target.href);
  };
  const body = (
    <>
      <StatusDot tone={tone} label={label} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-body-sm text-text-1">{label}</span>
          <span className="tabular shrink-0 text-label text-text-3">
            {formatAgo(now - event.ts)}
          </span>
        </span>
        <span className="min-w-0 truncate text-label text-text-2" title={detail ?? undefined}>
          {project?.name ?? 'No project'}
          {detail && ` · ${detail}`}
        </span>
      </span>
    </>
  );
  if (!project) {
    return (
      <div className={cx(ROW, 'hover:bg-transparent active:bg-transparent')} data-pulse-row="">
        {body}
      </div>
    );
  }
  return (
    <button type="button" onClick={open} className={ROW} data-pulse-row="">
      {body}
    </button>
  );
}

const THEME_LABEL: Record<ThemeSetting, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System',
};
const MOTION_LABEL: Record<MotionSetting, string> = {
  system: 'System',
  full: 'Full',
  reduced: 'Reduced',
  off: 'Off',
};

/** The More tab: what left the top bar (layout, theme, motion, editor status) and Settings. */
export function MorePage() {
  const layout = usePreference(layoutPreference);
  const { setting: theme, setTheme } = useTheme();
  const motion = usePreference(motionPreference);
  return (
    <Page width="narrow">
      <PageHeader title="More" />
      <div className="flex flex-col gap-8">
        <section aria-labelledby="more-layout" className="flex flex-col gap-3">
          <h2 id="more-layout" className="px-1 font-medium text-body-sm text-text-2">
            Layout
          </h2>
          <div
            role="radiogroup"
            aria-labelledby="more-layout"
            data-more="layout"
            className="flex flex-col divide-y divide-line rounded-panel border border-line bg-bg-1 shadow-raised"
          >
            {LAYOUTS.map((id) => (
              // biome-ignore lint/a11y/useSemanticElements: a list of choices, styled as rows
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={id === layout}
                data-layout-choice={id}
                onClick={() => layoutPreference.set(id)}
                className={cx(ROW, 'min-h-12 first:rounded-t-panel last:rounded-b-panel')}
              >
                <span className="min-w-0 flex-1 truncate text-body text-text-1">
                  {LAYOUT_NAME[id]}
                </span>
                {id === layout && (
                  <Check aria-hidden className="size-4 shrink-0 text-text-1" strokeWidth={2} />
                )}
              </button>
            ))}
          </div>
        </section>
        <UsageList />
        <SettingsSection title="Appearance">
          <SettingRow title="Theme" data="theme" description="Follows the system unless set here.">
            <Segmented
              label="Theme"
              options={THEME_SETTINGS}
              labels={THEME_LABEL}
              value={theme}
              onChange={setTheme}
            />
          </SettingRow>
          <SettingRow
            title="Motion"
            data="motion"
            description="Reduced only fades; Off holds still."
          >
            <Segmented
              label="Motion"
              options={MOTION_SETTINGS}
              labels={MOTION_LABEL}
              value={motion}
              onChange={(value) => motionPreference.set(value)}
            />
          </SettingRow>
        </SettingsSection>
        <SettingsSection title="Status">
          <EditorStatus />
        </SettingsSection>
        <div className="flex flex-col divide-y divide-line overflow-hidden rounded-panel border border-line bg-bg-1 shadow-raised">
          <Link href={routes.settings} data-more="settings" className={ROW}>
            <Settings aria-hidden className="size-5 shrink-0 text-text-2" strokeWidth={1.5} />
            <span className="min-w-0 flex-1 truncate text-body text-text-1">Settings</span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-text-3" strokeWidth={1.5} />
          </Link>
        </div>
      </div>
    </Page>
  );
}

/** The board's connection and the editor windows streaming to it. */
function EditorStatus() {
  const connection = connectionView(useBoard(selectConnection));
  const windows = useBoardList(selectWindows);
  const editors =
    windows.length === 0
      ? 'No editor connected'
      : `${countOf(windows.length, 'editor window')} connected`;
  return (
    <div className="flex flex-col gap-2 p-5" data-more="status">
      <StatusDot
        tone={connection.tone}
        label={`Board: ${connection.label}`}
        showLabel
        className="text-body-sm text-text-1"
      />
      <StatusDot
        tone={windows.length > 0 ? 'ok' : 'idle'}
        label={editors}
        showLabel
        className="text-body-sm text-text-1"
      />
    </div>
  );
}
