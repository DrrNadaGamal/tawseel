import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = () => process.env.TAWSEEL_SECRET || 'tawseel-demo-secret-change-me';
const b64 = (b) => Buffer.from(b).toString('base64url');

export function signToken(payload, now = Date.now(), ttlMs = 12 * 3600000) {
  const body = b64(JSON.stringify({ ...payload, exp: now + ttlMs }));
  const sig = createHmac('sha256', SECRET()).update(body).digest('base64url');
  return body + '.' + sig;
}

export function verifyToken(token, now = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const good = createHmac('sha256', SECRET()).update(body).digest('base64url');
  const a = Buffer.from(sig || ''), b = Buffer.from(good);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < now) return null;
    return p;
  } catch { return null; }
}

export const ROLES = ['admin', 'dispatcher', 'driver', 'viewer'];
