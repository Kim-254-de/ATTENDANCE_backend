import pino from 'pino';
import { env, isProduction, isTest } from './env.js';

/**
 * Structured logging. Anything that could identify a person or authenticate a
 * request is redacted before it reaches a log sink.
 */
export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
      '*.passwordHash',
      'confirmPassword',
      '*.confirmPassword',
      'token',
      '*.token',
    ],
    censor: '[redacted]',
  },
  base: { service: 'attendance-backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
      },
});

export type Logger = typeof logger;
