import { closePool } from '../src/db';
import {
  archiveCollabAudits,
  collabAuditRetentionDays,
} from '../src/services/collab_audit_archive';

const days = collabAuditRetentionDays();
const archived = await archiveCollabAudits();
console.log(
  archived
    ? `已归档 ${archived} 条超过 ${days} 天的协作审计`
    : `没有超过 ${days} 天的协作审计`,
);
await closePool();
