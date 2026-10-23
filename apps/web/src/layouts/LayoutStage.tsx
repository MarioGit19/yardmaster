import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { type Ref, Suspense, useEffect, useState } from 'react';
import { dur, ease } from '../motion.js';
import { PodGridSkeleton } from '../pod/PodGrid.js';
import { usePreference } from '../prefs.js';
import { isTypingTarget } from '../shell/railNav.js';
import { type LayoutId, layoutComponent, layoutPreference, layoutShortcut } from './registry.js';

/**
 * The overview in the chosen layout (DESIGN.md §10.1). A switch cross-fades the old scene out and
 * the new one in over `dur.slow` (Off swaps at once); a layout whose chunk is still loading shows
 * the pod skeleton.
 */
export function LayoutStage() {
  const layout = usePreference(layoutPreference);
  return (
    <div className="relative">
      <AnimatePresence initial={false} mode="popLayout">
        <LayoutFade key={layout} layout={layout} />
      </AnimatePresence>
    </div>
  );
}

function LayoutFade({ layout, ref }: { layout: LayoutId; ref?: Ref<HTMLDivElement> }) {
  const present = useIsPresent();
  // Fixed per mount: a layout that suspended keeps its lazy wrapper instead of remounting later.
  const [Layout] = useState(() => layoutComponent(layout));
  return (
    <motion.div
      ref={ref}
      data-layout={layout}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: dur.slow, ease: ease.inOut }}
      inert={!present}
      aria-hidden={!present || undefined}
      className="w-full"
    >
      <Suspense fallback={<PodGridSkeleton />}>
        <Layout />
      </Suspense>
    </motion.div>
  );
}

/** `⌥1`…`⌥5` switch the layout from anywhere but a text field or terminal. */
export function useLayoutShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const layout = layoutShortcut(event);
      if (!layout || event.defaultPrevented || isTypingTarget(event.target)) return;
      event.preventDefault();
      layoutPreference.set(layout);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
