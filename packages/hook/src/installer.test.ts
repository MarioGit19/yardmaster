import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyPlan,
  claudeSettingsPath,
  HOOK_TIMEOUT_S,
  hookCommand,
  hookStatus,
  InvalidSettingsError,
  OBSERVER_EVENTS,
  planInstall,
  planUninstall,
  readSettings,
  unifiedDiff,
} from './installer.js';

const COMMAND = '/home/dev/tools/c-board/packages/hook/bin/c-board-hook';
const NOW = new Date('2026-03-04T05:06:07.890Z');

const THIRD_PARTY = {
  model: 'sonnet',
  permissions: { allow: ['Bash(pnpm test:*)'] },
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: '/home/dev/bin/audit-bash.sh', timeout: 10 }],
      },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    PermissionRequest: [{ hooks: [{ type: 'command', command: '/home/dev/bin/approve.sh' }] }],
  },
  statusLine: { type: 'command', command: '/home/dev/bin/status.sh' },
};

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c-board-installer-'));
  path = join(dir, '.claude', 'settings.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function install(): Promise<string | undefined> {
  return applyPlan(path, planInstall(await readSettings(path), COMMAND), NOW);
}

async function uninstall(): Promise<string | undefined> {
  return applyPlan(path, planUninstall(await readSettings(path)), NOW);
}

async function settings(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function backups(): Promise<string[]> {
  return (await readdir(join(dir, '.claude'))).filter((name) => name.includes('backup')).sort();
}

const ours = {
  hooks: [{ type: 'command', command: COMMAND, async: true, timeout: HOOK_TIMEOUT_S }],
};

describe('hook installer', () => {
  it('installs into a missing file, creating the directory, without a backup', async () => {
    expect(await install()).toBeUndefined();
    const result = await settings();
    expect(Object.keys(result)).toEqual(['hooks']);
    const hooks = result.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks)).toEqual([...OBSERVER_EVENTS]);
    expect(hooks.PermissionRequest).toBeUndefined();
    for (const event of OBSERVER_EVENTS) expect(hooks[event]).toEqual([ours]);
    expect(await backups()).toEqual([]);
    expect(hookStatus(await readSettings(path), COMMAND)).toEqual({
      installed: [...OBSERVER_EVENTS],
      missing: [],
      outdated: [],
    });
  });

  it('adds to existing third-party hooks and keeps every other key, with a backup', async () => {
    await install(); // creates the directory
    const original = `${JSON.stringify(THIRD_PARTY, null, 2)}\n`;
    await writeFile(path, original);
    await chmod(path, 0o640);

    const backup = await install();
    expect(backup).toBe(`${path}.c-board-backup-20260304T050607Z`);
    expect(await readFile(backup as string, 'utf8')).toBe(original);
    expect((await stat(path)).mode & 0o777).toBe(0o640);

    const result = await settings();
    expect(result.model).toBe('sonnet');
    expect(result.permissions).toEqual(THIRD_PARTY.permissions);
    expect(result.statusLine).toEqual(THIRD_PARTY.statusLine);
    const hooks = result.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual([...THIRD_PARTY.hooks.PreToolUse, ours]);
    expect(hooks.Stop).toEqual([...THIRD_PARTY.hooks.Stop, ours]);
    expect(hooks.PermissionRequest).toEqual(THIRD_PARTY.hooks.PermissionRequest);
    expect(hooks.SessionStart).toEqual([ours]);
  });

  it('is idempotent: a second install plans no change and writes nothing', async () => {
    await install();
    await writeFile(path, `${JSON.stringify(THIRD_PARTY)}\n`);
    await install();
    const after = await readFile(path, 'utf8');
    const before = await backups();

    const plan = planInstall(after, COMMAND);
    expect(plan.changed).toBe(false);
    expect(plan.after).toBe(after);
    expect(await install()).toBeUndefined();
    expect(await readFile(path, 'utf8')).toBe(after);
    expect(await backups()).toEqual(before);
  });

  it('keeps its place when third-party hooks were added after it', async () => {
    await install();
    const current = await settings();
    const hooks = current.hooks as Record<string, unknown[]>;
    hooks.Stop?.push({ hooks: [{ type: 'command', command: 'say later' }] });
    const raw = JSON.stringify(current);
    expect(planInstall(raw, COMMAND).changed).toBe(false);
  });

  it('replaces an outdated or duplicated c-board handler with exactly one', async () => {
    const stale = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'say done' },
              { type: 'command', command: '/old/place/c-board-hook' },
            ],
          },
          { hooks: [{ type: 'command', command: '/old/place/c-board-hook', async: true }] },
        ],
      },
    };
    const raw = JSON.stringify(stale);
    expect(hookStatus(raw, COMMAND).outdated).toEqual(['Stop']);
    const hooks = JSON.parse(planInstall(raw, COMMAND).after).hooks;
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'say done' }] }, ours]);
  });

  it('uninstall restores exactly the other hooks', async () => {
    await install();
    await writeFile(path, `${JSON.stringify(THIRD_PARTY, null, 2)}\n`);
    await install();
    // An away-mode handler of ours is removed too.
    const current = await settings();
    (current.hooks as Record<string, unknown[]>).PermissionRequest?.push({
      hooks: [{ type: 'command', command: `${COMMAND} --permission` }],
    });
    await writeFile(path, JSON.stringify(current));

    expect(await uninstall()).toMatch(/\.c-board-backup-/);
    expect(await settings()).toEqual(THIRD_PARTY);
    expect(planUninstall(await readSettings(path)).changed).toBe(false);
  });

  it('uninstall after a fresh install leaves an empty object, and is a no-op on a missing file', async () => {
    expect(planUninstall(undefined).changed).toBe(false);
    await install();
    await uninstall();
    expect(await settings()).toEqual({});
  });

  it.each([
    ['broken JSON', '{"hooks": {'],
    ['a top-level array', '[]'],
    ['a non-object hooks key', '{"hooks": []}'],
    ['a non-array event', '{"hooks": {"Stop": {"command": "x"}}}'],
  ])('refuses to touch %s', async (_label, raw) => {
    await install();
    await writeFile(path, raw);
    expect(() => planInstall(raw, COMMAND)).toThrow(InvalidSettingsError);
    expect(() => planUninstall(raw)).toThrow(InvalidSettingsError);
    expect(() => hookStatus(raw, COMMAND)).toThrow(InvalidSettingsError);
    await expect(install()).rejects.toThrow(InvalidSettingsError);
    expect(await readFile(path, 'utf8')).toBe(raw);
    expect(await backups()).toEqual([]);
  });

  it('refuses to write when the file changed after planning', async () => {
    const plan = planInstall(undefined, COMMAND);
    await install();
    await expect(applyPlan(path, plan, NOW)).rejects.toThrow(InvalidSettingsError);
  });
});

describe('helpers', () => {
  it('resolves the settings path from CLAUDE_CONFIG_DIR or the home directory', () => {
    expect(claudeSettingsPath({}, '/home/dev')).toBe('/home/dev/.claude/settings.json');
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: '/home/dev/cfg' }, '/home/dev')).toBe(
      '/home/dev/cfg/settings.json',
    );
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: '  ' }, '/home/dev')).toBe(
      '/home/dev/.claude/settings.json',
    );
  });

  it('quotes script paths the shell would split', () => {
    expect(hookCommand('/home/dev/c-board/bin/c-board-hook')).toBe(
      '/home/dev/c-board/bin/c-board-hook',
    );
    expect(hookCommand("/home/dev/My Tools/it's/c-board-hook")).toBe(
      `'/home/dev/My Tools/it'\\''s/c-board-hook'`,
    );
    expect(hookCommand()).toMatch(/c-board-hook'?$/);
  });

  it('prints a unified diff with context and separate hunks', () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const b = [...a];
    b[1] = 'changed 2';
    b.splice(15, 0, 'inserted');
    const diff = unifiedDiff(`${a.join('\n')}\n`, `${b.join('\n')}\n`, 'old', 'new');
    expect(diff).toBe(
      [
        '--- old',
        '+++ new',
        '@@ -1,5 +1,5 @@',
        ' line 1',
        '-line 2',
        '+changed 2',
        ' line 3',
        ' line 4',
        ' line 5',
        '@@ -13,6 +13,7 @@',
        ' line 13',
        ' line 14',
        ' line 15',
        '+inserted',
        ' line 16',
        ' line 17',
        ' line 18',
        '',
      ].join('\n'),
    );
    expect(unifiedDiff('same\n', 'same\n', 'a', 'b')).toBe('');
    expect(unifiedDiff('', '{}\n', 'a', 'b')).toBe('--- a\n+++ b\n@@ -0,0 +1,1 @@\n+{}\n');
  });
});
