import { BOARD_WINDOW_ID, NOTIFY_LONG_RUN_MS } from '@yardmaster/protocol';
import type { BoardStore } from '../store.js';

const DRILL_PROJECTS = [
  'drill-needs',
  'drill-finished',
  'drill-command',
  'drill-crash',
  'drill-background',
];

/**
 * `POST /api/push/drill` (demo only): plays one of each push event through the store, each in its
 * own throwaway project so coalescing keeps them apart, then removes everything it made. The
 * notifier sees the real patches; the board's clients get the adds and removes in one batch.
 */
export function runPushDrill(store: BoardStore, now = Date.now()): void {
  const step = (mutate: () => void) => {
    mutate();
    store.flush();
  };
  const longAgo = now - NOTIFY_LONG_RUN_MS - 12_000;
  const [needs, finished, command, crash, background] = DRILL_PROJECTS.map((name, i) => {
    const id = `${name}-${now}`;
    step(() =>
      store.upsertProject({
        id,
        path: `/home/dev/${name}`,
        name,
        accent: i,
        source: 'manual',
        git: null,
        createdAt: now,
        lastActivityAt: now,
      }),
    );
    return id;
  }) as [string, string, string, string, string];

  step(() =>
    store.upsertSession({ id: `${needs}-s`, projectId: needs, status: { kind: 'working' } }),
  );
  step(() =>
    store.upsertApproval({
      id: `${needs}-a`,
      sessionId: `${needs}-s`,
      source: 'sdk',
      tool: 'Bash',
      input: { command: 'pnpm deploy --prod' },
      toolUseId: null,
      createdAt: now,
      expiresAt: null,
      state: 'pending',
      decidedAt: null,
      reason: null,
    }),
  );

  step(() =>
    store.upsertSession({
      id: `${finished}-s`,
      projectId: finished,
      status: { kind: 'working' },
      startedAt: longAgo,
      updatedAt: longAgo,
    }),
  );
  step(() => {
    store.updateSession(`${finished}-s`, {
      lastAssistantText: 'All 214 tests pass. The cart total now rounds per line.',
    });
    store.setSessionStatus(`${finished}-s`, { kind: 'idle' });
  });

  for (const [projectId, line, exitCode] of [
    [command, 'pnpm test', 0],
    [crash, 'pnpm dev', 139],
  ] as const) {
    const terminalId = `${projectId}-t`;
    step(() =>
      store.upsertTerminal({ id: terminalId, windowId: BOARD_WINDOW_ID, name: 'zsh', projectId }),
    );
    step(() =>
      store.startExec({
        execId: `${projectId}-e`,
        terminalId,
        commandLine: line,
        confidence: 'high',
        cwd: null,
        startedAt: longAgo,
        header: false,
      }),
    );
    step(() => store.endExec(`${projectId}-e`, exitCode));
  }

  const agent = {
    id: `${background}-agent`,
    type: 'Explore',
    description: 'Map the checkout flow',
    status: 'running' as const,
    startedAt: longAgo,
    endedAt: null,
  };
  step(() =>
    store.upsertSession({
      id: `${background}-s`,
      projectId: background,
      status: { kind: 'working' },
      subagents: [agent],
    }),
  );
  step(() =>
    store.updateSession(`${background}-s`, {
      subagents: [{ ...agent, status: 'done', endedAt: now }],
    }),
  );

  step(() => {
    for (const id of [needs, finished, background]) store.removeSession(`${id}-s`);
    for (const id of [command, crash]) store.removeTerminal(`${id}-t`);
    for (const id of [needs, finished, command, crash, background]) store.removeProject(id);
  });
}
