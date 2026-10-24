import { describe, expect, it } from 'vitest';
import {
  attributeTerminals,
  bindPorts,
  buildTree,
  type Listener,
  parseLsof,
  parsePs,
  parseSocketAddress,
  parseSs,
  sameStats,
  subtree,
} from './processes.js';

const T0 = 1_760_000_000_000;

// Synthetic `ps -axo pid=,ppid=,pcpu=,rss=,command=` (macOS).
const PS_MACOS = [
  '    1     0   0.3  14592 /sbin/launchd',
  '  501     1   1.2 182400 /Applications/Cursor.app/Contents/MacOS/Cursor',
  ' 4242   501   0.0   2048 -zsh',
  ' 4300  4242   2.5  10240 node /home/dev/acme-shop/node_modules/.bin/vite --port 5173',
  ' 4301  4300  10.0  51200 /home/dev/acme-shop/node_modules/@esbuild/darwin-arm64/bin/esbuild --service',
  ' 5000   501   0.1   1024 /bin/zsh -il',
  ' 5010  5000  40.0 307200 claude',
  ' 5011  5010   0.0   4096 /bin/sh -c npm test',
  'garbage line',
  '',
].join('\n');

// Synthetic `ps -eo pid=,ppid=,pcpu=,rss=,args=` (Linux procps).
const PS_LINUX = [
  '      1       0  0.0 11520 /sbin/init splash',
  '   2100       1  0.0  5632 bash',
  '   2150    2100 12,5 98304 python3 -m http.server 8000',
].join('\n');

// Synthetic `lsof -nP -iTCP -sTCP:LISTEN -F pcn` (lsof adds f records unasked).
const LSOF = [
  'p4300',
  'cnode',
  'f23',
  'n127.0.0.1:5173',
  'f24',
  'n[::1]:5173',
  'p5010',
  'cclaude',
  'f30',
  'n*:3000',
  'f31',
  'n127.0.0.1:3000->127.0.0.1:61000',
  'p77',
  'cControlCe',
  'f9',
  'n*:7000',
  '',
].join('\n');

// Synthetic `ss -ltnp`.
const SS = [
  'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
  'LISTEN 0      5            0.0.0.0:8000       0.0.0.0:*     users:(("python3",pid=2150,fd=3))',
  'LISTEN 0      511                *:3000             *:*     users:(("node",pid=2160,fd=20),("node",pid=2159,fd=20))',
  'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*',
  'LISTEN 0      128             [::]:22            [::]:*     users:(("sshd",pid=900,fd=4))',
].join('\n');

describe('parsePs', () => {
  it('parses macOS rows, keeping spaces in the command', () => {
    const procs = parsePs(PS_MACOS);
    expect(procs.size).toBe(8);
    expect(procs.get(4300)).toEqual({
      pid: 4300,
      ppid: 4242,
      cpu: 2.5,
      rssBytes: 10240 * 1024,
      command: 'node /home/dev/acme-shop/node_modules/.bin/vite --port 5173',
    });
  });

  it('parses Linux rows, including a comma decimal', () => {
    const procs = parsePs(PS_LINUX);
    expect(procs.size).toBe(3);
    expect(procs.get(2150)?.cpu).toBe(12.5);
    expect(procs.get(1)?.command).toBe('/sbin/init splash');
  });

  it('returns nothing for empty or junk output', () => {
    expect(parsePs('').size).toBe(0);
    expect(parsePs('PID PPID %CPU RSS COMMAND\nx y z').size).toBe(0);
  });
});

describe('parseSocketAddress', () => {
  it.each([
    ['*:3000', { address: '*', port: 3000 }],
    ['127.0.0.1:5173', { address: '127.0.0.1', port: 5173 }],
    ['[::1]:5173', { address: '::1', port: 5173 }],
    ['[::ffff:127.0.0.1]:8080', { address: '::ffff:127.0.0.1', port: 8080 }],
    ['127.0.0.53%lo:53', { address: '127.0.0.53', port: 53 }],
  ])('%s', (input, expected) => {
    expect(parseSocketAddress(input)).toEqual(expected);
  });

  it.each(['', ':80', 'localhost', '*:0', '*:70000', '*:http'])('rejects %j', (input) => {
    expect(parseSocketAddress(input)).toBeNull();
  });
});

describe('parseLsof', () => {
  it('reads pid, command and listening addresses, skipping connections', () => {
    expect(parseLsof(LSOF)).toEqual([
      { pid: 4300, command: 'node', address: '127.0.0.1', port: 5173 },
      { pid: 4300, command: 'node', address: '::1', port: 5173 },
      { pid: 5010, command: 'claude', address: '*', port: 3000 },
      { pid: 77, command: 'ControlCe', address: '*', port: 7000 },
    ]);
  });

  it('ignores names before any process record', () => {
    expect(parseLsof('n*:80\np12\nn*:81')).toEqual([
      { pid: 12, command: null, address: '*', port: 81 },
    ]);
  });
});

describe('parseSs', () => {
  it('reads owned listeners and skips the header and ownerless sockets', () => {
    expect(parseSs(SS)).toEqual([
      { pid: 2150, command: 'python3', address: '0.0.0.0', port: 8000 },
      { pid: 2160, command: 'node', address: '*', port: 3000 },
      { pid: 900, command: 'sshd', address: '::', port: 22 },
    ]);
  });
});

describe('subtree and attribution', () => {
  const tree = buildTree(parsePs(PS_MACOS));
  const terminals = [
    { id: 't-vite', shellPid: 4242, state: 'open' as const },
    { id: 't-claude', shellPid: 5000, state: 'open' as const },
    { id: 't-gone', shellPid: 9999, state: 'open' as const },
    { id: 't-closed', shellPid: 4242, state: 'closed' as const },
    { id: 't-nopid', shellPid: null, state: 'open' as const },
  ];

  it('collects descendants', () => {
    expect(subtree(tree, 4242).sort()).toEqual([4242, 4300, 4301]);
    expect(subtree(tree, 501, new Set([5000])).sort()).toEqual([4242, 4300, 4301, 501]);
    expect(subtree(tree, 12345)).toEqual([]);
  });

  it('survives a ppid cycle', () => {
    const cyclic = buildTree(
      parsePs(['10 11 1.0 1024 a', '11 10 1.0 1024 b', '12 12 0 0 self'].join('\n')),
    );
    expect(subtree(cyclic, 10).sort()).toEqual([10, 11]);
    expect(subtree(cyclic, 12)).toEqual([12]);
  });

  it('sums CPU and RSS per terminal subtree', () => {
    const { stats, owner } = attributeTerminals(tree, terminals, T0);
    expect(stats.get('t-vite')).toEqual({
      pid: 4242,
      cpu: 12.5,
      rssBytes: (2048 + 10240 + 51200) * 1024,
      processCount: 3,
      sampledAt: T0,
    });
    expect(stats.get('t-claude')).toMatchObject({ cpu: 40.1, processCount: 3 });
    expect(stats.get('t-claude')?.rssBytes).toBe((1024 + 307200 + 4096) * 1024);
    expect(stats.get('t-gone')).toBeNull();
    expect(stats.get('t-closed')).toBeNull();
    expect(stats.get('t-nopid')).toBeNull();
    expect(owner.get(4301)).toBe('t-vite');
    expect(owner.get(5011)).toBe('t-claude');
    expect(owner.has(501)).toBe(false);
  });

  it('gives a nested terminal shell its own subtree', () => {
    const nested = buildTree(
      parsePs(['100 1 1.0 1024 zsh', '200 100 2.0 1024 zsh', '201 200 4.0 1024 node'].join('\n')),
    );
    const { stats, owner } = attributeTerminals(
      nested,
      [
        { id: 'outer', shellPid: 100, state: 'open' },
        { id: 'inner', shellPid: 200, state: 'open' },
      ],
      T0,
    );
    expect(stats.get('outer')).toMatchObject({ cpu: 1, processCount: 1 });
    expect(stats.get('inner')).toMatchObject({ cpu: 6, processCount: 2 });
    expect(owner.get(201)).toBe('inner');
  });

  it('rounds sampling noise away', () => {
    const a = buildTree(parsePs('1 0 1.04 10000 x'));
    const b = buildTree(parsePs('1 0 0.96 10010 x'));
    const sa = attributeTerminals(a, [{ id: 't', shellPid: 1, state: 'open' }], T0).stats.get('t');
    const sb = attributeTerminals(b, [{ id: 't', shellPid: 1, state: 'open' }], T0 + 1).stats.get(
      't',
    );
    expect(sameStats(sa ?? null, sb ?? null)).toBe(true);
    expect(sameStats(sa ?? null, null)).toBe(false);
    expect(sameStats(null, null)).toBe(true);
  });
});

describe('bindPorts', () => {
  const owner = new Map([
    [4300, 't-vite'],
    [5010, 't-claude'],
  ]);
  const terminals = { 't-vite': { projectId: 'p-shop' }, 't-claude': { projectId: null } };

  it('attaches terminals and projects, sorted by port', () => {
    expect(bindPorts(parseLsof(LSOF), owner, terminals, T0)).toEqual([
      {
        id: '*:3000',
        port: 3000,
        address: '*',
        pid: 5010,
        command: 'claude',
        terminalId: 't-claude',
        projectId: null,
        firstSeenAt: T0,
      },
      {
        id: '127.0.0.1:5173',
        port: 5173,
        address: '127.0.0.1',
        pid: 4300,
        command: 'node',
        terminalId: 't-vite',
        projectId: 'p-shop',
        firstSeenAt: T0,
      },
      expect.objectContaining({ id: '[::1]:5173', terminalId: 't-vite', projectId: 'p-shop' }),
      expect.objectContaining({ id: '*:7000', pid: 77, terminalId: null, projectId: null }),
    ]);
  });

  it('dedupes a shared socket, preferring a terminal process, then the lowest pid', () => {
    const shared = (pid: number): Listener => ({ pid, command: 'node', address: '*', port: 3000 });
    expect(bindPorts([shared(9), shared(8)], new Map(), {}, T0)).toEqual([
      expect.objectContaining({ pid: 8, terminalId: null }),
    ]);
    expect(bindPorts([shared(3), shared(4300), shared(2)], owner, terminals, T0)).toEqual([
      expect.objectContaining({ pid: 4300, terminalId: 't-vite' }),
    ]);
  });

  it('is empty without listeners', () => {
    expect(bindPorts([], owner, terminals, T0)).toEqual([]);
  });

  it("attaches a port to the board terminal whose shell's descendant listens", () => {
    // The Yardmaster server (100) runs the board terminal's shell; `pnpm dev` starts vite under it.
    const tree = buildTree(
      parsePs(
        [
          '  100     1  0.5  90000 node Yardmaster',
          ' 4242   100  0.0   3000 -zsh',
          ' 4300  4242  0.1  50000 node pnpm dev',
          ' 4301  4300  2.0 120000 node vite',
        ].join('\n'),
      ),
    );
    const { owner: boardOwner } = attributeTerminals(
      tree,
      [{ id: 'board-t1', shellPid: 4242, state: 'open' }],
      T0,
    );
    const vite: Listener = { pid: 4301, command: 'node', address: '127.0.0.1', port: 5173 };
    expect(bindPorts([vite], boardOwner, { 'board-t1': { projectId: 'p-shop' } }, T0)).toEqual([
      expect.objectContaining({ port: 5173, terminalId: 'board-t1', projectId: 'p-shop' }),
    ]);
  });
});
