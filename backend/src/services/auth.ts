import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.AUTH_SECRET ?? 'dev-only-change-me';
export const TOKEN_TTL_SECONDS = 8 * 60 * 60;

export interface AuthUser {
  sub: string;
  org_id: string;
  org_slug?: string;
  role: string;
  platform_admin?: boolean;
  name: string;
  email: string;
  exp: number;
  jti?: string;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;

  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

export function signToken(user: {
  id: string;
  org_id: string;
  role: string;
  name: string;
  email: string;
  org_slug?: string;
  jti?: string;
  platform_admin?: boolean;
}): string {
  const payload: AuthUser = {
    sub: user.id,
    org_id: user.org_id,
    ...(user.org_slug ? { org_slug: user.org_slug } : {}),
    role: user.role,
    ...(user.platform_admin ? { platform_admin: true } : {}),
    name: user.name,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    ...(user.jti ? { jti: user.jti } : {}),
  };
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyToken(token: string): AuthUser | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  const expected = createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AuthUser;
    if (!payload.sub || !payload.org_id || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
