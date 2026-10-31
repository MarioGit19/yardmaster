import { describe, expect, it } from 'vitest';
import {
  isStatuslineCommand,
  planStatuslineInstall,
  planStatuslineUninstall,
  statuslineCommand,
  statuslineStatus,
} from './statusline.js';

const SCRIPT = '/home/dev/yardmaster/bin/yardmaster-statusline';
const settings = (statusLine?: unknown) =>
  JSON.stringify({ model: 'opus', ...(statusLine ? { statusLine } : {}) }, null, 2);

describe('statusline installer', () => {
  it('wraps the current command, keeps its other fields and round-trips on uninstall', () => {
    const previous = `input=$(cat); echo "it's $(echo "$input" | jq -r .model.id)" # a\nprintf done`;
    const raw = settings({ type: 'command', command: previous, padding: 2 });
    const install = planStatuslineInstall(raw, SCRIPT);
    const entry = JSON.parse(install.after).statusLine;
    expect(entry.padding).toBe(2);
    expect(isStatuslineCommand(entry.command)).toBe(true);
    expect(statuslineStatus(install.after, SCRIPT)).toEqual({ state: 'installed', previous });

    const uninstall = planStatuslineUninstall(install.after);
    expect(JSON.parse(uninstall.after)).toEqual(JSON.parse(raw));
  });

  it('adds a statusline when there is none, and removes it again', () => {
    const raw = settings();
    const install = planStatuslineInstall(raw, SCRIPT);
    expect(JSON.parse(install.after).statusLine).toEqual({ type: 'command', command: SCRIPT });
    expect(JSON.parse(planStatuslineUninstall(install.after).after)).toEqual(JSON.parse(raw));
  });

  it('works from a missing settings file', () => {
    const install = planStatuslineInstall(undefined, SCRIPT);
    expect(install.changed).toBe(true);
    expect(JSON.parse(install.after).statusLine.command).toBe(SCRIPT);
  });

  it('never wraps itself, and moves to a new script path keeping the old command', () => {
    const once = planStatuslineInstall(
      settings({ type: 'command', command: 'ccstatus' }),
      SCRIPT,
    ).after;
    expect(planStatuslineInstall(once, SCRIPT).changed).toBe(false);

    const moved = planStatuslineInstall(once, '/opt/ym/yardmaster-statusline');
    expect(JSON.parse(moved.after).statusLine.command).toBe(
      statuslineCommand('ccstatus', '/opt/ym/yardmaster-statusline'),
    );
    expect(statuslineStatus(once, '/opt/ym/yardmaster-statusline').state).toBe('outdated');
  });

  it('leaves a foreign statusline alone on uninstall', () => {
    const raw = settings({ type: 'command', command: 'ccstatus' });
    expect(planStatuslineUninstall(raw).changed).toBe(false);
    expect(statuslineStatus(raw, SCRIPT)).toEqual({ state: 'missing', previous: 'ccstatus' });
  });

  it('does not take a command that merely mentions the name for its own', () => {
    expect(isStatuslineCommand('echo yardmaster-statusline')).toBe(false);
    expect(isStatuslineCommand(`'/a b/yardmaster-statusline' 'x'`)).toBe(true);
  });

  it('refuses a statusLine it cannot wrap', () => {
    expect(() => planStatuslineInstall(settings({ type: 'static' }), SCRIPT)).toThrow(/statusLine/);
  });
});
