import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { BoardProvider, createBoard } from './data/index.js';
import { layoutPreference, preloadLayout } from './layouts/registry.js';
import { applyInitialMotion } from './motion.js';
import { seenItems } from './seen.js';
import { applyInitialTheme } from './theme/theme.js';

applyInitialTheme();
applyInitialMotion();
// The overview's layout chunk loads while the board connects.
void preloadLayout(layoutPreference.get());

const board = createBoard();
board.start();
void seenItems.load();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <BoardProvider client={board.client} store={board.store}>
        <App />
      </BoardProvider>
    </StrictMode>,
  );
}
