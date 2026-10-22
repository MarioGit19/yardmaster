import { readFileSync } from 'node:fs';

// Synthetic hook payloads shared with the protocol package.
const FIXTURES = new URL('../../../../packages/protocol/fixtures/hooks/', import.meta.url);

export type HookFixture =
  | 'notification-idle'
  | 'notification-permission'
  | 'permission-request'
  | 'post-compact'
  | 'post-tool-use-failure'
  | 'post-tool-use'
  | 'pre-compact'
  | 'pre-tool-use-bash'
  | 'pre-tool-use-edit'
  | 'session-end'
  | 'session-start'
  | 'stop-failure'
  | 'stop'
  | 'subagent-start'
  | 'subagent-stop'
  | 'unknown-event'
  | 'user-prompt-submit';

export function hookFixture(name: HookFixture, overrides: Record<string, unknown> = {}) {
  const raw = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8')) as Record<
    string,
    unknown
  >;
  return { ...raw, ...overrides };
}

export const FIXTURE_SESSION_ID = '3f6c1a2e-8b7d-4c5e-9a10-2b3c4d5e6f70';
export const FIXTURE_CWD = '/home/dev/acme-shop';
