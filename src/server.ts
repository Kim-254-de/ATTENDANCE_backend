import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeDatabase, verifyDatabaseConnection } from './db/database.js';

/**
 * Process entry point: connect dependencies, listen, and shut down cleanly.
 */

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function bootstrap(): Promise<void> {
  // Fails loudly here if the database is unreachable or is missing a table
  // this service queries, rather than as a 500 on the first registration.
  await verifyDatabaseConnection();

  const app = createApp();
  const server: Server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'attendance backend listening');
  });

  registerShutdownHandlers(server);
}

function registerShutdownHandlers(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    // A second Ctrl+C should not start a second teardown.
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutting down');

    // Stop accepting connections, then let in-flight requests finish.
    server.close(() => {
      closeDatabase()
        .then(() => {
          logger.info('shutdown complete');
          process.exit(0);
        })
        .catch((error: unknown) => {
          logger.error({ err: error }, 'error during shutdown');
          process.exit(1);
        });
    });

    // Never hang forever on a stuck connection.
    setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // An unhandled rejection leaves the process in an unknown state. Log it and
  // let the orchestrator restart a clean instance.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    shutdown('uncaughtException');
  });
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start server');
  process.exit(1);
});
