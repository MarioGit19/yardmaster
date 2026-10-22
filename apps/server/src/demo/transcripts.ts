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

/** A tool call and its result, shaped like the real tool's input and output. */
export function demoToolCall(
  project: DemoProject,
  tool: DemoTool,
  rng: Rng,
): { input: Record<string, unknown>; result: string } {
  const root = project.path;
  const target = fileOf(tool);
  switch (tool.tool) {
    case 'Read': {
      const count = rng.int(40, 220);
      const body = (SNIPPETS[langFor(target)] ?? SNIPPETS.ts ?? '')
        .split('\n')
        .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
        .join('\n');
      return { input: { file_path: `${root}/${target}` }, result: `${body}\n… ${count} lines` };
    }
    case 'Edit':
    case 'Write':
      return {
        input: {
          file_path: `${root}/${target}`,
          old_string: 'return rules.reduce((total, rule) => rule.apply(total), subtotal(items));',
          new_string: 'return ordered.reduce((total, rule) => rule.apply(total), subtotal(items));',
        },
        result: `The file ${root}/${target} has been updated.`,
      };
    case 'Grep':
      return {
        input: { pattern: target, path: root, output_mode: 'content' },
        result: `Found ${rng.int(2, 9)} matches in ${rng.int(1, 4)} files`,
      };
    case 'Glob':
      return { input: { pattern: target, path: root }, result: `${rng.int(1, 6)} files` };
    case 'Bash':
      return {
        input: { command: tool.summary, description: `Run ${tool.summary}` },
        result: `$ ${tool.summary}\n✓ ${rng.int(4, 40)} passed in ${rng.int(1, 9)}.${rng.int(0, 9)}s`,
      };
    case 'Task':
      return {
        input: { description: tool.summary, prompt: tool.summary, subagent_type: 'Explore' },
        result: `Done. ${rng.int(2, 7)} places found, summarised above.`,
      };
    case 'WebFetch':
      return {
        input: { url: `https://${tool.summary}`, prompt: 'Summarise the relevant section' },
        result: 'The page documents the options; the relevant one is described in section 3.',
      };
    case 'WebSearch':
      return { input: { query: tool.summary }, result: `${rng.int(5, 10)} results` };
    default:
      return { input: { summary: tool.summary }, result: 'Done.' };
  }
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
    const steps = rng.int(3, 8);
    for (let i = 0; i < steps; i++) {
      if (rng.chance(0.3)) {
        out.push({ entry: { kind: 'assistant', text: rng.pick(scenario.texts) }, ts: 0 });
        continue;
      }
      const tool = rng.pick(scenario.tools);
      const toolUseId = `toolu_demo_${seed.toString(16)}_${out.length}`;
      const call = demoToolCall(project, tool, rng);
      out.push({
        entry: { kind: 'tool_use', toolUseId, name: tool.tool, input: call.input },
        ts: 0,
      });
      const isError = rng.chance(0.05);
      out.push({
        entry: {
          kind: 'tool_result',
          toolUseId,
          text: isError ? 'Error: command exited with code 1' : call.result,
          isError,
        },
        ts: 0,
      });
    }
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
