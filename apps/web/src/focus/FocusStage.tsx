import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
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
  /** A terminal deep link: the stack opens with this terminal's tab active. */
  terminalId?: string;
  /** A phone workspace page (`/p/:projectId/:page`): git, history, ports or a new session. */
  page?: string;
}

/** The project (and session or terminal) of a focus route, or null elsewhere. */
export function useFocusRoute(): FocusRoute | null {
  const [inSession, session] = useRoute(routes.session);
  const [inTerminal, terminal] = useRoute(routes.terminal);
  const [inProject, project] = useRoute(routes.project);
  const [inPage, page] = useRoute(routes.projectPage);
  if (inSession) return { projectId: session.projectId, sessionId: session.sessionId };
  if (inTerminal) return { projectId: terminal.projectId, terminalId: terminal.terminalId };
  if (inProject) return { projectId: project.projectId };
  if (inPage) return { projectId: page.projectId, page: page.page };
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
  const focusId = focus?.projectId ?? null;
  const opened = focusId !== null && focusId !== direct.current;
  // The morph needs a pod to come from; another layout's overview cross-fades into the view.
  const fromPod = useMemo(
    () =>
      focusId !== null && document.querySelector(`[data-pod="${CSS.escape(focusId)}"]`) !== null,
    [focusId],
  );
  const shared = level === 'full' && opened && fromPod;
  const fade = level !== 'off' && opened && !shared;

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

  // Back on the overview, keyboard focus returns to the pod (or the layout's room or node) the
  // view came from.
  const last = useRef<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = last.current;
    last.current = focus?.projectId ?? null;
    if (focus || !previous) return;
    const active = document.activeElement;
    if (active && active !== document.body && !stageRef.current?.contains(active)) return;
    const id = CSS.escape(previous);
    // The first one on screen: a layout may keep others hidden (the Grid's labels behind its
    // cockpit).
    [
      ...document.querySelectorAll<HTMLElement>(
        `[data-pod="${id}"] header a, [data-focus-return="${id}"]`,
      ),
    ]
      .find((el) => el.checkVisibility?.({ visibilityProperty: true }) ?? true)
      ?.focus({ preventScroll: true });
  }, [focus]);

  return (
    <div ref={stageRef} className="contents">
      <AnimatePresence>
        {focus && (
          <div
            key={focus.projectId}
            className="focus-layer absolute inset-0 z-10 flex flex-col md:p-6"
          >
            <FocusView
              projectId={focus.projectId}
              sessionId={focus.sessionId}
              terminalId={focus.terminalId}
              page={focus.page}
              shared={shared}
              fade={fade}
            />
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
