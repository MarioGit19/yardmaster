import { startDemoBoard } from './board.js';
import { E2E_SESSION, E2E_URL } from './env.js';

/** Boots the shared demo board and hands its URL and session secret to the workers via env. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const board = await startDemoBoard();
  process.env[E2E_URL] = board.url;
  process.env[E2E_SESSION] = board.session;
  return board.stop;
}
