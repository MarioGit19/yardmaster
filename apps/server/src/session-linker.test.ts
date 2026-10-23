import { describe, expect, it } from 'vitest';
import { buildTree, parsePs, terminalForPid } from './processes.js';
import { SessionLinker } from './session-linker.js';
import { BoardStore } from './store.js';

const T0 = 1_760_000_000_000;

const ROWS = {
  editor: '  501     1   1.0 100000 /Applications/Cursor.app/Contents/MacOS/Cursor',
  shell: ' 4242   501   0.0   2048 -zsh',
  claude: ' 4300  4242   5.0  80000 claude',
  sh: ' 4400  4300   0.0    512 /bin/sh -c c-board-hook',
  hook: ' 4401  4400   0.0    512 /bin/sh /home/dev/.local/bin/c-board-hook',
  other: ' 5300   501   1.0  60000 claude --resume',
  nested: ' 4500  4242   0.0   2048 -bash',
  nestedClaude: ' 4510  4500   3.0  70000 claude',
};

function tree(...rows: string[]) {
  return buildTree(parsePs(rows.join('\n')));
}

describe('terminalForPid', () => {
  const shells = new Map([[4242, 't-1']]);
  const all = tree(...Object.values(ROWS));

  it('links a direct child of the terminal shell', () => {
    expect(terminalForPid(all, 4300, shells)).toBe('t-1');
  });

  it('walks up through an intermediate sh', () => {
    expect(terminalForPid(all, 4400, shells)).toBe('t-1');
    expect(terminalForPid(all, 4401, shells)).toBe('t-1');
  });

  it('returns null when no ancestor is a terminal shell', () => {
    expect(terminalForPid(all, 5300, shells)).toBeNull();
    expect(terminalForPid(all, 501, shells)).toBeNull();
  });

  it('returns null for a pid missing from the sample', () => {
    expect(terminalForPid(all, 9999, shells)).toBeNull();
  });

  it('stops at the nearest terminal shell when terminals nest', () => {
    const nested = new Map([
      [4242, 't-1'],
      [4500, 't-2'],
    ]);
    expect(terminalForPid(all, 4510, nested)).toBe('t-2');
    expect(terminalForPid(all, 4300, nested)).toBe('t-1');
  });

  it('survives a ppid loop in a racy sample', () => {
    const loop = tree(' 700   701   0.0 1 a', ' 701   700   0.0 1 b');
    expect(terminalForPid(loop, 700, shells)).toBeNull();
  });
});

function setup(rows: string[] = Object.values(ROWS)) {
  const store = new BoardStore({ autoFlush: false, now: () => T0 });
  let sample: ReturnType<typeof tree> | null = tree(...rows);
  store.upsertTerminal({ id: 't-1', windowId: 'w-1', name: 'zsh', shellPid: 4242 });
  store.upsertSession({ id: 'sess-1', claudePid: 4300, updatedAt: T0 - 5_000 });
  store.flush();
  const linker = new SessionLinker({ store, tree: () => sample });
  return {
    store,
    linker,
    setTree: (next: string[] | null) => {
      sample = next ? tree(...next) : null;
    },
  };
}

describe('SessionLinker', () => {
  it('sets the terminal without touching updatedAt', () => {
    const { store, linker } = setup();
    linker.link();
    expect(store.state.sessions['sess-1']).toMatchObject({
      terminalId: 't-1',
      updatedAt: T0 - 5_000,
    });
  });

  it('links a hook pid behind an intermediate sh, and a registry pid', () => {
    const { store, linker } = setup();
    store.upsertSession({ id: 'sess-hook', claudePid: 4400 });
    store.upsertSession({ id: 'sess-free', claudePid: 5300 });
    linker.link();
    expect(store.state.sessions['sess-hook']?.terminalId).toBe('t-1');
    expect(store.state.sessions['sess-free']?.terminalId).toBeNull();
  });

  it('emits nothing when no link changed', () => {
    const { store, linker } = setup();
    linker.link();
    store.flush();
    linker.link();
    expect(store.flush()).toEqual([]);
  });

  it('ignores closed terminals and terminals whose shell is not sampled', () => {
    const { store, linker } = setup();
    store.upsertTerminal({ id: 't-1', windowId: 'w-1', name: 'zsh', state: 'closed' });
    store.upsertTerminal({ id: 't-2', windowId: 'w-1', name: 'zsh', shellPid: 8888 });
    linker.link();
    expect(store.state.sessions['sess-1']?.terminalId).toBeNull();
  });

  it('keeps the link while the pid is unsampled and clears it once the terminal is gone', () => {
    const { store, linker, setTree } = setup();
    linker.link();
    setTree([ROWS.editor, ROWS.shell]);
    linker.link();
    expect(store.state.sessions['sess-1']?.terminalId).toBe('t-1');
    setTree(null);
    linker.link();
    expect(store.state.sessions['sess-1']?.terminalId).toBe('t-1');
    store.removeTerminal('t-1');
    linker.link();
    expect(store.state.sessions['sess-1']?.terminalId).toBeNull();
  });

  it('does not relink an ended session to whatever reused its pid', () => {
    const { store, linker } = setup();
    store.upsertSession({ id: 'sess-1', status: { kind: 'ended' } });
    linker.link();
    expect(store.state.sessions['sess-1']?.terminalId).toBeNull();
  });

  it('never links a board session, even when it descends from a terminal', () => {
    const { store, linker } = setup();
    store.upsertSession({ id: 'sess-board', origin: 'board', claudePid: 4510 });
    store.upsertSession({ id: 'sess-1', origin: 'board' });
    linker.link();
    expect(store.state.sessions['sess-board']?.terminalId).toBeNull();
    expect(store.state.sessions['sess-1']?.terminalId).toBeNull();
  });

  it('moves the link when the session gets a new pid', () => {
    const { store, linker } = setup([...Object.values(ROWS)]);
    store.upsertTerminal({ id: 't-2', windowId: 'w-1', name: 'bash', shellPid: 4500 });
    linker.link();
    expect(store.state.sessions['sess-1']?.terminalId).toBe('t-1');
    store.updateSession('sess-1', { claudePid: 4510 });
    linker.link();
    expect(store.state.sessions['sess-1']?.terminalId).toBe('t-2');
  });

  it('re-links after a terminal or session patch once started', async () => {
    const { store, linker } = setup();
    linker.start();
    store.upsertTerminal({ id: 't-1', windowId: 'w-1', name: 'zsh', shellPid: 1 });
    store.flush();
    await Promise.resolve();
    expect(store.state.sessions['sess-1']?.terminalId).toBeNull();
    store.upsertTerminal({ id: 't-1', windowId: 'w-1', name: 'zsh', shellPid: 4242 });
    store.flush();
    await Promise.resolve();
    expect(store.state.sessions['sess-1']?.terminalId).toBe('t-1');
    linker.stop();
    store.upsertSession({ id: 'sess-2', claudePid: 4300 });
    store.flush();
    await Promise.resolve();
    expect(store.state.sessions['sess-2']?.terminalId).toBeNull();
  });
});
