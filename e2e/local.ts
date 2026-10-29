import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { DemoBoard } from './board.js';

// Editors and hooks reach the board only through its socket in the data dir, so these play them
// the way the extension and the real hook scripts do.

const HOOK_DIR = fileURLToPath(new URL('../packages/hook/bin/', import.meta.url));
export const OBSERVER_HOOK = join(HOOK_DIR, 'yardmaster-hook');
export const PERMISSION_HOOK = join(HOOK_DIR, 'yardmaster-hook-permission.mjs');

export const socketOf = (board: DemoBoard) => join(board.home, 'board.sock');

export interface HookRun {
  code: number | null;
  stdout: string;
}

/** Runs a real hook script against the board, with `payload` on stdin, as Claude Code does. */
export function runHook(board: DemoBoard, script: string, payload: unknown): Promise<HookRun> {
  const [file, args] = script.endsWith('.mjs')
    ? [process.execPath, [script]]
    : [script, [] as string[]];
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: board.home,
        YARDMASTER_HOME: board.home,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Connects a fake editor window over the socket, the way the extension does, and says hello. */
export async function connectEditor(
  board: DemoBoard,
  token: string,
  folders: string[],
  windowId = 'e2e-window-1',
): Promise<WebSocket> {
  const socket = new WebSocket('ws://localhost/ws/editor', {
    headers: { 'x-yardmaster-token': token },
    createConnection: () => connect(socketOf(board)),
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  socket.send(
    JSON.stringify({
      v: 1,
      type: 'editor.hello',
      ts: Date.now(),
      payload: {
        windowId,
        appName: 'Cursor',
        appVersion: '1.105.0',
        workspaceFolders: folders,
        extensionVersion: '0.1.0',
        capabilities: { shellExecution: true },
      },
    }),
  );
  return socket;
}

/** A fresh one-time sign-in link, asked over the socket the way `yardmaster open` does. */
export async function signInLink(board: DemoBoard): Promise<string> {
  const token = (await readFile(join(board.home, 'token'), 'utf8')).trim();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socketOf(board),
        path: '/api/local/dashboard-link',
        method: 'POST',
        headers: { 'x-yardmaster-token': token },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const url = (JSON.parse(body) as { url?: string }).url;
          if (res.statusCode === 200 && url) resolve(url);
          else reject(new Error(`no sign-in link: HTTP ${res.statusCode}`));
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
