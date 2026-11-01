import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PdfCacheStatus = 'HIT' | 'MISS';

const cacheDir = () =>
  (process.env.PDF_CACHE_DIR ?? '').trim() || join(process.cwd(), '.pdf-cache');

const ttlDays = () => Number(process.env.PDF_CACHE_TTL_DAYS ?? 30);

/** 交付物内容/版本变化会产生不同 key，不会命中旧 PDF。 */
export function pdfCacheKey(parts: Array<string | number | null | undefined>): string {
  return createHash('sha256').update(parts.map((p) => String(p ?? '')).join('\u0000')).digest('hex');
}

async function pruneCache(): Promise<void> {
  const days = ttlDays();
  if (!Number.isFinite(days) || days <= 0) return;
  const dir = cacheDir();
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  try {
    const files = await readdir(dir);
    await Promise.all(
      files
        .filter((f) => f.endsWith('.pdf'))
        .map(async (f) => {
          const path = join(dir, f);
          try {
            const info = await stat(path);
            if (info.mtimeMs < cutoff) await rm(path, { force: true });
          } catch {
            /* ignore */
          }
        }),
    );
  } catch {
    /* cache dir 不存在时忽略 */
  }
}

/**
 * 读取/生成 PDF 缓存。
 * - refresh=true 时跳过读取，重新渲染并覆盖；
 * - 写入采用临时文件 + rename，避免并发读到半个文件；
 * - TTL 只清理过期文件，不影响当前请求。
 */
export async function cachedPdf(
  key: string,
  build: () => Promise<Buffer>,
  refresh = false,
): Promise<{ buffer: Buffer; cache: PdfCacheStatus }> {
  const dir = cacheDir();
  const path = join(dir, `${key}.pdf`);

  if (!refresh) {
    try {
      const buffer = await readFile(path);
      if (buffer.length > 0) return { buffer, cache: 'HIT' };
    } catch {
      /* miss */
    }
  }

  const buffer = await build();
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, buffer);
  await rename(tmp, path);
  void pruneCache();
  return { buffer, cache: 'MISS' };
}

/** 读取已缓存的 PDF；不存在/为空时返回 null。 */
export async function readPdfCache(key: string): Promise<Buffer | null> {
  try {
    const buffer = await readFile(join(cacheDir(), `${key}.pdf`));
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

/** 测试/运维用：清空缓存目录。 */
export async function clearPdfCache(): Promise<void> {
  await rm(cacheDir(), { recursive: true, force: true }).catch(() => undefined);
}
