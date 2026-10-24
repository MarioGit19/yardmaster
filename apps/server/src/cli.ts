#!/usr/bin/env node
import type { FastifyInstance } from 'fastify';
import { processIo, runCli } from './cli-app.js';

function handleSignals(app: FastifyInstance): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const running = app.sessionRunner.liveCount;
    if (running > 0) {
      process.stderr.write(
        `yardmaster: stopping ${running} running board session${running === 1 ? '' : 's'}. ` +
          'They show as interrupted on the next start, with Resume.\n',
      );
    }
    const terminals = app.ptyManager.liveCount;
    if (terminals > 0) {
      process.stderr.write(
        `yardmaster: closing ${terminals} board terminal${terminals === 1 ? '' : 's'} and what runs in them.\n`,
      );
    }
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
    process.stderr.write(`yardmaster: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
