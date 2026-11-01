import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db';
import { httpError } from '../services/s1';

const params = z.object({ id: z.uuid() });

const createBody = z.object({
  object_type: z.enum(['flowchart', 'pain_point', 'opportunity', 'deliverable']),
  object_id: z.uuid(),
  confirmed_by: z.uuid(),
  method: z.enum(['meeting', 'email', 'wechat', 'signature']),
  evidence: z.string().max(2000).optional(),
});

const OBJECT_SQL: Record<string, string> = {
  deliverable: `SELECT d.id FROM deliverables d WHERE d.id = $1 AND d.engagement_id = $2`,
  opportunity: `SELECT o.id FROM opportunities o WHERE o.id = $1 AND o.engagement_id = $2`,
  pain_point: `SELECT p.id FROM pain_points p WHERE p.id = $1 AND p.engagement_id = $2`,
  flowchart: `SELECT m.id FROM process_models m WHERE m.id = $1 AND m.engagement_id = $2`,
};

export async function confirmationRoutes(app: FastifyInstance) {
  app.get('/api/engagements/:id/confirmations', async (req) => {
    const { id } = params.parse(req.params);
    const rows = await query(
      `SELECT c.*, s.name AS confirmed_by_name, s.title AS confirmed_by_title,
              CASE c.object_type
                WHEN 'deliverable' THEN
                  (SELECT d.title || ' v' || d.version FROM deliverables d WHERE d.id = c.object_id)
                WHEN 'opportunity' THEN
                  (SELECT o.code || ' ' || o.title FROM opportunities o WHERE o.id = c.object_id)
                WHEN 'pain_point' THEN
                  (SELECT p.code || ' ' || p.description FROM pain_points p WHERE p.id = c.object_id)
                ELSE
                  (SELECT '业务流程 v' || m.version FROM process_models m WHERE m.id = c.object_id)
              END AS object_label
         FROM confirmations c
         JOIN stakeholders s ON s.id = c.confirmed_by
        WHERE c.engagement_id = $1
        ORDER BY c.confirmed_at DESC`,
      [id],
    );
    return { items: rows };
  });

  app.post('/api/engagements/:id/confirmations', async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = createBody.parse(req.body);

    const object = await one(OBJECT_SQL[body.object_type], [body.object_id, id]);
    if (!object) {
      throw httpError(422, 'OBJECT_NOT_IN_ENGAGEMENT', '确认对象不属于该项目');
    }

    const stakeholder = await one(
      `SELECT 1 FROM stakeholders s
         JOIN engagements e ON e.client_id = s.client_id
        WHERE s.id = $1 AND e.id = $2`,
      [body.confirmed_by, id],
    );
    if (!stakeholder) {
      throw httpError(422, 'STAKEHOLDER_NOT_IN_CLIENT', '确认人不属于该项目客户');
    }

    const row = await one(
      `INSERT INTO confirmations
         (engagement_id, object_type, object_id, confirmed_by, method, evidence)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        id,
        body.object_type,
        body.object_id,
        body.confirmed_by,
        body.method,
        body.evidence ?? null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.delete('/api/confirmations/:id', async (req) => {
    const { id } = params.parse(req.params);
    const row = await one(`DELETE FROM confirmations WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '确认记录不存在');
    return { ok: true };
  });
}
