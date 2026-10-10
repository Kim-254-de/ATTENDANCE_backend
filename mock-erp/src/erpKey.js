import crypto from 'node:crypto';

// Protects /api/erp/* with a shared secret sent as the `x-api-key` header.
export function requireErpKey(req, res, next) {
  const expected = process.env.ERP_API_KEY || '';
  const given = String(req.headers['x-api-key'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!expected || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Invalid or missing API key' });
  next();
}
