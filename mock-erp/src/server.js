import 'dotenv/config';
import { createApp } from './app.js';
import { migrate } from './db.js';
import { seedErp } from './seed.js';

for (const v of ['ERP_API_KEY', 'MOCK_ERP_DATABASE_URL']) if (!process.env[v]) throw new Error(`${v} is not set (see .env.example)`);
await migrate();
console.log('Mock ERP seeded (empty tables only):', await seedErp());
const port = process.env.MOCK_ERP_PORT || 4100;
createApp().listen(port, () => console.log(`Mock ERP listening on http://localhost:${port}/api/erp`));
