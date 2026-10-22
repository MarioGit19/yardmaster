import { selectHydrated, selectProjects, useBoard, useBoardList } from '../data/index.js';
import { EmptyState, Page, PageHeader } from './Page.js';
import { ProjectCard, ProjectCardSkeleton } from './ProjectCard.js';

const GRID = 'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 min-[1800px]:grid-cols-4';

export function Overview() {
  const hydrated = useBoard(selectHydrated);
  const projects = useBoardList(selectProjects);

  return (
    <Page>
      <PageHeader
        title="Overview"
        meta={
          hydrated
            ? `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`
            : 'Loading…'
        }
      />
      {!hydrated ? (
        <div className={GRID} aria-busy>
          {[0, 1, 2].map((i) => (
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState title="No projects yet">
          Open a folder in your editor or start Claude Code in a project, and it shows up here.
        </EmptyState>
      ) : (
        <div className={GRID}>
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </Page>
  );
}
