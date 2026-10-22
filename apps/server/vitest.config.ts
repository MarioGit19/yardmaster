import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    include: ['src/**/*.test.ts'],
    // Servers built in tests must never read the real ~/.claude (registry, transcripts).
    env: { CLAUDE_CONFIG_DIR: join(tmpdir(), 'c-board-test-no-claude') },
  },
});
