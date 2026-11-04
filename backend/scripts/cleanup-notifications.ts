import { closePool } from '../src/db';
import {
  cleanupDeletedNotifications,
  notificationTrashRetentionDays,
} from '../src/services/notification_cleanup';

const days = notificationTrashRetentionDays();
const deleted = await cleanupDeletedNotifications();
console.log(
  deleted
    ? `已彻底删除 ${deleted} 条超过 ${days} 天的回收站通知`
    : `没有超过 ${days} 天的回收站通知`,
);
await closePool();
