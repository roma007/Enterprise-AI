import { useState } from 'react';
import { api } from '../api';
import { useLoad } from '../hooks';
import type { TrashBatch } from '../types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Notice,
  PageHeader,
  Spinner,
  Stat,
} from '../ui';
import { fmtDateTime } from '../utils';

const TYPE_LABEL: Record<string, string> = {
  client: '客户',
  engagement: '项目',
  deliverable: '交付物',
};

const TYPE_TONE: Record<string, 'brand' | 'blue' | 'amber'> = {
  client: 'brand',
  engagement: 'blue',
  deliverable: 'amber',
};

export function TrashPage() {
  const { data, error, loading, reload } = useLoad(() => api.listTrash(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const batches = data?.items ?? [];
  const items = batches.flatMap((b) => b.items);
  const count = (type: string) => items.filter((i) => i.object_type === type).length;

  const restore = async (b: TrashBatch) => {
    setBusy(b.batch);
    setNotice(null);
    setActionError(null);
    try {
      const res = await api.restoreTrash(b.batch);
      setNotice(
        `已恢复：客户 ${res.restored.clients}、项目 ${res.restored.engagements}、交付物 ${res.restored.deliverables}。`,
      );
      await reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="R1 · 数据安全"
        title="回收站"
        subtitle="客户、项目、交付物删除后进入回收站，按批次整体恢复。"
        actions={
          <Button onClick={() => void reload()} disabled={loading}>
            刷新
          </Button>
        }
      />

      {loading && !data ? <Spinner /> : null}
      {error && !data ? <ErrorBox error={error} onRetry={() => void reload()} /> : null}

      {data ? (
        <>
          <div className="stat-grid">
            <Stat label="删除批次" value={batches.length} hint="按一次删除分组" tone="brand" />
            <Stat label="客户" value={count('client')} hint="可整体恢复" />
            <Stat label="项目" value={count('engagement')} hint="含其交付物" tone="blue" />
            <Stat label="交付物" value={count('deliverable')} hint="报告版本" tone="amber" />
          </div>

          {notice ? <Notice tone="green">{notice}</Notice> : null}
          {actionError ? <ErrorBox error={actionError} /> : null}

          {batches.length === 0 ? (
            <Card>
              <Empty
                title="回收站是空的"
                hint="删除客户/项目/交付物后会在这里出现，可以按批次恢复。"
              />
            </Card>
          ) : (
            <div className="trash-list">
              {batches.map((b) => (
                <Card
                  key={b.batch}
                  title={`删除批次 · ${b.batch.slice(0, 8)}`}
                  subtitle={`删除时间 ${fmtDateTime(b.deleted_at)} · ${b.items.length} 条记录`}
                  actions={
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy === b.batch}
                      onClick={() => void restore(b)}
                    >
                      {busy === b.batch ? '恢复中…' : '恢复这批'}
                    </Button>
                  }
                >
                  <div className="trash-items">
                    {b.items.map((i) => (
                      <div key={`${i.object_type}-${i.id}`} className="trash-item">
                        <Badge tone={TYPE_TONE[i.object_type] ?? 'gray'}>
                          {TYPE_LABEL[i.object_type] ?? i.object_type}
                        </Badge>
                        <span>{i.title}</span>
                        <span className="mono muted">{i.id.slice(0, 8)}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          )}

          <Notice tone="amber">
            回收站目前只覆盖客户 / 项目 / 交付物。痛点、盘点、机会点等子资源仍是物理删除，
            但所有写操作都会写入审计日志。恢复批次时，已单独删除的子资源不会被一并恢复。
          </Notice>
        </>
      ) : null}
    </div>
  );
}
