/**
 * `layoutId`s shared by a pod and its focus view (DESIGN.md §3 rule 3): the container, the
 * header and each session's orb.
 */
export const sharedId = {
  container: (projectId: string) => `pod:${projectId}`,
  header: (projectId: string) => `pod-header:${projectId}`,
  orb: (sessionId: string) => `orb:${sessionId}`,
};

/**
 * Pods only take part in the hand-off to and from their focus view. A fixed dependency keeps
 * their own re-renders (a new session row, a longer caption) from playing layout animations;
 * the focus side has none, so the hand-off still runs in both directions.
 */
export const POD_LAYOUT_DEPENDENCY = 'pod';
