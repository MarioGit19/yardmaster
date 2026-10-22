import { selectHydrated, selectProjectCount, useBoard } from '../data/index.js';
import { OnboardingWizard } from '../onboarding/OnboardingWizard.js';
import { useOnboarding } from '../onboarding/useOnboarding.js';
import { PodGrid, PodGridSkeleton } from '../pod/PodGrid.js';
import { EmptyState, Page, PageHeader } from './Page.js';

export function Overview() {
  const hydrated = useBoard(selectHydrated);
  const count = useBoard(selectProjectCount);
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
      <PageHeader
        title="Overview"
        meta={hydrated ? `${count} ${count === 1 ? 'project' : 'projects'}` : 'Loading…'}
      />
      {!hydrated || onboarding.show === null ? (
        <PodGridSkeleton />
      ) : count === 0 ? (
        <EmptyState title="No projects yet">
          Open a folder in your editor or start Claude Code in a project, and it shows up here.
        </EmptyState>
      ) : (
        <PodGrid />
      )}
    </Page>
  );
}
