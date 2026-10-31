import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { lazy, type ReactNode, type Ref, Suspense } from 'react';
import { type BaseLocationHook, Route, Router, Switch, useLocation, useRoute } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { AmbientField } from './ambient/AmbientField.js';
import { useBackdropTaken } from './ambient/backdrop.js';
import { AttentionAlerts } from './attention/AttentionAlerts.js';
import { AttentionCenter, AttentionItemLink, AttentionPage } from './attention/AttentionCenter.js';
import { SignInScreen } from './auth/SignInScreen.js';
import { useSignedOut } from './auth/session.js';
import { LiveFavicon } from './brand/LiveFavicon.js';
import { TrustFolderDialog } from './claude/TrustFolderDialog.js';
import { FocusBackdrop, FocusStage, useFocusRoute } from './focus/FocusStage.js';
import { useLayoutShortcuts } from './layouts/LayoutStage.js';
import { CloseProjectDialog } from './library/CloseProject.js';
import { OpenProjectDialog } from './library/OpenProject.js';
import { EditorLaunchWatcher } from './library/opening.js';
import { MotionRoot } from './MotionRoot.js';
import { dur, ease } from './motion.js';
import { OnboardingWizard } from './onboarding/OnboardingWizard.js';
import { CommandPalette } from './palette/CommandPalette.js';
import { PortShareDialog } from './ports/PortShareDialog.js';
import { PulseRail } from './pulse/PulseRail.js';
import { PushPresence } from './push/push.js';
import { RecapHost } from './recap/Recap.js';
import { routes } from './routes.js';
import { AppShell } from './shell/AppShell.js';
import { useTheme } from './theme/theme.js';
import { Toasts } from './ui/Toasts.js';
import { TooltipProvider } from './ui/Tooltip.js';
import { Overview } from './views/Overview.js';
import { EmptyState, Page } from './views/Page.js';
import { MorePage, ProjectsPage, PulsePage } from './views/PhoneTabs.js';
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
 * Screens cross-fade: the new one fades in (`dur.base`) while the old one leaves faster
 * (`dur.fast`, §3 rule 2), so the two overlap only briefly. The leaving screen is inert and hidden
 * from assistive tech while it goes.
 */
function ScreenFade({ children, ref }: { children: ReactNode; ref?: Ref<HTMLDivElement> }) {
  const present = useIsPresent();
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
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
      <Route path={routes.projects}>
        <ProjectsPage />
      </Route>
      <Route path={routes.attention}>
        <AttentionPage />
      </Route>
      <Route path={routes.attentionItem}>
        {(params) => <AttentionItemLink item={params.item} />}
      </Route>
      <Route path={routes.pulse}>
        <PulsePage />
      </Route>
      <Route path={routes.more}>
        <MorePage />
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

/** The ambient field, unless a layout draws its own backdrop (Office, Grid). */
function AmbientGate() {
  return useBackdropTaken() ? null : <AmbientField />;
}

export function App({ locationHook = useHashLocation }: { locationHook?: BaseLocationHook }) {
  useTheme();
  useLayoutShortcuts();
  const signedOut = useSignedOut();
  if (signedOut) {
    return (
      <MotionRoot>
        <AmbientGate />
        <SignInScreen />
      </MotionRoot>
    );
  }
  return (
    <MotionRoot>
      <AmbientGate />
      <TooltipProvider>
        <Router hook={locationHook}>
          <AppRoutes />
          <CommandPalette />
          <OpenProjectDialog />
          <CloseProjectDialog />
          <TrustFolderDialog />
          <PortShareDialog />
          <EditorLaunchWatcher />
          <RecapHost />
        </Router>
        <Toasts />
        <AttentionAlerts />
        <PushPresence />
        <LiveFavicon />
      </TooltipProvider>
    </MotionRoot>
  );
}
