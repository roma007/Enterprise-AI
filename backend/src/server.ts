import { buildApp } from './app';
import { closePool } from './db';
import {
  batchReapIntervalSeconds,
  reapStaleBatches,
} from './services/copilot_batches';
import {
  cleanupDeletedNotifications,
  notificationCleanupIntervalSeconds,
} from './services/notification_cleanup';
import {
  archiveCollabAudits,
  collabAuditArchiveIntervalSeconds,
} from './services/collab_audit_archive';
import {
  snapshotCollabAudits,
  cleanupCollabSnapshots,
  collabSnapshotIntervalSeconds,
} from './services/collab_audit_snapshot';
import {
  collabDigestIntervalSeconds,
  sendCollabAuditDigest,
} from './services/collab_audit_digest';
import {
  auditExportCleanupIntervalSeconds,
  cleanupAuditExportJobs,
  resumePendingAuditExportJobs,
} from './services/audit_exports';

const app = buildApp();

const port = Number(process.env.PORT ?? 8788);
const host = process.env.HOST ?? '127.0.0.1';

let batchReapTimer: NodeJS.Timeout | null = null;
let notificationCleanupTimer: NodeJS.Timeout | null = null;
let auditExportCleanupTimer: NodeJS.Timeout | null = null;
let collabAuditArchiveTimer: NodeJS.Timeout | null = null;
let collabSnapshotTimer: NodeJS.Timeout | null = null;
let collabDigestTimer: NodeJS.Timeout | null = null;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  if (batchReapTimer) {
    clearInterval(batchReapTimer);
    batchReapTimer = null;
  }
  if (notificationCleanupTimer) {
    clearInterval(notificationCleanupTimer);
    notificationCleanupTimer = null;
  }
  if (auditExportCleanupTimer) {
    clearInterval(auditExportCleanupTimer);
    auditExportCleanupTimer = null;
  }
  if (collabAuditArchiveTimer) {
    clearInterval(collabAuditArchiveTimer);
    collabAuditArchiveTimer = null;
  }
  if (collabSnapshotTimer) {
    clearInterval(collabSnapshotTimer);
    collabSnapshotTimer = null;
  }
  if (collabDigestTimer) {
    clearInterval(collabDigestTimer);
    collabDigestTimer = null;
  }
  await app.close();
  await closePool();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port, host });
  app.log.info(`API ready at http://${host}:${port}/api/health`);
  void resumePendingAuditExportJobs().catch((err) => {
    app.log.warn({ err }, 'resume audit export jobs failed');
  });

  const reapInterval = batchReapIntervalSeconds();
  if (reapInterval > 0) {
    const reap = async () => {
      try {
        const ids = await reapStaleBatches();
        if (ids.length) {
          app.log.info(
            { count: ids.length, ids },
            'reaped stale copilot reconcile batches',
          );
        }
      } catch (err) {
        app.log.warn({ err }, 'failed to reap stale copilot reconcile batches');
      }
    };
    setTimeout(() => void reap(), 5000).unref?.();
    batchReapTimer = setInterval(() => void reap(), reapInterval * 1000);
    batchReapTimer.unref?.();
    app.log.info(
      { intervalSeconds: reapInterval },
      'copilot batch reaper enabled',
    );
  }

  const cleanupInterval = notificationCleanupIntervalSeconds();
  if (cleanupInterval > 0) {
    const cleanup = async () => {
      try {
        const deleted = await cleanupDeletedNotifications();
        if (deleted) {
          app.log.info({ count: deleted }, 'purged expired notification trash');
        }
      } catch (err) {
        app.log.warn({ err }, 'failed to purge notification trash');
      }
    };
    setTimeout(() => void cleanup(), 10000).unref?.();
    notificationCleanupTimer = setInterval(
      () => void cleanup(),
      cleanupInterval * 1000,
    );
    notificationCleanupTimer.unref?.();
    app.log.info(
      { intervalSeconds: cleanupInterval },
      'notification trash cleanup enabled',
    );
  }

  const exportCleanupInterval = auditExportCleanupIntervalSeconds();
  if (exportCleanupInterval > 0) {
    const cleanup = async () => {
      try {
        const deleted = await cleanupAuditExportJobs();
        if (deleted) {
          app.log.info({ count: deleted }, 'purged expired audit exports');
        }
      } catch (err) {
        app.log.warn({ err }, 'failed to purge audit exports');
      }
    };
    setTimeout(() => void cleanup(), 30000).unref?.();
    auditExportCleanupTimer = setInterval(
      () => void cleanup(),
      exportCleanupInterval * 1000,
    );
    auditExportCleanupTimer.unref?.();
    app.log.info(
      { intervalSeconds: exportCleanupInterval },
      'audit export cleanup enabled',
    );
  }

  const archiveInterval = collabAuditArchiveIntervalSeconds();
  if (archiveInterval > 0) {
    const archive = async () => {
      try {
        const archived = await archiveCollabAudits();
        if (archived) {
          app.log.info({ count: archived }, 'archived collaboration audits');
        }
      } catch (err) {
        app.log.warn({ err }, 'failed to archive collaboration audits');
      }
    };
    setTimeout(() => void archive(), 15000).unref?.();
    collabAuditArchiveTimer = setInterval(
      () => void archive(),
      archiveInterval * 1000,
    );
    collabAuditArchiveTimer.unref?.();
    app.log.info(
      { intervalSeconds: archiveInterval },
      'collaboration audit archive enabled',
    );
  }

  const snapshotInterval = collabSnapshotIntervalSeconds();
  if (snapshotInterval > 0) {
    const snapshot = async () => {
      try {
        const count = await snapshotCollabAudits();
        const cleaned = await cleanupCollabSnapshots();
        if (count || cleaned) {
          app.log.info(
            { count, cleaned },
            'updated collaboration audit snapshots',
          );
        }
      } catch (err) {
        app.log.warn({ err }, 'failed to snapshot collaboration audits');
      }
    };
    setTimeout(() => void snapshot(), 20000).unref?.();
    collabSnapshotTimer = setInterval(
      () => void snapshot(),
      snapshotInterval * 1000,
    );
    collabSnapshotTimer.unref?.();
    app.log.info(
      { intervalSeconds: snapshotInterval },
      'collaboration audit snapshot enabled',
    );
  }

  const digestInterval = collabDigestIntervalSeconds();
  if (digestInterval > 0) {
    const digest = async () => {
      try {
        const sent = await sendCollabAuditDigest();
        if (sent) {
          app.log.info({ sent }, 'sent collaboration audit digest');
        }
      } catch (err) {
        app.log.warn({ err }, 'failed to send collaboration audit digest');
      }
    };
    setTimeout(() => void digest(), 30000).unref?.();
    collabDigestTimer = setInterval(
      () => void digest(),
      digestInterval * 1000,
    );
    collabDigestTimer.unref?.();
    app.log.info(
      { intervalSeconds: digestInterval },
      'collaboration audit digest enabled',
    );
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
