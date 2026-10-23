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

/** Whether `location` is the project's focus view (any of its sessions included). */
export const inProject = (location: string, projectId: string) => {
  const href = projectHref(projectId);
  return location === href || location.startsWith(`${href}/`);
};
