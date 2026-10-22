import { z } from 'zod';

// Inputs of Claude Code's built-in tools, as they appear in `tool_use` blocks. The schemas are
// lenient (unknown fields pass, optional fields stay optional), so a newer Claude Code that adds
// a field still parses; a call that doesn't fit its schema falls back to the generic view.

const Text = z.string();

export const BashInput = z.object({
  command: Text.min(1),
  description: Text.optional(),
  run_in_background: z.boolean().optional(),
});
export const EditInput = z.object({
  file_path: Text.min(1),
  old_string: Text,
  new_string: Text,
  replace_all: z.boolean().optional(),
});
export const MultiEditInput = z.object({
  file_path: Text.min(1),
  edits: z
    .array(z.object({ old_string: Text, new_string: Text, replace_all: z.boolean().optional() }))
    .min(1),
});
export const WriteInput = z.object({ file_path: Text.min(1), content: Text });
export const ReadInput = z.object({
  file_path: Text.min(1),
  offset: z.number().optional(),
  limit: z.number().optional(),
});
export const GrepInput = z.object({
  pattern: Text.min(1),
  path: Text.optional(),
  glob: Text.optional(),
  output_mode: Text.optional(),
});
export const GlobInput = z.object({ pattern: Text.min(1), path: Text.optional() });
export const TodoStatus = z.enum(['pending', 'in_progress', 'completed']);
export type TodoStatus = z.infer<typeof TodoStatus>;
export const TodoWriteInput = z.object({
  todos: z.array(z.object({ content: Text, status: TodoStatus, activeForm: Text.optional() })),
});
export const TaskInput = z.object({
  description: Text.optional(),
  prompt: Text.optional(),
  subagent_type: Text.optional(),
});
export const WebFetchInput = z.object({ url: Text.min(1), prompt: Text.optional() });
export const WebSearchInput = z.object({ query: Text.min(1) });

export interface FileEdit {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

/** A tool call in the shape its card renders. `other` covers unknown tools and odd inputs. */
export type ToolCall =
  | { kind: 'bash'; command: string; description: string | null; background: boolean }
  | { kind: 'edit'; tool: 'Edit' | 'MultiEdit'; filePath: string; edits: FileEdit[] }
  | { kind: 'write'; filePath: string; content: string }
  | { kind: 'read'; filePath: string; offset: number | null; limit: number | null }
  | { kind: 'grep'; pattern: string; path: string | null; glob: string | null }
  | { kind: 'glob'; pattern: string; path: string | null }
  | {
      kind: 'todo';
      todos: { content: string; status: TodoStatus; activeForm: string | null }[];
    }
  | { kind: 'task'; description: string; prompt: string; agent: string | null }
  | { kind: 'fetch'; url: string; prompt: string | null }
  | { kind: 'search'; query: string }
  | { kind: 'other' };

/** Parses a `tool_use` input by tool name. Never throws. */
export function parseToolCall(name: string, input: unknown): ToolCall {
  switch (name) {
    case 'Bash': {
      const r = BashInput.safeParse(input);
      if (!r.success) break;
      return {
        kind: 'bash',
        command: r.data.command,
        description: r.data.description ?? null,
        background: r.data.run_in_background ?? false,
      };
    }
    case 'Edit': {
      const r = EditInput.safeParse(input);
      if (!r.success) break;
      const { file_path, old_string, new_string, replace_all } = r.data;
      return {
        kind: 'edit',
        tool: 'Edit',
        filePath: file_path,
        edits: [{ oldString: old_string, newString: new_string, replaceAll: replace_all ?? false }],
      };
    }
    case 'MultiEdit': {
      const r = MultiEditInput.safeParse(input);
      if (!r.success) break;
      return {
        kind: 'edit',
        tool: 'MultiEdit',
        filePath: r.data.file_path,
        edits: r.data.edits.map((e) => ({
          oldString: e.old_string,
          newString: e.new_string,
          replaceAll: e.replace_all ?? false,
        })),
      };
    }
    case 'Write': {
      const r = WriteInput.safeParse(input);
      if (!r.success) break;
      return { kind: 'write', filePath: r.data.file_path, content: r.data.content };
    }
    case 'Read': {
      const r = ReadInput.safeParse(input);
      if (!r.success) break;
      return {
        kind: 'read',
        filePath: r.data.file_path,
        offset: r.data.offset ?? null,
        limit: r.data.limit ?? null,
      };
    }
    case 'Grep': {
      const r = GrepInput.safeParse(input);
      if (!r.success) break;
      return {
        kind: 'grep',
        pattern: r.data.pattern,
        path: r.data.path ?? null,
        glob: r.data.glob ?? null,
      };
    }
    case 'Glob': {
      const r = GlobInput.safeParse(input);
      if (!r.success) break;
      return { kind: 'glob', pattern: r.data.pattern, path: r.data.path ?? null };
    }
    case 'TodoWrite': {
      const r = TodoWriteInput.safeParse(input);
      if (!r.success) break;
      return {
        kind: 'todo',
        todos: r.data.todos.map((t) => ({
          content: t.content,
          status: t.status,
          activeForm: t.activeForm ?? null,
        })),
      };
    }
    case 'Task':
    case 'Agent': {
      const r = TaskInput.safeParse(input);
      if (!r.success) break;
      return {
        kind: 'task',
        description: r.data.description ?? '',
        prompt: r.data.prompt ?? '',
        agent: r.data.subagent_type ?? null,
      };
    }
    case 'WebFetch': {
      const r = WebFetchInput.safeParse(input);
      if (!r.success) break;
      return { kind: 'fetch', url: r.data.url, prompt: r.data.prompt ?? null };
    }
    case 'WebSearch': {
      const r = WebSearchInput.safeParse(input);
      if (!r.success) break;
      return { kind: 'search', query: r.data.query };
    }
  }
  return { kind: 'other' };
}
