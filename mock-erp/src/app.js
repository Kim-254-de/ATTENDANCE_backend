import express from 'express';
import cors from 'cors';
import erp from './routes.js';

export function createApp() {
  const app = express();
  app.use(cors({ origin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',') }));
  app.use(express.json({ limit: '10kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/erp', erp);
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(err.type === 'entity.parse.failed' ? 400 : 500).json({ error: 'Request failed' });
  });
  return app;
}
