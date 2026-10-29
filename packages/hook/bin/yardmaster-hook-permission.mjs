// Yardmaster's away-mode hook for Claude Code's PermissionRequest event (PRD §6.1), run by the
// absolute Node path the installer writes into the hook command (hooks may run without the
// user's shell PATH).
//
// It asks the board, through its socket in the data dir, whether away mode is on (300 ms). If
// it is, it posts the request and waits for the board's decision: "allow", "allow_always" or
// "deny" with a reason. It builds Claude Code's output itself:
//   {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny",…}}}
// "Always allow" applies only the permission_suggestions Claude Code put in this hook's own
// input, and the output never carries updatedInput, so the board can't rewrite a tool call or
// add rules of its own. Output shape verified against https://code.claude.com/docs/en/hooks.
// Away mode off, a timeout or any error: exit 0 with no output, so the terminal prompt appears.

import { lstatSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AWAY_TIMEOUT_MS = 300;
const DEFAULT_WAIT_SEC = 120;
const MAX_WAIT_SEC = 300;
/** curl in the old script gave up a little after the board; so does this. */
const WAIT_SLACK_SEC = 5;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ANSWER_BYTES = 16 * 1024;
const REASON_MAX = 500;
const DENY_MESSAGE = 'Denied from Yardmaster.';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function dataDir(env) {
  // The old CBOARD_HOME and ~/.c-board are read for one version (Yardmaster was c-board).
  const configured = env.YARDMASTER_HOME || env.CBOARD_HOME || '';
  const home = env.HOME || homedir();
  if (configured === '~') return home;
  if (configured.startsWith('~/')) return join(home, configured.slice(2));
  if (configured) return configured;
  const dir = join(home, '.yardmaster');
  return readToken(dir) === null && readToken(join(home, '.c-board')) !== null
    ? join(home, '.c-board')
    : dir;
}

function readToken(dir) {
  try {
    const token = readFileSync(join(dir, 'token'), 'utf8').trim();
    return TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** A socket this user owns, and not a link to one: nobody else can create such a file. */
function ownSocket(path) {
  try {
    const info = lstatSync(path);
    return info.isSocket() && (process.getuid === undefined || info.uid === process.getuid());
  } catch {
    return false;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_INPUT_BYTES) chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(size <= MAX_INPUT_BYTES ? Buffer.concat(chunks) : null));
    process.stdin.on('error', () => resolve(null));
  });
}

/** One request to the board over its socket: the status and the body, or null on any failure. */
function call(socketPath, method, path, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    const req = request(
      { socketPath, method, path, headers, timeout: timeoutMs, agent: false },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_ANSWER_BYTES) req.destroy();
          else chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Claude Code's own suggestions from this hook's input; the board's answer never adds any. */
function suggestionsOf(input) {
  const list = input.permission_suggestions;
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => isObject(entry) && typeof entry.type === 'string');
}

/** The hook output for a board answer, or null when the answer isn't one we know. */
function hookOutput(answer, input) {
  if (!isObject(answer)) return null;
  let decision;
  if (answer.decision === 'allow') {
    decision = { behavior: 'allow' };
  } else if (answer.decision === 'allow_always') {
    const suggestions = suggestionsOf(input);
    decision =
      suggestions.length > 0
        ? { behavior: 'allow', updatedPermissions: suggestions }
        : { behavior: 'allow' };
  } else if (answer.decision === 'deny') {
    const reason = typeof answer.reason === 'string' ? answer.reason.trim() : '';
    decision = { behavior: 'deny', message: reason ? reason.slice(0, REASON_MAX) : DENY_MESSAGE };
  } else {
    return null;
  }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

/** The decision to print, or null for none. */
async function decide() {
  const env = process.env;
  const dir = dataDir(env);
  const socketPath = join(dir, 'board.sock');
  const token = readToken(dir);
  if (token === null || !ownSocket(socketPath)) return null;

  const raw = await readStdin();
  if (raw === null) return null;
  const input = parseJson(raw.toString('utf8'));
  if (!isObject(input)) return null;

  const headers = { 'x-yardmaster-token': token };
  const away = await call(socketPath, 'GET', '/api/away', headers, undefined, AWAY_TIMEOUT_MS);
  const status = away?.status === 200 ? parseJson(away.body) : undefined;
  if (!isObject(status) || status.away !== true) return null;
  const wait =
    Number.isInteger(status.timeoutSec) &&
    status.timeoutSec >= 0 &&
    status.timeoutSec <= MAX_WAIT_SEC
      ? status.timeoutSec
      : DEFAULT_WAIT_SEC;

  const answer = await call(
    socketPath,
    'POST',
    '/api/hooks/permission',
    {
      ...headers,
      'content-type': 'application/json',
      'x-yardmaster-claude-pid': String(process.ppid),
    },
    raw,
    (wait + WAIT_SLACK_SEC) * 1000,
  );
  if (answer?.status !== 200) return null;
  return hookOutput(parseJson(answer.body), input);
}

// Never block Claude or fail its tool call: every error ends in "no decision" and exit 0.
process.on('uncaughtException', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
decide()
  .catch(() => null)
  .then((output) => {
    if (output === null) process.exit(0);
    // Pipes can be asynchronous: exit once the decision is written.
    process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0));
  });
