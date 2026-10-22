import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'hook',
    include: ['src/**/*.test.ts'],
  },
});
