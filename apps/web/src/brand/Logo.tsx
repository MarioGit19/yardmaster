import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { dur, ease, move, useMotionLevel } from '../motion.js';
import { createPreference } from '../prefs.js';
import { cx } from '../ui/cx.js';
import logoSource from './logo.svg?raw';
import { WORDMARK } from './name.js';
import { parseLogo, renderLogo } from './render.js';

const INLINE = renderLogo(logoSource, { ink: 'currentColor', accent: 'var(--st-work)' });

/** The logomark, inline: the Y follows `currentColor`, the orb takes the work accent. */
export function Logomark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx('inline-block shrink-0 [&>svg]:size-full', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: our own bundled SVG, recolored with fixed strings.
      dangerouslySetInnerHTML={{ __html: INLINE }}
    />
  );
}

/** Logomark plus the lowercase `yardmaster` wordmark in Geist 600 (DESIGN.md §4.9). */
export function Wordmark({
  className,
  markClassName = 'size-5',
  nameClassName,
}: {
  className?: string;
  markClassName?: string;
  nameClassName?: string;
}) {
  return (
    <span className={cx('inline-flex items-center gap-[0.4em] font-semibold', className)}>
      <Logomark className={cx('text-text-1', markClassName)} />
      <span className={cx('wordmark', nameClassName)}>{WORDMARK}</span>
    </span>
  );
}

/** Set when the brand moment plays, so it greets each browser once. */
export const brandIntroPreference = createPreference<'pending' | 'seen'>(
  'yardmaster.brandIntro',
  ['pending', 'seen'],
  'pending',
);

const PARTS = parseLogo(logoSource);
/** Where each stroke starts, in mark units: out along its own axis (left arm, right arm, stem). */
const FROM = ['translate(-26px, -26px)', 'translate(26px, -26px)', 'translate(0px, 36px)'];
const HOME = 'translate(0px, 0px)';
// The whole moment fits in `dur.slow`: the strokes converge, then the orb lights at the hub.
// It starts after `dur.fast`, once the guide's card has mostly blurred in.
const LEAD_S = dur.fast;
const STROKE_S = dur.slow * 0.7;
const STROKE_STAGGER_S = 0.04;
const ORB_DELAY_S = dur.slow * 0.42;

/**
 * The onboarding's brand moment (DESIGN.md §4.9): the Y's three strokes converge on the hub and
 * the orb lights there. Plays once per browser, at Full only; otherwise it's the still mark.
 */
export function BrandIntro({ className }: { className?: string }) {
  const still = useMotionLevel() !== 'full';
  // Decided on mount: a later preference change must not replay or cut it short.
  const [play] = useState(() => !still && brandIntroPreference.get() === 'pending');
  // Seen once it starts: a reload mid-moment shouldn't greet the same browser again.
  useEffect(() => {
    if (play) brandIntroPreference.set('seen');
  }, [play]);
  if (!play) return <Logomark className={className} />;
  return (
    <span aria-hidden="true" data-brand-intro className={cx('inline-block shrink-0', className)}>
      <svg viewBox={PARTS.viewBox} className="size-full overflow-visible" fill="none" aria-hidden>
        {PARTS.strokes.map((d, i) => (
          <motion.path
            key={d}
            d={d}
            fill="currentColor"
            initial={{ opacity: 0, transform: move(still, FROM[i] ?? HOME) }}
            animate={{ opacity: 1, transform: move(still, HOME) }}
            transition={{
              duration: STROKE_S,
              ease: ease.out,
              delay: LEAD_S + i * STROKE_STAGGER_S,
            }}
          />
        ))}
        <motion.circle
          cx={PARTS.orb.cx}
          cy={PARTS.orb.cy}
          r={PARTS.orb.r}
          fill="var(--st-work)"
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          initial={{ opacity: 0, transform: move(still, 'scale(0.4)') }}
          animate={{ opacity: 1, transform: move(still, 'scale(1)') }}
          transition={{
            duration: dur.slow - ORB_DELAY_S,
            ease: ease.out,
            delay: LEAD_S + ORB_DELAY_S,
          }}
        />
      </svg>
    </span>
  );
}
