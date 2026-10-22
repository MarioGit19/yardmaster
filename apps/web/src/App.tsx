import { lazy, Suspense } from 'react';
import { type BaseLocationHook, Route, Router, Switch } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { AmbientField } from './ambient/AmbientField.js';
import { LiveFavicon } from './brand/LiveFavicon.js';
import { MotionRoot } from './MotionRoot.js';
import { routes } from './routes.js';
import { AppShell } from './shell/AppShell.js';
import { useTheme } from './theme/theme.js';
import { Toasts } from './ui/Toasts.js';
import { TooltipProvider } from './ui/Tooltip.js';
import { FocusView } from './views/FocusView.js';
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
        <AppShell>
          <Switch>
            <Route path={routes.overview}>
              <Overview />
            </Route>
            <Route path={routes.session}>
              {(params) => <FocusView projectId={params.projectId} sessionId={params.sessionId} />}
            </Route>
            <Route path={routes.project}>
              {(params) => <FocusView projectId={params.projectId} />}
            </Route>
            <Route path={routes.settings}>
              <SettingsView />
            </Route>
            <Route>
              <Page>
                <EmptyState title="Nothing here">This page doesn't exist.</EmptyState>
              </Page>
            </Route>
          </Switch>
        </AppShell>
      </Route>
    </Switch>
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
        </Router>
        <Toasts />
        <LiveFavicon />
      </TooltipProvider>
    </MotionRoot>
  );
}
