import { redis, redisPrefix } from './redis';

const memory = new Map<string, { value: boolean; expiresAt: number }>();
const keyOf = (jti: string) => `${redisPrefix()}session:${jti}`;

export async function getCachedSession(jti: string): Promise<boolean | null> {
  const r = redis();
  if (r) {
    try {
      const value = await r.get(keyOf(jti));
      if (value === '1') return true;
      if (value === '0') return false;
      return null;
    } catch {
      /* fallback */
    }
  }
  const hit = memory.get(jti);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    memory.delete(jti);
    return null;
  }
  return hit.value;
}

export async function cacheSession(jti: string, active: boolean): Promise<void> {
  const ttl = active ? 30 : 5;
  const r = redis();
  if (r) {
    try {
      await r.set(keyOf(jti), active ? '1' : '0', 'EX', ttl);
      return;
    } catch {
      /* fallback */
    }
  }
  memory.set(jti, { value: active, expiresAt: Date.now() + ttl * 1000 });
}

export async function invalidateSessions(jtis: string[]): Promise<void> {
  if (!jtis.length) return;
  for (const jti of jtis) memory.delete(jti);
  const r = redis();
  if (r) {
    try {
      await r.del(...jtis.map(keyOf));
    } catch {
      /* ignore */
    }
  }
}
