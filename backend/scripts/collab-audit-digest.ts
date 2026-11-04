import { closePool } from '../src/db';
import { sendCollabAuditDigest } from '../src/services/collab_audit_digest';

const sent = await sendCollabAuditDigest();
console.log(
  sent
    ? `已发送 ${sent} 条协作审计周报通知`
    : '本周没有需要发送的协作审计摘要',
);
await closePool();
