import { z } from 'zod';

// Folder trust for board Claude sessions (PLAN 14.4, PRD §8). Headless SDK runs load a folder's
// project settings and `.mcp.json` without the CLI's "trust this folder?" dialog, so the board
// asks first whenever those files can run code or widen permissions.

/** A board session in this folder waits until the user trusts it. */
export const FOLDER_UNTRUSTED = 'folder_untrusted';
/** The folder's settings changed since the card was shown: review it again. */
export const TRUST_CHANGED = 'trust_changed';

/** The files a board session reads from its folder, relative to it. */
export const TRUST_FILES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.mcp.json',
] as const;
export const TrustFile = z.enum(TRUST_FILES);
export type TrustFile = z.infer<typeof TrustFile>;

export const TrustFindingKind = z.enum([
  /** A hook: runs a command on a Claude Code event (`SessionStart` runs at once). */
  'hook',
  /** A permission rule that lets tools run without asking. */
  'allow',
  /** A default permission mode other than asking. */
  'mode',
  /** A directory outside the folder that sessions may touch. */
  'directory',
  /** A setting whose value is a command Claude Code runs (`apiKeyHelper`, `statusLine`, …). */
  'command',
  /** An environment variable set for every session (values are never shown). */
  'env',
  /** An MCP server the session would start or connect to. */
  'mcp',
  /** A plugin or marketplace: plugins can carry hooks and MCP servers. */
  'plugin',
  /** A file the board could not check (unreadable, too large, not JSON). */
  'unreadable',
]);
export type TrustFindingKind = z.infer<typeof TrustFindingKind>;

export const TrustFinding = z.object({
  file: TrustFile,
  kind: TrustFindingKind,
  /** What it is: the hook event, the rule, the setting or variable name. */
  label: z.string().min(1).max(300),
  /** What it runs or points at, when there is one (a command, a URL, a path). */
  detail: z.string().max(2_000).nullable(),
});
export type TrustFinding = z.infer<typeof TrustFinding>;

/** Shown before the first board session in a folder whose settings can run code. */
export const FolderTrustReview = z.object({
  path: z.string().min(1).max(4_096),
  /** sha256 of what was found; trusting sends it back, so a change in between asks again. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  findings: z.array(TrustFinding).min(1).max(200),
  /** More was found than the list holds. */
  truncated: z.boolean(),
});
export type FolderTrustReview = z.infer<typeof FolderTrustReview>;
