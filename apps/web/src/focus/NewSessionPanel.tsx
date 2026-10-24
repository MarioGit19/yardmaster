import type { Project } from '@yardmaster/protocol';
import { NewSessionComposer } from '../claude/Composer.js';
import { OriginBadge } from '../claude/OriginBadge.js';
import { EmptyState } from '../views/Page.js';

/** A blank composer that starts a board session in the project, until the session exists. */
export function NewSessionPanel({
  project,
  missing = false,
  header = true,
}: {
  project: Project;
  /** The route named a session the board doesn't have. */
  missing?: boolean;
  /** Off on the phone's page, whose own header says what it is. */
  header?: boolean;
}) {
  return (
    <div className="claude-panel flex h-full min-h-0 flex-col" data-new-session-panel>
      {header && (
        <header className="flex min-w-0 shrink-0 items-center gap-3 border-line border-b px-5 pt-5 pb-3">
          <h2 className="min-w-0 flex-1 truncate font-medium text-body text-text-1 leading-7">
            New session
          </h2>
          <OriginBadge origin="board" />
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-5">
        <EmptyState title={missing ? 'This session is no longer available' : 'Start a session'}>
          Claude runs headless from the board in {project.name}, with your own Claude Code login.
          Pick a model and how much it may do without asking.
        </EmptyState>
      </div>
      <NewSessionComposer projectId={project.id} />
    </div>
  );
}
