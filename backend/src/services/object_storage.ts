import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export type StorageDriver = 'local' | 's3';

export interface ObjectStorage {
  driver: StorageDriver;
  detail: string;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  prune(ttlDays: number): Promise<void>;
  clear(): Promise<void>;
}

const localRoot = () =>
  (process.env.PDF_CACHE_DIR ?? '').trim() || join(process.cwd(), '.pdf-cache');

class LocalStorage implements ObjectStorage {
  driver = 'local' as const;
  detail = localRoot();

  private path(key: string) {
    return join(localRoot(), key);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true }).catch(() => undefined);
  }

  async prune(ttlDays: number): Promise<void> {
    if (!Number.isFinite(ttlDays) || ttlDays <= 0) return;
    const root = localRoot();
    const cutoff = Date.now() - ttlDays * 24 * 3600 * 1000;
    try {
      const entries = await readdir(root, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          if (!entry.isDirectory()) return;
          const dir = join(root, entry.name);
          const files = await readdir(dir).catch(() => [] as string[]);
          await Promise.all(
            files
              .filter((f) => f.endsWith('.pdf'))
              .map(async (f) => {
                const path = join(dir, f);
                const info = await stat(path).catch(() => null);
                if (info && info.mtimeMs < cutoff) await rm(path, { force: true });
              }),
          );
        }),
      );
    } catch {
      /* root 不存在 */
    }
  }

  async clear(): Promise<void> {
    await rm(localRoot(), { recursive: true, force: true }).catch(() => undefined);
  }
}

class S3Storage implements ObjectStorage {
  driver = 's3' as const;
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  detail: string;

  constructor() {
    const endpoint = (process.env.S3_ENDPOINT ?? '').trim() || undefined;
    const region = (process.env.S3_REGION ?? 'us-east-1').trim();
    this.bucket = (process.env.S3_BUCKET ?? '').trim();
    this.prefix = (process.env.S3_PREFIX ?? 'ai-delivery').replace(/^\/+|\/+$/g, '');
    this.detail = `${endpoint ?? 'aws'} / ${this.bucket} / ${this.prefix}`;
    const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? '';
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? '';
    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
      // MinIO / S3rver 等兼容实现不一定支持新版默认的灵活校验和
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
  }

  private key(key: string) {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch (err: any) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }))
      .catch(() => undefined);
  }

  async prune(): Promise<void> {
    // S3 生命周期规则负责过期；应用侧不做列表扫描
  }

  async clear(): Promise<void> {
    // 不提供批量清空，避免误删对象存储
  }
}

let cached: ObjectStorage | null = null;

export function objectStorage(): ObjectStorage {
  if (cached) return cached;
  const requested = (process.env.STORAGE_DRIVER ?? '').trim();
  const useS3 = requested === 's3' || (!requested && Boolean(process.env.S3_BUCKET));
  if (useS3) {
    if (!process.env.S3_BUCKET) {
      throw new Error('STORAGE_DRIVER=s3 但未设置 S3_BUCKET');
    }
    cached = new S3Storage();
  } else {
    cached = new LocalStorage();
  }
  return cached;
}
