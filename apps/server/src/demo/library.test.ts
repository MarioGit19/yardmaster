import { describe, expect, it } from 'vitest';
import { scanFolder } from '../claude/folder-trust.js';
import {
  DEMO_LIBRARY_ROOT,
  DEMO_UNTRUSTED_FOLDER,
  demoFolderHasGit,
  demoLibrary,
  readDemoTrustFile,
} from './library.js';

const project = (name: string) => ({
  id: `id-${name}`,
  path: `/home/dev/${name}`,
  name,
  accent: 0,
  source: 'manual' as const,
  git: null,
  createdAt: 1,
  lastActivityAt: 2,
});

describe('demoLibrary', () => {
  it('lists a folder opened from the board once, as its project', async () => {
    const listed = await demoLibrary().list([DEMO_LIBRARY_ROOT], [project('garden-planner')]);
    const garden = listed.entries.filter((e) => e.name === 'garden-planner');
    expect(garden).toEqual([expect.objectContaining({ projectId: 'id-garden-planner' })]);
    expect(listed.entries.filter((e) => e.projectId === null)).toHaveLength(4);
  });

  it('resolves only its own folders, and only with a root', async () => {
    const library = demoLibrary();
    expect(await library.resolve([DEMO_LIBRARY_ROOT], '/home/dev/recipe-box')).toBe(
      '/home/dev/recipe-box',
    );
    expect(await library.resolve([DEMO_LIBRARY_ROOT], '/home/dev/acme-shop')).toBe(
      '/home/dev/acme-shop',
    );
    expect(await library.resolve([DEMO_LIBRARY_ROOT], '/home/dev/../etc')).toBeNull();
    expect(await library.resolve([DEMO_LIBRARY_ROOT], '/etc')).toBeNull();
    expect(await library.resolve([], '/home/dev/recipe-box')).toBeNull();
  });

  it('knows which folders are repositories', () => {
    expect(demoFolderHasGit('/home/dev/tax-notes')).toBe(false);
    expect(demoFolderHasGit('/home/dev/weather-bot')).toBe(true);
  });

  it('has one cloned folder whose Claude settings need trusting, read from memory', async () => {
    const scan = await scanFolder(DEMO_UNTRUSTED_FOLDER, readDemoTrustFile);
    expect(scan.findings.map((f) => f.kind)).toEqual([
      'hook',
      'allow',
      'allow',
      'mode',
      'env',
      'mcp',
    ]);
    expect((await scanFolder('/home/dev/recipe-box', readDemoTrustFile)).findings).toEqual([]);
  });
});
