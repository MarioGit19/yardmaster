import { MotionConfig, MotionGlobalConfig } from 'motion/react';
import { type ReactNode, useEffect } from 'react';
import { motionConfigFor, useMotionLevel } from './motion.js';

/** Applies the motion level to Motion components and, via `data-motion`, to CSS animations. */
export function MotionRoot({ children }: { children: ReactNode }) {
  const level = useMotionLevel();
  const { reducedMotion, skipAnimations } = motionConfigFor(level);
  MotionGlobalConfig.skipAnimations = skipAnimations;
  useEffect(() => {
    document.documentElement.dataset.motion = level;
  }, [level]);
  return <MotionConfig reducedMotion={reducedMotion}>{children}</MotionConfig>;
}
