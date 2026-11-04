import { createHash } from 'node:crypto';
import { objectStorage, type StorageDriver } from './object_storage';

export type PdfCacheStatus = 'HIT' | 'MISS';

const PREFIX = 'pdf-cache';

const ttlDays = () => Number(process.env.PDF_CACHE_TTL_DAYS ?? 30);

/** 交付物内容/版本变化会产生不同 key，不会命中旧 PDF。 */
export function pdfCacheKey(parts: Array<string | number | null | undefined>): string {
  return createHash('sha256').update(parts.map((p) => String(p ?? '')).join('\u0000')).digest('hex');
}

const objectKey = (key: string) => `${PREFIX}/${key}.pdf`;

/**
 * 读取/生成 PDF 缓存，底层支持 local / s3。
 * - refresh=true 跳过读取并覆盖；
 * - 写入由存储驱动保证原子性（local 临时文件 + rename）；
 * - local 按 TTL 清理，S3 由 bucket 生命周期规则负责。
 */
export async function cachedPdf(
  key: string,
  build: () => Promise<Buffer>,
  refresh = false,
): Promise<{ buffer: Buffer; cache: PdfCacheStatus }> {
  const storage = objectStorage();
  if (!refresh) {
    const hit = await storage.get(objectKey(key));
    if (hit && hit.length) return { buffer: hit, cache: 'HIT' };
  }

  const buffer = await build();
  await storage.put(objectKey(key), buffer, 'application/pdf');
  void storage.prune(ttlDays());
  return { buffer, cache: 'MISS' };
}

export async function readPdfCache(key: string): Promise<Buffer | null> {
  return objectStorage().get(objectKey(key));
}

export async function clearPdfCache(): Promise<void> {
  await objectStorage().clear();
}

export function pdfStorageInfo(): { driver: StorageDriver; detail: string } {
  const storage = objectStorage();
  return { driver: storage.driver, detail: storage.detail };
}
