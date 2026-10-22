import { parseArgs } from 'node:util';
import { startServer } from './app.js';
import { ConfigError, loadConfig } from './config.js';

function parseFlags(): { demo: boolean } {
  try {
    const { values } = parseArgs({ options: { demo: { type: 'boolean', default: false } } });
    return { demo: values.demo };
  } catch (err) {
    process.stderr.write(`c-board: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const flags = parseFlags();
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

  const app = await startServer(config, { demo: flags.demo });
  if (flags.demo) app.log.info('demo mode: serving synthetic projects, nothing is persisted');

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
