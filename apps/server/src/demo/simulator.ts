import {
  type ActivityEvent,
  type ActivityKind,
  type Approval,
  type ApprovalDecision,
  accentIndexForProject,
  type BackgroundTask,
  type ClaudeSession,
  endBackground,
  GIT_MAX_COMMITS,
  GIT_MAX_FILES,
  type GitFileChange,
  type GitInfo,
  makeMessage,
  type PortBinding,
  type Project,
  projectIdFromPath,
  type ResumableSessionStatus,
  type ServerToUi,
  type SessionHistoryEntry,
  startBackground,
  type ToolActivity,
  toolFamily,
} from '@c-board/protocol';
import type { ActionHandlers, ActionResult } from '../actions.js';
import { NOTHING_TO_RERUN, type TerminalActionKind } from '../editor-actions.js';
import type { BoardStore } from '../store.js';
import {
  DEMO_BACKGROUND_GAP_MS,
  DEMO_BACKGROUND_SHELL_MS,
  DEMO_CHANGED_FILES,
  DEMO_COMMITS,
  DEMO_HOME,
  DEMO_MODELS,
  DEMO_PAST_SESSIONS,
  DEMO_PROJECTS,
  DEMO_WINDOWS,
  type DemoBackground,
  type DemoProject,
  type DemoScenario,
  type DemoTerminal,
  type DemoTool,
  type TerminalKind,
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
import { firehoseLines, STRESS_TOOLS_PER_SECOND, stressProjects } from './stress.js';
import {
  type DemoEntry,
  DemoTranscripts,
  demoAssistantText,
  demoHistory,
  demoTodos,
  demoToolCall,
  TODO_RESULT,
} from './transcripts.js';
import { readTuiInput } from './tui-input.js';

/** PRD F12: a permission request roughly every 45 s. */
export const DEMO_PERMISSION_INTERVAL_MS = 45_000;
export const DEMO_APPROVAL_TIMEOUT_MS = 120_000;
const CRASH_CHANCE = 0.012;
/** What a crashed dev server exits with. */
const CRASH_EXIT_CODE = 1;
/** The `staysDown` dev server crashes on this tick (a few seconds after it boots). */
const STAYS_DOWN_AFTER_TICKS = 2;
/** A quiet terminal's newest history is at least this old, past the board's idle threshold. */
const QUIET_MS = 6 * 60_000;
/** What the history's subagents were doing. */
const PAST_SUBAGENTS = [
  'Explore the checkout flow',
  'Review the test coverage',
  'Search for unused exports',
  'Draft the migration notes',
] as const;
const quiet = (def: DemoProject) => def.terminals.every((t) => t.quiet === true);
const COMPACT_AT_TOKENS = 150_000;
const STATS_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const RESOLVED_APPROVAL_TTL_MS = 60_000;
const MAX_SUBAGENTS = 6;
/** How often a log firehose writes a chunk. */
const FIREHOSE_CHUNK_MS = 50;

/** How fast Claude sessions work. */
interface Pace {
  bashMs: [number, number];
  toolMs: [number, number];
  stepGapMs: [number, number];
  textChance: number;
  steps: [number, number];
  turnGapMs: [number, number];
  tokenScale: number;
}

const NORMAL_PACE: Pace = {
  bashMs: [2_000, 7_000],
  toolMs: [500, 3_000],
  stepGapMs: [400, 1_200],
  textChance: 0.3,
  steps: [4, 8],
  turnGapMs: [5_000, 30_000],
  tokenScale: 1,
};

/** About `STRESS_TOOLS_PER_SECOND` tool calls per second, in long turns. */
const STRESS_CYCLE_MS = Math.round(1_000 / STRESS_TOOLS_PER_SECOND);
const STRESS_PACE: Pace = {
  bashMs: [Math.round(STRESS_CYCLE_MS * 0.5), Math.round(STRESS_CYCLE_MS * 0.9)],
  toolMs: [Math.round(STRESS_CYCLE_MS * 0.5), Math.round(STRESS_CYCLE_MS * 0.9)],
  stepGapMs: [Math.round(STRESS_CYCLE_MS * 0.1), Math.round(STRESS_CYCLE_MS * 0.3)],
  textChance: 0,
  steps: [40, 80],
  turnGapMs: [1_000, 2_000],
  tokenScale: 0.05,
};
const STRESS_APPROVAL_TIMEOUT_MS = 3_000;
/** How long a new terminal takes to appear, and then to start its command. */
const CREATE_DELAY_MS = 300;
/** How long an editor window takes to connect after "Open in Cursor". */
const OPEN_EDITOR_DELAY_MS = 900;
const DEV_KINDS: ReadonlySet<TerminalKind> = new Set(['next', 'vite', 'rails']);

/** What a terminal created with this command plays out as. */
function createdKind(commandLine: string): TerminalKind {
  if (commandLine === 'claude' || commandLine.startsWith('claude ')) return 'claude';
  if (commandLine === 'pnpm jest') return 'jest';
  for (const kind of ['next', 'vite', 'rails'] as const) {
    if (DEV_SERVERS[kind].command === commandLine) return kind;
  }
  return 'shell';
}

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
  /** The `--demo-stress` board: 10 projects × 6 terminals, log firehoses and fast sessions. */
  stress?: boolean;
  /** How many projects the stress board has (default `STRESS_PROJECTS`). */
  projects?: number;
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
  /** Dev server ticks so far, for the one that crashes on purpose. */
  ticks: number;
  /** What sits typed at Claude's prompt, for a terminal running claude. */
  prompt: string;
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
  /** Background work draws apart, so it doesn't shift the rest of the seeded demo. */
  private readonly bgRng: Rng;
  private readonly historySeed: number;
  private readonly history = new Map<string, SessionHistoryEntry[]>();
  private readonly onActivity: (event: ActivityEvent) => void;
  private readonly onMessage: (message: ServerToUi) => void;
  private readonly permissionIntervalMs: number;
  private readonly approvalTimeoutMs: number;
  private readonly defs: DemoProject[];
  private readonly pace: Pace;
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
    this.bgRng = new Rng((options.seed ?? 0xc0ffee) ^ 0xb6b6);
    this.historySeed = (options.seed ?? 0xc0ffee) ^ 0x4157;
    this.transcripts = options.transcripts ?? new DemoTranscripts();
    this.onActivity = options.onActivity ?? (() => {});
    this.onMessage = options.onMessage ?? (() => {});
    this.permissionIntervalMs = options.permissionIntervalMs ?? DEMO_PERMISSION_INTERVAL_MS;
    // Unanswered stress approvals expire quickly, so the sessions keep their pace.
    this.approvalTimeoutMs =
      options.approvalTimeoutMs ??
      (options.stress ? STRESS_APPROVAL_TIMEOUT_MS : DEMO_APPROVAL_TIMEOUT_MS);
    this.defs = options.stress ? stressProjects(options.projects) : DEMO_PROJECTS;
    this.pace = options.stress ? STRESS_PACE : NORMAL_PACE;
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
      const rename = terminal.def.renameTo;
      if (rename) {
        this.after(rename.afterMs, () =>
          this.store.upsertTerminal({
            id: terminal.id,
            windowId: terminal.project.windowId,
            name: rename.name,
          }),
        );
      }
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
   * A new terminal opens as an editor would open one; closing terminals still needs a real
   * editor.
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
      'terminal.create': ({ projectId, name, command }) =>
        this.createTerminal(projectId, name, command),
      'terminal.close': offline,
    };
  }

  /**
   * A library folder opened from the board (12.2): it joins the demo board without an editor
   * window or terminals, ready for a session, a terminal or "Open in Cursor".
   */
  addProject(project: Project, git: boolean): void {
    if (!this.running || this.projects.some((p) => p.id === project.id)) {
      this.store.upsertProject(project);
      return;
    }
    const ctx: ProjectCtx = {
      id: project.id,
      def: {
        name: project.name,
        path: project.path,
        branch: 'main',
        window: -1,
        terminals: [],
        testFiles: [],
        scenarios: DEMO_PROJECTS[0]?.scenarios ?? [],
      },
      // Not the seeded random sequence: opening a folder mustn't shift the rest of the demo.
      windowId: `demo-window-${project.id}`,
      dirty: 0,
      seededAt: project.createdAt,
      scenarioCursor: 0,
    };
    this.projects.push(ctx);
    this.store.upsertProject({
      ...project,
      git: git ? this.gitInfo(ctx, project.createdAt) : null,
    });
  }

  /** "Open in Cursor" plays out as a Cursor window for the project connecting a moment later. */
  editorActions(): Pick<ActionHandlers, 'project.openInEditor'> {
    return {
      'project.openInEditor': ({ projectId }) => {
        const project = this.running ? this.projects.find((p) => p.id === projectId) : undefined;
        if (!project) return { ok: false, error: 'unknown_project' };
        if (this.store.state.windows[project.windowId]) return { ok: true, editor: 'Cursor' };
        this.after(OPEN_EDITOR_DELAY_MS, () => {
          const ts = this.now();
          this.store.upsertWindow({
            id: project.windowId,
            appName: 'Cursor',
            appVersion: DEMO_WINDOWS[0].appVersion,
            extensionVersion: '0.1.0',
            workspaceFolders: [project.def.path],
            projectIds: [project.id],
            capabilities: { shellExecution: true },
            connectedAt: ts,
            lastSeenAt: ts,
          });
        });
        return { ok: true, editor: 'Cursor' };
      },
    };
  }

  /** Synthetic past sessions of a project, newest first; made once, stable after that. */
  sessionHistory(projectId: string): SessionHistoryEntry[] {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) return [];
    let entries = this.history.get(projectId);
    if (!entries) {
      entries = this.pastSessions(project);
      this.history.set(projectId, entries);
    }
    return entries;
  }

  // Setup

  private seedBoard(): void {
    const ts = this.now();
    const windowIds = DEMO_WINDOWS.map(() => `demo-window-${this.rng.hex(8)}`);
    for (const def of this.defs) {
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
        lastActivityAt: ts - this.rng.int(10, 600) * 1000 - (quiet(def) ? QUIET_MS : 0),
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
          ticks: 0,
          prompt: '',
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
    for (const project of this.projects) this.seedInterrupted(project);
  }

  /** A board session left `interrupted` by a restart (10.9e); resuming it runs the demo query. */
  private seedInterrupted(project: ProjectCtx): void {
    const def = project.def.interrupted;
    if (!def) return;
    const ts = this.now();
    const model = DEMO_MODELS[0];
    this.transcripts.open(def.id, model);
    const seed = Number.parseInt(def.id.slice(0, 8), 16);
    for (const { entry, ts: at } of demoHistory(project.def, seed, 14, ts - 4 * 60_000)) {
      this.transcripts.append(def.id, entry, at);
    }
    this.store.upsertSession({
      id: def.id,
      origin: 'board',
      projectId: project.id,
      cwd: project.def.path,
      status: { kind: 'interrupted', turnRunning: true },
      title: def.title,
      model,
      permissionMode: 'default',
      startedAt: ts - 25 * 60_000,
      updatedAt: ts - 4 * 60_000,
    });
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
        if (terminal.def.quiet) return;
        if (terminal.def.linesPerSecond) {
          this.after(this.rng.int(100, 600), () => this.runFirehose(terminal));
          return;
        }
        this.after(this.rng.int(1_500, 8_000), () => this.runShellCommand(terminal));
        return;
      case 'claude':
        this.after(this.rng.int(200, 2_000), () => this.launchClaude(terminal));
        return;
    }
  }

  // History backfill: the last hour of synthetic activity, so the Pulse rail and the Transit map
  // aren't empty on load.

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
      const at = now - rng.int(6, 50) * 60_000;
      this.pastEvent(at, 'exec.start', terminal, null, command);
      this.pastEvent(at + rng.int(60, 240) * 1_000, 'exec.end', terminal, null, command, {
        exitCode: 1,
      });
      return;
    }
    let at = now - rng.int(52, 58) * 60_000;
    const until = now - (terminal.def.quiet ? QUIET_MS : 20_000);
    while (at < until) {
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
    let at = now - rng.int(48, 58) * 60_000;
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
      // Some turns hand part of the work to a subagent: a Transit branch line.
      const end = at + rng.int(60, 240) * 1_000;
      if (rng.chance(0.25) && end < now - 60_000) {
        const description = rng.pick(PAST_SUBAGENTS);
        const agentId = `past-agent-${this.seq + 1}`;
        this.pastEvent(at, 'subagent.start', terminal, session, description, { agentId });
        this.pastEvent(end, 'subagent.stop', terminal, session, description, { agentId });
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
      terminal.ticks++;
      const staysDown = terminal.def.staysDown === true;
      // Once: after a rerun from the board it stays up.
      if (staysDown ? terminal.ticks === STAYS_DOWN_AFTER_TICKS : this.rng.chance(CRASH_CHANCE)) {
        this.write(terminal, execId, script.crash(this.rng));
        this.endExec(terminal, execId, CRASH_EXIT_CODE);
        terminal.execId = null;
        terminal.childPid = null;
        this.unbindPort(terminal);
        this.toast(
          'error',
          `${terminal.def.name} crashed in ${terminal.project.def.name}`,
          terminal.project,
          `Exit code ${CRASH_EXIT_CODE}. ${staysDown ? 'Rerun it from the board.' : 'Restarting in a few seconds.'}`,
        );
        if (!staysDown) {
          this.after(this.rng.int(3_000, 7_000), () => this.bootDevServer(terminal, kind));
        }
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
      if (run.failed) {
        this.toast(
          'warning',
          `Tests failed in ${terminal.project.def.name}`,
          terminal.project,
          `pnpm jest exited with code 1 in ${terminal.def.name}.`,
        );
      }
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

  /** A long-running `tail -f` that writes `linesPerSecond` lines in small, steady chunks. */
  private runFirehose(terminal: TerminalCtx): void {
    const execId = this.startExec(terminal, 'tail -f logs/access.log');
    terminal.execId = execId;
    terminal.childPid = this.rng.int(20_000, 89_999);
    const perChunk = ((terminal.def.linesPerSecond ?? 0) * FIREHOSE_CHUNK_MS) / 1_000;
    let owed = 0;
    const tick = () => {
      if (terminal.execId !== execId) return;
      owed += perChunk;
      const count = Math.floor(owed);
      owed -= count;
      if (count > 0) this.write(terminal, execId, firehoseLines(this.rng, this.now(), count));
      this.after(FIREHOSE_CHUNK_MS, tick);
    };
    tick();
  }

  // Board input

  /** A terminal opened from the board: it shows up shortly after, then runs `command`, if any. */
  private createTerminal(projectId: string, name?: string, command?: string): ActionResult {
    const project = this.running ? this.projects.find((p) => p.id === projectId) : undefined;
    if (!project) return { ok: false, error: 'unknown_project' };
    const commandLine = command?.trim() ?? '';
    const kind = createdKind(commandLine);
    const def: DemoTerminal = { kind, name: name ?? project.def.name, quiet: true };
    const port = DEV_KINDS.has(kind) ? this.freePort() : undefined;
    if (port !== undefined) def.port = port;
    const terminal: TerminalCtx = {
      id: `demo-term-${project.def.name}-new-${++this.seq}`,
      project,
      def,
      shellPid: this.rng.int(20_000, 89_999),
      execId: null,
      childPid: null,
      session: null,
      busyUntil: 0,
      ticks: 0,
      prompt: '',
    };
    this.after(CREATE_DELAY_MS, () => {
      for (const other of this.terminals) {
        if (other.project.windowId === project.windowId && other.id !== terminal.id) {
          this.store.upsertTerminal({
            id: other.id,
            windowId: project.windowId,
            name: other.def.name,
            active: false,
          });
        }
      }
      this.terminals.push(terminal);
      this.store.upsertTerminal({
        id: terminal.id,
        windowId: project.windowId,
        name: def.name,
        projectId: project.id,
        shellPid: terminal.shellPid,
        cwd: project.def.path,
        shellIntegration: true,
        active: true,
        createdAt: this.now(),
      });
      if (commandLine === '') return;
      this.after(CREATE_DELAY_MS, () => {
        if (kind === 'claude') this.launchClaude(terminal);
        else if (kind === 'jest') this.runTests(terminal);
        else if (kind === 'next' || kind === 'vite' || kind === 'rails') {
          this.bootDevServer(terminal, kind);
        } else this.runTyped(terminal, commandLine);
      });
    });
    return { ok: true };
  }

  /** A port no demo dev server is bound to, from 3001 up. */
  private freePort(): number {
    const taken = new Set([
      ...[...this.ports.values()].map((p) => p.port),
      ...this.terminals.map((t) => t.def.port),
    ]);
    let port = 3001;
    while (taken.has(port)) port++;
    return port;
  }

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
    const session = terminal.session;
    if (terminal.execId && session) {
      // Claude's TUI: text and Enter in one burst is a paste, where the Enter is a newline.
      const input = readTuiInput(terminal.prompt, execute ? `${text}\r` : text);
      terminal.prompt = input.buffer;
      if (input.echo !== '') this.write(terminal, terminal.execId, input.echo);
      // Claude at its prompt takes a submitted prompt as the next turn's.
      for (const prompt of input.submitted) {
        const status = this.store.state.sessions[session.id]?.status.kind;
        if (status !== 'idle' && status !== 'waiting_input') continue;
        this.cancel(session.timer);
        this.beginTurn(session, prompt.trim());
      }
      return;
    }
    if (terminal.execId) {
      this.write(terminal, terminal.execId, execute ? `${text}\r\n` : text);
      return;
    }
    // At the prompt, only a submitted line does anything visible.
    const command = text.split(/\r?\n/)[0]?.trim() ?? '';
    if (execute && command !== '') this.runTyped(terminal, command);
  }

  private runTyped(terminal: TerminalCtx, commandLine: string): void {
    if (commandLine.trim() === 'htop') {
      this.runTui(terminal, commandLine);
      return;
    }
    const { output, exitCode } = typedCommand(commandLine, this.rng, terminal.project.def);
    const execId = this.startExec(terminal, commandLine);
    this.after(this.rng.int(80, 240), () => {
      if (output !== '') this.write(terminal, execId, output);
      this.endExec(terminal, execId, exitCode);
    });
  }

  /** A full-screen app (alternate screen) that runs until Ctrl+C. */
  private runTui(terminal: TerminalCtx, commandLine: string): void {
    const execId = this.startExec(terminal, commandLine);
    this.store.markExecInteractive(execId);
    terminal.execId = execId;
    terminal.childPid = this.rng.int(20_000, 89_999);
    this.write(
      terminal,
      execId,
      '\x1b[?1049h\x1b[H  CPU [||||      12.4%]   Tasks: 214, 1 running\r\n',
    );
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
      ...(terminal.def.sessionName ? { customTitle: terminal.def.sessionName } : {}),
    });
    session.timer = this.after(this.rng.int(500, 2_500), () => {
      this.store.setSessionStatus(id, { kind: 'idle' });
      this.activity('session.start', session, 'Session started');
      if (terminal.def.background) this.backgroundShell(session, terminal.def.background);
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

  private beginTurn(session: SessionCtx, typed?: string): void {
    this.cancel(session.nudge);
    const { project } = session;
    const scenario = project.def.scenarios[project.scenarioCursor++ % project.def.scenarios.length];
    if (!scenario) return;
    session.turn = { scenario, steps: this.rng.int(...this.pace.steps), done: 0 };
    this.store.updateSession(session.id, {
      title: scenario.title,
      lastAssistantText: null,
      todos: this.todos(scenario, 0),
    });
    this.store.setSessionStatus(session.id, { kind: 'working' });
    this.addTokens(session, this.rng.int(800, 3_000), 0);
    const prompt = typed || scenario.prompt;
    this.activity('prompt', session, prompt);
    this.transcript(session, { kind: 'user', text: prompt });
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
    if (this.rng.chance(this.pace.textChance)) {
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

    const duration = this.rng.int(...(tool.tool === 'Bash' ? this.pace.bashMs : this.pace.toolMs));
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
      session.timer = this.after(this.rng.int(...this.pace.stepGapMs), () =>
        this.nextStep(session),
      );
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
    this.activity('subagent.start', session, description, { agentId: id });
    this.after(this.rng.int(6_000, 16_000), () => {
      const latest = this.store.state.sessions[session.id];
      if (!latest) return;
      const status = this.rng.chance(0.08) ? ('error' as const) : ('done' as const);
      this.store.updateSession(session.id, {
        subagents: latest.subagents.map((agent) =>
          agent.id === id ? { ...agent, status, endedAt: this.now() } : agent,
        ),
      });
      this.activity('subagent.stop', session, description, { agentId: id });
    });
  }

  /**
   * A background shell that runs for a while and finishes (now and then with an error), and
   * an async subagent alongside every other run, then again after a pause. The tracker turns
   * the starts and ends into Pulse events.
   */
  private backgroundShell(session: SessionCtx, def: DemoBackground, round = 0): void {
    if (!this.isLive(session)) return;
    const ts = this.now();
    const id = `b${this.bgRng.hex(8)}`;
    let background = startBackground(this.backgroundOf(session), {
      id,
      kind: 'shell',
      label: def.shell.description,
      command: def.shell.command,
      toolUseId: `toolu_${this.bgRng.hex(12)}`,
      ts,
    });
    const agentId = round % 2 === 0 ? this.bgRng.hex(12) : null;
    if (agentId !== null) {
      background = startBackground(background, {
        id: agentId,
        kind: 'agent',
        label: def.agent.description,
        ts,
      });
    }
    const current = this.store.state.sessions[session.id];
    this.store.updateSession(session.id, {
      background,
      ...(agentId !== null && current
        ? {
            subagents: [
              ...current.subagents.slice(-(MAX_SUBAGENTS - 1)),
              {
                id: `agent-${agentId}`,
                type: def.agent.type,
                description: def.agent.description,
                status: 'running' as const,
                startedAt: ts,
                endedAt: null,
              },
            ],
          }
        : {}),
    });
    const runFor = this.bgRng.int(...DEMO_BACKGROUND_SHELL_MS);
    if (agentId !== null) {
      this.after(Math.round(runFor * 0.6), () => this.finishBackground(session, agentId, 0));
    }
    this.after(runFor, () => {
      this.finishBackground(session, id, this.bgRng.chance(0.2) ? 1 : 0);
      this.after(this.bgRng.int(...DEMO_BACKGROUND_GAP_MS), () =>
        this.backgroundShell(session, def, round + 1),
      );
    });
  }

  private finishBackground(session: SessionCtx, id: string, exitCode: number): void {
    const latest = this.store.state.sessions[session.id];
    if (!latest || !this.isLive(session)) return;
    const ts = this.now();
    const background = this.backgroundOf(session).map((task) =>
      task.id === id
        ? endBackground(task, { status: exitCode === 0 ? 'done' : 'error', ts, exitCode })
        : task,
    );
    const subagents = latest.subagents.map((agent) =>
      agent.id === `agent-${id}` && agent.status === 'running'
        ? { ...agent, status: 'done' as const, endedAt: ts }
        : agent,
    );
    this.store.updateSession(session.id, { background, subagents });
  }

  private backgroundOf(session: SessionCtx): BackgroundTask[] {
    return [...(this.store.state.sessions[session.id]?.background ?? [])];
  }

  private isLive(session: SessionCtx): boolean {
    const status = this.store.state.sessions[session.id]?.status.kind;
    return this.running && status !== undefined && status !== 'ended';
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
      this.toast(
        'error',
        `Claude stopped with an error in ${session.project.def.name}`,
        session.project,
        message,
      );
      session.timer = this.after(this.rng.int(8_000, 14_000), () => {
        this.store.setSessionStatus(session.id, { kind: 'idle' });
        this.scheduleTurn(session, this.rng.int(4_000, 15_000));
      });
      return;
    }
    // Like a Stop hook's `last_assistant_message`: the turn's final block, as written.
    const answer = demoAssistantText(turn.scenario, this.textRng, true);
    this.store.updateSession(session.id, {
      todos: this.todos(turn.scenario, 1),
      lastAssistantText: answer,
    });
    this.transcript(session, { kind: 'assistant', text: answer });
    this.store.setSessionStatus(session.id, { kind: 'idle' });
    this.activity('stop', session, turn.scenario.title);
    if (this.rng.chance(0.06)) {
      session.timer = this.after(this.rng.int(2_000, 6_000), () => this.endSession(session));
      return;
    }
    this.scheduleTurn(session, this.rng.int(...this.pace.turnGapMs));
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

  private addTokens(session: SessionCtx, rawInput: number, rawOutput: number): void {
    const current = this.store.state.sessions[session.id];
    if (!current) return;
    const input = Math.round(rawInput * this.pace.tokenScale);
    const output = Math.round(rawOutput * this.pace.tokenScale);
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
    if (current?.git)
      this.store.upsertProject({ ...current, git: this.gitInfo(project, this.now()) });
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
        // The newest lands inside the last hour, so the Transit map has an interchange.
        at: project.seededAt - (18 + ((def.name.length * 7) % 30) + index * 90) * 60_000,
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

  private pastSessions(project: ProjectCtx): SessionHistoryEntry[] {
    let seed = this.historySeed;
    for (const char of project.def.name) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) >>> 0;
    const rng = new Rng(seed);
    // The first scenario is the one running live, so past work starts with the others.
    const pool = [
      ...project.def.scenarios.slice(1).map((s) => ({ title: s.title, prompt: s.prompt })),
      ...DEMO_PAST_SESSIONS,
    ];
    const count = Math.min(pool.length, 5 + (project.def.name.length % 4));
    let at = project.seededAt - rng.int(2, 6) * 3_600_000;
    return pool.slice(0, count).map(({ title, prompt }) => {
      const input = rng.int(4, 220) * 1_000;
      const createdAt = at - rng.int(10, 160) * 60_000;
      const entry: SessionHistoryEntry = {
        id: rng.uuid(),
        projectId: project.id,
        title,
        firstPrompt: prompt,
        cwd: project.def.path,
        gitBranch: project.def.branch,
        createdAt,
        updatedAt: at,
        fileSize: input * 9,
        // Older sessions predate the board, so it never saw their usage.
        tokens:
          rng.next() < 0.75
            ? {
                input,
                output: Math.round(input / rng.int(6, 14)),
                cacheRead: input * rng.int(2, 9),
                cacheCreation: Math.round(input / 4),
              }
            : null,
      };
      at = createdAt - rng.int(1, 40) * 3_600_000;
      return entry;
    });
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
