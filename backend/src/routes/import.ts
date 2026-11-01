import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, withTransaction } from '../db';
import {
  insertImportRows,
  parseCsv,
  parseWorkbook,
  REQUIRED_COLUMNS,
  TEMPLATE_COLUMNS,
  templateCsv,
  validateImport,
} from '../services/import';

const kindSchema = z.enum(['pains', 'inventory', 'opportunities']);
const engagementParams = z.object({ id: z.uuid() });
const kindParams = z.object({ kind: kindSchema });

const TEMPLATE_NAME: Record<string, string> = {
  pains: '痛点导入模板',
  inventory: '四维盘点导入模板',
  opportunities: '机会点导入模板',
};

export async function importRoutes(app: FastifyInstance) {
  app.get('/api/import/schema/:kind', async (req) => {
    const { kind } = kindParams.parse(req.params);
    return {
      kind,
      columns: TEMPLATE_COLUMNS[kind],
      required: REQUIRED_COLUMNS[kind],
    };
  });

  app.get('/api/import/templates/:kind.csv', async (req, reply) => {
    const { kind } = kindParams.parse(req.params);
    const ascii = `import-${kind}.csv`;
    const utf8 = encodeURIComponent(`${TEMPLATE_NAME[kind]}.csv`);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`)
      .send(`\uFEFF${templateCsv(kind)}`);
  });

  app.post('/api/engagements/:id/import', async (req, reply) => {
    const { id } = engagementParams.parse(req.params);
    const { kind } = z.object({ kind: kindSchema }).parse(req.query);

    const engagement = await one(`SELECT id FROM engagements WHERE id = $1`, [id]);
    if (!engagement) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '项目不存在' });
    }

    const file = await req.file();
    if (!file) {
      return reply.code(400).send({
        error: 'FILE_REQUIRED',
        message: '请上传 CSV 或 Excel 文件',
      });
    }

    const buffer = await file.toBuffer();
    const filename = (file.filename ?? '').toLowerCase();
    const mime = file.mimetype ?? '';

    let rows: string[][];
    if (
      filename.endsWith('.xlsx') ||
      filename.endsWith('.xls') ||
      mime.includes('spreadsheet')
    ) {
      rows = await parseWorkbook(buffer);
    } else if (filename.endsWith('.csv') || mime.includes('csv') || mime.includes('text/plain')) {
      rows = parseCsv(buffer.toString('utf8'));
    } else {
      return reply.code(400).send({
        error: 'UNSUPPORTED_FILE',
        message: '只支持 .csv、.xlsx、.xls',
      });
    }

    if (rows.length < 2) {
      return reply.code(422).send({
        error: 'IMPORT_EMPTY',
        message: '文件只有表头或没有数据',
      });
    }

    const header = rows[0];
    const dataRows = rows.slice(1);
    const { data, errors } = validateImport(kind, header, dataRows);

    if (errors.length) {
      return reply.code(422).send({
        error: 'IMPORT_VALIDATION_FAILED',
        message: `${errors.length} 行校验失败，未写入任何数据`,
        errors,
      });
    }

    if (!data.length) {
      return reply.code(422).send({ error: 'IMPORT_EMPTY', message: '没有可导入的数据' });
    }

    const result = await withTransaction(async (client) =>
      insertImportRows(client, id, kind, data),
    );

    return reply.code(201).send({
      kind,
      inserted: result.inserted,
      rows: dataRows.length,
    });
  });
}
