#!/usr/bin/env node
import type { FastifyInstance } from 'fastify';
import { processIo, runCli } from './cli-app.js';

function handleSignals(app: FastifyInstance): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

runCli(process.argv.slice(2), { ...processIo(), onStarted: handleSignals }).then(
  (code) => {
    if (code !== null) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`c-board: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
