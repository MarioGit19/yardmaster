import {
  type ActivityEvent,
  type ActivityKind,
  type Approval,
  type ApprovalDecision,
  accentIndexForProject,
  type ClaudeSession,
  GIT_MAX_COMMITS,
  GIT_MAX_FILES,
  type GitFileChange,
  type GitInfo,
  makeMessage,
  type PortBinding,
  projectIdFromPath,
  type ResumableSessionStatus,
  type ServerToUi,
  type ToolActivity,
  toolFamily,
} from '@c-board/protocol';
import type { ActionHandlers, ActionResult } from '../actions.js';
import { NOTHING_TO_RERUN, type TerminalActionKind } from '../editor-actions.js';
import type { BoardStore } from '../store.js';
import {
  DEMO_CHANGED_FILES,
  DEMO_COMMITS,
  DEMO_HOME,
  DEMO_MODELS,
  DEMO_PROJECTS,
  DEMO_WINDOWS,
  type DemoProject,
  type DemoScenario,
  type DemoTerminal,
  type DemoTool,
} from './content.js';
import {
  claudeBanner,
  DEV_SERVERS,
  type DevServerKind,
  jestRun,
  SHELL_COMMANDS,
  typedCommand,
} from './logs.js';
import { Rng } from './rng.js';
import {
  type DemoEntry,
  DemoTranscripts,
  demoAssistantText,
  demoHistory,
  demoTodos,
  demoToolCall,
  TODO_RESULT,
} from './transcripts.js';

/** PRD F12: a permission request roughly every 45 s. */
export const DEMO_PERMISSION_INTERVAL_MS = 45_000;
export const DEMO_APPROVAL_TIMEOUT_MS = 120_000;
const CRASH_CHANCE = 0.012;
const COMPACT_AT_TOKENS = 150_000;
const STATS_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const RESOLVED_APPROVAL_TTL_MS = 60_000;
const MAX_SUBAGENTS = 6;
/** SIGINT: what a shell reports for a command stopped with Ctrl+C. */
const INTERRUPTED_EXIT = 130;
/**
 * Transcript entries in the first session of the first project: a long history for the message
 * list (tool results fold into their calls, so this shows as about 550 messages).
 */
export const DEMO_LONG_HISTORY = 800;

export interface DemoSimulatorOptions {
  store: BoardStore;
  seed?: number;
  /** Normalized events, as the hook ingest would produce them. */
  onActivity?: (event: ActivityEvent) => void;
  /** Toasts and approval notices for UI clients. */
  onMessage?: (message: ServerToUi) => void;
  permissionIntervalMs?: number;
  approvalTimeoutMs?: number;
  /** Where session transcripts go. Defaults to a fresh one, exposed as `transcripts`. */
  transcripts?: DemoTranscripts;
}

interface ProjectCtx {
  id: string;
  def: DemoProject;
  windowId: string;
  dirty: number;
  /** Fixed reference time for the synthetic commit history. */
  seededAt: number;
  scenarioCursor: number;
}

interface TerminalCtx {
  id: string;
  project: ProjectCtx;
  def: DemoTerminal;
  shellPid: number;
  /** Running long-lived execution (dev server or claude), if any. */
  execId: string | null;
  childPid: number | null;
  session: SessionCtx | null;
  busyUntil: number;
}

interface Turn {
  scenario: DemoScenario;
  steps: number;
  done: number;
}

interface SessionCtx {
  id: string;
  project: ProjectCtx;
  terminal: TerminalCtx;
  /** The session's step chain; cancelled when a permission request interrupts it. */
  timer: NodeJS.Timeout | undefined;
  nudge: NodeJS.Timeout | undefined;
  turn: Turn | null;
  approval: Approval | null;
}

/**
 * Synthetic board for `--demo`: five fictional projects with dev servers, test runs, shells
 * and Claude sessions. It only touches the board through `BoardStore` mutators, exactly
 * like the real ingest, so the UI can't tell the difference.
 */
export class DemoSimulator {
  readonly transcripts: DemoTranscripts;
  private readonly store: BoardStore;
  private readonly rng: Rng;
  /** Transcript wording only, so it doesn't shift the simulation's own random sequence. */
  private readonly textRng: Rng;
  /** The Pulse backfill only, for the same reason. */
  private readonly pastRng: Rng;
  private readonly onActivity: (event: ActivityEvent) => void;
  private readonly onMessage: (message: ServerToUi) => void;
  private readonly permissionIntervalMs: number;
  private readonly approvalTimeoutMs: number;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly projects: ProjectCtx[] = [];
  private readonly terminals: TerminalCtx[] = [];
  private readonly sessions = new Map<string, SessionCtx>();
  private readonly ports = new Map<string, PortBinding>();
  private running = false;
  private longHistory = false;
  private todoCalls = 0;
  private seq = 0;

  constructor(options: DemoSimulatorOptions) {
    this.store = options.store;
    this.rng = new Rng(options.seed ?? 0xc0ffee);
    this.textRng = new Rng((options.seed ?? 0xc0ffee) ^ 0x5eed);
    this.pastRng = new Rng((options.seed ?? 0xc0ffee) ^ 0x9a57);
    this.transcripts = options.transcripts ?? new DemoTranscripts();
    this.onActivity = options.onActivity ?? (() => {});
    this.onMessage = options.onMessage ?? (() => {});
    this.permissionIntervalMs = options.permissionIntervalMs ?? DEMO_PERMISSION_INTERVAL_MS;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEMO_APPROVAL_TIMEOUT_MS;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.seedBoard();
    for (const terminal of this.terminals) {
      this.backfillTerminal(terminal);
      this.bootTerminal(terminal);
    }
    this.every(STATS_INTERVAL_MS, () => this.sampleStats());
    this.every(HEARTBEAT_INTERVAL_MS, () => {
      for (const project of this.projects) this.store.touchWindow(project.windowId);
    });
    this.after(Math.min(this.permissionIntervalMs, this.rng.int(8_000, 14_000)), () =>
      this.requestPermission(),
    );
  }

  /** Cancels every timer. The board keeps its last state. */
  stop(): void {
    this.running = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** Handles a UI `approval.decide` for a demo approval. */
  decideApproval(decision: ApprovalDecision): ActionResult {
    const approval = this.store.state.approvals[decision.approvalId];
    const session = approval && this.sessions.get(approval.sessionId);
    if (approval?.state !== 'pending' || !session || session.approval?.id !== approval.id) {
      return { ok: false, error: 'unknown_approval' };
    }
    const reason = decision.decision === 'deny' ? (decision.reason ?? null) : null;
    this.resolveApproval(session, decision.decision === 'deny' ? 'denied' : 'allowed', reason);
    return { ok: true };
  }

  /**
   * Terminal actions from the board, played out on the demo terminals as a shell would: typed
   * commands run and echo, Ctrl+C stops what is running, and a rerun runs the command again.
   * Creating and closing terminals still needs a real editor.
   */
  terminalActions(): Pick<ActionHandlers, TerminalActionKind> {
    const offline = (): ActionResult => ({ ok: false, error: 'editor_offline' });
    return {
      'terminal.sendText': ({ terminalId, text, execute }) => {
        const terminal = this.openTerminal(terminalId);
        if (!terminal.ok) return terminal;
        this.sendText(terminal.ctx, text, execute);
        return { ok: true };
      },
      'terminal.interrupt': ({ terminalId }) => {
        const terminal = this.openTerminal(terminalId);
        if (!terminal.ok) return terminal;
        this.interrupt(terminal.ctx);
        return { ok: true };
      },
      'terminal.rerun': ({ execId }) => {
        const execution = this.store.state.executions[execId];
        if (!execution) return { ok: false, error: 'unknown_execution' };
        const terminal = this.openTerminal(execution.terminalId);
        if (!terminal.ok) return terminal;
        if (execution.commandLine.trim() === '') return { ok: false, error: NOTHING_TO_RERUN };
        this.rerun(terminal.ctx, execution.commandLine);
        return { ok: true };
      },
      'terminal.focus': ({ terminalId }) => {
        const terminal = this.openTerminal(terminalId);
        return terminal.ok ? { ok: true } : terminal;
      },
      'terminal.create': offline,
      'terminal.close': offline,
    };
  }

  // Setup

  private seedBoard(): void {
    const ts = this.now();
    const windowIds = DEMO_WINDOWS.map(() => `demo-window-${this.rng.hex(8)}`);
    for (const def of DEMO_PROJECTS) {
      const id = projectIdFromPath(def.path);
      const project: ProjectCtx = {
        id,
        def,
        windowId: windowIds[def.window] ?? `demo-window-${def.window}`,
        dirty: this.rng.int(0, 4),
        seededAt: ts,
        scenarioCursor: 0,
      };
      this.projects.push(project);
      this.store.upsertProject({
        id,
        path: def.path,
        name: def.name,
        accent: accentIndexForProject(id),
        source: 'editor',
        git: this.gitInfo(project, ts),
        createdAt: ts - this.rng.int(1, 30) * 86_400_000,
        lastActivityAt: ts - this.rng.int(10, 600) * 1000,
      });
    }

    DEMO_WINDOWS.forEach((app, index) => {
      const members = this.projects.filter((p) => p.def.window === index);
      const id = windowIds[index];
      if (!id || members.length === 0) return;
      this.store.upsertWindow({
        id,
        appName: app.appName,
        appVersion: app.appVersion,
        extensionVersion: '0.1.0',
        workspaceFolders: members.map((p) => p.def.path),
        projectIds: members.map((p) => p.id),
        capabilities: { shellExecution: true },
        connectedAt: ts - this.rng.int(5, 240) * 60_000,
        lastSeenAt: ts,
      });
    });

    for (const project of this.projects) {
      project.def.terminals.forEach((def, index) => {
        const terminal: TerminalCtx = {
          id: `demo-term-${project.def.name}-${index + 1}`,
          project,
          def,
          shellPid: this.rng.int(20_000, 89_999),
          execId: null,
          childPid: null,
          session: null,
          busyUntil: 0,
        };
        this.terminals.push(terminal);
        this.store.upsertTerminal({
          id: terminal.id,
          windowId: project.windowId,
          name: def.name,
          projectId: project.id,
          shellPid: terminal.shellPid,
          cwd: project.def.path,
          shellIntegration: true,
          active: index === project.def.terminals.length - 1,
          createdAt: ts - this.rng.int(1, 90) * 60_000,
        });
      });
    }
  }

  private bootTerminal(terminal: TerminalCtx): void {
    const { kind } = terminal.def;
    switch (kind) {
      case 'next':
      case 'vite':
      case 'rails':
        this.after(this.rng.int(100, 1_200), () => this.bootDevServer(terminal, kind));
        return;
      case 'jest':
        this.after(this.rng.int(1_000, 6_000), () => this.runTests(terminal));
        return;
      case 'shell':
        this.after(this.rng.int(1_500, 8_000), () => this.runShellCommand(terminal));
        return;
      case 'claude':
        this.after(this.rng.int(200, 2_000), () => this.launchClaude(terminal));
        return;
    }
  }

  // Pulse backfill: the last 15 minutes of synthetic activity, so the rail isn't empty on load.

  private pastEvent(
    ts: number,
    kind: ActivityKind,
    terminal: TerminalCtx,
    session: SessionCtx | null,
    summary: string,
    data: Record<string, unknown> = {},
  ): void {
    // A turn that would run into the present is cut off there.
    if (ts > this.now() - 2_000) return;
    this.onActivity({
      id: `demo-past-${++this.seq}`,
      ts,
      kind,
      projectId: terminal.project.id,
      sessionId: session?.id ?? null,
      terminalId: terminal.id,
      execId: null,
      summary,
      data,
    });
  }

  private backfillTerminal(terminal: TerminalCtx): void {
    const rng = this.pastRng;
    const now = this.now();
    const { kind } = terminal.def;
    if (kind === 'claude') return;
    if (kind === 'next' || kind === 'vite' || kind === 'rails') {
      // One earlier crash and restart for some dev servers.
      if (!rng.chance(0.4)) return;
      const command = DEV_SERVERS[kind].command;
      const at = now - rng.int(6, 13) * 60_000;
      this.pastEvent(at, 'exec.start', terminal, null, command);
      this.pastEvent(at + rng.int(60, 240) * 1_000, 'exec.end', terminal, null, command, {
        exitCode: 1,
      });
      return;
    }
    let at = now - rng.int(13, 14) * 60_000;
    while (at < now - 20_000) {
      const command = kind === 'jest' ? 'pnpm jest' : rng.pick(SHELL_COMMANDS).command;
      const exitCode = kind === 'jest' && rng.chance(0.25) ? 1 : 0;
      this.pastEvent(at, 'exec.start', terminal, null, command);
      this.pastEvent(at + rng.int(800, 6_000), 'exec.end', terminal, null, command, { exitCode });
      at += rng.int(kind === 'jest' ? 70 : 100, kind === 'jest' ? 160 : 260) * 1_000;
    }
  }

  private backfillSession(session: SessionCtx): void {
    const rng = this.pastRng;
    const { terminal } = session;
    const scenarios = session.project.def.scenarios;
    const now = this.now();
    let at = now - rng.int(12, 14) * 60_000;
    this.pastEvent(at, 'session.start', terminal, session, 'Session started');
    while (at < now - 60_000) {
      const scenario = rng.pick(scenarios);
      at += rng.int(10, 40) * 1_000;
      this.pastEvent(at, 'prompt', terminal, session, scenario.prompt);
      const tools = scenario.tools.length;
      for (const tool of scenario.tools.slice(0, rng.int(Math.min(2, tools), tools))) {
        at += rng.int(4, 18) * 1_000;
        const label = `${tool.tool} ${tool.summary}`;
        this.pastEvent(at, 'tool.start', terminal, session, label, { tool_name: tool.tool });
        at += rng.int(1, 8) * 1_000;
        const failed = rng.chance(0.06);
        this.pastEvent(at, failed ? 'tool.error' : 'tool.end', terminal, session, label, {
          tool_name: tool.tool,
        });
      }
      const permission = scenario.permissions[0];
      if (permission && rng.chance(0.3)) {
        at += rng.int(2, 6) * 1_000;
        this.pastEvent(
          at,
          'permission.request',
          terminal,
          session,
          `${permission.tool} needs approval`,
        );
        at += rng.int(5, 40) * 1_000;
        this.pastEvent(at, 'permission.decision', terminal, session, `${permission.tool} allowed`);
      }
      at += rng.int(3, 10) * 1_000;
      this.pastEvent(at, 'stop', terminal, session, scenario.title);
      at += rng.int(60, 200) * 1_000;
    }
  }

  // Dev servers

  private bootDevServer(terminal: TerminalCtx, kind: DevServerKind): void {
    const script = DEV_SERVERS[kind];
    const port = terminal.def.port ?? 3000;
    const execId = this.startExec(terminal, script.command);
    terminal.execId = execId;
    terminal.childPid = this.rng.int(20_000, 89_999);
    const banner = script.banner(port);
    banner.forEach((chunk, index) => {
      this.after(250 * (index + 1), () => this.write(terminal, execId, chunk));
    });
    this.after(250 * banner.length + 50, () => {
      if (terminal.execId !== execId) return;
      this.bindPort(terminal, port);
      this.devServerTick(terminal, kind, execId);
    });
  }

  private devServerTick(terminal: TerminalCtx, kind: DevServerKind, execId: string): void {
    this.after(this.rng.int(1_500, 6_000), () => {
      if (terminal.execId !== execId) return;
      const script = DEV_SERVERS[kind];
      if (this.rng.chance(CRASH_CHANCE)) {
        this.write(terminal, execId, script.crash(this.rng));
        this.endExec(terminal, execId, 1);
        terminal.execId = null;
        terminal.childPid = null;
        this.unbindPort(terminal);
        this.toast(
          'error',
          `${terminal.def.name} crashed`,
          terminal.project,
          'Restarting in a few seconds',
        );
        this.after(this.rng.int(3_000, 7_000), () => this.bootDevServer(terminal, kind));
        return;
      }
      this.write(terminal, execId, script.tick(this.rng, this.now()));
      this.devServerTick(terminal, kind, execId);
    });
  }

  private bindPort(terminal: TerminalCtx, port: number): void {
    const address = '127.0.0.1';
    this.ports.set(terminal.id, {
      id: `${address}:${port}`,
      port,
      address,
      pid: terminal.childPid ?? terminal.shellPid,
      command: terminal.def.kind === 'rails' ? 'ruby' : 'node',
      terminalId: terminal.id,
      projectId: terminal.project.id,
      firstSeenAt: this.now(),
    });
    this.store.setPorts([...this.ports.values()]);
  }

  private unbindPort(terminal: TerminalCtx): void {
    if (this.ports.delete(terminal.id)) this.store.setPorts([...this.ports.values()]);
  }

  // Tests and shell commands

  private runTests(terminal: TerminalCtx): void {
    const run = jestRun(this.rng, terminal.project.def);
    const execId = this.startExec(terminal, 'pnpm jest');
    run.chunks.forEach((chunk, index) => {
      this.after(400 * (index + 1), () => this.write(terminal, execId, chunk));
    });
    this.after(400 * run.chunks.length + 100, () => {
      this.endExec(terminal, execId, run.failed ? 1 : 0);
      if (run.failed) this.toast('warning', 'Tests failed', terminal.project, terminal.def.name);
      this.after(this.rng.int(20_000, 45_000), () => this.runTests(terminal));
    });
  }

  private runShellCommand(terminal: TerminalCtx): void {
    const command = this.rng.pick(SHELL_COMMANDS);
    const execId = this.startExec(terminal, command.command);
    this.after(this.rng.int(150, 900), () => {
      this.write(terminal, execId, command.output(this.rng, terminal.project.def));
      this.endExec(terminal, execId, command.exitCode ?? 0);
      this.after(this.rng.int(15_000, 50_000), () => this.runShellCommand(terminal));
    });
  }

  // Board input

  private openTerminal(
    terminalId: string,
  ): { ok: true; ctx: TerminalCtx } | { ok: false; error: string } {
    const ctx = this.running ? this.terminals.find((t) => t.id === terminalId) : undefined;
    if (!ctx) return { ok: false, error: 'unknown_terminal' };
    if (this.store.state.terminals[terminalId]?.state !== 'open') {
      return { ok: false, error: 'terminal_closed' };
    }
    return { ok: true, ctx };
  }

  private sendText(terminal: TerminalCtx, text: string, execute: boolean): void {
    // A running program gets the input, and the pty echoes it into its output.
    if (terminal.execId) {
      this.write(terminal, terminal.execId, execute ? `${text}\r\n` : text);
      return;
    }
    // At the prompt, only a submitted line does anything visible.
    const command = text.split(/\r?\n/)[0]?.trim() ?? '';
    if (execute && command !== '') this.runTyped(terminal, command);
  }

  private runTyped(terminal: TerminalCtx, commandLine: string): void {
    const { output, exitCode } = typedCommand(commandLine, this.rng, terminal.project.def);
    const execId = this.startExec(terminal, commandLine);
    this.after(this.rng.int(80, 240), () => {
      if (output !== '') this.write(terminal, execId, output);
      this.endExec(terminal, execId, exitCode);
    });
  }

  private interrupt(terminal: TerminalCtx): void {
    const execId = terminal.execId;
    if (!execId) return;
    const { kind } = terminal.def;
    if (kind === 'claude') {
      // Claude Code asks for a second Ctrl+C before it exits; the session carries on.
      this.write(terminal, execId, `\r\n${'\x1b[2m'}Press Ctrl-C again to exit${'\x1b[22m'}\r\n`);
      return;
    }
    this.write(terminal, execId, '^C\r\n');
    this.endExec(terminal, execId, INTERRUPTED_EXIT);
    terminal.execId = null;
    terminal.childPid = null;
    this.unbindPort(terminal);
  }

  private rerun(terminal: TerminalCtx, commandLine: string): void {
    const { kind } = terminal.def;
    if (terminal.execId) return;
    if (
      (kind === 'next' || kind === 'vite' || kind === 'rails') &&
      DEV_SERVERS[kind].command === commandLine
    ) {
      this.bootDevServer(terminal, kind);
      return;
    }
    this.runTyped(terminal, commandLine);
  }

  // Claude sessions

  private launchClaude(terminal: TerminalCtx): void {
    const { project } = terminal;
    const model = this.rng.pick(DEMO_MODELS);
    const execId = this.startExec(terminal, 'claude');
    this.store.markExecInteractive(execId);
    terminal.execId = execId;
    terminal.childPid = this.rng.int(20_000, 89_999);
    this.write(terminal, execId, claudeBanner(project.def, model));

    const id = this.rng.uuid();
    const encodedCwd = project.def.path.replaceAll('/', '-');
    const session: SessionCtx = {
      id,
      project,
      terminal,
      timer: undefined,
      nudge: undefined,
      turn: null,
      approval: null,
    };
    this.sessions.set(id, session);
    this.seedTranscript(session, model);
    this.backfillSession(session);
    terminal.session = session;
    // No hook yet: the session shows as "unknown, alive" until SessionStart.
    this.store.upsertSession({
      id,
      origin: 'terminal',
      projectId: project.id,
      cwd: project.def.path,
      model,
      permissionMode: 'default',
      terminalId: terminal.id,
      claudePid: terminal.childPid,
      transcriptPath: `${DEMO_HOME}/.claude/projects/${encodedCwd}/${id}.jsonl`,
      contextTokens: this.rng.int(18_000, 120_000),
    });
    session.timer = this.after(this.rng.int(500, 2_500), () => {
      this.store.setSessionStatus(id, { kind: 'idle' });
      this.activity('session.start', session, 'Session started');
      this.scheduleTurn(session, this.rng.int(1_000, 6_000));
    });
  }

  private scheduleTurn(session: SessionCtx, delay: number): void {
    session.timer = this.after(delay, () => this.beginTurn(session));
    if (delay > 20_000) {
      session.nudge = this.after(this.rng.int(12_000, 18_000), () => {
        this.store.setSessionStatus(session.id, { kind: 'waiting_input' });
        this.activity('notification', session, 'Claude is waiting for your input', {
          notification_type: 'idle_prompt',
        });
      });
    }
  }

  private beginTurn(session: SessionCtx): void {
    this.cancel(session.nudge);
    const { project } = session;
    const scenario = project.def.scenarios[project.scenarioCursor++ % project.def.scenarios.length];
    if (!scenario) return;
    session.turn = { scenario, steps: this.rng.int(4, 8), done: 0 };
    this.store.updateSession(session.id, {
      title: scenario.title,
      lastAssistantText: null,
      todos: this.todos(scenario, 0),
    });
    this.store.setSessionStatus(session.id, { kind: 'working' });
    this.addTokens(session, this.rng.int(800, 3_000), 0);
    this.activity('prompt', session, scenario.prompt);
    this.transcript(session, { kind: 'user', text: scenario.prompt });
    if (this.textRng.chance(0.6)) {
      this.transcript(session, {
        kind: 'thinking',
        text: `I'll start with the todo list: ${scenario.todos.join('; ')}.`,
      });
    }
    this.todoWrite(session, scenario, 0);
    session.timer = this.after(this.rng.int(600, 1_500), () => this.nextStep(session));
  }

  private nextStep(session: SessionCtx): void {
    const turn = session.turn;
    if (!turn) return;
    if (turn.done >= turn.steps) {
      this.finishTurn(session);
      return;
    }
    const ctx = this.store.state.sessions[session.id]?.contextTokens ?? 0;
    if (ctx > COMPACT_AT_TOKENS) {
      this.compact(session, { kind: 'working' });
      return;
    }
    const before = this.doneTodos(turn.scenario, turn.done / turn.steps);
    turn.done += 1;
    this.store.updateSession(session.id, {
      todos: this.todos(turn.scenario, turn.done / turn.steps),
    });
    const after = this.doneTodos(turn.scenario, turn.done / turn.steps);
    if (after !== before) this.todoWrite(session, turn.scenario, after);
    if (this.rng.chance(0.3)) {
      this.streamText(session, this.rng.pick(turn.scenario.texts));
    } else {
      this.runTool(session, this.rng.pick(turn.scenario.tools));
    }
  }

  /** Streams assistant text a few words at a time, then moves on. */
  private streamText(session: SessionCtx, text: string): void {
    const words = text.split(' ');
    let shown = 0;
    const emit = () => {
      shown = Math.min(words.length, shown + this.rng.int(2, 5));
      this.store.updateSession(session.id, { lastAssistantText: words.slice(0, shown).join(' ') });
      this.addTokens(session, 0, 8);
      if (shown < words.length) {
        session.timer = this.after(this.rng.int(90, 220), emit);
      } else {
        this.transcript(session, { kind: 'assistant', text });
        session.timer = this.after(this.rng.int(400, 1_200), () => this.nextStep(session));
      }
    };
    this.store.setSessionStatus(session.id, { kind: 'working' });
    session.timer = this.after(100, emit);
  }

  private runTool(session: SessionCtx, tool: DemoTool): void {
    const toolUseId = `toolu_${this.rng.hex(24)}`;
    const activity: ToolActivity = {
      id: toolUseId,
      sessionId: session.id,
      tool: tool.tool,
      family: toolFamily(tool.tool),
      summary: tool.summary,
      startedAt: this.now(),
      endedAt: null,
      status: 'running',
    };
    this.store.setSessionStatus(session.id, { kind: 'tool', tool: tool.tool, toolUseId });
    this.store.updateSession(session.id, { currentTool: activity });
    this.activity('tool.start', session, `${tool.tool} ${tool.summary}`, {
      tool_name: tool.tool,
      tool_use_id: toolUseId,
    });
    if (tool.tool === 'Task') this.spawnSubagent(session, tool.summary);
    const call = demoToolCall(session.project.def, tool, this.textRng);
    this.transcript(session, { kind: 'tool_use', toolUseId, name: call.name, input: call.input });

    const duration = tool.tool === 'Bash' ? this.rng.int(2_000, 7_000) : this.rng.int(500, 3_000);
    session.terminal.busyUntil = this.now() + duration;
    session.timer = this.after(duration, () => {
      const failed = this.rng.chance(0.06);
      this.transcript(session, {
        kind: 'tool_result',
        toolUseId,
        text: failed ? call.error : call.result,
        isError: failed,
      });
      this.activity(failed ? 'tool.error' : 'tool.end', session, `${tool.tool} ${tool.summary}`, {
        tool_name: tool.tool,
        tool_use_id: toolUseId,
      });
      this.addTokens(session, this.rng.int(1_500, 9_000), this.rng.int(80, 900));
      if (!failed && tool.tool === 'Edit') this.markDirty(session.project);
      this.store.setSessionStatus(session.id, { kind: 'working' });
      session.timer = this.after(this.rng.int(400, 1_200), () => this.nextStep(session));
    });
  }

  private spawnSubagent(session: SessionCtx, description: string): void {
    const current = this.store.state.sessions[session.id];
    if (!current) return;
    const id = `agent-${this.rng.hex(12)}`;
    const subagents = [
      ...current.subagents.slice(-(MAX_SUBAGENTS - 1)),
      {
        id,
        type: this.rng.pick(['general-purpose', 'Explore']),
        description,
        status: 'running' as const,
        startedAt: this.now(),
        endedAt: null,
      },
    ];
    this.store.updateSession(session.id, { subagents });
    this.activity('subagent.start', session, description, { agent_id: id });
    this.after(this.rng.int(6_000, 16_000), () => {
      const latest = this.store.state.sessions[session.id];
      if (!latest) return;
      const status = this.rng.chance(0.08) ? ('error' as const) : ('done' as const);
      this.store.updateSession(session.id, {
        subagents: latest.subagents.map((agent) =>
          agent.id === id ? { ...agent, status, endedAt: this.now() } : agent,
        ),
      });
      this.activity('subagent.stop', session, description, { agent_id: id });
    });
  }

  private compact(session: SessionCtx, previous: ResumableSessionStatus): void {
    this.store.setSessionStatus(session.id, { kind: 'compacting', previous });
    this.activity('compact.start', session, 'Compacting conversation', { trigger: 'auto' });
    session.timer = this.after(this.rng.int(3_000, 6_000), () => {
      this.store.updateSession(session.id, { contextTokens: this.rng.int(22_000, 38_000) });
      this.store.setSessionStatus(session.id, previous);
      this.activity('compact.end', session, 'Conversation compacted');
      session.timer = this.after(this.rng.int(400, 1_000), () => this.nextStep(session));
    });
  }

  private finishTurn(session: SessionCtx): void {
    const turn = session.turn;
    session.turn = null;
    if (!turn) return;
    if (this.rng.chance(0.05)) {
      const message = this.rng.pick(['API Error: 529 Overloaded', 'Request timed out']);
      this.store.setSessionStatus(session.id, { kind: 'error', message });
      this.activity('stop.failure', session, message);
      this.toast('error', 'Claude stopped with an error', session.project, message);
      session.timer = this.after(this.rng.int(8_000, 14_000), () => {
        this.store.setSessionStatus(session.id, { kind: 'idle' });
        this.scheduleTurn(session, this.rng.int(4_000, 15_000));
      });
      return;
    }
    this.store.updateSession(session.id, {
      todos: this.todos(turn.scenario, 1),
      lastAssistantText: turn.scenario.texts.at(-1) ?? null,
    });
    this.transcript(session, {
      kind: 'assistant',
      text: demoAssistantText(turn.scenario, this.textRng, true),
    });
    this.store.setSessionStatus(session.id, { kind: 'idle' });
    this.activity('stop', session, turn.scenario.title);
    if (this.rng.chance(0.06)) {
      session.timer = this.after(this.rng.int(2_000, 6_000), () => this.endSession(session));
      return;
    }
    this.scheduleTurn(session, this.rng.int(5_000, 30_000));
  }

  private endSession(session: SessionCtx): void {
    const { terminal } = session;
    this.cancel(session.nudge);
    this.store.setSessionStatus(session.id, { kind: 'ended' });
    this.activity('session.end', session, 'Session ended', { reason: 'prompt_input_exit' });
    if (terminal.execId) this.endExec(terminal, terminal.execId, 0);
    terminal.execId = null;
    terminal.childPid = null;
    terminal.session = null;
    this.after(this.rng.int(15_000, 25_000), () => {
      this.sessions.delete(session.id);
      this.store.removeSession(session.id);
      this.transcripts.forget(session.id);
      this.launchClaude(terminal);
    });
  }

  // Permissions

  private requestPermission(): void {
    const candidates = [...this.sessions.values()].filter(
      (s) =>
        s.turn !== null &&
        s.approval === null &&
        this.store.state.sessions[s.id]?.status.kind === 'working',
    );
    if (candidates.length === 0) {
      this.after(2_000, () => this.requestPermission());
      return;
    }
    const session = this.rng.pick(candidates);
    const permission = this.rng.pick(session.turn?.scenario.permissions ?? []);
    const ts = this.now();
    const approval: Approval = {
      id: `demo-approval-${this.rng.hex(12)}`,
      sessionId: session.id,
      source: 'hook',
      tool: permission.tool,
      input: permission.input,
      toolUseId: `toolu_${this.rng.hex(24)}`,
      createdAt: ts,
      expiresAt: ts + this.approvalTimeoutMs,
      state: 'pending',
      decidedAt: null,
      reason: null,
    };
    this.cancel(session.timer);
    session.approval = approval;
    this.store.upsertApproval(approval);
    this.store.setSessionStatus(session.id, {
      kind: 'waiting_permission',
      approvalId: approval.id,
    });
    this.activity('permission.request', session, `${permission.tool} needs approval`, {
      tool_name: permission.tool,
      approval_id: approval.id,
    });
    this.onMessage(makeMessage('approval.new', { approval }, { ts }));
    session.timer = this.after(this.approvalTimeoutMs, () =>
      this.resolveApproval(session, 'expired', null),
    );

    const jitter = Math.round(this.permissionIntervalMs * 0.2);
    this.after(this.permissionIntervalMs + this.rng.int(-jitter, jitter), () =>
      this.requestPermission(),
    );
  }

  private resolveApproval(
    session: SessionCtx,
    state: 'allowed' | 'denied' | 'expired',
    reason: string | null,
  ): void {
    const approval = session.approval;
    if (!approval) return;
    this.cancel(session.timer);
    session.approval = null;
    this.store.resolveApproval(approval.id, state, reason);
    this.onMessage(makeMessage('approval.resolved', { approvalId: approval.id, state, reason }));
    this.activity('permission.decision', session, `${approval.tool} ${state}`, {
      approval_id: approval.id,
      decision: state,
    });
    this.after(RESOLVED_APPROVAL_TTL_MS, () => this.store.removeApproval(approval.id));

    if (state === 'allowed') {
      this.runTool(session, { tool: approval.tool, summary: describeInput(approval.input) });
    } else {
      this.streamText(session, "Understood, I won't run that. I'll take a different approach.");
    }
  }

  // Transcripts

  private seedTranscript(session: SessionCtx, model: string): void {
    this.transcripts.open(session.id, model);
    const long = !this.longHistory && session.project === this.projects[0];
    if (long) this.longHistory = true;
    const count = long ? DEMO_LONG_HISTORY : this.textRng.int(12, 90);
    const seed = Number.parseInt(session.id.slice(0, 8), 16);
    for (const { entry, ts } of demoHistory(session.project.def, seed, count, this.now())) {
      this.transcripts.append(session.id, entry, ts);
    }
  }

  private transcript(session: SessionCtx, entry: DemoEntry): void {
    this.transcripts.append(session.id, entry, this.now());
  }

  // Shared plumbing

  private sampleStats(): void {
    const ts = this.now();
    for (const terminal of this.terminals) {
      const busy = terminal.execId !== null || terminal.busyUntil > ts;
      const working = terminal.session
        ? this.store.state.sessions[terminal.session.id]?.status.kind !== 'idle'
        : false;
      const base = terminal.def.kind === 'shell' ? 0.2 : busy ? 3 : 0.4;
      const cpu = base + (working ? this.rng.int(8, 45) : this.rng.next() * (busy ? 14 : 1.2));
      const rssMb = { next: 520, vite: 210, rails: 340, jest: 180, shell: 12, claude: 290 }[
        terminal.def.kind
      ];
      this.store.setTerminalStats(terminal.id, {
        pid: terminal.shellPid,
        cpu: Math.round(cpu * 10) / 10,
        rssBytes: Math.round(
          Math.max(rssMb / 2, rssMb + this.rng.int(-30, 60)) * 1024 * 1024 * (busy ? 1 : 0.1),
        ),
        processCount: busy ? this.rng.int(2, 9) : 1,
        sampledAt: ts,
      });
    }
  }

  private startExec(terminal: TerminalCtx, commandLine: string): string {
    const execId = `demo-exec-${++this.seq}`;
    this.store.startExec({
      execId,
      terminalId: terminal.id,
      commandLine,
      confidence: 'high',
      cwd: terminal.project.def.path,
    });
    this.emitActivity(
      'exec.start',
      terminal.project.id,
      null,
      terminal.id,
      execId,
      commandLine,
      {},
    );
    return execId;
  }

  private write(terminal: TerminalCtx, execId: string, chunk: string): void {
    if (this.store.appendExecOutput(execId, chunk)) {
      terminal.busyUntil = Math.max(terminal.busyUntil, this.now() + 1_000);
    }
  }

  private endExec(terminal: TerminalCtx, execId: string, exitCode: number): void {
    this.store.endExec(execId, exitCode);
    const command = this.store.state.executions[execId]?.commandLine ?? null;
    this.emitActivity('exec.end', terminal.project.id, null, terminal.id, execId, command, {
      exitCode,
    });
  }

  private addTokens(session: SessionCtx, input: number, output: number): void {
    const current = this.store.state.sessions[session.id];
    if (!current) return;
    const cacheRead = input > 0 ? input * this.rng.int(3, 8) : 0;
    this.store.updateSession(session.id, {
      tokens: {
        input: current.tokens.input + input,
        output: current.tokens.output + output,
        cacheRead: current.tokens.cacheRead + cacheRead,
        cacheCreation: current.tokens.cacheCreation + Math.round(input / 4),
      },
      contextTokens: (current.contextTokens ?? 0) + input + output,
    });
  }

  private markDirty(project: ProjectCtx): void {
    project.dirty = Math.min(project.dirty + 1, 24);
    const current = this.store.state.projects[project.id];
    if (current) this.store.upsertProject({ ...current, git: this.gitInfo(project, this.now()) });
  }

  private gitInfo(project: ProjectCtx, ts: number): GitInfo {
    const { def } = project;
    const pool = [...def.testFiles, ...DEMO_CHANGED_FILES];
    const files = pool.slice(0, Math.min(project.dirty, GIT_MAX_FILES)).map(
      (path, index): GitFileChange => ({
        path,
        origPath: null,
        status: index === pool.length - 1 ? 'untracked' : index % 4 === 3 ? 'added' : 'modified',
        staged: index % 3 === 0,
        unstaged: index % 3 !== 0 || index === pool.length - 1,
      }),
    );
    const offset = def.name.length % DEMO_COMMITS.length;
    const commits = Array.from({ length: GIT_MAX_COMMITS }, (_, index) => {
      const commit = DEMO_COMMITS[(offset + index) % DEMO_COMMITS.length] ?? DEMO_COMMITS[0];
      return {
        hash: projectIdFromPath(`${def.path}#${index}`).padEnd(40, '0').slice(0, 40),
        author: commit.author,
        at: project.seededAt - (index + 1) * 5_400_000,
        subject: commit.subject,
      };
    });
    return {
      branch: def.branch,
      head: commits[0]?.hash ?? null,
      detached: false,
      dirty: project.dirty,
      upstream: `origin/${def.branch}`,
      ahead: def.branch === 'main' ? 0 : 2,
      behind: def.name === 'orbit-api' ? 1 : 0,
      files,
      commits,
      updatedAt: ts,
    };
  }

  private doneTodos(scenario: DemoScenario, progress: number): number {
    return Math.min(scenario.todos.length, Math.floor(progress * scenario.todos.length));
  }

  /** Mirrors a todo update into the transcript as a TodoWrite call. */
  private todoWrite(session: SessionCtx, scenario: DemoScenario, done: number): void {
    if (scenario.todos.length === 0) return;
    const toolUseId = `toolu_demo_todo_${(this.todoCalls++).toString(36)}`;
    const input = demoTodos(scenario, done);
    this.transcript(session, { kind: 'tool_use', toolUseId, name: 'TodoWrite', input });
    this.transcript(session, { kind: 'tool_result', toolUseId, text: TODO_RESULT, isError: false });
  }

  private todos(scenario: DemoScenario, progress: number): ClaudeSession['todos'] {
    const doneCount = this.doneTodos(scenario, progress);
    return scenario.todos.map((content, index) => ({
      content,
      status: index < doneCount ? 'completed' : index === doneCount ? 'in_progress' : 'pending',
      activeForm: index === doneCount ? `${content}…` : null,
    }));
  }

  private toast(
    level: 'info' | 'success' | 'warning' | 'error',
    title: string,
    project: ProjectCtx,
    body?: string,
  ): void {
    this.onMessage(
      makeMessage('toast', {
        level,
        title,
        projectId: project.id,
        ...(body === undefined ? {} : { body }),
      }),
    );
  }

  private activity(
    kind: ActivityKind,
    session: SessionCtx,
    summary: string,
    data: Record<string, unknown> = {},
  ): void {
    this.emitActivity(
      kind,
      session.project.id,
      session.id,
      session.terminal.id,
      null,
      summary,
      data,
    );
  }

  private emitActivity(
    kind: ActivityKind,
    projectId: string,
    sessionId: string | null,
    terminalId: string | null,
    execId: string | null,
    summary: string | null,
    data: Record<string, unknown>,
  ): void {
    this.onActivity({
      id: `demo-evt-${++this.seq}`,
      ts: this.now(),
      kind,
      projectId,
      sessionId,
      terminalId,
      execId,
      summary,
      data,
    });
  }

  private now(): number {
    return Date.now();
  }

  private after(ms: number, fn: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.running) fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private every(ms: number, fn: () => void): void {
    this.after(ms, () => {
      fn();
      this.every(ms, fn);
    });
  }

  private cancel(timer: NodeJS.Timeout | undefined): void {
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(timer);
  }
}

function describeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'url']) {
      if (typeof record[key] === 'string') return record[key];
    }
  }
  return 'requested action';
}
