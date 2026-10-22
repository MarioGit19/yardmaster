import { lazy, Suspense } from 'react';
import { type BaseLocationHook, Route, Router, Switch, useRoute } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { AmbientField } from './ambient/AmbientField.js';
import { AttentionCenter } from './attention/AttentionCenter.js';
import { LiveFavicon } from './brand/LiveFavicon.js';
import { FocusBackdrop, FocusStage, useFocusRoute } from './focus/FocusStage.js';
import { MotionRoot } from './MotionRoot.js';
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
  const focus = useFocusRoute();
  const board = onOverview || focus !== null;
  return (
    <AppShell
      sheet={<AttentionCenter />}
      stage={board ? <FocusStage focus={focus} /> : undefined}
      pulse={<PulseRail />}
    >
      {board ? (
        <FocusBackdrop dimmed={focus !== null}>
          <Overview />
        </FocusBackdrop>
      ) : (
        <Switch>
          <Route path={routes.settings}>
            <SettingsView />
          </Route>
          <Route>
            <Page>
              <EmptyState title="Nothing here">This page doesn't exist.</EmptyState>
            </Page>
          </Route>
        </Switch>
      )}
    </AppShell>
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
        <LiveFavicon />
      </TooltipProvider>
    </MotionRoot>
  );
}
