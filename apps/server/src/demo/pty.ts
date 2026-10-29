import { basename } from 'node:path';
import type { PtyLoad, PtyProcess } from '../pty.js';
import { MARKER_NONCE_ENV } from '../shell-markers.js';

const DIM = '\x1b[2m';
const ACCENT = '\x1b[36m';
const RESET = '\x1b[0m';

/** Shell integration markers, as the real shells' injected hooks print them. */
const mark = (body: string) => `\x1b]${body}\x07`;
const escapeValue = (value: string) => value.replaceAll('\\', '\\\\').replaceAll(';', '\\x3b');

type DataListener = (data: string) => void;
type ExitListener = (event: { exitCode: number; signal?: number }) => void;

/**
 * A synthetic shell for the demo board's board terminals (F19): it echoes keystrokes, edits the
 * line, and runs a handful of made-up commands. Nothing on the machine runs and nothing is read.
 */
export class DemoShell implements PtyProcess {
  readonly pid: number;
  private readonly folder: string;
  private readonly cwd: string;
  /** Signs the command line and cwd markers, like the real shells' hooks. */
  private readonly nonce: string;
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private line = '';
  /** A command that keeps running (a dev server) until Ctrl+C. */
  private running = false;
  /** Inside an escape sequence the keyboard sent (arrows and such), which the line ignores. */
  private escape = false;
  private exited = false;

  constructor(pid: number, options: { cwd: string; env?: Record<string, string> }) {
    this.pid = pid;
    this.nonce = options.env?.[MARKER_NONCE_ENV] ?? '';
    this.folder = basename(options.cwd);
    this.cwd = options.cwd;
    this.emit(`${DIM}Yardmaster demo shell: nothing runs on your machine.${RESET}\r\n`);
    this.prompt();
  }

  onData(listener: DataListener) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: ExitListener) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    if (this.exited) return;
    for (const char of data) this.key(char);
  }

  resize(): void {}

  kill(): void {
    this.exit(0);
  }

  private key(char: string): void {
    if (this.escape) {
      // A lone Esc ends at the next control key, which still counts.
      if (char >= ' ') {
        if (/[A-Za-z~]/.test(char)) this.escape = false;
        return;
      }
      this.escape = false;
    }
    if (char === '\x1b') {
      this.escape = true;
      return;
    }
    if (char === '\x03') {
      const wasRunning = this.running;
      this.running = false;
      this.line = '';
      this.emit(`^C\r\n${wasRunning ? mark('133;D;130') : ''}`);
      this.prompt();
      return;
    }
    if (this.running) return;
    if (char === '\r' || char === '\n') {
      this.emit('\r\n');
      const line = this.line;
      this.line = '';
      this.run(line.trim());
    } else if (char === '\x7f' || char === '\b') {
      if (this.line.length === 0) return;
      this.line = [...this.line].slice(0, -1).join('');
      this.emit('\b \b');
    } else if (char === '\x04') {
      if (this.line === '') {
        this.emit('exit\r\n');
        this.exit(0);
      }
    } else if (char >= ' ') {
      this.line += char;
      this.emit(char);
    }
  }

  private run(line: string): void {
    const [command = '', ...args] = line.split(/\s+/);
    if (command === '') {
      this.prompt();
      return;
    }
    this.emit(mark(`633;E;${escapeValue(line)};${this.nonce}`) + mark('133;C'));
    if (command === 'exit') {
      const code = Number.parseInt(args[0] ?? '0', 10);
      this.emit('exit\r\n');
      this.exit(Number.isFinite(code) ? code & 0xff : 0);
      return;
    }
    if (command === 'echo') this.emit(`${args.join(' ')}\r\n`);
    else if (command === 'pwd') this.emit(`/home/dev/${this.folder}\r\n`);
    else if (command === 'clear') this.emit('\x1b[2J\x1b[H');
    else if (/^(pnpm|npm|yarn|bun)$/.test(command) && args.join(' ').match(/^(run )?dev$/)) {
      this.running = true;
      this.emit(
        `\r\n  ${ACCENT}VITE${RESET} v7.1.2  ${DIM}ready in 312 ms${RESET}\r\n\r\n` +
          `  ➜  Local:   ${ACCENT}http://localhost:5173/${RESET}\r\n` +
          `  ${DIM}➜  press Ctrl+C to stop${RESET}\r\n`,
      );
      return;
    } else {
      this.emit(
        `${DIM}${command}: the demo shell only knows echo, pwd, clear and exit${RESET}\r\n`,
      );
      this.emit(mark('133;D;127'));
      this.prompt();
      return;
    }
    this.emit(mark('133;D;0'));
    this.prompt();
  }

  private prompt(): void {
    this.emit(mark(`633;P;Cwd=${escapeValue(this.cwd)};${this.nonce}`) + mark('133;A'));
    this.emit(`${ACCENT}${this.folder}${RESET} $ `);
  }

  private emit(data: string): void {
    // Async, like a real pty: output never arrives inside the write that caused it.
    setTimeout(() => {
      if (this.exited) return;
      for (const listener of this.dataListeners) listener(data);
    }, 0);
  }

  private exit(exitCode: number): void {
    if (this.exited) return;
    setTimeout(() => {
      this.exited = true;
      for (const listener of this.exitListeners) listener({ exitCode });
    }, 0);
  }
}

/** The demo board's stand-in for node-pty. */
export function demoPty(): PtyLoad {
  let pid = 61_000;
  return {
    ok: true,
    signsMarkers: true,
    spawn: (_file, _args, options) => new DemoShell(++pid, options),
  };
}
