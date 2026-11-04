import { closePool } from '../src/db';
import { batchTimeoutMinutes, reapStaleBatches } from '../src/services/copilot_batches';

const minutes = batchTimeoutMinutes();
const ids = await reapStaleBatches();
console.log(
  ids.length
    ? `已将 ${ids.length} 个超过 ${minutes} 分钟的 running 批次标记为失败：${ids.join(', ')}`
    : `没有超过 ${minutes} 分钟的 running 批次`,
);
await closePool();
