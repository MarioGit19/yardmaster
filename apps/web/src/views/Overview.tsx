import { selectHydrated, selectProjectCount, useBoard } from '../data/index.js';
import { LayoutStage } from '../layouts/LayoutStage.js';
import { useActiveProjects, useClosedProjects } from '../library/useActive.js';
import { OnboardingWizard } from '../onboarding/OnboardingWizard.js';
import { useOnboarding } from '../onboarding/useOnboarding.js';
import { PodGridSkeleton } from '../pod/PodGrid.js';
import { EmptyState, Page, PageHeader } from './Page.js';

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

export function Overview() {
  const hydrated = useBoard(selectHydrated);
  const total = useBoard(selectProjectCount);
  const count = useActiveProjects().size;
  const closed = useClosedProjects().size;
  const hidden = Math.max(0, total - count - closed);
  const meta = [
    plural(count, 'project'),
    ...(hidden > 0 ? [`${hidden} quiet, hidden`] : []),
    ...(closed > 0 ? [`${closed} closed`] : []),
  ].join(' · ');
  const onboarding = useOnboarding();

  if (onboarding.show) {
    return (
      <Page width="narrow">
        <OnboardingWizard onDone={onboarding.dismiss} />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader title="Overview" meta={hydrated ? meta : 'Loading…'} />
      {!hydrated || onboarding.show === null ? (
        <PodGridSkeleton />
      ) : total === 0 ? (
        <EmptyState title="No projects yet">
          Open a folder in your editor or start Claude Code in a project, and it shows up here.
        </EmptyState>
      ) : count === 0 && hidden === 0 ? (
        <EmptyState title="Nothing open">
          Every project here is closed. Open one with ⌘O or ⌘K, or start something in one, and it
          comes back.
        </EmptyState>
      ) : count === 0 ? (
        <EmptyState title="All quiet">
          {plural(hidden, 'project')} had no activity for a while, so the overview hides{' '}
          {hidden === 1 ? 'it' : 'them'}. Find {hidden === 1 ? 'it' : 'one'} with ⌘K, or pin a
          project from its menu to keep it here.
        </EmptyState>
      ) : (
        <LayoutStage />
      )}
    </Page>
  );
}
