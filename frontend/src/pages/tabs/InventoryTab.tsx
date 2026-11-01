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
  Progress,
  Select,
  Spinner,
  Textarea,
} from '../../ui';
import { dimensionLabel, jsonPretty } from '../../utils';

const DIMENSIONS = ['business', 'data', 'system', 'org'] as const;

function attributeText(attrs: Record<string, unknown>) {
  const entries = Object.entries(attrs).filter(
    ([k, v]) => !k.startsWith('benchmark_') && v !== null && v !== undefined,
  );
  if (!entries.length) return '—';
  return entries
    .slice(0, 5)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('、') : String(v)}`)
    .join('；');
}

export function InventoryTab({
  engagementId,
  onChanged,
}: {
  engagementId: string;
  onChanged: () => void;
}) {
  const [search, setSearch] = useState('');
  const dq = useDebouncedValue(search, 300);
  const paged = usePaged(
    (limit, offset) => api.listInventory(engagementId, { limit, offset, q: dq }),
    [engagementId, dq],
  );
  const { error, loading, reload, loadMore, loadingMore, hasMore } = paged;
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);
  const form = useForm({
    dimension: 'business',
    category: '',
    name: '',
    completeness: '70',
    verified: false,
    is_implicit: false,
    discovered_by: '',
    attributes: '{\n  "roles": ["单证员"],\n  "daily_volume": 100\n}',
  });

  const items = paged.items;
  const grouped = useMemo(
    () =>
      DIMENSIONS.map((dim) => {
        const list = items.filter((i) => i.dimension === dim);
        const avg = list.length
          ? Math.round(list.reduce((a, i) => a + i.completeness, 0) / list.length)
          : 0;
        return { dim, list, avg };
      }),
    [items],
  );
  const overall = items.length
    ? Math.round(items.reduce((a, i) => a + i.completeness, 0) / items.length)
    : 0;

  const save = async () => {
    setFormError(null);
    try {
      let attributes: Record<string, unknown> = {};
      try {
        attributes = JSON.parse(form.values.attributes || '{}');
      } catch {
        throw new Error('属性 JSON 格式不正确');
      }
      await api.createInventory(engagementId, {
        dimension: form.values.dimension,
        category: form.values.category || undefined,
        name: form.values.name.trim(),
        attributes,
        completeness: Number(form.values.completeness),
        verified: form.values.verified,
        is_implicit: form.values.is_implicit,
        discovered_by: form.values.discovered_by || undefined,
      });
      setOpen(false);
      form.reset();
      await reload();
      onChanged();
    } catch (err) {
      setFormError(err);
    }
  };

  if (loading && items.length === 0) return <Spinner />;
  if (error && items.length === 0) return <ErrorBox error={error} onRetry={() => void reload()} />;

  return (
    <div className="tab-body">
      <Card
        title="四维盘点"
        subtitle="业务 / 数据 / 系统 / 组织。完整度 ≥80% 是 G1 的量化要求。"
        actions={
          <>
            <Input
              placeholder="搜索名称/类别"
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
              + 添加盘点项
            </Button>
          </>
        }
      >
        <div className="inline-stats">
          <span>
            已加载 <strong>{items.length}</strong> / {paged.total} 项
          </span>
          <span>
            平均完整度 <strong>{overall}%</strong>
          </span>
          <div className="inline-progress">
            <Progress value={overall} max={100} />
          </div>
          <Badge tone={overall >= 80 ? 'green' : 'amber'}>
            {overall >= 80 ? '已达 G1' : '未达 80%'}
          </Badge>
        </div>
      </Card>

      <div className="dimension-grid">
        {grouped.map(({ dim, list, avg }) => (
          <Card
            key={dim}
            title={`${dimensionLabel(dim)}维度`}
            subtitle={`${list.length} 项 · 平均完整度 ${avg}%`}
            actions={<Badge tone={avg >= 80 ? 'green' : 'gray'}>{avg}%</Badge>}
          >
            {list.length === 0 ? (
              <Empty title="暂无盘点" hint={`补充${dimensionLabel(dim)}维度的现状。`} />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>对象</th>
                      <th>类别</th>
                      <th>关键信息</th>
                      <th>完整度</th>
                      <th>核实</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <strong>{i.name}</strong>
                          {i.is_implicit && <Badge tone="amber">隐性</Badge>}
                        </td>
                        <td>{i.category || '—'}</td>
                        <td className="muted small">{attributeText(i.attributes)}</td>
                        <td>{i.completeness}%</td>
                        <td>
                          <Badge tone={i.verified ? 'green' : 'gray'}>
                            {i.verified ? '已核实' : '未核实'}
                          </Badge>
                        </td>
                        <td className="actions-cell">
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={async () => {
                              if (!window.confirm(`删除盘点项「${i.name}」？`)) return;
                              await api.deleteInventory(i.id);
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
          </Card>
        ))}
      </div>

      {hasMore ? (
        <div className="form-actions">
          <Button size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? '加载中…' : `加载更多（已显示 ${items.length} / ${paged.total}）`}
          </Button>
        </div>
      ) : null}

      <Modal
        open={open}
        title="添加盘点项"
        subtitle="属性用 JSON 存灵活字段；报告里会按维度渲染成表。"
        onClose={() => setOpen(false)}
        wide
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
          <Field label="维度" required>
            <Select
              value={form.values.dimension}
              onChange={(e) => form.set('dimension', e.target.value)}
            >
              {DIMENSIONS.map((d) => (
                <option key={d} value={d}>
                  {dimensionLabel(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="类别">
            <Input
              value={form.values.category}
              onChange={(e) => form.set('category', e.target.value)}
              placeholder="如：单证 / 订单数据 / TMS"
            />
          </Field>
          <Field label="对象名称" required className="span-2">
            <Input
              value={form.values.name}
              onChange={(e) => form.set('name', e.target.value)}
              placeholder="如：订单录入"
            />
          </Field>
          <Field label="完整度（0–100）">
            <Input
              type="number"
              min={0}
              max={100}
              value={form.values.completeness}
              onChange={(e) => form.set('completeness', e.target.value)}
            />
          </Field>
          <Field label="发现方式">
            <Select
              value={form.values.discovered_by}
              onChange={(e) => form.set('discovered_by', e.target.value)}
            >
              <option value="">未记录</option>
              <option value="interview">访谈</option>
              <option value="observation">现场观察</option>
              <option value="data">数据抽样</option>
            </Select>
          </Field>
          <Field label="属性（JSON）" className="span-2">
            <Textarea
              rows={6}
              className="mono"
              value={form.values.attributes}
              onChange={(e) => form.set('attributes', e.target.value)}
            />
          </Field>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={form.values.verified}
              onChange={(e) => form.set('verified', e.target.checked)}
            />
            已核实
          </label>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={form.values.is_implicit}
              onChange={(e) => form.set('is_implicit', e.target.checked)}
            />
            隐性环节
          </label>
        </div>
        <p className="hint-line">示例：{jsonPretty({ roles: ['单证员'], daily_volume: 100 })}</p>
      </Modal>

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        engagementId={engagementId}
        kind="inventory"
        onImported={async () => {
          await reload();
          onChanged();
        }}
      />
    </div>
  );
}
