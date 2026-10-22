import type { PortBinding, ProcessStats, Terminal } from '@c-board/protocol';

/** One row of `ps`. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  cpu: number;
  rssBytes: number;
  command: string;
}

/** A listening TCP socket, before it is attributed to a terminal. */
export interface Listener {
  pid: number;
  port: number;
  address: string;
  command: string | null;
}

export interface ProcessTree {
  procs: ReadonlyMap<number, ProcessInfo>;
  children: ReadonlyMap<number, readonly number[]>;
}

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+(.*)$/;

/** Parses `ps -o pid=,ppid=,pcpu=,rss=,command=` output (rss in KiB). Bad rows are skipped. */
export function parsePs(stdout: string): Map<number, ProcessInfo> {
  const procs = new Map<number, ProcessInfo>();
  for (const line of stdout.split('\n')) {
    const m = PS_ROW.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const cpu = Number(m[3]?.replace(',', '.'));
    if (pid <= 0 || !Number.isFinite(cpu)) continue;
    procs.set(pid, {
      pid,
      ppid: Number(m[2]),
      cpu,
      rssBytes: Number(m[4]) * 1024,
      command: m[5]?.trim() ?? '',
    });
  }
  return procs;
}

/** Splits `host:port` as lsof and ss print it: `*:3000`, `[::1]:5173`, `127.0.0.53%lo:53`. */
export function parseSocketAddress(value: string): { address: string; port: number } | null {
  const colon = value.lastIndexOf(':');
  if (colon <= 0) return null;
  const port = Number(value.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let address = value.slice(0, colon);
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const zone = address.indexOf('%');
  if (zone > 0) address = address.slice(0, zone);
  return address ? { address, port } : null;
}

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output. */
export function parseLsof(stdout: string): Listener[] {
  const out: Listener[] = [];
  let pid: number | null = null;
  let command: string | null = null;
  for (const line of stdout.split('\n')) {
    const field = line[0];
    const value = line.slice(1).trim();
    if (field === 'p') {
      const n = Number(value);
      pid = Number.isInteger(n) && n > 0 ? n : null;
      command = null;
    } else if (field === 'c') {
      command = value || null;
    } else if (field === 'n' && pid !== null) {
      // Connected sockets print `local->remote`; LISTEN ones never should.
      if (value.includes('->')) continue;
      const socket = parseSocketAddress(value);
      if (socket) out.push({ pid, command, ...socket });
    }
  }
  return out;
}

const SS_USER = /\("((?:[^"\\]|\\.)*)",pid=(\d+)/;

/** Parses `ss -ltnp` output. Sockets without a visible owner (other users) are skipped. */
export function parseSs(stdout: string): Listener[] {
  const out: Listener[] = [];
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'LISTEN' || cols.length < 5) continue;
    const socket = parseSocketAddress(cols[3] ?? '');
    const user = SS_USER.exec(line);
    if (!socket || !user) continue;
    out.push({ pid: Number(user[2]), command: user[1] || null, ...socket });
  }
  return out;
}

export function buildTree(procs: ReadonlyMap<number, ProcessInfo>): ProcessTree {
  const children = new Map<number, number[]>();
  for (const proc of procs.values()) {
    if (proc.ppid === proc.pid) continue;
    const list = children.get(proc.ppid);
    if (list) list.push(proc.pid);
    else children.set(proc.ppid, [proc.pid]);
  }
  return { procs, children };
}

/** Pids of `root` and all its descendants; `stopAt` pids (and their subtrees) are excluded. */
export function subtree(
  tree: ProcessTree,
  root: number,
  stopAt: ReadonlySet<number> = new Set(),
): number[] {
  if (!tree.procs.has(root)) return [];
  const seen = new Set<number>([root]);
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    for (const child of tree.children.get(pid) ?? []) {
      if (seen.has(child) || stopAt.has(child)) continue;
      seen.add(child);
      stack.push(child);
    }
  }
  return [...seen];
}

const RSS_QUANTUM = 64 * 1024;

/**
 * Summed CPU and RSS of a subtree, or null when the root isn't running. Values are
 * rounded (0.1 % CPU, 64 KiB RSS) so sampling noise doesn't count as a change.
 */
export function aggregate(
  tree: ProcessTree,
  pids: readonly number[],
  root: number,
  sampledAt: number,
): ProcessStats | null {
  if (pids.length === 0) return null;
  let cpu = 0;
  let rss = 0;
  for (const pid of pids) {
    const proc = tree.procs.get(pid);
    if (!proc) continue;
    cpu += proc.cpu;
    rss += proc.rssBytes;
  }
  return {
    pid: root,
    cpu: Math.round(cpu * 10) / 10,
    rssBytes: Math.round(rss / RSS_QUANTUM) * RSS_QUANTUM,
    processCount: pids.length,
    sampledAt,
  };
}

export interface Attribution {
  /** Stats per open terminal whose shell is running; others map to null. */
  stats: Map<string, ProcessStats | null>;
  /** The terminal owning each pid inside a terminal subtree. */
  owner: Map<number, string>;
}

/**
 * Splits the tree into terminal subtrees. A terminal started from inside another
 * terminal's shell owns its own subtree, which the outer one doesn't count.
 */
export function attributeTerminals(
  tree: ProcessTree,
  terminals: readonly Pick<Terminal, 'id' | 'shellPid' | 'state'>[],
  sampledAt: number,
): Attribution {
  const stats = new Map<string, ProcessStats | null>();
  const owner = new Map<number, string>();
  const roots = new Map<number, string>();
  for (const terminal of terminals) {
    stats.set(terminal.id, null);
    if (
      terminal.state === 'open' &&
      terminal.shellPid !== null &&
      tree.procs.has(terminal.shellPid)
    )
      roots.set(terminal.shellPid, terminal.id);
  }
  const shells = new Set(roots.keys());
  for (const [root, terminalId] of roots) {
    const pids = subtree(tree, root, shells);
    for (const pid of pids) owner.set(pid, terminalId);
    stats.set(terminalId, aggregate(tree, pids, root, sampledAt));
  }
  return { stats, owner };
}

/** Turns raw listeners into port bindings, deduplicated by `<address>:<port>`. */
export function bindPorts(
  listeners: readonly Listener[],
  owner: ReadonlyMap<number, string>,
  terminals: Readonly<Record<string, Pick<Terminal, 'projectId'>>>,
  now: number,
): PortBinding[] {
  const bindings = new Map<string, PortBinding>();
  for (const listener of listeners) {
    const host = listener.address.includes(':') ? `[${listener.address}]` : listener.address;
    const id = `${host}:${listener.port}`;
    const terminalId = owner.get(listener.pid) ?? null;
    const existing = bindings.get(id);
    // Forked workers share a socket; prefer one inside a terminal, then the lowest pid.
    if (existing) {
      const inTerminal = terminalId !== null;
      const wasInTerminal = existing.terminalId !== null;
      if (wasInTerminal && !inTerminal) continue;
      if (wasInTerminal === inTerminal && existing.pid <= listener.pid) continue;
    }
    bindings.set(id, {
      id,
      port: listener.port,
      address: listener.address,
      pid: listener.pid,
      command: listener.command,
      terminalId,
      projectId: terminalId ? (terminals[terminalId]?.projectId ?? null) : null,
      firstSeenAt: now,
    });
  }
  return [...bindings.values()].sort(
    (a, b) => a.port - b.port || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Equal ignoring `sampledAt`. */
export function sameStats(a: ProcessStats | null, b: ProcessStats | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.pid === b.pid &&
    a.cpu === b.cpu &&
    a.rssBytes === b.rssBytes &&
    a.processCount === b.processCount
  );
}

/** Deeper chains than this are a loop in a racy `ps` sample, not real nesting. */
const MAX_ANCESTRY = 128;

/**
 * Walks from `pid` up through its ancestors and returns the terminal of the first
 * shell pid it meets, so a process started through an intermediate `sh` still
 * links. Null when the pid isn't sampled or no ancestor is a terminal shell.
 */
export function terminalForPid(
  tree: ProcessTree,
  pid: number,
  shells: ReadonlyMap<number, string>,
): string | null {
  const seen = new Set<number>();
  let current: number | undefined = pid;
  while (current !== undefined && current > 0 && seen.size < MAX_ANCESTRY) {
    const terminalId = shells.get(current);
    if (terminalId !== undefined) return terminalId;
    const proc = tree.procs.get(current);
    if (!proc || seen.has(current)) return null;
    seen.add(current);
    current = proc.ppid;
  }
  return null;
}
