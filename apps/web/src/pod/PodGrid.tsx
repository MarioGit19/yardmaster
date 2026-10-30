import { AnimatePresence, motion, useDragControls, type Variants } from 'motion/react';
import { type PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { selectProject, useBoard } from '../data/index.js';
import { useActiveProjects } from '../library/useActive.js';
import { dur, ease, spring, useMotionLevel } from '../motion.js';
import { keepOrder } from '../order.js';
import { risingPods } from './model.js';
import { type PodMove, PodMoveContext } from './PodGrip.js';
import { ProjectPod, ProjectPodSkeleton } from './ProjectPod.js';
import { nudgeProject, projectOrder, usePinnedProjects, useProjectOrder } from './projectOrder.js';

/** Columns follow the space the grid gets (the rail takes some), not the viewport. */
const POD_GRID =
  'relative grid grid-cols-1 gap-4 @min-[40rem]:grid-cols-2 @min-[66rem]:grid-cols-3 @min-[96rem]:grid-cols-4';

/** DESIGN.md §3 rule 1: 30–40 ms apart, at most eight pods staggered. */
const STAGGER_S = 0.035;
const MAX_STAGGERED = 8;
/** After a pod slips past another, its neighbours get this long to settle before the next. */
const SWAP_SETTLE_MS = 250;

/** Only the first overview of a page load gets the orchestrated entrance. */
let entered = false;

const variants: Variants = {
  // First load: fade, y 8→0, blur 4→0, staggered.
  stagger: { opacity: 0, y: 8, filter: 'blur(4px)' },
  // Anything later: a plain fade and a 4 px rise.
  plain: { opacity: 0, y: 4 },
  shown: (index: number) => ({
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { ...spring.smooth, delay: Math.min(index, MAX_STAGGERED - 1) * STAGGER_S },
    transitionEnd: { filter: 'none' },
  }),
  settled: { opacity: 1, y: 0, transition: spring.smooth },
  exit: { opacity: 0, transition: { duration: dur.fast, ease: ease.out } },
};

const toId = (id: string) => id;

/** `order` with `id` taken out and put back where `target` stands. */
function moveTo(order: readonly string[], id: string, target: string): string[] {
  const next = order.filter((other) => other !== id);
  next.splice(order.indexOf(target), 0, id);
  return next;
}

/**
 * The overview's pods in the board's stable order: a status never moves one. The user can, with a
 * pod's grip; its neighbours glide with `layout`, and peeks raise a pod above them.
 */
export function PodGrid() {
  const all = useProjectOrder();
  const pinned = usePinnedProjects();
  // Only active projects (F26); one that goes quiet leaves through the exit variant.
  const active = useActiveProjects();
  const live = useMemo(() => all.filter((id) => active.has(id)), [all, active]);
  // The order on screen during a drag; it's saved when the pod is dropped.
  const [dragged, setDragged] = useState<readonly string[] | null>(null);
  const order = useMemo(() => (dragged ? keepOrder(live, dragged, toId) : live), [dragged, live]);
  const settled = useRef(0);
  const [moved, setMoved] = useState('');
  const dragOver = (id: string, point: { x: number; y: number }) => {
    if (performance.now() < settled.current) return;
    const under = document
      .elementsFromPoint(point.x - window.scrollX, point.y - window.scrollY)
      .map((element) => element.closest<HTMLElement>('[data-pod-slot]')?.dataset.podSlot)
      .find((slot) => slot && slot !== id);
    if (!under || pinned.includes(under) !== pinned.includes(id)) return;
    settled.current = performance.now() + SWAP_SETTLE_MS;
    setDragged(moveTo(order, id, under));
  };
  const nudge = (id: string, name: string, by: 1 | -1) => {
    const next = nudgeProject(live, pinned, id, by);
    if (!next) return;
    projectOrder.save(next);
    setMoved(`${name} moved to place ${next.indexOf(id) + 1} of ${next.length}`);
  };
  // Only a reorder measures the slots; any other re-render would measure every pod on the page.
  const orderKey = order.join('|');
  const level = useMotionLevel();
  const [stagger] = useState(() => !entered && level === 'full');
  const [initial] = useState(() => new Set(order));
  useEffect(() => {
    entered = true;
  }, []);
  // The order the slots last animated from: pods that overtook a neighbour fly above the rest.
  const previous = useRef(order);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed per reorder (`orderKey`)
  const rising = useMemo(() => risingPods(previous.current, order), [orderKey]);
  useEffect(() => {
    previous.current = order;
  });

  return (
    <div className="@container">
      <div className={POD_GRID}>
        <AnimatePresence mode="popLayout" initial>
          {order.map((id, index) => {
            const first = stagger && initial.has(id);
            return (
              <PodSlot
                key={id}
                id={id}
                onDragStart={() => setDragged(order)}
                onDragOver={dragOver}
                onDrop={() => {
                  projectOrder.save(order);
                  setDragged(null);
                }}
                onNudge={nudge}
                orderKey={orderKey}
                index={index}
                first={first}
                rising={rising.has(id)}
              >
                <PodById id={id} />
              </PodSlot>
            );
          })}
        </AnimatePresence>
      </div>
      <div aria-live="polite" className="sr-only">
        {moved}
      </div>
    </div>
  );
}

/**
 * One grid cell. A reorder glides every slot on `smooth`; a pod that overtakes a neighbour is
 * lifted above the others with a soft shadow for the flight, so cards never cross visibly.
 */
function PodSlot({
  id,
  onDragStart,
  onDragOver,
  onDrop,
  onNudge,
  orderKey,
  index,
  first,
  rising,
  children,
}: {
  id: string;
  onDragStart(): void;
  onDragOver(id: string, point: { x: number; y: number }): void;
  onDrop(): void;
  onNudge(id: string, name: string, by: 1 | -1): void;
  orderKey: string;
  index: number;
  first: boolean;
  rising: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const controls = useDragControls();
  const name = useBoard((s) => selectProject(id)(s)?.name ?? '');
  const move = useMemo<PodMove>(
    () => ({
      drag: (event: PointerEvent) => controls.start(event),
      nudge: (by) => onNudgeRef.current(id, name, by),
    }),
    [controls, id, name],
  );
  const onNudgeRef = useRef(onNudge);
  onNudgeRef.current = onNudge;
  const hold = (on: boolean) => {
    const slot = ref.current;
    if (!slot) return;
    if (on) slot.dataset.rising = '';
    else delete slot.dataset.rising;
  };
  const lift = (on: boolean) => {
    const slot = ref.current;
    if (!slot) return;
    if (on && rising) slot.dataset.rising = '';
    else delete slot.dataset.rising;
  };
  return (
    <motion.div
      ref={ref}
      layout="position"
      layoutDependency={orderKey}
      drag
      dragControls={controls}
      dragListener={false}
      dragSnapToOrigin
      dragMomentum={false}
      onDragStart={() => {
        hold(true);
        onDragStart();
      }}
      onDrag={(_, info) => onDragOver(id, info.point)}
      onDragEnd={onDrop}
      onDragTransitionEnd={() => hold(false)}
      custom={index}
      variants={variants}
      initial={first ? 'stagger' : 'plain'}
      animate={first ? 'shown' : 'settled'}
      exit="exit"
      transition={{ layout: spring.smooth }}
      onLayoutAnimationStart={() => lift(true)}
      onLayoutAnimationComplete={() => lift(false)}
      data-pod-slot={id}
      className="pod-slot relative h-full min-w-0 has-[[data-open]]:z-10"
    >
      <span aria-hidden className="pod-lift" />
      <PodMoveContext.Provider value={move}>{children}</PodMoveContext.Provider>
    </motion.div>
  );
}

function PodById({ id }: { id: string }) {
  const project = useBoard(selectProject(id));
  return project ? <ProjectPod project={project} /> : null;
}

export function PodGridSkeleton() {
  return (
    <div className="@container" aria-busy>
      <div className={POD_GRID}>
        {[0, 1, 2].map((i) => (
          <ProjectPodSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
