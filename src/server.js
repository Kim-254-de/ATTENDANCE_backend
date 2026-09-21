import 'dotenv/config';
import { createApp } from './app.js';
import { migrate } from './db.js';
import { seedErp } from './erp/seed.js';

if (!process.env.ERP_API_KEY) throw new Error('ERP_API_KEY is not set (see .env.example)');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (see .env.example)');

await migrate();
console.log('Mock ERP seeded:', await seedErp());
const port = process.env.PORT || 4000;
createApp().listen(port, () => console.log(`API listening on http://localhost:${port}`));
