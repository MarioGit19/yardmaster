import type { FolderTrustReview, TrustFinding, TrustFindingKind } from '@yardmaster/protocol';

// Folder trust (14.4): a board session's folder whose Claude settings can run code waits for the
// user's yes. The client's trust gate queues the reviews here and the trust card answers them.

export interface TrustRequest {
  review: FolderTrustReview;
  answer: (trusted: boolean) => void;
}

const listeners = new Set<() => void>();
const queue: TrustRequest[] = [];

const emit = () => {
  for (const listener of listeners) listener();
};

export const trustRequests = {
  /** The review the card shows; the rest wait their turn. */
  get: (): TrustRequest | null => queue[0] ?? null,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** The client's trust gate: resolves once the user trusts the folder (`true`) or cancels. */
export function requestTrust(review: FolderTrustReview): Promise<boolean> {
  return new Promise((resolve) => {
    const request: TrustRequest = {
      review,
      answer: (trusted) => {
        const index = queue.indexOf(request);
        if (index === -1) return;
        queue.splice(index, 1);
        resolve(trusted);
        emit();
      },
    };
    queue.push(request);
    emit();
  });
}

export interface FindingGroup {
  kind: TrustFindingKind;
  title: string;
  note: string | null;
  findings: TrustFinding[];
}

/** In the order a reader should weigh them: what runs at once first. */
const GROUPS: readonly { kind: TrustFindingKind; title: string; note: string | null }[] = [
  {
    kind: 'hook',
    title: 'Hooks',
    note: 'Run commands on Claude Code events. A SessionStart hook runs as the session starts.',
  },
  { kind: 'mcp', title: 'MCP servers', note: 'Started or connected when the session starts.' },
  { kind: 'command', title: 'Commands', note: 'Settings Claude Code runs as commands.' },
  { kind: 'plugin', title: 'Plugins', note: 'Plugins can bring their own hooks and MCP servers.' },
  { kind: 'allow', title: 'Allowed without asking', note: null },
  { kind: 'mode', title: 'Permission mode', note: 'Asks less than the default.' },
  { kind: 'directory', title: 'Extra directories', note: 'Outside this folder.' },
  { kind: 'env', title: 'Environment', note: 'Set for every session. Values are not shown.' },
  {
    kind: 'unreadable',
    title: 'Could not check',
    note: 'Yardmaster could not read these, so it cannot say what they do.',
  },
];

export function groupFindings(findings: readonly TrustFinding[]): FindingGroup[] {
  return GROUPS.flatMap((group) => {
    const matching = findings.filter((f) => f.kind === group.kind);
    return matching.length > 0 ? [{ ...group, findings: matching }] : [];
  });
}

/** The folder's own name, for the title. */
export function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
