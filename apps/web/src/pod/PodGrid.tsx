import { AnimatePresence, motion, type Variants } from 'motion/react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { selectProject, useBoard, useBoardList } from '../data/index.js';
import { useActiveProjects } from '../library/useActive.js';
import { dur, ease, spring, useMotionLevel } from '../motion.js';
import { risingPods, selectPodOrder } from './model.js';
import { ProjectPod, ProjectPodSkeleton } from './ProjectPod.js';

/** Columns follow the space the grid gets (the rail takes some), not the viewport. */
const POD_GRID =
  'relative grid grid-cols-1 gap-4 @min-[40rem]:grid-cols-2 @min-[66rem]:grid-cols-3 @min-[96rem]:grid-cols-4';

/** DESIGN.md §3 rule 1: 30–40 ms apart, at most eight pods staggered. */
const STAGGER_S = 0.035;
const MAX_STAGGERED = 8;

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

/**
 * The overview's pods, attention first (waiting, then errors, then by name). Reorders glide
 * with `layout`; peeks raise their pod above its neighbours.
 */
export function PodGrid() {
  const all = useBoardList(selectPodOrder);
  // Only active projects (F26); one that goes quiet leaves through the exit variant.
  const active = useActiveProjects();
  const order = useMemo(() => all.filter((id) => active.has(id)), [all, active]);
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
    </div>
  );
}

/**
 * One grid cell. A reorder glides every slot on `smooth`; a pod that overtakes a neighbour is
 * lifted above the others with a soft shadow for the flight, so cards never cross visibly.
 */
function PodSlot({
  orderKey,
  index,
  first,
  rising,
  children,
}: {
  orderKey: string;
  index: number;
  first: boolean;
  rising: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
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
      custom={index}
      variants={variants}
      initial={first ? 'stagger' : 'plain'}
      animate={first ? 'shown' : 'settled'}
      exit="exit"
      transition={{ layout: spring.smooth }}
      onLayoutAnimationStart={() => lift(true)}
      onLayoutAnimationComplete={() => lift(false)}
      data-pod-slot
      className="pod-slot relative h-full min-w-0 has-[[data-open]]:z-10"
    >
      <span aria-hidden className="pod-lift" />
      {children}
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
