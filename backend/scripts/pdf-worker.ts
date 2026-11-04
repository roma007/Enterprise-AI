/**
 * 独立 PDF worker：多实例部署时使用，和 API 共享 pdf_jobs 队列。
 *
 *   PDF_WORKER_INLINE=false npm run start   # API 不内联跑 worker
 *   npm run worker:pdf                      # 单独启动 1..N 个 worker
 */
import { closePool } from '../src/db';
import { startPdfWorker } from '../src/services/pdf_jobs';

const stop = startPdfWorker();
console.log('[pdf-worker] started');

const shutdown = async (signal: string) => {
  console.log(`[pdf-worker] ${signal}, stopping`);
  stop();
  await closePool();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
