import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { lazy, type ReactNode, type Ref, Suspense } from 'react';
import { type BaseLocationHook, Route, Router, Switch, useLocation, useRoute } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { AmbientField } from './ambient/AmbientField.js';
import { AttentionAlerts } from './attention/AttentionAlerts.js';
import { AttentionCenter } from './attention/AttentionCenter.js';
import { LiveFavicon } from './brand/LiveFavicon.js';
import { FocusBackdrop, FocusStage, useFocusRoute } from './focus/FocusStage.js';
import { MotionRoot } from './MotionRoot.js';
import { dur, ease } from './motion.js';
import { OnboardingWizard } from './onboarding/OnboardingWizard.js';
import { CommandPalette } from './palette/CommandPalette.js';
import { PulseRail } from './pulse/PulseRail.js';
import { routes } from './routes.js';
import { AppShell } from './shell/AppShell.js';
import { useTheme } from './theme/theme.js';
import { Toasts } from './ui/Toasts.js';
import { TooltipProvider } from './ui/Tooltip.js';
import { Overview } from './views/Overview.js';
import { EmptyState, Page } from './views/Page.js';
import { SettingsView } from './views/SettingsView.js';

const TokenPreview = lazy(() => import('./dev/TokenPreview.js'));

/** The routed screens inside the shell. `/_tokens` is a standalone dev page. */
export function AppRoutes() {
  return (
    <Switch>
      <Route path={routes.tokens}>
        <Suspense fallback={null}>
          <TokenPreview />
        </Suspense>
      </Route>
      <Route>
        <Screens />
      </Route>
    </Switch>
  );
}

/** The overview and focus routes share one stage: the focus view opens over the overview. */
function Screens() {
  const [onOverview] = useRoute(routes.overview);
  const [location] = useLocation();
  const focus = useFocusRoute();
  const board = onOverview || focus !== null;
  return (
    <AppShell
      sheet={<AttentionCenter />}
      stage={board ? <FocusStage focus={focus} /> : undefined}
      pulse={<PulseRail />}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <ScreenFade key={board ? 'board' : location}>
          {board ? (
            <FocusBackdrop dimmed={focus !== null}>
              <Overview />
            </FocusBackdrop>
          ) : (
            <OtherScreens />
          )}
        </ScreenFade>
      </AnimatePresence>
    </AppShell>
  );
}

/**
 * Screens cross-fade (`dur.base`): the old one fades out over the new one as it fades in. The
 * leaving screen is inert and hidden from assistive tech while it goes.
 */
function ScreenFade({ children, ref }: { children: ReactNode; ref?: Ref<HTMLDivElement> }) {
  const present = useIsPresent();
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: dur.base, ease: ease.out }}
      inert={!present}
      aria-hidden={!present || undefined}
      data-screen={present ? '' : 'leaving'}
    >
      {children}
    </motion.div>
  );
}

function OtherScreens() {
  return (
    <Switch>
      <Route path={routes.settings}>
        <SettingsView />
      </Route>
      <Route path={routes.welcome}>
        <WelcomeView />
      </Route>
      <Route>
        <Page>
          <EmptyState title="Nothing here">This page doesn't exist.</EmptyState>
        </Page>
      </Route>
    </Switch>
  );
}

/** The setup guide on demand (Settings, ⌘K), whatever the board's state. */
function WelcomeView() {
  const [, navigate] = useLocation();
  return (
    <Page width="narrow">
      <OnboardingWizard onDone={() => navigate(routes.overview)} />
    </Page>
  );
}

export function App({ locationHook = useHashLocation }: { locationHook?: BaseLocationHook }) {
  useTheme();
  return (
    <MotionRoot>
      <AmbientField />
      <TooltipProvider>
        <Router hook={locationHook}>
          <AppRoutes />
          <CommandPalette />
        </Router>
        <Toasts />
        <AttentionAlerts />
        <LiveFavicon />
      </TooltipProvider>
    </MotionRoot>
  );
}
