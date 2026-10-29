import {
  type ActivityEvent,
  type ActivityKind,
  accentIndexForProject,
  GIT_MAX_COMMITS,
  GIT_MAX_FILES,
  type GitFileChange,
  type GitInfo,
  type PortBinding,
  projectIdFromPath,
  type SessionHistoryEntry,
  type SessionStatus,
  type TokenUsage,
  toolFamily,
} from '@yardmaster/protocol';
import { BoardStore } from '../store.js';
import { DEMO_HOME } from './content.js';

// The `?worst=1` demo board: realistic worst-case data for layout testing. Long
// names, branches and commands, empty and 99+ collections, huge token counts, non-Latin text,
// emoji and missing fields. Static apart from a little live output; everything is made up.

const MIN = 60_000;
const HOUR = 60 * MIN;
const TICK_MS = 700;

const LONG_NAME = 'northwind-industries-customer-onboarding-platform-monorepo';
const LONG_BRANCH = 'feature/NW-48213-migrate-legacy-subscription-billing-webhooks-to-eventbridge';
const LONG_AUTHOR = 'Aleksandra Wiśniewska-Kowalczyk';
const LONG_COMMAND =
  'NODE_OPTIONS=--max-old-space-size=8192 pnpm turbo run dev --filter=@northwind/web... --filter=@northwind/billing-webhooks --concurrency=20 --output-logs=new-only';
const LONG_PATH =
  'packages/billing-webhooks/src/handlers/subscription/legacy/__tests__/invoice-payment-succeeded-with-proration-and-tax-adjustments.test.ts';
const LONG_REPLY = [
  'I traced the duplicate invoices to the legacy webhook handler: it acknowledges the event before the idempotency key is written, so a retry from the payment provider inside the 30 s window creates a second invoice.',
  '',
  'The fix moves the write into the same transaction as the invoice insert and returns 200 only after commit. I also found three other handlers with the same pattern (`invoice.payment_failed`, `customer.subscription.updated` and `charge.refunded`) and would like to fix them in this branch too, since they share the helper.',
  'Running the full billing suite now, which takes about four minutes on this machine because the proration fixtures replay eleven months of usage records for every plan tier.',
].join('\n');
const LONG_ERROR =
  'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CWorstCaseFixture0000000000"}';

interface ProjectDef {
  name: string;
  /** Folder under the demo home; defaults to the name. */
  folder?: string;
  git:
    | (Omit<GitInfo, 'updatedAt' | 'files' | 'commits'> & {
        files?: number;
        commits?: number;
      })
    | null;
  sessions: SessionDef[];
  terminals: TerminalDef[];
}

interface SessionDef {
  status: SessionStatus;
  title?: string | null;
  /** A name the user gave it (`/rename`). */
  customTitle?: string;
  model?: string | null;
  tokens?: Partial<TokenUsage>;
  tool?: { tool: string; summary: string | null };
  text?: string | null;
  subagents?: number;
  approval?: { tool: string; input: Record<string, unknown> };
}

interface TerminalDef {
  name: string;
  command?: string;
  /** Exit code once finished; omitted = still running. */
  exit?: number;
  ports?: { port: number; command: string | null }[];
  /** Gets a new line of output every tick. */
  streaming?: boolean;
  output?: string[];
}

const SAMPLE_TOKENS: TokenUsage = {
  input: 18_400,
  output: 6_200,
  cacheRead: 240_000,
  cacheCreation: 9_800,
};

function manySessions(count: number): SessionDef[] {
  return Array.from({ length: count }, (_, i) => ({
    status: i % 9 === 0 ? { kind: 'working' } : { kind: 'idle' },
    title: `Shard ${i + 1} soak test`,
    tokens: { input: 1_000 * (i + 1), output: 400 * (i + 1) },
    text: i % 9 === 0 ? `Replaying shard ${i + 1} at 4× production traffic.` : null,
  }));
}

function manyTerminals(count: number): TerminalDef[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `worker-${String(i + 1).padStart(3, '0')}`,
    command: `node dist/worker.js --shard=${i + 1} --of=${count}`,
    ...(i % 17 === 5
      ? { exit: 1, output: [`Error: connect ECONNREFUSED 127.0.0.1:${6379 + (i % 4)}`] }
      : {}),
    ...(i < 2 ? { streaming: true } : {}),
  }));
}

const PROJECTS: ProjectDef[] = [
  {
    name: LONG_NAME,
    git: {
      branch: LONG_BRANCH,
      head: '9f8e7d6',
      detached: false,
      dirty: 1_284,
      upstream: `origin/${LONG_BRANCH}`,
      ahead: 99,
      behind: 1_203,
      files: GIT_MAX_FILES,
      commits: GIT_MAX_COMMITS,
    },
    sessions: [
      {
        status: { kind: 'waiting_permission', approvalId: null },
        title: 'Migrate every legacy subscription billing webhook handler to EventBridge',
        customTitle: 'billing-webhooks-eventbridge-migration-with-a-name-nobody-should-type',
        model: 'claude-opus-5-5',
        tokens: {
          input: 1_204_881_337,
          output: 48_213_904,
          cacheRead: 9_876_543_210,
          cacheCreation: 312_004_118,
        },
        tool: {
          tool: 'Bash',
          summary:
            'pnpm --filter @northwind/billing-webhooks exec prisma migrate deploy --schema ./packages/billing/prisma/schema.prisma',
        },
        approval: {
          tool: 'Bash',
          input: {
            command:
              'pnpm --filter @northwind/billing-webhooks exec prisma migrate deploy --schema ./packages/billing/prisma/schema.prisma',
          },
        },
        text: LONG_REPLY,
      },
      {
        status: { kind: 'tool', tool: 'Edit', toolUseId: 'toolu_worst_edit' },
        title: 'Proration tests',
        tokens: { input: 999_949, output: 1 },
        tool: { tool: 'Edit', summary: LONG_PATH },
        subagents: 6,
        text: 'Updating the proration fixtures.',
      },
      { status: { kind: 'error', message: LONG_ERROR }, title: 'Retry queue', text: LONG_REPLY },
      { status: { kind: 'working' }, title: null, text: LONG_REPLY, subagents: 2 },
      {
        status: { kind: 'waiting_input' },
        title: 'Which region should own the dead-letter queue?',
      },
      {
        status: { kind: 'compacting', previous: { kind: 'working' } },
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      },
      {
        status: { kind: 'tool', tool: 'WebFetch', toolUseId: null },
        tool: {
          tool: 'WebFetch',
          summary:
            'https://docs.example.com/eventbridge/latest/userguide/eb-rule-dead-letter-queue.html?tab=cli&lang=typescript#retry-policy',
        },
      },
      { status: { kind: 'idle' }, title: null, model: null, text: null },
    ],
    terminals: [
      {
        name: 'pnpm --filter @northwind/web dev',
        command: LONG_COMMAND,
        streaming: true,
        ports: [
          {
            port: 3000,
            command:
              'node /home/dev/northwind/node_modules/.pnpm/next@16.0.0/node_modules/next/dist/server/lib/start-server.js',
          },
          { port: 3001, command: 'node' },
          { port: 9229, command: null },
          { port: 24678, command: 'node' },
        ],
        output: [
          '\u001b[32m✓\u001b[0m Compiled /api/webhooks/billing/subscription/legacy/invoice-payment-succeeded in 18.4s (4821 modules)',
          '\u001b[33mwarn\u001b[0m  - ./packages/billing-webhooks/src/handlers/subscription/legacy/index.ts: export "handleInvoicePaymentSucceededWithProrationAndTaxAdjustments" was not found',
        ],
      },
      {
        name: 'billing tests',
        command: `pnpm vitest run ${LONG_PATH}`,
        exit: 1,
        output: [
          ` FAIL  ${LONG_PATH} > invoice.payment_succeeded > prorates a mid-cycle upgrade across two tax jurisdictions`,
          "AssertionError: expected { amount: 4821, currency: 'eur', lines: [ …(14) ] } to deeply equal { amount: 4820, currency: 'eur', lines: [ …(14) ] }",
        ],
      },
      {
        name: 'queue worker',
        command: 'node --inspect=0.0.0.0:9230 dist/queue-worker.js',
        exit: 137,
        output: [
          '<--- Last few GCs --->',
          'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
        ],
      },
      { name: '', command: '' },
      { name: 'zsh', command: 'git log --oneline --graph --decorate --all', exit: 130 },
      {
        name: 'docker compose',
        command:
          'docker compose -f docker-compose.yml -f docker-compose.override.yml up --build postgres redis localstack',
        streaming: true,
      },
    ],
  },
  {
    name: '東京オフィス-在庫管理システム',
    git: {
      branch: '機能/在庫の自動補充',
      head: 'a1b2c3d',
      detached: false,
      dirty: 7,
      upstream: null,
      ahead: 3,
      behind: 0,
      files: 7,
      commits: 3,
    },
    sessions: [
      {
        status: { kind: 'working' },
        title: '在庫の自動補充ロジック',
        text: '補充しきい値を倉庫ごとに設定できるようにしています。既存のテストはすべて通りました。',
      },
      {
        status: { kind: 'idle' },
        title: 'تحسين صفحة الدفع',
        text: 'انتهيت من تحديث صفحة الدفع، وجميع الاختبارات ناجحة الآن.',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 },
      },
    ],
    terminals: [
      {
        name: '開発サーバー',
        command: 'pnpm dev --host 0.0.0.0',
        streaming: true,
        ports: [{ port: 5173, command: 'node' }],
        output: [
          '  ➜  ローカル:   http://localhost:5173/',
          '  ➜  ネットワーク: http://192.168.0.12:5173/',
        ],
      },
      { name: 'zsh', command: 'echo "在庫の自動補充 ✓"', exit: 0 },
    ],
  },
  {
    name: '👩🏽‍💻 portfolio',
    folder: 'portfolio',
    git: {
      branch: '✨/dark-mode-🌙',
      head: 'c0ffee1',
      detached: false,
      dirty: 1,
      upstream: 'origin/✨/dark-mode-🌙',
      ahead: 1,
      behind: 1,
      files: 1,
      commits: 1,
    },
    sessions: [
      {
        status: { kind: 'waiting_input' },
        title: '🎨 Pick a palette for the 🌙 theme',
        text: 'Which of these three palettes 🎨 should the dark mode use?',
      },
    ],
    terminals: [{ name: '🚀 deploy', command: 'vercel deploy --prod 🚀', exit: 0 }],
  },
  { name: 'x', git: null, sessions: [], terminals: [] },
  {
    // Nothing but failures: every session errored, every terminal exited non-zero.
    name: 'nightly-etl',
    git: {
      branch: 'main',
      head: 'badf00d',
      detached: false,
      dirty: 0,
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
    },
    sessions: [
      { status: { kind: 'error', message: LONG_ERROR }, title: 'Backfill the warehouse' },
      {
        status: { kind: 'error', message: 'Prompt is too long' },
        title: 'Explain the failing DAG',
      },
    ],
    terminals: [
      {
        name: 'airflow scheduler',
        command: 'airflow scheduler',
        exit: 137,
        output: ['Killed'],
      },
      {
        name: 'dbt run',
        command: 'dbt run --select +orders',
        exit: 2,
        output: ['Compilation Error in model orders (models/orders.sql)'],
      },
    ],
  },
  {
    name: 'fleet-load-test',
    git: {
      branch: null,
      head: '0d15ea5e0d15ea5e',
      detached: true,
      dirty: 0,
      upstream: null,
      ahead: 0,
      behind: 0,
    },
    sessions: manySessions(104),
    terminals: manyTerminals(127),
  },
  {
    name: 'Đặng-Thị-Ngọc-Hân-portfolio',
    git: {
      branch: null,
      head: null,
      detached: false,
      dirty: 0,
      upstream: null,
      ahead: 0,
      behind: 0,
    },
    sessions: [
      {
        status: {
          kind: 'tool',
          tool: 'mcp__northwind-internal-docs__search_confluence_pages_by_label',
          toolUseId: null,
        },
        title: null,
        model: null,
        text: null,
      },
      { status: { kind: 'unknown', alive: true }, title: '   ', model: null, text: '```\n---\n' },
    ],
    terminals: [
      {
        name: 'Ứng dụng',
        command: 'npm run dev -- --port 4321',
        ports: [{ port: 4321, command: 'node' }],
      },
    ],
  },
];

const ACTIVITY: { kind: ActivityKind; summary: string | null; ago: number }[] = [
  { kind: 'tool.start', summary: LONG_COMMAND, ago: 40_000 },
  { kind: 'tool.error', summary: LONG_ERROR, ago: 90_000 },
  { kind: 'permission.request', summary: 'Bash: prisma migrate deploy', ago: 120_000 },
  { kind: 'exec.end', summary: '在庫の自動補充 ✓', ago: 200_000 },
  { kind: 'prompt', summary: 'تحسين صفحة الدفع', ago: 260_000 },
  { kind: 'stop', summary: null, ago: 300_000 },
];

export interface WorstBoardOptions {
  now?: () => number;
}

/**
 * The worst-case board, served to `/ws/ui?worst=1` in demo mode. It lives in its own store so the
 * regular demo board is untouched, and only writes output while a client is watching.
 */
export class WorstBoard {
  readonly store: BoardStore;
  private readonly now: () => number;
  private readonly history = new Map<string, SessionHistoryEntry[]>();
  private readonly streaming: { execId: string; lines: string[]; next: number }[] = [];
  private readonly events: ActivityEvent[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(options: WorstBoardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.store = new BoardStore({ now: this.now });
    this.seed();
    this.store.flush();
  }

  /** Writes live output while `active()` holds. */
  start(active: () => boolean): void {
    this.timer ??= setInterval(() => {
      if (active()) this.tick();
    }, TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  recentActivity(): ActivityEvent[] {
    return this.events;
  }

  sessionHistory(projectId: string): SessionHistoryEntry[] | undefined {
    return this.history.get(projectId);
  }

  private tick(): void {
    for (const stream of this.streaming) {
      const line = stream.lines[stream.next % stream.lines.length] ?? '';
      stream.next++;
      this.store.appendExecOutput(stream.execId, `${line}\r\n`);
    }
  }

  private seed(): void {
    const ts = this.now();
    const windowId = 'worst-window-1';
    const ids = PROJECTS.map((def) => projectIdFromPath(`${DEMO_HOME}/${def.folder ?? def.name}`));
    this.store.upsertWindow({
      id: windowId,
      appName: 'Cursor',
      appVersion: '2.1.4',
      extensionVersion: '0.1.0',
      workspaceFolders: PROJECTS.map((def) => `${DEMO_HOME}/${def.folder ?? def.name}`),
      projectIds: ids,
      capabilities: { shellExecution: true },
      connectedAt: ts - 3 * HOUR,
      lastSeenAt: ts,
    });
    const ports: PortBinding[] = [];
    let pid = 40_000;
    PROJECTS.forEach((def, p) => {
      const id = ids[p] ?? '';
      const path = `${DEMO_HOME}/${def.folder ?? def.name}`;
      this.store.upsertProject({
        id,
        path,
        name: def.name,
        accent: accentIndexForProject(id),
        source: 'editor',
        git: def.git ? gitInfo(def.git, ts) : null,
        createdAt: ts - 30 * 24 * HOUR,
        lastActivityAt: def.sessions.length + def.terminals.length > 0 ? ts - MIN : null,
      });

      const terminalIds: string[] = [];
      def.terminals.forEach((t, i) => {
        const terminalId = `worst-term-${p}-${i}`;
        terminalIds.push(terminalId);
        this.store.upsertTerminal({
          id: terminalId,
          windowId,
          name: t.name,
          projectId: id,
          shellPid: ++pid,
          cwd: path,
          shellIntegration: true,
          createdAt: ts - (i + 1) * MIN,
        });
        if (t.command === undefined) return;
        const execId = `worst-exec-${p}-${i}`;
        this.store.startExec({
          execId,
          terminalId,
          commandLine: t.command,
          confidence: 'high',
          cwd: path,
          startedAt: ts - (i + 2) * 7 * MIN - (i === 0 ? 26 * HOUR : 0),
        });
        const lines = t.output ?? [`${t.command}`, '\u001b[2mwaiting for changes…\u001b[0m'];
        for (const line of lines) this.store.appendExecOutput(execId, `${line}\r\n`);
        if (t.exit !== undefined) this.store.endExec(execId, t.exit, ts - (i + 1) * MIN);
        if (t.streaming) this.streaming.push({ execId, lines, next: 0 });
        for (const port of t.ports ?? []) {
          ports.push({
            id: `127.0.0.1:${port.port}`,
            port: port.port,
            address: '127.0.0.1',
            pid: ++pid,
            command: port.command,
            terminalId,
            projectId: id,
            firstSeenAt: ts - 10 * MIN,
          });
        }
      });

      def.sessions.forEach((s, i) => {
        const sessionId = `worst-session-${p}-${String(i).padStart(3, '0')}`;
        let status = s.status;
        if (s.approval) {
          const approvalId = `worst-approval-${p}-${i}`;
          this.store.upsertApproval({
            id: approvalId,
            sessionId,
            source: 'hook',
            tool: s.approval.tool,
            input: s.approval.input,
            toolUseId: null,
            createdAt: ts - 30_000,
            // Far enough out that the countdown ring never runs dry during a screenshot.
            expiresAt: ts + 10 * HOUR,
            state: 'pending',
            decidedAt: null,
            reason: null,
          });
          status = { kind: 'waiting_permission', approvalId };
        }
        this.store.upsertSession({
          id: sessionId,
          projectId: id,
          cwd: path,
          status,
          title: s.title === undefined ? `Session ${i + 1}` : s.title,
          ...(s.customTitle ? { customTitle: s.customTitle } : {}),
          model: s.model === undefined ? 'claude-sonnet-5-5' : s.model,
          permissionMode: s.model === null ? null : 'default',
          tokens: { ...SAMPLE_TOKENS, ...s.tokens },
          contextTokens: null,
          currentTool: s.tool
            ? {
                id: `worst-tool-${p}-${i}`,
                sessionId,
                tool: s.tool.tool,
                family: toolFamily(s.tool.tool),
                summary: s.tool.summary,
                startedAt: ts - 20_000,
                endedAt: null,
                status: 'running',
              }
            : null,
          subagents: Array.from({ length: s.subagents ?? 0 }, (_, n) => ({
            id: `worst-agent-${p}-${i}-${n}`,
            type: 'general-purpose',
            description: `Audit handler group ${n + 1}`,
            status: 'running' as const,
            startedAt: ts - MIN,
            endedAt: null,
          })),
          terminalId: null,
          lastAssistantText: s.text === undefined ? null : s.text,
          startedAt: ts - (i + 1) * 3 * MIN,
          updatedAt: ts - 30_000,
        });
      });

      this.history.set(id, pastSessions(id, def, ts));
    });
    this.store.setPorts(ports);

    ACTIVITY.forEach((event, i) => {
      this.events.push({
        id: `worst-activity-${i}`,
        ts: ts - event.ago,
        kind: event.kind,
        projectId: ids[0] ?? null,
        sessionId: null,
        terminalId: null,
        execId: null,
        summary: event.summary,
        data: event.kind === 'exec.end' ? { exitCode: 0 } : {},
      });
    });
    this.events.reverse();
  }
}

function gitInfo(def: NonNullable<ProjectDef['git']>, ts: number): GitInfo {
  const { files = 0, commits = 0, ...rest } = def;
  return {
    ...rest,
    files: Array.from(
      { length: files },
      (_, i): GitFileChange => ({
        path:
          i % 3 === 0 ? LONG_PATH.replace('.test.ts', `-${i}.test.ts`) : `src/handlers/h${i}.ts`,
        origPath: i % 50 === 7 ? `src/legacy/handlers/old-name-${i}.ts` : null,
        status:
          i % 50 === 7
            ? 'renamed'
            : i % 11 === 0
              ? 'untracked'
              : i % 13 === 0
                ? 'conflicted'
                : 'modified',
        staged: i % 4 === 0,
        unstaged: i % 4 !== 0 || i % 11 === 0,
      }),
    ),
    commits: Array.from({ length: commits }, (_, i) => ({
      hash: `${(0x9f8e7d6 - i).toString(16)}c5b4a3f2e1d0`,
      author: i % 2 === 0 ? LONG_AUTHOR : 'Jo',
      at: ts - (i + 1) * 5 * HOUR - (i === commits - 1 ? 400 * 24 * HOUR : 0),
      subject:
        i === 0
          ? 'Move idempotency key write into the invoice transaction so provider retries inside the 30 s window no longer create duplicate invoices (NW-48213)'
          : i === 1
            ? 'wip'
            : `Fix handler group ${i}`,
    })),
    updatedAt: ts,
  };
}

function pastSessions(projectId: string, def: ProjectDef, ts: number): SessionHistoryEntry[] {
  if (def.sessions.length === 0) return [];
  return Array.from({ length: 6 }, (_, i) => ({
    id: `0000000${i}-5b4a-4c3d-8e2f-1a0b9c8d7e6f`,
    projectId,
    title: i === 0 ? null : i === 1 ? (def.sessions[0]?.title ?? null) : `Earlier session ${i}`,
    firstPrompt:
      i === 0
        ? 'Can you look at why the billing webhooks create duplicate invoices when the payment provider retries? It started after the EventBridge migration and only happens in eu-central-1.'
        : null,
    cwd: `${DEMO_HOME}/${def.folder ?? def.name}`,
    gitBranch: i === 0 ? (def.git?.branch ?? null) : null,
    createdAt: i === 5 ? null : ts - (i + 1) * 26 * HOUR,
    updatedAt: ts - (i + 1) * 25 * HOUR - (i === 5 ? 700 * 24 * HOUR : 0),
    fileSize: i === 0 ? 2_147_483_648 : i === 5 ? 0 : 48_213 * (i + 1),
    tokens:
      i === 0
        ? {
            input: 12_048_813_370,
            output: 482_139_040,
            cacheRead: 98_765_432_100,
            cacheCreation: 3_120_041_180,
          }
        : i === 5
          ? null
          : SAMPLE_TOKENS,
  }));
}
