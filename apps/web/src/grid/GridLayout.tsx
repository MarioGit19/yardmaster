import { AnimatePresence, motion } from 'motion/react';
import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useOwnBackdrop } from '../ambient/backdrop.js';
import { useNow } from '../anim/clock.js';
import { OffstageContext } from '../anim/useFrame.js';
import { attentionOpen } from '../attention/attention.js';
import { SCENE_TICK_MS, useSceneModel } from '../layouts/useScene.js';
import { dur, ease, useMotionLevel } from '../motion.js';
import { isTypingTarget } from '../shell/railNav.js';
import { FlatCockpit } from './FlatCockpit.js';
import { GridMap } from './GridMap.js';
import { GridTrunk } from './GridTrunk.js';
import { TRUNK_BELOW } from './map.js';

/** The history entry the cockpit pushes, so the back gesture leaves it like Esc. */
const HISTORY_KEY = 'cboardGridNode';

const fade = { duration: dur.slow, ease: ease.inOut };

/** The 3D network and `three` arrive in their own chunk, only when the 3D view is shown. */
const Grid3D = lazy(() => import('./Grid3D.js'));

/**
 * DESIGN.md §10.4: the board as a neon network. At Full motion with WebGL it's the 3D network
 * (`Grid3D`); at Reduced or Off, without WebGL, or when its context is lost it's the 2D map, a
 * ring of nodes around the core with packets on straight pipelines, and on a phone one trunk.
 * Enter on a node (or a click) cross-fades to its flat cockpit; Esc, the Back button or the
 * browser's back step out again and focus lands back on the node. The Grid draws its own floor,
 * so the ambient field steps out while it's shown.
 */
export default function GridLayout() {
  useOwnBackdrop();
  const scene = useSceneModel();
  const now = useNow(SCENE_TICK_MS);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const offstage = useContext(OffstageContext);
  const level = useMotionLevel();
  const [webglLost, setWebglLost] = useState(false);
  const onWebglLost = useCallback(() => setWebglLost(true), []);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.floor(element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const narrow = width > 0 && width < TRUNK_BELOW;
  const deep = !narrow && level === 'full' && !webglLost;
  const entered = nodeId ? scene.projects.find((p) => p.id === nodeId) : undefined;

  // A node whose project left the board closes its cockpit.
  useEffect(() => {
    if (nodeId && !entered) setNodeId(null);
  }, [nodeId, entered]);

  const enter = useCallback((id: string) => {
    window.history.pushState({ ...window.history.state, [HISTORY_KEY]: id }, '');
    setNodeId(id);
  }, []);
  const leave = useCallback(() => {
    if (!nodeId) return;
    focusNode(nodeId);
    // Leave the way we came in, so Back doesn't re-open the cockpit later.
    if (window.history.state?.[HISTORY_KEY] === nodeId) window.history.back();
    else setNodeId(null);
  }, [nodeId]);

  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const id = (event.state?.[HISTORY_KEY] as string | undefined) ?? null;
      setNodeId((current) => {
        if (current && id !== current) focusNode(current);
        return id;
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Esc steps out, unless something on top took it (an inspector, the palette, a dialog).
  const offstageRef = useRef(offstage);
  offstageRef.current = offstage;
  useEffect(() => {
    if (!nodeId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || offstageRef.current) return;
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      if (attentionOpen.get() === 'open') return;
      event.preventDefault();
      leave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nodeId, leave]);

  // Entering moves focus into the cockpit (its region, so Back's tooltip doesn't pop up).
  useEffect(() => {
    if (!nodeId) return;
    const frame = requestAnimationFrame(() =>
      ref.current
        ?.querySelector<HTMLElement>('[data-grid-cockpit]')
        ?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [nodeId]);

  return (
    <>
      <GridFloor flat={!deep} />
      <div
        ref={ref}
        data-grid
        data-grid-view={entered ? 'cockpit' : narrow ? 'trunk' : deep ? '3d' : 'map'}
        data-grid-entered={entered?.id}
        data-paused={offstage || undefined}
        className="grid-world relative w-full"
      >
        <AnimatePresence initial={false} mode="popLayout">
          {entered ? (
            <motion.div
              key={`cockpit:${entered.id}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={fade}
            >
              <FlatCockpit project={entered} now={now} narrow={narrow} onBack={leave} />
            </motion.div>
          ) : (
            width > 0 && (
              <motion.div
                key="network"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={fade}
              >
                {scene.projects.length === 0 ? (
                  <p className="py-16 text-center text-body-sm text-text-2">
                    No projects on the network yet.
                  </p>
                ) : narrow ? (
                  <GridTrunk projects={scene.projects} onEnter={enter} />
                ) : deep ? (
                  <Suspense fallback={null}>
                    <Grid3D projects={scene.projects} onEnter={enter} onLost={onWebglLost} />
                  </Suspense>
                ) : (
                  <GridMap projects={scene.projects} width={width} onEnter={enter} />
                )}
              </motion.div>
            )
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

/** Focus a node once the cross-fade has swapped the network back in. */
function focusNode(id: string) {
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>(`[data-grid-node="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: true }),
  );
}

/**
 * The ground behind the network: near-black with the fog's glow, plus (for the flat views) a
 * faint grid and scanlines. The 3D view draws its own perspective floor and scanlines over it.
 */
function GridFloor({ flat }: { flat: boolean }) {
  return (
    <div
      aria-hidden
      data-grid-floor={flat ? 'flat' : '3d'}
      className="grid-floor pointer-events-none fixed inset-0 -z-10"
    >
      {flat && <div className="grid-floor-lines absolute inset-0" />}
      {flat && <div className="grid-floor-scan absolute inset-0" />}
    </div>
  );
}
