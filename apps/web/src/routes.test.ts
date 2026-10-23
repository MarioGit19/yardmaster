import { describe, expect, it } from 'vitest';
import { inProject, projectHref, sessionHref } from './routes.js';

describe('inProject', () => {
  it("matches the project's focus view and its sessions only", () => {
    expect(inProject(projectHref('p-acme'), 'p-acme')).toBe(true);
    expect(inProject(sessionHref('p-acme', 's-1'), 'p-acme')).toBe(true);
    expect(inProject('/p/p-acme-two', 'p-acme')).toBe(false);
    expect(inProject('/', 'p-acme')).toBe(false);
  });
});
