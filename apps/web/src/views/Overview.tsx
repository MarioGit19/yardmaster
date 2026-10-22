import { selectHydrated, selectProjects, useBoard, useBoardList } from '../data/index.js';
import { PodGrid, PodGridSkeleton } from '../pod/PodGrid.js';
import { EmptyState, Page, PageHeader } from './Page.js';

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
        <PodGridSkeleton />
      ) : projects.length === 0 ? (
        <EmptyState title="No projects yet">
          Open a folder in your editor or start Claude Code in a project, and it shows up here.
        </EmptyState>
      ) : (
        <PodGrid />
      )}
    </Page>
  );
}
