import {
  GIT_MAX_COMMITS,
  GIT_MAX_FILES,
  type GitCommit,
  type GitFileChange,
  type GitFileStatus,
  type GitInfo,
} from '@c-board/protocol';

/** Arguments for `git status`; `-z` keeps paths unquoted and NUL-separated. */
export const GIT_STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '-z'] as const;

const FIELD = '\x1f';

/** Arguments for `git log`: one NUL-terminated record per commit, fields split by US. */
export const GIT_LOG_ARGS = [
  'log',
  `-n${GIT_MAX_COMMITS}`,
  '-z',
  '--no-show-signature',
  `--format=%H${FIELD}%an${FIELD}%at${FIELD}%s`,
] as const;

export interface GitStatus {
  branch: string | null;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: number;
  files: GitFileChange[];
}

/**
 * Parses `git status --porcelain=v2 --branch -z`. Unknown or malformed records are
 * skipped; files beyond `GIT_MAX_FILES` are counted but not listed.
 */
export function parseGitStatus(stdout: string): GitStatus {
  const status: GitStatus = {
    branch: null,
    head: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: 0,
    files: [],
  };
  const records = stdout.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? '';
    if (record.startsWith('# ')) {
      parseHeader(status, record.slice(2));
      continue;
    }
    let file: GitFileChange | null = null;
    switch (record.slice(0, 2)) {
      case '1 ':
        file = changedEntry(record, 8, null);
        break;
      case '2 ':
        // The rename source is the next NUL-separated record.
        file = changedEntry(record, 9, records[++i] ?? null);
        break;
      case 'u ':
        file = conflictEntry(record);
        break;
      case '? ':
        file = untrackedEntry(record.slice(2));
        break;
    }
    if (!file) continue;
    status.dirty += 1;
    if (status.files.length < GIT_MAX_FILES) status.files.push(file);
  }
  return status;
}

function parseHeader(status: GitStatus, header: string): void {
  const space = header.indexOf(' ');
  if (space < 0) return;
  const key = header.slice(0, space);
  const value = header.slice(space + 1);
  switch (key) {
    case 'branch.oid':
      status.head = /^[0-9a-f]{7,64}$/.test(value) ? value : null;
      break;
    case 'branch.head':
      status.detached = value === '(detached)';
      status.branch = status.detached || value.length === 0 ? null : value;
      break;
    case 'branch.upstream':
      status.upstream = value.length > 0 ? value : null;
      break;
    case 'branch.ab': {
      const match = /^\+(\d+) -(\d+)$/.exec(value);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
      break;
    }
  }
}

/** Splits off `count` space-separated fields; the rest of the record is the path. */
function splitFields(record: string, count: number): { fields: string[]; path: string } | null {
  const fields: string[] = [];
  let start = 0;
  for (let n = 0; n < count; n++) {
    const end = record.indexOf(' ', start);
    if (end < 0) return null;
    fields.push(record.slice(start, end));
    start = end + 1;
  }
  const path = record.slice(start);
  return path.length > 0 ? { fields, path } : null;
}

function changedEntry(
  record: string,
  count: number,
  origPath: string | null,
): GitFileChange | null {
  const parts = splitFields(record, count);
  const xy = parts?.fields[1];
  if (!parts || !xy || xy.length !== 2) return null;
  const [x = '.', y = '.'] = xy;
  let status: GitFileStatus;
  if (count === 9) {
    status = parts.fields[8]?.startsWith('C') ? 'copied' : 'renamed';
  } else if (x === 'D' || y === 'D') status = 'deleted';
  else if (x === 'A') status = 'added';
  else if (x === 'T' || y === 'T') status = 'typechange';
  else status = 'modified';
  return {
    path: parts.path,
    origPath: count === 9 && origPath ? origPath : null,
    status,
    staged: x !== '.',
    unstaged: y !== '.',
  };
}

function conflictEntry(record: string): GitFileChange | null {
  const parts = splitFields(record, 10);
  if (!parts) return null;
  return { path: parts.path, origPath: null, status: 'conflicted', staged: false, unstaged: true };
}

function untrackedEntry(path: string): GitFileChange | null {
  if (path.length === 0) return null;
  return { path, origPath: null, status: 'untracked', staged: false, unstaged: true };
}

/** Parses the output of `GIT_LOG_ARGS`, newest first. Malformed records are skipped. */
export function parseGitLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of stdout.split('\0')) {
    const [hash, author, at, ...subject] = record.replace(/^\n/, '').split(FIELD);
    if (!hash || !/^[0-9a-f]{7,64}$/.test(hash) || author === undefined || !at) continue;
    const seconds = Number(at);
    if (!Number.isSafeInteger(seconds) || seconds < 0) continue;
    commits.push({ hash, author, at: seconds * 1000, subject: subject.join(FIELD) });
    if (commits.length === GIT_MAX_COMMITS) break;
  }
  return commits;
}

/** Same repository state, ignoring `updatedAt`. */
export function sameGitInfo(a: GitInfo | null, b: GitInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.branch === b.branch &&
    a.head === b.head &&
    a.detached === b.detached &&
    a.dirty === b.dirty &&
    a.upstream === b.upstream &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.files.length === b.files.length &&
    a.files.every((file, i) => sameFile(file, b.files[i])) &&
    a.commits.length === b.commits.length &&
    a.commits.every((commit, i) => sameCommit(commit, b.commits[i]))
  );
}

function sameFile(a: GitFileChange, b: GitFileChange | undefined): boolean {
  return (
    b !== undefined &&
    a.path === b.path &&
    a.origPath === b.origPath &&
    a.status === b.status &&
    a.staged === b.staged &&
    a.unstaged === b.unstaged
  );
}

function sameCommit(a: GitCommit, b: GitCommit | undefined): boolean {
  return (
    b !== undefined &&
    a.hash === b.hash &&
    a.author === b.author &&
    a.at === b.at &&
    a.subject === b.subject
  );
}
