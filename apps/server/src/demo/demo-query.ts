import { randomUUID } from 'node:crypto';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { MessageQueue, type QueryFn } from '../claude/runner.js';
import { DEMO_MODELS } from './content.js';

// A scripted stand-in for the Agent SDK's `query()`, so board sessions work in `--demo`
// without Claude Code or the API: every prompt gets a short tool call and a streamed reply.

export interface DemoQueryOptions {
  /** Before the first output of a turn. */
  thinkMs?: number;
  /** A Read tool call's run time. */
  toolMs?: number;
  /** Between streamed words. */
  wordMs?: number;
  /** A fork asks for its parent's transcript to be copied under the new id. */
  onFork?: (fromId: string, toId: string) => void;
}

const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
};

const REPLIES = [
  [
    'I read through the project layout first. The change touches one module and its tests, so it stays small.',
    '',
    'Here is the plan:',
    '',
    '1. Move the calculation behind a single function so every caller shares it.',
    '2. Keep the public API as it is and only change the internals.',
    '3. Add a regression test for the empty case and one for the rounding edge.',
    '',
    '```ts',
    'export function total(items: readonly Item[]): number {',
    '  return items.reduce((sum, item) => sum + item.price * item.qty, 0);',
    '}',
    '```',
    '',
    'Nothing else depends on the old helper, so it can go once the callers move over. Tell me if you want me to go ahead and make the edit, or keep it as a proposal for now.',
  ].join('\n'),
  [
    'Short answer: yes, and it is safer to do it where the data is produced rather than at each call site.',
    '',
    'The current code computes the value in three places, and two of them disagree on rounding. Fixing it at the source keeps every caller consistent, and the existing tests already pin the behaviour we want to keep.',
    '',
    'I would also rename `calc` to something that says what it returns, since it shows up in the stack traces you pasted earlier. Want me to make both changes and run the tests afterwards?',
  ].join('\n'),
] as const;

/** Resolves after `ms`, or as soon as `signal` aborts (to `false`). */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function promptText(message: SDKUserMessage): string {
  const { content } = message.message;
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join(' ')
    .trim();
}

export function createDemoQuery(options: DemoQueryOptions = {}): QueryFn {
  const thinkMs = options.thinkMs ?? 700;
  const toolMs = options.toolMs ?? 600;
  const wordMs = options.wordMs ?? 45;

  return ({ prompt, options: sdk }) => {
    const sessionId = sdk.sessionId ?? sdk.resume ?? randomUUID();
    if (sdk.forkSession && sdk.resume && sdk.sessionId) options.onFork?.(sdk.resume, sdk.sessionId);
    const cwd = sdk.cwd ?? '/home/dev';
    const outbox = new MessageQueue<SDKMessage>();
    let model = MODEL_ALIASES[sdk.model ?? ''] ?? sdk.model ?? DEMO_MODELS[0];
    let turn: AbortController | null = null;
    let turns = 0;
    let closed = false;

    const emit = (message: Record<string, unknown>) => {
      if (!closed) outbox.push({ session_id: sessionId, uuid: randomUUID(), ...message } as never);
    };
    const state = (value: 'idle' | 'running') =>
      emit({ type: 'system', subtype: 'session_state_changed', state: value });
    const stream = (event: Record<string, unknown>) =>
      emit({ type: 'stream_event', event, parent_tool_use_id: null });
    const assistant = (content: unknown[]) =>
      emit({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: `msg_demo_${randomUUID().slice(0, 8)}`,
          type: 'message',
          role: 'assistant',
          model,
          content,
          usage: { input_tokens: 1_200, output_tokens: 180 },
        },
      });

    const runTurn = async (text: string, signal: AbortSignal) => {
      const n = turns++;
      state('running');
      let written = '';
      const finish = (ok: boolean) => {
        if (ok) {
          emit({ type: 'result', subtype: 'success', is_error: false, result: written });
        } else {
          // An interrupted reply keeps what was already written, as the CLI does.
          if (written) assistant([{ type: 'text', text: written }]);
          emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] });
        }
        state('idle');
      };
      if (!(await wait(thinkMs, signal))) return finish(false);

      if (n === 0) {
        const id = `toolu_demo_${randomUUID().slice(0, 8)}`;
        assistant([
          { type: 'tool_use', id, name: 'Read', input: { file_path: `${cwd}/README.md` } },
        ]);
        if (!(await wait(toolMs, signal))) return finish(false);
        emit({
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: id,
                content: '     1\t# Project\n     2\t\n     3\tRun `pnpm dev` to start.',
              },
            ],
          },
        });
      }

      const reply = REPLIES[(n + text.length) % REPLIES.length] as string;
      stream({ type: 'message_start' });
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      for (const word of reply.split(/(?<=\s)/)) {
        if (!(await wait(wordMs, signal))) return finish(false);
        written += word;
        stream({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: word },
        });
      }
      stream({ type: 'content_block_stop', index: 0 });
      assistant([{ type: 'text', text: reply }]);
      finish(true);
    };

    emit({
      type: 'system',
      subtype: 'init',
      model,
      permissionMode: sdk.permissionMode ?? 'default',
      cwd,
      tools: ['Read', 'Edit', 'Bash'],
    });

    void (async () => {
      for await (const message of prompt) {
        if (closed) break;
        turn = new AbortController();
        await runTurn(promptText(message), turn.signal);
        turn = null;
      }
      outbox.end();
    })();

    const generator = (async function* () {
      yield* outbox;
    })();
    return Object.assign(generator, {
      interrupt: async () => {
        turn?.abort();
      },
      setModel: async (next?: string) => {
        if (next) model = MODEL_ALIASES[next] ?? next;
      },
      setPermissionMode: async () => {},
      close: () => {
        closed = true;
        turn?.abort();
        outbox.end();
      },
    }) as unknown as Query;
  };
}
