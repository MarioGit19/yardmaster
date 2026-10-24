import { describe, expect, it, vi } from 'vitest';
import { createMarkerParser, type ShellMarker } from '../shell-markers.js';
import { DemoShell } from './pty.js';

/** Reads the shell like the board does: the text, and the shell integration markers apart. */
function shell() {
  const sh = new DemoShell(61_001, { cwd: '/home/dev/garden-planner' });
  const parser = createMarkerParser();
  let out = '';
  const markers: ShellMarker[] = [];
  const exits: number[] = [];
  sh.onData((data) => {
    for (const token of parser.push(data)) {
      if ('text' in token) out += token.text;
      else markers.push(token.marker);
    }
  });
  sh.onExit(({ exitCode }) => exits.push(exitCode));
  return { sh, read: () => out, markers, exits };
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

  it('reports its commands like a shell with the integration', async () => {
    const { sh, markers } = shell();
    sh.write('pnpm dev\r');
    sh.write('\x03');
    sh.write('echo hi\r');
    sh.write('nope\r');
    await vi.waitFor(() => expect(markers.filter((m) => m.kind === 'finished')).toHaveLength(3));
    const cwd = { kind: 'cwd', cwd: '/home/dev/garden-planner' };
    const run = (commandLine: string, exitCode: number) => [
      { kind: 'commandLine', commandLine },
      { kind: 'executed' },
      { kind: 'finished', exitCode },
      cwd,
      { kind: 'prompt' },
    ];
    expect(markers).toEqual([
      cwd,
      { kind: 'prompt' },
      ...run('pnpm dev', 130),
      ...run('echo hi', 0),
      ...run('nope', 127),
    ]);
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
