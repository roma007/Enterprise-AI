import { closePool } from '../src/db';
import {
  cleanupCollabSnapshots,
  collabSnapshotRetentionDays,
  snapshotCollabAudits,
} from '../src/services/collab_audit_snapshot';

const count = await snapshotCollabAudits();
const cleaned = await cleanupCollabSnapshots();
console.log(
  `已更新 ${count} 个组织的协作审计快照；清理 ${cleaned} 条超过 ${collabSnapshotRetentionDays()} 天的快照`,
);
await closePool();
