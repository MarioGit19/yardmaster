/** Hash routes (wouter patterns) and builders for links into them. */
export const routes = {
  overview: '/',
  project: '/p/:projectId',
  session: '/p/:projectId/s/:sessionId',
  terminal: '/p/:projectId/t/:terminalId',
  /** A phone workspace's page beside its items: git, history, ports, or a new session. */
  projectPage: '/p/:projectId/:page',
  settings: '/settings',
  // The phone shell's tabs (DESIGN.md §11); the overview is the first.
  projects: '/projects',
  attention: '/attention',
  pulse: '/pulse',
  more: '/more',
  welcome: '/welcome',
  tokens: '/_tokens',
} as const;

export const projectHref = (projectId: string) => `/p/${encodeURIComponent(projectId)}`;

export const sessionHref = (projectId: string, sessionId: string) =>
  `${projectHref(projectId)}/s/${encodeURIComponent(sessionId)}`;

export const terminalHref = (projectId: string, terminalId: string) =>
  `${projectHref(projectId)}/t/${encodeURIComponent(terminalId)}`;

export const projectPageHref = (projectId: string, page: string) =>
  `${projectHref(projectId)}/${encodeURIComponent(page)}`;

/** Whether `location` is the project's focus view (any of its sessions included). */
export const inProject = (location: string, projectId: string) => {
  const href = projectHref(projectId);
  return location === href || location.startsWith(`${href}/`);
};
