import { lazy, Suspense, useSyncExternalStore } from 'react';
import { MotionRoot } from './MotionRoot.js';
import { useTheme } from './theme/theme.js';

const TokenPreview = lazy(() => import('./dev/TokenPreview.js'));

function subscribeHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

// Minimal hash switch until the router lands (3.3).
function useHashPath(): string {
  return useSyncExternalStore(subscribeHash, () => window.location.hash.replace(/^#/, '') || '/');
}

export function App() {
  useTheme();
  const path = useHashPath();
  return (
    <MotionRoot>
      {path === '/_tokens' ? (
        <Suspense fallback={null}>
          <TokenPreview />
        </Suspense>
      ) : (
        <main className="grid min-h-dvh place-items-center p-6">
          <p className="font-mono text-title-sm font-medium text-text-2">c-board</p>
        </main>
      )}
    </MotionRoot>
  );
}
