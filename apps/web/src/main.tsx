import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { BoardProvider, createBoard } from './data/index.js';
import { applyInitialMotion } from './motion.js';
import { applyInitialTheme } from './theme/theme.js';

applyInitialTheme();
applyInitialMotion();

const board = createBoard();
board.start();

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
