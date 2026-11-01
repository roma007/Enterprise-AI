/** 登录失败限流：每 IP + 邮箱滑动窗口，只统计失败次数。 */

const failures = new Map<string, number[]>();

function envNumber(name: string, fallback: number, min = 1): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

export function loginKey(ip: string | undefined, email: string): string {
  return `${ip ?? 'unknown'}:${email.trim().toLowerCase()}`;
}

export function loginAllowed(key: string): { allowed: boolean; retryAfter: number } {
  const limit = envNumber('LOGIN_MAX_FAILURES', 5);
  const windowMs = envNumber('LOGIN_WINDOW_MS', 15 * 60_000, 1000);
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

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  const list = failures.get(key) ?? [];
  list.push(now);
  failures.set(key, list);
}

export function clearLoginFailures(key: string): void {
  failures.delete(key);
}

/** 仅测试用。 */
export function resetLoginGuard(): void {
  failures.clear();
}
