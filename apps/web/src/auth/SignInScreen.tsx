import { motion } from 'motion/react';
import { Logomark } from '../brand/Logo.js';
import { BRAND_NAME } from '../brand/name.js';
import { move, spring, useMotionLevel } from '../motion.js';
import { onRemoteHost } from '../settings/remoteHost.js';
import { CopyCommand } from '../ui/CopyCommand.js';

/**
 * Shown instead of the board when this browser has no live session: never signed in, revoked,
 * expired, the token was rotated, or it signed in with a cookie before per-browser sessions.
 * The same glass card as the onboarding (DESIGN.md §6), over the ambient field.
 */
export function SignInScreen() {
  const still = useMotionLevel() !== 'full';
  const phone = onRemoteHost();
  return (
    <main className="flex min-h-dvh items-center justify-center p-4 md:p-6">
      <motion.section
        data-sign-in
        aria-labelledby="sign-in-title"
        className="onboarding-card flex w-full max-w-md flex-col gap-5 rounded-modal border border-line p-6 shadow-raised"
        initial={{ opacity: 0, transform: move(still, 'translateY(8px)') }}
        animate={{
          opacity: 1,
          transform: move(still, 'translateY(0px)'),
          transition: spring.smooth,
        }}
      >
        <header className="flex flex-col gap-3">
          <Logomark className="size-10 text-text-1" />
          <div className="flex flex-col gap-1">
            <h1 id="sign-in-title" className="font-medium text-text-1 text-title">
              {phone ? 'Pair this phone again' : 'Sign in again'}
            </h1>
            <p className="text-body-sm text-text-2">
              {phone
                ? `This phone isn’t signed in to ${BRAND_NAME} any more. On your Mac, open ${BRAND_NAME} → Settings → Phone and scan a new pairing code.`
                : `This browser isn’t signed in to ${BRAND_NAME}. Open a one-time sign-in link from this computer:`}
            </p>
          </div>
        </header>
        {!phone && (
          <div className="flex flex-col gap-2">
            <CopyCommand command="yardmaster open" />
            <p className="text-meta text-text-3">
              Or run <span className="text-text-2">Yardmaster: Open Dashboard</span> from your
              editor’s command palette.
            </p>
          </div>
        )}
        <p className="border-line border-t pt-4 text-meta text-text-3">
          {BRAND_NAME} signs each browser in on its own now. Browsers and phones signed in before
          this update sign in once more.
        </p>
      </motion.section>
    </main>
  );
}
