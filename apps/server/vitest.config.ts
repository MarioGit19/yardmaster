import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    include: ['src/**/*.test.ts'],
    // Servers built in tests must never read the real ~/.claude (registry, transcripts) or ask
    // the real Claude Code what's running.
    env: {
      CLAUDE_CONFIG_DIR: join(tmpdir(), 'yardmaster-test-no-claude'),
      YARDMASTER_CLAUDE_BIN: join(tmpdir(), 'yardmaster-test-no-claude', 'claude'),
    },
  },
});
