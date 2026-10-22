import { startServer } from './app.js';
import { ConfigError, loadConfig } from './config.js';

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`c-board: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const app = await startServer(config);

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

main().catch((err: unknown) => {
  process.stderr.write(
    `c-board: failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
