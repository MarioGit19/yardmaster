/** Hash routes (wouter patterns) and builders for links into them. */
export const routes = {
  overview: '/',
  project: '/p/:projectId',
  session: '/p/:projectId/s/:sessionId',
  settings: '/settings',
  welcome: '/welcome',
  tokens: '/_tokens',
} as const;

export const projectHref = (projectId: string) => `/p/${encodeURIComponent(projectId)}`;

export const sessionHref = (projectId: string, sessionId: string) =>
  `${projectHref(projectId)}/s/${encodeURIComponent(sessionId)}`;
