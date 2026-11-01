import { verifyPassword } from './auth';
import { query } from '../db';
import { httpError } from './s1';

const COMMON = new Set([
  'password',
  'password1',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty123',
  'admin123',
  'demo1234',
  'hengzhi',
  'a1234567',
]);

/** 新密码策略：≥10 位，大小写/数字/符号至少 3 类，不能是常见弱口令/邮箱前缀。 */
export function assertPasswordPolicy(password: string, email?: string): void {
  const fail = (message: string): never => {
    throw httpError(422, 'WEAK_PASSWORD', message);
  };

  if (password.length < 10) fail('密码至少 10 位');
  if (password.length > 128) fail('密码不能超过 128 位');

  const categories = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  if (categories < 3) fail('密码需包含大小写字母、数字、符号中的至少 3 类');

  const lower = password.toLowerCase();
  if (COMMON.has(lower)) fail('密码过于常见，请更换');
  if (email) {
    const local = email.split('@')[0]?.toLowerCase() ?? '';
    if (local.length >= 3 && lower.includes(local)) fail('密码不能包含邮箱前缀');
  }
}

/** 记录新密码哈希并只保留最近 5 条。 */
export async function rememberPassword(
  userId: string,
  passwordHash: string,
  client?: { query: (sql: string, values?: any[]) => Promise<any> },
): Promise<void> {
  const exec = client
    ? (sql: string, values?: any[]) => client.query(sql, values)
    : (sql: string, values?: any[]) => query(sql, values);
  await exec(
    `INSERT INTO password_history (user_id, password_hash) VALUES ($1,$2)`,
    [userId, passwordHash],
  );
  await exec(
    `DELETE FROM password_history
      WHERE user_id = $1
        AND id NOT IN (
          SELECT id FROM password_history
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 5
        )`,
    [userId],
  );
}

/** 新密码是否与最近 5 次密码重复。 */
export async function passwordReused(userId: string, password: string): Promise<boolean> {
  const rows = await query<{ password_hash: string }>(
    `SELECT password_hash FROM password_history
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
    [userId],
  );
  return rows.some((row) => verifyPassword(password, row.password_hash));
}
