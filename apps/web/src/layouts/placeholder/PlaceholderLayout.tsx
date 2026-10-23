import { toneLabel } from '../../status.js';
import { StatusDot } from '../../ui/StatusDot.js';
import { ActorInspector } from '../ActorInspector.js';
import { LAYOUT_NAME, type LayoutId } from '../registry.js';
import { actorKindName, actorStateLabel, type SceneActor, type SceneProject } from '../scene.js';
import { useSceneModel } from '../useScene.js';

const PITCH: Record<Exclude<LayoutId, 'minimal'>, string> = {
  office: 'Each project becomes a room in a cut-away building, with your crew at their stations.',
  grid: 'Projects become nodes in a neon network, fed by pipelines carrying data packets.',
  transit: 'Each project becomes a metro line, and every session and terminal a train on it.',
  retro: 'The whole board as a green-phosphor text console, in box drawing.',
};

/**
 * A layout that isn't drawn yet: what it will be, and the scene it will draw, so switching works
 * end to end and every actor already opens the inspector.
 */
export function PlaceholderLayout({ layout }: { layout: Exclude<LayoutId, 'minimal'> }) {
  const scene = useSceneModel();
  return (
    <div data-layout-placeholder={layout} className="flex flex-col gap-4">
      <div className="rounded-panel border border-line border-dashed px-4 py-3">
        <p className="font-medium text-body-sm text-text-1">{LAYOUT_NAME[layout]} is coming soon</p>
        <p className="text-body-sm text-text-2">
          {PITCH[layout]} Until then, here is what it will show.
        </p>
      </div>
      <div className="@container">
        <ul
          aria-label="Projects"
          className="grid grid-cols-1 gap-4 @min-[40rem]:grid-cols-2 @min-[66rem]:grid-cols-3 @min-[96rem]:grid-cols-4"
        >
          {scene.projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function ProjectCard({ project }: { project: SceneProject }) {
  return (
    <li
      data-scene-project={project.id}
      style={{ '--accent': `var(--accent-${project.accent})` } as React.CSSProperties}
      className="flex min-w-0 flex-col gap-2 rounded-panel border border-line bg-bg-1 p-4 shadow-raised"
    >
      <h2 className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-(--accent)" />
        <span className="truncate font-medium text-text-1 text-title-sm">{project.name}</span>
        <StatusDot tone={project.tone} label={toneLabel(project.tone)} className="ml-auto" />
      </h2>
      {project.actors.length === 0 ? (
        <p className="text-body-sm text-text-2">Nothing running</p>
      ) : (
        <ul aria-label={`${project.name} actors`} className="-mx-2 flex flex-col">
          {project.actors.map((actor) => (
            <li key={actor.id} className={actor.parentId ? 'pl-5' : undefined}>
              <ActorRow actor={actor} projectName={project.name} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function ActorRow({ actor, projectName }: { actor: SceneActor; projectName: string }) {
  return (
    <ActorInspector
      projectId={actor.projectId}
      actorId={actor.id}
      label={`${projectName}, ${actor.label}`}
      trigger={
        <button
          type="button"
          aria-label={actor.name}
          data-scene-actor={actor.id}
          data-actor-state={actor.state}
          className="flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-control px-2 py-1.5 text-left transition-colors duration-fast hover:bg-bg-2 data-[state=open]:bg-bg-2"
        >
          <StatusDot tone={actor.tone} label={actorStateLabel(actor)} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-body-sm text-text-1">{actor.label}</span>
              <span className="shrink-0 text-meta text-text-3">{actorKindName(actor.kind)}</span>
            </span>
            <span className="truncate text-meta text-text-2">{actor.caption.text}</span>
          </span>
        </button>
      }
    />
  );
}
