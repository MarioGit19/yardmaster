import { startDemoBoard } from './board.js';
import { E2E_COOKIE, E2E_URL } from './env.js';

/** Boots the shared demo board and hands its URL and session cookie to the workers via env. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const board = await startDemoBoard();
  process.env[E2E_URL] = board.url;
  process.env[E2E_COOKIE] = board.cookie;
  return board.stop;
}
