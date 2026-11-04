import { redis, redisPrefix } from './redis';

/** 登录失败限流：优先 Redis，未配置/连接失败回退进程内存。 */

const failures = new Map<string, number[]>();

const redisKey = (key: string) => `${redisPrefix()}login:fail:${key}`;

function envNumber(name: string, fallback: number, min = 1): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

export function loginKey(ip: string | undefined, email: string): string {
  return `${ip ?? 'unknown'}:${email.trim().toLowerCase()}`;
}

export async function loginAllowed(
  key: string,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const limit = envNumber('LOGIN_MAX_FAILURES', 5);
  const windowMs = envNumber('LOGIN_WINDOW_MS', 15 * 60_000, 1000);
  const r = redis();
  if (r) {
    try {
      const value = Number((await r.get(redisKey(key))) ?? 0);
      if (value >= limit) {
        const ttl = await r.ttl(redisKey(key));
        return { allowed: false, retryAfter: Math.max(1, ttl > 0 ? ttl : 60) };
      }
      return { allowed: true, retryAfter: 0 };
    } catch {
      /* fallback */
    }
  }

  const now = Date.now();
  const recent = (failures.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
    failures.set(key, recent);
    return { allowed: false, retryAfter };
  }
  failures.set(key, recent);
  return { allowed: true, retryAfter: 0 };
}

export async function recordLoginFailure(key: string): Promise<void> {
  const r = redis();
  if (r) {
    try {
      const windowSeconds = Math.ceil(envNumber('LOGIN_WINDOW_MS', 15 * 60_000, 1000) / 1000);
      await r
        .multi()
        .incr(redisKey(key))
        .expire(redisKey(key), windowSeconds)
        .exec();
      return;
    } catch {
      /* fallback */
    }
  }
  const now = Date.now();
  const list = failures.get(key) ?? [];
  list.push(now);
  failures.set(key, list);
}

export async function clearLoginFailures(key: string): Promise<void> {
  const r = redis();
  if (r) {
    try {
      await r.del(redisKey(key));
    } catch {
      /* fallback */
    }
  }
  failures.delete(key);
}

/** 仅测试用。 */
export async function resetLoginGuard(): Promise<void> {
  failures.clear();
  const r = redis();
  if (r) {
    try {
      const keys = await r.keys(`${redisPrefix()}login:fail:*`);
      if (keys.length) await r.del(...keys);
    } catch {
      /* ignore */
    }
  }
}
