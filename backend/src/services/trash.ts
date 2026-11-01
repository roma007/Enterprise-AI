import type pg from 'pg';
import { query } from '../db';
import { httpError } from './s1';

async function newBatch(client: pg.PoolClient): Promise<string> {
  const row = await client.query<{ id: string }>(`SELECT gen_random_uuid() AS id`);
  return row.rows[0].id;
}

/** 软删客户：客户 + 其项目 + 其交付物，同一个 batch，便于整体恢复。 */
export async function softDeleteClient(
  client: pg.PoolClient,
  id: string,
  orgId: string,
): Promise<string> {
  const batch = await newBatch(client);
  const result = await client.query(
    `UPDATE clients
        SET deleted_at = now(), delete_batch = $2
      WHERE id = $1 AND org_id = $3 AND deleted_at IS NULL
      RETURNING id`,
    [id, batch, orgId],
  );
  if (!result.rowCount) throw httpError(404, 'NOT_FOUND', '客户不存在或已删除');

  await client.query(
    `UPDATE engagements
        SET deleted_at = now(), delete_batch = $2
      WHERE client_id = $1 AND deleted_at IS NULL`,
    [id, batch],
  );
  await client.query(
    `UPDATE deliverables
        SET deleted_at = now(), delete_batch = $2
      WHERE engagement_id IN (SELECT id FROM engagements WHERE client_id = $1)
        AND deleted_at IS NULL`,
    [id, batch],
  );
  return batch;
}

/** 软删项目：项目 + 其交付物。 */
export async function softDeleteEngagement(
  client: pg.PoolClient,
  id: string,
  orgId: string,
): Promise<string> {
  const batch = await newBatch(client);
  const result = await client.query(
    `UPDATE engagements
        SET deleted_at = now(), delete_batch = $2
      WHERE id = $1 AND org_id = $3 AND deleted_at IS NULL
      RETURNING id`,
    [id, batch, orgId],
  );
  if (!result.rowCount) throw httpError(404, 'NOT_FOUND', '项目不存在或已删除');

  await client.query(
    `UPDATE deliverables
        SET deleted_at = now(), delete_batch = $2
      WHERE engagement_id = $1 AND deleted_at IS NULL`,
    [id, batch],
  );
  return batch;
}

/** 软删交付物。 */
export async function softDeleteDeliverable(
  client: pg.PoolClient,
  id: string,
  orgId: string,
): Promise<string> {
  const batch = await newBatch(client);
  const result = await client.query(
    `UPDATE deliverables d
        SET deleted_at = now(), delete_batch = $2
       FROM engagements e
      WHERE d.id = $1 AND d.engagement_id = e.id AND e.org_id = $3
        AND d.deleted_at IS NULL AND e.deleted_at IS NULL
      RETURNING d.id`,
    [id, batch, orgId],
  );
  if (!result.rowCount) throw httpError(404, 'NOT_FOUND', '交付物不存在或已删除');
  return batch;
}

export async function restoreBatch(
  client: pg.PoolClient,
  batch: string,
  orgId: string,
): Promise<{ clients: number; engagements: number; deliverables: number }> {
  const owned = await client.query(
    `SELECT 1 FROM clients WHERE delete_batch = $1 AND org_id = $2
     UNION ALL
     SELECT 1 FROM engagements WHERE delete_batch = $1 AND org_id = $2
     UNION ALL
     SELECT 1 FROM deliverables d
       JOIN engagements e ON e.id = d.engagement_id
      WHERE d.delete_batch = $1 AND e.org_id = $2
     LIMIT 1`,
    [batch, orgId],
  );
  if (!owned.rowCount) throw httpError(404, 'NOT_FOUND', '回收站记录不存在');

  const clients = await client.query(
    `UPDATE clients SET deleted_at = NULL, delete_batch = NULL
      WHERE delete_batch = $1 AND org_id = $2`,
    [batch, orgId],
  );
  const engagements = await client.query(
    `UPDATE engagements SET deleted_at = NULL, delete_batch = NULL
      WHERE delete_batch = $1 AND org_id = $2`,
    [batch, orgId],
  );
  const deliverables = await client.query(
    `UPDATE deliverables d SET deleted_at = NULL, delete_batch = NULL
      WHERE d.delete_batch = $1
        AND EXISTS (
          SELECT 1 FROM engagements e
           WHERE e.id = d.engagement_id AND e.deleted_at IS NULL
        )`,
    [batch],
  );

  return {
    clients: clients.rowCount ?? 0,
    engagements: engagements.rowCount ?? 0,
    deliverables: deliverables.rowCount ?? 0,
  };
}

export interface TrashItem {
  batch: string;
  deleted_at: string;
  object_type: 'client' | 'engagement' | 'deliverable';
  id: string;
  title: string;
}

export async function listTrash(orgId: string): Promise<TrashItem[]> {
  const rows = await query<TrashItem>(
    `SELECT delete_batch AS batch, deleted_at::text AS deleted_at,
            'client'::text AS object_type, id, name AS title
       FROM clients
      WHERE org_id = $1 AND deleted_at IS NOT NULL AND delete_batch IS NOT NULL
     UNION ALL
     SELECT e.delete_batch, e.deleted_at::text,
            'engagement'::text, e.id, e.name
       FROM engagements e
      WHERE e.org_id = $1 AND e.deleted_at IS NOT NULL AND e.delete_batch IS NOT NULL
     UNION ALL
     SELECT d.delete_batch, d.deleted_at::text,
            'deliverable'::text, d.id, d.title || ' v' || d.version
       FROM deliverables d
       JOIN engagements e ON e.id = d.engagement_id
      WHERE e.org_id = $1 AND d.deleted_at IS NOT NULL AND d.delete_batch IS NOT NULL
     ORDER BY deleted_at DESC`,
    [orgId],
  );
  return rows;
}
