import { type ChatMessage, sessionIdFromStream, transcriptStreamId } from '@c-board/protocol';
import { type ReadResult, RingBuffer } from '../ring-buffer.js';
import type { StreamSource } from '../ui-gateway.js';
import type { DemoProject, DemoScenario, DemoTool } from './content.js';
import { Rng } from './rng.js';

/** Same cap as the real transcript reader. */
const DEMO_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

type Listener = (streamId: string, seq: number, chunk: string) => void;

/** Assistant messages without the per-entry ids, which `DemoTranscripts` assigns. */
export type DemoEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant' | 'thinking'; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; toolUseId: string; text: string; isError: boolean };

/**
 * `transcript:<sessionId>` streams for `--demo`, in the same normalized `ChatMessage` form the
 * real transcript reader publishes. The simulator appends to them as its sessions work.
 */
export class DemoTranscripts implements StreamSource {
  private readonly rings = new Map<string, RingBuffer>();
  private readonly listeners = new Set<Listener>();
  private readonly models = new Map<string, string>();
  private counter = 0;

  read(streamId: string, fromSeq?: number): ReadResult | undefined {
    const id = sessionIdFromStream(streamId);
    return id === null ? undefined : this.rings.get(id)?.read(fromSeq);
  }

  nextSeq(streamId: string): number {
    const id = sessionIdFromStream(streamId);
    return (id === null ? undefined : this.rings.get(id)?.nextSeq) ?? 0;
  }

  onData(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  open(sessionId: string, model: string): void {
    this.models.set(sessionId, model);
  }

  forget(sessionId: string): void {
    this.rings.delete(sessionId);
    this.models.delete(sessionId);
  }

  /** Appends one entry, stamped `ts`, and publishes it. */
  append(sessionId: string, entry: DemoEntry, ts: number): void {
    let ring = this.rings.get(sessionId);
    if (!ring) {
      ring = new RingBuffer(DEMO_TRANSCRIPT_BYTES);
      this.rings.set(sessionId, ring);
    }
    const chunk = JSON.stringify(this.message(sessionId, entry, ts));
    const seq = ring.append(chunk);
    const streamId = transcriptStreamId(sessionId);
    for (const listener of this.listeners) listener(streamId, seq, chunk);
  }

  private message(sessionId: string, entry: DemoEntry, ts: number): ChatMessage {
    const n = this.counter++;
    const uuid = `demo-${sessionId.slice(0, 8)}-${n.toString(36).padStart(6, '0')}`;
    const base = { id: `${uuid}:0`, uuid, ts };
    switch (entry.kind) {
      case 'user':
        return { ...base, kind: 'user', text: entry.text, meta: false };
      case 'tool_result':
        return { ...base, ...entry };
      default:
        return {
          ...base,
          ...entry,
          messageId: `msg_demo_${n.toString(36)}`,
          model: this.models.get(sessionId) ?? null,
          usage: null,
        };
    }
  }
}

// Synthetic content

const FOLLOW_UPS = [
  'Can you also cover the empty case?',
  'Looks good. Please tidy up the naming before we move on.',
  'Run the tests again, one of them looked flaky.',
  'Why did you choose that approach over a lookup table?',
  'Keep the public API the same, only change the internals.',
] as const;

const THOUGHTS = [
  'The user wants the behaviour changed without touching callers. I should read the module first, find where the value is computed, and check which tests pin the current behaviour.',
  'Two options: patch the call site, or fix it where the data is produced. Fixing it at the source keeps every caller consistent, so I will do that and add a regression test.',
  'The failing assertion compares a rounded value against an unrounded one. I need to decide where rounding belongs before editing anything.',
  'Before editing, check whether anything else depends on the current order. A quick search should tell me.',
] as const;

function langFor(path: string): string {
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.ts')) return 'ts';
  if (path.endsWith('.rb')) return 'ruby';
  if (path.endsWith('.md')) return 'md';
  return '';
}

const SNIPPETS: Record<string, string> = {
  ts: [
    'export function applyAll(items: readonly Item[], rules: readonly Rule[]): number {',
    '  const ordered = [...rules].sort((a, b) => rank(a) - rank(b));',
    '  // Percentages first, so fixed amounts are never scaled.',
    '  return ordered.reduce((total, rule) => rule.apply(total), subtotal(items));',
    '}',
  ].join('\n'),
  tsx: [
    'export function SearchBox({ onQuery }: { onQuery: (q: string) => void }) {',
    "  const [value, setValue] = useState('');",
    '  return <input value={value} onChange={(e) => setValue(e.target.value)} />;',
    '}',
  ].join('\n'),
  ruby: [
    'def index',
    '  orbits = Orbit.order(created_at: :desc).limit(per_page)',
    '  render json: OrbitSerializer.new(orbits).as_json',
    'end',
  ].join('\n'),
  md: ['## Pagination', '', 'Pass `page` and `per_page`. The default page size is 25.'].join('\n'),
};

function fileOf(tool: DemoTool): string {
  return tool.summary.replace(/^"|"$/g, '');
}

/** Before/after pairs for demo edits, with where they sit in the (imaginary) file. */
const EDITS: Record<string, { line: number; before: string; after: string }[]> = {
  ts: [
    {
      line: 41,
      before: [
        'export function applyAll(items: readonly Item[], rules: readonly Rule[]): number {',
        '  return rules.reduce((total, rule) => rule.apply(total), subtotal(items));',
        '}',
      ].join('\n'),
      after: [
        'export function applyAll(items: readonly Item[], rules: readonly Rule[]): number {',
        '  const ordered = [...rules].sort((a, b) => rank(a) - rank(b));',
        '  // Percentages first, so fixed amounts are never scaled.',
        '  return ordered.reduce((total, rule) => rule.apply(total), subtotal(items));',
        '}',
      ].join('\n'),
    },
    {
      line: 12,
      before: 'const MAX_RETRIES = 3;\nconst BASE_DELAY_MS = 200;',
      after: 'const MAX_RETRIES = 5;\nconst BASE_DELAY_MS = 250;\nconst MAX_DELAY_MS = 8_000;',
    },
    {
      line: 88,
      before: "  it('rounds the total', () => {\n    expect(total(cart)).toBe(19.99);\n  });",
      after:
        "  it('rounds the total to whole cents', () => {\n    expect(total(cart)).toBe(1999);\n    expect(Number.isInteger(total(cart))).toBe(true);\n  });",
    },
  ],
  tsx: [
    {
      line: 7,
      before:
        "export function SearchBox({ onQuery }: { onQuery: (q: string) => void }) {\n  const [value, setValue] = useState('');",
      after:
        "export function SearchBox({ onQuery }: { onQuery: (q: string) => void }) {\n  const [value, setValue] = useState('');\n  const deferred = useDeferredValue(value);\n  useEffect(() => onQuery(deferred), [deferred, onQuery]);",
    },
  ],
  ruby: [
    {
      line: 14,
      before: '  def index\n    orbits = Orbit.order(created_at: :desc)\n    render json: orbits',
      after:
        '  def index\n    orbits = Orbit.order(created_at: :desc).limit(per_page).offset(offset)\n    render json: OrbitSerializer.new(orbits).as_json',
    },
  ],
  md: [
    {
      line: 3,
      before: '## Pagination\n\nResults are not paginated.',
      after: '## Pagination\n\nPass `page` and `per_page`. The default page size is 25.',
    },
  ],
};

const numbered = (text: string, first: number) =>
  text
    .split('\n')
    .map((line, i) => `${String(first + i).padStart(6)}\t${line}`)
    .join('\n');

const editResult = (path: string, after: string, line: number) =>
  `The file ${path} has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:\n${numbered(after, line)}`;

/** A tool call and its result, shaped like the real tool's input and output. */
export function demoToolCall(
  project: DemoProject,
  tool: DemoTool,
  rng: Rng,
): { name: string; input: Record<string, unknown>; result: string; error: string } {
  const root = project.path;
  const target = fileOf(tool);
  const name = tool.tool;
  switch (tool.tool) {
    case 'Read': {
      const snippet = SNIPPETS[langFor(target)] ?? SNIPPETS.ts ?? '';
      const offset = rng.chance(0.3) ? rng.int(20, 120) : 1;
      return {
        name,
        input:
          offset > 1
            ? { file_path: `${root}/${target}`, offset, limit: 80 }
            : { file_path: `${root}/${target}` },
        result: numbered(snippet, offset),
        error: `File does not exist: ${root}/${target}`,
      };
    }
    case 'Edit':
    case 'Write': {
      const path = target.startsWith('/') ? target : `${root}/${target}`;
      const edits = EDITS[langFor(path)] ?? EDITS.ts ?? [];
      if (tool.tool === 'Write' || rng.chance(0.08)) {
        const content = SNIPPETS[langFor(path)] ?? SNIPPETS.ts ?? '';
        return {
          name: 'Write',
          input: { file_path: path, content: `${content}\n` },
          result: `File created successfully at: ${path}`,
          error: `EACCES: permission denied, open '${path}'`,
        };
      }
      if (edits.length > 1 && rng.chance(0.25)) {
        const [a, b] = [edits[0], edits[1]] as [(typeof edits)[number], (typeof edits)[number]];
        return {
          name: 'MultiEdit',
          input: {
            file_path: path,
            edits: [
              { old_string: a.before, new_string: a.after },
              { old_string: b.before, new_string: b.after },
            ],
          },
          result: `Applied 2 edits to ${path}:\n1. Replaced "${a.before.split('\n')[0]}…"\n2. Replaced "${b.before.split('\n')[0]}…"`,
          error: 'String to replace not found in file.',
        };
      }
      const edit = rng.pick(edits);
      return {
        name: 'Edit',
        input: { file_path: path, old_string: edit.before, new_string: edit.after },
        result: editResult(path, edit.after, edit.line),
        error: `String to replace not found in file.\nString: ${edit.before.split('\n')[0] ?? ''}`,
      };
    }
    case 'Grep': {
      const files = [
        ...new Set([
          ...project.testFiles,
          ...project.scenarios.flatMap((s) => s.tools.filter((t) => t.tool === 'Edit').map(fileOf)),
        ]),
      ];
      const hits = files.slice(0, rng.int(1, Math.min(5, files.length)));
      return {
        name,
        input: { pattern: target, path: root, output_mode: 'files_with_matches' },
        result: hits.length
          ? `Found ${hits.length} ${hits.length === 1 ? 'file' : 'files'}\n${hits.map((f) => `${root}/${f}`).join('\n')}`
          : 'No files found',
        error: 'Error: regex parse error',
      };
    }
    case 'Glob': {
      const files = project.testFiles.slice(0, rng.int(1, project.testFiles.length));
      return {
        name,
        input: { pattern: target, path: root },
        result: files.map((f) => `${root}/${f}`).join('\n'),
        error: 'Error: invalid glob',
      };
    }
    case 'Bash': {
      const passed = rng.int(4, 40);
      const seconds = `${rng.int(1, 9)}.${rng.int(0, 9)}`;
      return {
        name,
        input: { command: tool.summary, description: `Run ${tool.summary}` },
        result: `> ${tool.summary}\n\n Test Files  ${rng.int(1, 6)} passed\n      Tests  ${passed} passed\n   Duration  ${seconds}s`,
        error: `Exit code 1\n> ${tool.summary}\n\n FAIL  ${project.testFiles[0] ?? 'test'}\n  ✕ applies codes in order (4 ms)\n\n    Expected: 1800\n    Received: 1799\n\n Tests  1 failed, ${passed - 1} passed`,
      };
    }
    case 'Task':
      return {
        name,
        input: {
          description: tool.summary,
          prompt: `${tool.summary}. Report file paths with line numbers and a one-line note for each, and say if anything looks unsafe to change.`,
          subagent_type: 'Explore',
        },
        result: [
          `Found ${rng.int(2, 5)} places worth a look:`,
          '',
          ...project.testFiles
            .slice(0, 3)
            .map(
              (f, i) =>
                `- \`${f}:${12 + i * 17}\`: ${rng.pick(['reads the value directly', 'wraps it in a helper', 'only used in tests'])}`,
            ),
          '',
          'Nothing looks unsafe to change; the helper is the only shared entry point.',
        ].join('\n'),
        error: 'Subagent stopped: the request timed out.',
      };
    case 'WebFetch':
      return {
        name,
        input: { url: `https://${tool.summary}`, prompt: 'Summarise the relevant section' },
        result:
          'The page documents the options. The relevant one is described in **section 3**: it takes a block, and the default is `nil`.',
        error: 'Request failed with status code 404',
      };
    case 'WebSearch': {
      const slug = tool.summary.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const links = [
        { title: 'Backoff strategies compared', url: `https://example.com/blog/${slug}` },
        { title: 'Retry guide', url: `https://docs.example.org/guides/${slug}` },
        { title: 'Notes on jitter', url: `https://example.net/notes/${slug}#jitter` },
      ];
      return {
        name,
        input: { query: tool.summary },
        result: `Web search results for query: "${tool.summary}"\n\nLinks: ${JSON.stringify(links)}\n\nFull jitter spreads retries evenly across the window, which avoids synchronized retry storms.`,
        error: 'Search failed: rate limited',
      };
    }
    default:
      return {
        name,
        input: { summary: tool.summary },
        result: 'Done.',
        error: `Error: ${tool.tool} failed`,
      };
  }
}

/** A TodoWrite input for a scenario's todos, `done` of them finished. */
export function demoTodos(scenario: DemoScenario, done: number): Record<string, unknown> {
  return {
    todos: scenario.todos.map((content, index) => ({
      content,
      status: index < done ? 'completed' : index === done ? 'in_progress' : 'pending',
      activeForm: content,
    })),
  };
}

export const TODO_RESULT =
  'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.';

/** A call to a third-party (MCP) tool the UI doesn't know, for the generic card. */
export function demoMcpCall(
  scenario: DemoScenario,
  rng: Rng,
): {
  name: string;
  input: Record<string, unknown>;
  result: string;
} {
  const id = rng.int(100, 999);
  return {
    name: 'mcp__tracker__create_ticket',
    input: {
      title: scenario.title,
      labels: ['demo', rng.pick(['backend', 'frontend', 'tests'])],
      priority: rng.pick(['low', 'medium', 'high']),
      estimate: { points: rng.int(1, 5), confidence: 0.7 },
    },
    result: `Created ticket TRK-${id}: ${scenario.title}`,
  };
}

/** Assistant text with some markdown: a list of touched files, sometimes a code block. */
export function demoAssistantText(scenario: DemoScenario, rng: Rng, rich: boolean): string {
  const text = rng.pick(scenario.texts);
  if (!rich) return text;
  const files = [...new Set(scenario.tools.filter((t) => t.tool === 'Edit').map((t) => fileOf(t)))];
  const parts = [text];
  if (files.length > 0) {
    parts.push(
      `**Changed**\n\n${files.map((f) => `- \`${f}\`: ${rng.pick(['updated', 'refactored', 'covered by a new test'])}`).join('\n')}`,
    );
  }
  const lang = langFor(files[0] ?? '');
  const snippet = SNIPPETS[lang];
  if (snippet && rng.chance(0.6))
    parts.push(`The core of it:\n\n\`\`\`${lang}\n${snippet}\n\`\`\``);
  return parts.join('\n\n');
}

/**
 * A plausible past conversation of about `count` entries, oldest first, ending before `endTs`.
 * Seeded per session so it is reproducible without consuming the simulator's own random stream.
 */
export function demoHistory(
  project: DemoProject,
  seed: number,
  count: number,
  endTs: number,
): { entry: DemoEntry; ts: number }[] {
  const rng = new Rng(seed);
  const out: { entry: DemoEntry; ts: number }[] = [];
  let turn = 0;
  while (out.length < count) {
    const scenario = project.scenarios[turn % project.scenarios.length];
    if (!scenario) break;
    out.push({
      entry: {
        kind: 'user',
        text: turn < project.scenarios.length ? scenario.prompt : rng.pick(FOLLOW_UPS),
      },
      ts: 0,
    });
    if (rng.chance(0.7)) out.push({ entry: { kind: 'thinking', text: rng.pick(THOUGHTS) }, ts: 0 });
    const todo = (done: number) => {
      const toolUseId = `toolu_demo_${seed.toString(16)}_${out.length}`;
      out.push({
        entry: { kind: 'tool_use', toolUseId, name: 'TodoWrite', input: demoTodos(scenario, done) },
        ts: 0,
      });
      out.push({
        entry: { kind: 'tool_result', toolUseId, text: TODO_RESULT, isError: false },
        ts: 0,
      });
    };
    const planned = scenario.todos.length > 0 && rng.chance(0.6);
    if (planned) todo(0);
    const steps = rng.int(3, 8);
    for (let i = 0; i < steps; i++) {
      if (planned && i === Math.floor(steps / 2)) todo(Math.floor(scenario.todos.length / 2));
      if (rng.chance(0.3)) {
        out.push({ entry: { kind: 'assistant', text: rng.pick(scenario.texts) }, ts: 0 });
        continue;
      }
      const toolUseId = `toolu_demo_${seed.toString(16)}_${out.length}`;
      const isError = rng.chance(0.05);
      const call = rng.chance(0.04)
        ? { ...demoMcpCall(scenario, rng), error: 'Error: tracker is unavailable' }
        : demoToolCall(project, rng.pick(scenario.tools), rng);
      out.push({
        entry: { kind: 'tool_use', toolUseId, name: call.name, input: call.input },
        ts: 0,
      });
      out.push({
        entry: {
          kind: 'tool_result',
          toolUseId,
          text: isError ? call.error : call.result,
          isError,
        },
        ts: 0,
      });
    }
    if (planned) todo(scenario.todos.length);
    out.push({ entry: { kind: 'assistant', text: demoAssistantText(scenario, rng, true) }, ts: 0 });
    turn++;
  }
  // Space entries a few seconds apart, with longer gaps between turns.
  let ts = endTs;
  for (let i = out.length - 1; i >= 0; i--) {
    const item = out[i] as (typeof out)[number];
    ts -= item.entry.kind === 'user' ? rng.int(60_000, 600_000) : rng.int(1_500, 12_000);
    item.ts = ts;
  }
  return out;
}
