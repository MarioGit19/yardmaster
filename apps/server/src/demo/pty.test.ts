import { describe, expect, it, vi } from 'vitest';
import { DemoShell } from './pty.js';

function shell() {
  const sh = new DemoShell(61_001, { cwd: '/home/dev/garden-planner' });
  let out = '';
  const exits: number[] = [];
  sh.onData((data) => {
    out += data;
  });
  sh.onExit(({ exitCode }) => exits.push(exitCode));
  return { sh, read: () => out, exits };
}

describe('DemoShell', () => {
  it('echoes keystrokes and runs echo', async () => {
    const { sh, read } = shell();
    sh.write('echo hi there\r');
    await vi.waitFor(() => expect(read()).toContain('echo hi there\r\nhi there\r\n'));
    expect(read()).toContain('garden-planner');
  });

  it('edits the line with backspace and ignores arrow keys', async () => {
    const { sh, read } = shell();
    sh.write('echo ab\x7fc\x1b[A\r');
    await vi.waitFor(() => expect(read()).toContain('\r\nac\r\n'));
  });

  it('stops a dev server on Ctrl+C', async () => {
    const { sh, read } = shell();
    sh.write('pnpm dev\r');
    await vi.waitFor(() => expect(read()).toContain('Local:'));
    sh.write('echo ignored\r');
    sh.write('\x03');
    sh.write('echo back\r');
    await vi.waitFor(() => expect(read()).toContain('^C'));
    await vi.waitFor(() => expect(read()).toContain('\r\nback\r\n'));
    expect(read()).not.toContain('ignored');
  });

  it('takes Ctrl+C right after a lone Esc', async () => {
    const { sh, read } = shell();
    sh.write('pnpm dev\r');
    await vi.waitFor(() => expect(read()).toContain('Local:'));
    sh.write('\x1b');
    sh.write('\x03');
    await vi.waitFor(() => expect(read()).toContain('^C'));
  });

  it('exits with the code', async () => {
    const { sh, exits } = shell();
    sh.write('exit 3\r');
    await vi.waitFor(() => expect(exits).toEqual([3]));
    sh.write('echo after\r');
    sh.kill();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(exits).toEqual([3]);
  });
});
