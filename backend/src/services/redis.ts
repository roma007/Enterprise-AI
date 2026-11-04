import Redis from 'ioredis';

let client: Redis | null | undefined;

export const redisPrefix = () => (process.env.REDIS_PREFIX ?? 'ai-delivery:').replace(/:+$/, ':');

export function redis(): Redis | null {
  if (client !== undefined) return client;
  const url = (process.env.REDIS_URL ?? '').trim();
  if (!url) {
    client = null;
    return null;
  }
  client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  client.on('error', () => {
    // 连接失败时由调用方回退内存/数据库；不要让未处理错误打崩进程
  });
  return client;
}

export async function redisHealthy(): Promise<boolean> {
  const r = redis();
  if (!r) return false;
  try {
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export function cacheDriver(): 'redis' | 'memory' {
  return redis() ? 'redis' : 'memory';
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  const current = client;
  client = null;
  await current.quit().catch(() => current.disconnect());
}
