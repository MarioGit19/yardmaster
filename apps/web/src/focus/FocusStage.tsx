import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useRef } from 'react';
import { useLocation, useRoute } from 'wouter';
import { OffstageContext } from '../anim/useFrame.js';
import { attentionOpen } from '../attention/attention.js';
import { FrozenBoard } from '../data/index.js';
import { dur, ease, useMotionLevel } from '../motion.js';
import { routes } from '../routes.js';
import { isTypingTarget } from '../shell/railNav.js';
import { FocusView } from './FocusView.js';

export interface FocusRoute {
  projectId: string;
  sessionId?: string;
}

/** The project (and session) of a focus route, or null elsewhere. */
export function useFocusRoute(): FocusRoute | null {
  const [inSession, session] = useRoute(routes.session);
  const [inProject, project] = useRoute(routes.project);
  if (inSession) return { projectId: session.projectId, sessionId: session.sessionId };
  if (inProject) return { projectId: project.projectId };
  return null;
}

/**
 * The overview behind the focus view: dimmed, blurred, inert, and offstage, so its orbs,
 * sparklines and mascots stop drawing while covered, and its board is frozen until it is shown
 * again. It stays mounted so the pod is there to morph from and back into, and the overview
 * keeps its scroll position.
 */
export function FocusBackdrop({ dimmed, children }: { dimmed: boolean; children: ReactNode }) {
  return (
    <OffstageContext.Provider value={dimmed}>
      <motion.div
        data-offstage={dimmed || undefined}
        inert={dimmed}
        aria-hidden={dimmed || undefined}
        initial={false}
        animate={
          dimmed
            ? { opacity: 0.35, filter: 'blur(6px)' }
            : { opacity: 1, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }
        }
        transition={{ duration: dur.slow, ease: ease.out }}
      >
        <FrozenBoard frozen={dimmed}>{children}</FrozenBoard>
      </motion.div>
    </OffstageContext.Provider>
  );
}

/**
 * The focus view layer over the main area. Opening a project from the overview morphs its pod
 * into the view (container, header and session orbs share `layoutId`s); Esc or Back morphs it
 * back. A direct load of the route skips the morph: there is no pod on screen to come from.
 */
export function FocusStage({ focus }: { focus: FocusRoute | null }) {
  const [, navigate] = useLocation();
  // The project the page was loaded on; cleared once the overview has been shown.
  const direct = useRef(focus?.projectId ?? null);
  if (focus === null) direct.current = null;
  // Reduced and Off swap without the morph (Motion would still paint a frame at the pod's box).
  const level = useMotionLevel();
  const shared = level === 'full' && focus !== null && focus.projectId !== direct.current;

  const open = focus !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      // The Attention Center closes first.
      if (attentionOpen.get() === 'open') return;
      event.preventDefault();
      navigate(routes.overview);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, navigate]);

  // Back on the overview, keyboard focus returns to the pod the view came from.
  const last = useRef<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = last.current;
    last.current = focus?.projectId ?? null;
    if (focus || !previous) return;
    const active = document.activeElement;
    if (active && active !== document.body && !stageRef.current?.contains(active)) return;
    document
      .querySelector<HTMLElement>(`[data-pod="${CSS.escape(previous)}"] header a`)
      ?.focus({ preventScroll: true });
  }, [focus]);

  return (
    <div ref={stageRef} className="contents">
      <AnimatePresence>
        {focus && (
          <div
            key={focus.projectId}
            className="focus-layer absolute inset-0 z-10 flex flex-col p-4 md:p-6"
          >
            <FocusView projectId={focus.projectId} sessionId={focus.sessionId} shared={shared} />
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
