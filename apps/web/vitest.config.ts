import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'web',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
