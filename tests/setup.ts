/**
 * Test environment. Set before any module imports src/config/env.ts, which
 * validates process.env at import time and would otherwise refuse to load.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/attendance_test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-1234567890';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-0987654321';
process.env.ERP_BASE_URL ??= 'https://erp.test.local/api';
process.env.ERP_AUTH_SCHEME ??= 'none';
process.env.ERP_CACHE_TTL_SECONDS ??= '0';
