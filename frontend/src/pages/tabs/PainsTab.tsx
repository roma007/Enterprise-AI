import { useMemo, useState } from 'react';
import { api } from '../../api';
import { ImportModal } from '../../components/ImportModal';
import { useDebouncedValue, useForm, usePaged } from '../../hooks';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Input,
  Modal,
  Notice,
  Select,
  Spinner,
  Textarea,
} from '../../ui';
import { frequencyLabel } from '../../utils';

export function PainsTab({
  engagementId,
  onChanged,
}: {
  engagementId: string;
  onChanged: () => void;
}) {
  const [search, setSearch] = useState('');
  const dq = useDebouncedValue(search, 300);
  const paged = usePaged(
    (limit, offset) => api.listPains(engagementId, { limit, offset, q: dq }),
    [engagementId, dq],
  );
  const { error, loading, reload, loadMore, loadingMore, hasMore } = paged;
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);
  const form = useForm({
    description: '',
    channel: '',
    frequency: 'daily',
    severity: '3',
    quantified_impact: '',
    source_type: 'interview',
    source_ref: '',
    status: 'open',
  });

  const pains = paged.items;
  const sourceCoverage = useMemo(
    () => (pains.length ? pains.filter((p) => p.source_ref.trim()).length / pains.length : 0),
    [pains],
  );

  const save = async () => {
    setFormError(null);
    try {
      await api.createPain(engagementId, {
        description: form.values.description.trim(),
        channel: form.values.channel || undefined,
        frequency: form.values.frequency,
        severity: form.values.severity ? Number(form.values.severity) : undefined,
        quantified_impact: form.values.quantified_impact || undefined,
        source_type: form.values.source_type,
        source_ref: form.values.source_ref.trim(),
        status: form.values.status,
      });
      setOpen(false);
      form.reset();
      await reload();
      onChanged();
    } catch (err) {
      setFormError(err);
    }
  };

  if (loading && pains.length === 0) return <Spinner />;
  if (error && pains.length === 0) return <ErrorBox error={error} onRetry={() => void reload()} />;

  return (
    <div className="tab-body">
      <Card
        title="痛点清单"
        subtitle="痛点必须有来源；量化影响不接受「很大 / 很多 / 严重」这类词。"
        actions={
          <>
            <Input
              placeholder="搜索编号/描述/来源"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button size="sm" onClick={() => setImportOpen(true)}>
              导入 CSV/Excel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setFormError(null);
                setOpen(true);
              }}
            >
              + 添加痛点
            </Button>
          </>
        }
      >
        <div className="inline-stats">
          <span>
            共 <strong>{paged.total}</strong> 条
          </span>
          <span>
            有来源 <strong>{Math.round(sourceCoverage * 100)}%</strong>
          </span>
          <span>
            G1 要求 <strong>≥10 条</strong>
          </span>
          {paged.total < 10 && (
            <Badge tone="amber">还差 {10 - paged.total} 条</Badge>
          )}
        </div>

        {pains.length === 0 ? (
          <Empty title="还没有痛点" hint="从访谈和现场观察里提炼，每条都要能追到来源。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>编号</th>
                  <th>痛点</th>
                  <th>环节</th>
                  <th>频次</th>
                  <th>严重度</th>
                  <th>量化影响</th>
                  <th>来源</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pains.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.code}</td>
                    <td>{p.description}</td>
                    <td>{p.channel || '—'}</td>
                    <td>{frequencyLabel(p.frequency)}</td>
                    <td>{p.severity ?? '—'}</td>
                    <td className="muted">{p.quantified_impact || '待确认'}</td>
                    <td className="muted">
                      {p.source_ref}
                      <Badge tone={p.source_type === 'interview' ? 'blue' : 'gray'}>
                        {p.source_type === 'interview'
                          ? '访谈'
                          : p.source_type === 'observation'
                            ? '观察'
                            : '数据'}
                      </Badge>
                    </td>
                    <td className="actions-cell">
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (!window.confirm(`删除痛点 ${p.code}？`)) return;
                          await api.deletePain(p.id);
                          await reload();
                          onChanged();
                        }}
                      >
                        删除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hasMore ? (
          <div className="form-actions">
            <Button size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? '加载中…' : `加载更多（已显示 ${pains.length} / ${paged.total}）`}
            </Button>
          </div>
        ) : null}
      </Card>

      <Notice tone="blue">
        痛点进入 <strong>机会点关联</strong> 时，R1 触发器会再检查一次来源；已归并的痛点不能单独关联。
      </Notice>

      <Modal
        open={open}
        title="添加痛点"
        subtitle="用客户原话；量化影响尽量带数字和口径。"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button variant="primary" onClick={() => void save()}>
              保存
            </Button>
          </>
        }
      >
        {formError ? <ErrorBox error={formError} /> : null}
        <div className="form-grid">
          <Field label="痛点描述" required className="span-2">
            <Textarea
              rows={3}
              value={form.values.description}
              onChange={(e) => form.set('description', e.target.value)}
              placeholder="如：单证员每天手工把微信/邮件托书录入 TMS，格式不统一"
            />
          </Field>
          <Field label="环节">
            <Input
              value={form.values.channel}
              onChange={(e) => form.set('channel', e.target.value)}
              placeholder="如：单证录入"
            />
          </Field>
          <Field label="频次">
            <Select
              value={form.values.frequency}
              onChange={(e) => form.set('frequency', e.target.value)}
            >
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
              <option value="occasional">偶尔</option>
            </Select>
          </Field>
          <Field label="严重度（1–5）">
            <Input
              type="number"
              min={1}
              max={5}
              value={form.values.severity}
              onChange={(e) => form.set('severity', e.target.value)}
            />
          </Field>
          <Field label="状态">
            <Select value={form.values.status} onChange={(e) => form.set('status', e.target.value)}>
              <option value="open">开放</option>
              <option value="resolved">已解决</option>
              <option value="merged">已归并</option>
            </Select>
          </Field>
          <Field label="量化影响" className="span-2">
            <Input
              value={form.values.quantified_impact}
              onChange={(e) => form.set('quantified_impact', e.target.value)}
              placeholder="如：日均 120 单 × 10 分钟 ≈ 20 小时/日"
            />
          </Field>
          <Field label="来源类型" required>
            <Select
              value={form.values.source_type}
              onChange={(e) => form.set('source_type', e.target.value)}
            >
              <option value="interview">访谈</option>
              <option value="observation">现场观察</option>
              <option value="data">数据抽样</option>
            </Select>
          </Field>
          <Field label="来源说明" required>
            <Input
              value={form.values.source_ref}
              onChange={(e) => form.set('source_ref', e.target.value)}
              placeholder="如：访谈#4 刘芳 · 2026-10-17 · 第 12 分钟"
            />
          </Field>
        </div>
      </Modal>

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        engagementId={engagementId}
        kind="pains"
        onImported={async () => {
          await reload();
          onChanged();
        }}
      />
    </div>
  );
}
