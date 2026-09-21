import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env, isProduction } from './config/env.js';
import { logger } from './config/logger.js';
import { requestContext } from './middleware/request-context.js';
import { globalLimiter } from './middleware/rate-limit.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { apiRouter } from './routes.js';
import { query } from './db/database.js';

/**
 * Builds the Express application. Kept separate from server.ts so tests can
 * drive the app with supertest without binding a port.
 */
export function createApp(): Express {
  const app = express();

  // Behind a load balancer or reverse proxy, req.ip must reflect the real
  // client or the rate limiter would throttle the proxy as a single caller.
  app.set('trust proxy', isProduction ? 1 : false);
  app.disable('x-powered-by');

  app.use(requestContext);

  app.use(
    helmet({
      // An API serves JSON, not documents; the default CSP only gets in the
      // way of the error pages Express renders.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 86_400,
    }),
  );

  app.use(compression());

  // A registration payload is a few hundred bytes; a generous cap here would
  // only widen the memory-exhaustion surface.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/health/ready',
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  // --- Health checks -------------------------------------------------------
  // Liveness: is the process up? Must not touch dependencies, or a database
  // blip would have the orchestrator restart healthy containers.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) });
  });

  // Readiness: can this instance actually serve traffic?
  app.get('/health/ready', (_req, res) => {
    query('SELECT 1')
      .then(() => res.json({ status: 'ready', database: 'up' }))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'readiness check failed');
        res.status(503).json({ status: 'not-ready', database: 'down' });
      });
  });

  app.use('/api', globalLimiter);
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
