import { describe, expect, it } from 'vitest';
import {
  errorLine,
  formatUptime,
  type LaneExecution,
  laneView,
  terminalDisplay,
  uptimePeriod,
} from './lane.js';

const terminal = {
  id: 't1',
  name: 'backend',
  cwd: '/home/dev/acme-shop',
  state: 'open',
  exitCode: null,
} as const;
const execution = (over: Partial<LaneExecution> = {}): LaneExecution => ({
  id: 'e1',
  commandLine: 'pnpm dev',
  startedAt: 1_000,
  endedAt: null,
  exitCode: null,
  interactive: false,
  ...over,
});
const none = {
  id: null,
  commandLine: null,
  startedAt: null,
  endedAt: null,
  exitCode: null,
  interactive: false,
} as const;

describe('laneView', () => {
  it('shows a running command with its start time', () => {
    expect(laneView(terminal, execution())).toMatchObject({
      command: 'pnpm dev',
      running: true,
      startedAt: 1_000,
      exit: null,
      tone: 'tool',
      label: 'backend: pnpm dev, running',
    });
  });

  it('shows the exit badge of a finished command', () => {
    const ok = laneView(terminal, execution({ endedAt: 2_000, exitCode: 0 }));
    expect(ok).toMatchObject({ running: false, exit: { key: 'e1', code: 0 }, tone: 'idle' });
    const failed = laneView(terminal, execution({ endedAt: 2_000, exitCode: 2 }));
    expect(failed).toMatchObject({ exit: { code: 2 }, tone: 'err' });
    expect(failed.label).toBe('backend: pnpm dev, failed with exit code 2');
  });

  it('falls back to the closed terminal exit code and to no command', () => {
    const closed = laneView({ ...terminal, state: 'closed', exitCode: 1 }, none);
    expect(closed).toMatchObject({ command: null, exit: { code: 1 }, tone: 'err' });
    expect(laneView(terminal, none)).toMatchObject({ command: null, tone: 'idle', exit: null });
  });

  it('shows control characters in a command, and calls it unsafe to re-run', () => {
    const view = laneView(terminal, execution({ commandLine: 'echo ok\x1b[8m\rrm -rf ~' }));
    expect(view).toMatchObject({ command: 'echo ok␛[8m␍rm -rf ~', safe: false });
    expect(view.label).toBe('backend: echo ok␛[8m␍rm -rf ~, running');
    expect(laneView(terminal, execution()).safe).toBe(true);
    expect(laneView(terminal, none).safe).toBe(false);
    expect(
      terminalDisplay({ ...terminal, name: 'zsh' }, execution({ commandLine: 'a\nb' })).name,
    ).toBe('a␊b');
  });

  it('never calls a command running in a closed terminal', () => {
    const view = laneView({ ...terminal, state: 'closed', exitCode: null }, execution());
    expect(view.running).toBe(false);
  });
});

describe('terminalDisplay', () => {
  const zsh = { ...terminal, name: 'zsh' };

  it('keeps a user name and replaces an automatic one with the command', () => {
    expect(terminalDisplay(terminal, execution())).toEqual({ name: 'backend', raw: null });
    expect(terminalDisplay(zsh, execution())).toEqual({ name: 'pnpm dev', raw: 'zsh' });
    expect(terminalDisplay(zsh, execution({ endedAt: 2_000, exitCode: 0 })).name).toBe('pnpm dev');
    expect(terminalDisplay(zsh, none).name).toBe('acme-shop · zsh');
  });

  it('names a Claude terminal after its session', () => {
    const claude = { ...terminal, name: 'claude' };
    const session = { title: 'acme-shop-c3', ordinal: 2 };
    expect(terminalDisplay(claude, execution({ commandLine: 'claude' }), session).name).toBe(
      'Claude 2',
    );
  });

  it('does not repeat the command in the label when it is the name', () => {
    expect(laneView(zsh, execution()).label).toBe('pnpm dev, running');
  });
});

describe('formatUptime', () => {
  it('uses the largest whole unit', () => {
    expect(formatUptime(-5)).toBe('0s');
    expect(formatUptime(9_400)).toBe('9s');
    expect(formatUptime(125_000)).toBe('2m');
    expect(formatUptime(3 * 3_600_000 + 5 * 60_000)).toBe('3h');
    expect(formatUptime(2 * 86_400_000)).toBe('2d');
    expect(uptimePeriod(30_000)).toBe(1_000);
    expect(uptimePeriod(120_000)).toBe(15_000);
  });
});

describe('errorLine', () => {
  it('picks the last line that reads like an error', () => {
    expect(
      errorLine([
        ' ⨯ TypeError: Cannot read properties of undefined',
        '    at CartTotal (src/cart.tsx:18:31)',
        'error: the dev server exited unexpectedly',
        '',
      ]),
    ).toBe('error: the dev server exited unexpectedly');
    expect(errorLine(['booting', '  Exiting  '])).toBe('Exiting');
    expect(errorLine(['', '  '])).toBeNull();
  });
});
