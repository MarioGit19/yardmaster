import type { FolderTrustReview } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { folderName, groupFindings, requestTrust, trustRequests } from './trust.js';

const review = (path: string): FolderTrustReview => ({
  path,
  hash: 'b'.repeat(64),
  findings: [
    { file: '.claude/settings.json', kind: 'env', label: 'NODE_OPTIONS', detail: null },
    { file: '.mcp.json', kind: 'mcp', label: 'tracker', detail: 'npx tracker-mcp' },
    { file: '.claude/settings.json', kind: 'hook', label: 'SessionStart hook', detail: './a.sh' },
  ],
  truncated: false,
});

describe('trust requests', () => {
  it('shows one review at a time, in order, and answers each', async () => {
    const first = requestTrust(review('/home/dev/one'));
    const second = requestTrust(review('/home/dev/two'));
    expect(trustRequests.get()?.review.path).toBe('/home/dev/one');
    trustRequests.get()?.answer(true);
    await expect(first).resolves.toBe(true);
    expect(trustRequests.get()?.review.path).toBe('/home/dev/two');
    trustRequests.get()?.answer(false);
    await expect(second).resolves.toBe(false);
    expect(trustRequests.get()).toBeNull();
  });

  it('groups findings with what runs at once first', () => {
    expect(groupFindings(review('/home/dev/one').findings).map((g) => g.kind)).toEqual([
      'hook',
      'mcp',
      'env',
    ]);
    expect(folderName('/home/dev/cloned-tool/')).toBe('cloned-tool');
  });
});
