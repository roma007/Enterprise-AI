/**
 * 子进程读取 S3 对象，用于验证 API / worker 跨进程共享对象存储。
 * 由 scripts/s3-drill.ts 调用，不作为独立命令使用。
 */
import { objectStorage } from '../src/services/object_storage';

const key = process.argv[2];
if (!key) {
  console.error('用法：tsx scripts/s3-read-probe.ts <key>');
  process.exit(1);
}

const buffer = await objectStorage().get(key);
if (!buffer) {
  console.error('MISS');
  process.exit(2);
}
process.stdout.write(buffer.toString('base64'));
