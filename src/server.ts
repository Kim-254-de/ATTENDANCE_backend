import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeDatabase, verifyDatabaseConnection } from './db/database.js';
import { invitationService } from './modules/auth/index.js';

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
  void bootstrapFirstAdmin();
}

const BOOTSTRAP_MESSAGES: Record<invitationService.BootstrapOutcome, string> = {
  ADMIN_EXISTS: 'bootstrap admin: an administrator already exists; BOOTSTRAP_ADMIN_EMAIL can be removed',
  INVITED: 'bootstrap admin: invitation sent',
  RESENT: 'bootstrap admin: the earlier invitation expired; a new one was sent',
  INVITATION_PENDING: 'bootstrap admin: invitation already sent and not yet accepted',
  EMAIL_FAILED: 'bootstrap admin: the invitation email could not be sent (check RESEND_API_KEY and EMAIL_FROM); retrying at next start',
};

/**
 * BOOTSTRAP_ADMIN_EMAIL: invites the first administrator (auth.invitation.ts
 * bootstrapAdmin). Runs after listening so a slow email never holds up the
 * health check, and is never fatal: the API is useful without it.
 */
async function bootstrapFirstAdmin(): Promise<void> {
  const email = env.BOOTSTRAP_ADMIN_EMAIL;
  const fullName = env.BOOTSTRAP_ADMIN_NAME;
  if (!email || !fullName) return;
  try {
    const outcome = await invitationService.bootstrapAdmin(email, fullName);
    const log = { email, expiresInHours: env.OFFICER_INVITE_TTL_HOURS };
    if (outcome === 'EMAIL_FAILED') logger.error(log, BOOTSTRAP_MESSAGES[outcome]);
    else logger.info(log, BOOTSTRAP_MESSAGES[outcome]);
  } catch (error) {
    logger.error({ err: error, email }, 'bootstrap admin: could not invite');
  }
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
