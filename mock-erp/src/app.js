import express from 'express';
import cors from 'cors';
import erp from './routes.js';
import { fileURLToPath } from 'node:url';

export function createApp() {
  const app = express();
  app.use(cors({ origin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',') }));
  app.use(express.json({ limit: '10kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/erp', erp);
  // Admin page for browsing/editing the mock ERP (asks for the API key; the API itself stays key-protected)
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(err.type === 'entity.parse.failed' ? 400 : 500).json({ error: 'Request failed' });
  });
  return app;
}
