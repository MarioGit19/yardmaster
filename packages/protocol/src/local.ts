import { z } from 'zod';

// The local channel (PRD §8): a Unix domain socket in the data dir that only this user can
// reach. The extension and the hooks talk to the server only through it, so no other local
// process can pose as the server by binding the TCP port first.

/** The socket's file name inside `~/.yardmaster` (kept short: `sun_path` holds 104 bytes on macOS). */
export const LOCAL_SOCKET_FILE = 'board.sock';

export const LOCAL_ROUTES = {
  editor: '/ws/editor',
  hooks: '/api/hooks/claude',
  permission: '/api/hooks/permission',
  statusline: '/api/hooks/statusline',
  away: '/api/away',
  dashboardLink: '/api/local/dashboard-link',
} as const;

/** Routes served only on the socket; over TCP they answer 403 `local_channel_required`. */
export const LOCAL_ONLY_ROUTES: readonly string[] = Object.values(LOCAL_ROUTES);

/**
 * `POST /api/hooks/permission` (socket, token): the board's minimal decision on a
 * `PermissionRequest`. The hook builds Claude Code's output itself, taking "always allow"
 * rules only from Claude Code's own `permission_suggestions`, so the server can't inject any.
 * 204 means no decision: the terminal prompt shows.
 */
export const PermissionHookAnswer = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow') }),
  z.object({ decision: z.literal('allow_always') }),
  z.object({ decision: z.literal('deny'), reason: z.string().max(500).nullable() }),
]);
export type PermissionHookAnswer = z.infer<typeof PermissionHookAnswer>;

/** `POST /api/local/dashboard-link` (socket, token): the link the extension opens to sign in. */
export const DashboardLinkResponse = z.object({ url: z.url({ protocol: /^http$/ }) });
export type DashboardLinkResponse = z.infer<typeof DashboardLinkResponse>;
