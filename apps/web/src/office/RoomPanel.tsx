import { ArrowLeft, SquareArrowOutUpRight } from 'lucide-react';
import { motion, useDragControls } from 'motion/react';
import { useState } from 'react';
import { Link } from 'wouter';
import { ActorInspector } from '../layouts/ActorInspector.js';
import { actorKindName, type SceneProject } from '../layouts/scene.js';
import { dur, ease, spring } from '../motion.js';
import { LiveCaption } from '../pod/LiveCaption.js';
import { projectHref } from '../routes.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { toneLabel } from '../status.js';
import { buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { StatusDot } from '../ui/StatusDot.js';
import { Tooltip } from '../ui/Tooltip.js';
import type { Box } from './zoom.js';

/** A pull this far (px) or this fast (px/s) folds the sheet down to its header. */
const PULL_PX = 60;
const PULL_VELOCITY = 500;
/** What stays of a folded sheet: its handle and header. */
const PEEK_PX = 148;

export interface RoomPanelProps {
  project: SceneProject;
  /** Where it sits, in the Office stage's coordinates (office/zoom.ts). */
  box: Box;
  /** A phone: the list is a bottom sheet under the room. */
  sheet: boolean;
  onBack(): void;
}

/**
 * The room view's panel (DESIGN.md §10.3): every actor in the room with its state and live
 * caption, each opening the Actor inspector, and "Open workspace" into the focus view. Beside the
 * zoomed room on desktop; on a phone a bottom sheet that folds down to its header when pulled.
 */
export function RoomPanel({ project, box, sheet, onBack }: RoomPanelProps) {
  const drag = useDragControls();
  const [folded, setFolded] = useState(false);
  const fold = sheet && folded;
  const count = project.actors.length;

  return (
    <motion.aside
      aria-label={`${project.name} room`}
      data-office-room-panel={project.id}
      data-sheet={sheet || undefined}
      data-folded={fold || undefined}
      className={cx(
        'palette absolute z-20 flex min-h-0 flex-col border-line-strong shadow-raised',
        sheet ? 'rounded-t-modal border border-b-0' : 'rounded-modal border',
      )}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      initial={{ opacity: 0, ...(sheet ? { y: 24 } : { x: 16 }) }}
      animate={{
        opacity: 1,
        x: 0,
        y: fold ? Math.max(0, box.h - PEEK_PX) : 0,
        transition: { default: spring.smooth, opacity: { duration: dur.base, ease: ease.out } },
      }}
      exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
      {...(sheet && {
        drag: 'y' as const,
        dragListener: false,
        dragControls: drag,
        dragConstraints: { top: 0, bottom: 0 },
        dragElastic: { top: 0.1, bottom: 0.7 },
        onDragEnd: (_: unknown, info: { offset: { y: number }; velocity: { y: number } }) => {
          const down = info.offset.y > PULL_PX || info.velocity.y > PULL_VELOCITY;
          const up = info.offset.y < -PULL_PX || info.velocity.y < -PULL_VELOCITY;
          if (down) setFolded(true);
          else if (up) setFolded(false);
        },
      })}
    >
      {sheet && (
        <button
          type="button"
          aria-label={fold ? 'Show everyone in the room' : 'Fold the list down'}
          aria-expanded={!fold}
          onPointerDown={(e) => drag.start(e)}
          onClick={() => setFolded((f) => !f)}
          className="-mb-5 flex h-11 w-full shrink-0 cursor-grab touch-none select-none items-start justify-center pt-2.5 active:cursor-grabbing"
        >
          <span aria-hidden className="h-1 w-10 rounded-full bg-line-strong" />
        </button>
      )}
      <header
        className={cx(
          'flex min-w-0 shrink-0 flex-col gap-3 border-line border-b px-4 pb-3',
          !sheet && 'pt-4',
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Tooltip content="Back to the building" shortcut="Esc">
            <button
              type="button"
              aria-label="Back to the building"
              aria-keyshortcuts="Escape"
              data-room-back
              onClick={onBack}
              className={cx(buttonClass('ghost', 'sm', { square: true }), 'size-11 md:size-8')}
            >
              <ArrowLeft aria-hidden className="size-4" strokeWidth={1.5} />
            </button>
          </Tooltip>
          <ProjectAvatar project={project} size="sm" />
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="truncate font-medium text-text-1 text-title-sm" title={project.name}>
              {project.name}
            </h2>
            <StatusDot
              tone={project.tone}
              label={toneLabel(project.tone)}
              showLabel
              className="text-label text-text-2"
            />
          </div>
        </div>
        <Link
          href={projectHref(project.id)}
          data-focus-return={project.id}
          data-room-open
          className={cx(buttonClass('primary', 'sm'), 'w-full touch:min-h-11')}
        >
          <SquareArrowOutUpRight aria-hidden className="size-3.5" strokeWidth={1.75} />
          Open workspace
        </Link>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2" inert={fold || undefined}>
        <p className="px-2 pt-1 pb-2 text-meta text-text-3 tabular">
          {count === 0 ? 'Nobody is here right now.' : count === 1 ? '1 here' : `${count} here`}
        </p>
        <ul aria-label={`In ${project.name}`} className="flex flex-col gap-0.5">
          {project.actors.map((actor) => (
            <li key={actor.id}>
              <ActorInspector
                projectId={project.id}
                actorId={actor.id}
                label={`${project.name}, ${actor.label}`}
                trigger={
                  <button
                    type="button"
                    aria-label={actor.name}
                    data-room-actor={actor.id}
                    data-room-actor-kind={actor.kind}
                    data-actor-state={actor.state}
                    className="flex min-h-11 w-full min-w-0 items-start gap-2.5 rounded-control px-2 py-2 text-left outline-none transition-colors duration-fast hover:bg-bg-2 focus-visible:ring-2 focus-visible:ring-line-strong"
                  >
                    <StatusDot tone={actor.tone} label={actor.label} className="mt-1.5" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate font-medium text-body-sm text-text-1">
                          {actor.label}
                        </span>
                        <span className="shrink-0 text-meta text-text-3">
                          {actorKindName(actor.kind)}
                        </span>
                      </span>
                      <LiveCaption caption={actor.caption} className="text-meta" />
                    </span>
                  </button>
                }
              />
            </li>
          ))}
        </ul>
      </div>
    </motion.aside>
  );
}
