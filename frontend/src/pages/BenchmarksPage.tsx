import { useMemo, useState } from 'react';
import { api } from '../api';
import { useLoad } from '../hooks';
import type { Benchmark } from '../types';
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
  PageHeader,
  Select,
  Spinner,
  Stat,
} from '../ui';

const DIRECTION_LABEL: Record<string, string> = {
  higher_better: '越高越好',
  lower_better: '越低越好',
};

const emptyForm = () => ({
  metric_key: '',
  metric_name: '',
  unit: '%',
  direction: 'lower_better',
  p25: '',
  p50: '',
  p75: '',
  year: String(new Date().getFullYear()),
  region: 'CN',
  sub_industry: 'port_container_trucking',
  source: '',
  source_url: '',
  sample_size: '',
  calibrated: false,
});

type FormState = ReturnType<typeof emptyForm>;

export function BenchmarksPage() {
  const { data, error, loading, reload } = useLoad(
    () => api.listBenchmarks(true),
    [],
  );
  const [search, setSearch] = useState('');
  const [onlyUncalibrated, setOnlyUncalibrated] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Benchmark | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const items = data?.items ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((b) => {
      if (onlyUncalibrated && b.calibrated) return false;
      if (!q) return true;
      return `${b.metric_name} ${b.metric_key}`.toLowerCase().includes(q);
    });
  }, [items, search, onlyUncalibrated]);

  const calibratedCount = items.filter((b) => b.calibrated).length;

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setFormError(null);
    setOpen(true);
  };

  const openEdit = (b: Benchmark) => {
    setEditing(b);
    setForm({
      metric_key: b.metric_key,
      metric_name: b.metric_name,
      unit: b.unit,
      direction: b.direction,
      p25: b.p25 != null ? String(b.p25) : '',
      p50: b.p50 != null ? String(b.p50) : '',
      p75: b.p75 != null ? String(b.p75) : '',
      year: String(b.year),
      region: b.region,
      sub_industry: b.sub_industry,
      source: b.source,
      source_url: b.source_url ?? '',
      sample_size: b.sample_size != null ? String(b.sample_size) : '',
      calibrated: b.calibrated,
    });
    setFormError(null);
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const p25 = Number(form.p25);
      const p50 = Number(form.p50);
      const p75 = Number(form.p75);
      if (!form.p25 || !form.p50 || !form.p75) throw new Error('p25 / p50 / p75 必填');
      if (!(p25 <= p50 && p50 <= p75)) throw new Error('必须满足 p25 ≤ p50 ≤ p75');
      if (!form.source.trim()) throw new Error('来源必填；校准后要能追到出处');

      const payload = {
        industry: 'logistics',
        sub_industry: form.sub_industry,
        metric_key: form.metric_key.trim(),
        metric_name: form.metric_name.trim(),
        unit: form.unit.trim(),
        direction: form.direction,
        p25,
        p50,
        p75,
        year: Number(form.year),
        region: form.region.trim(),
        source: form.source.trim(),
        source_url: form.source_url.trim() || undefined,
        sample_size: form.sample_size ? Number(form.sample_size) : undefined,
        calibrated: form.calibrated,
      };

      if (editing) await api.updateBenchmark(editing.id, payload);
      else await api.createBenchmark(payload);
      setOpen(false);
      await reload();
    } catch (err) {
      setFormError(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (b: Benchmark) => {
    if (!window.confirm(`删除标杆「${b.metric_name}」？引用它的报告会变成“无基准”警告。`)) return;
    await api.deleteBenchmark(b.id);
    await reload();
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="R1 · 行业基准库"
        title="行业标杆"
        subtitle="20 项物流核心指标的 p25 / p50 / p75。未校准的基准会在报告里标注，C7 只 warn 不 block。"
        actions={
          <>
            <Button onClick={() => void reload()}>刷新</Button>
            <Button variant="primary" onClick={openCreate}>
              + 新增指标
            </Button>
          </>
        }
      />

      {loading && !data ? <Spinner /> : null}
      {error && !data ? <ErrorBox error={error} onRetry={() => void reload()} /> : null}

      {data ? (
        <>
          <div className="stat-grid">
            <Stat label="指标数" value={items.length} hint="物流行业" tone="brand" />
            <Stat label="已校准" value={calibratedCount} hint="可用于对外承诺" tone="green" />
            <Stat
              label="未校准"
              value={items.length - calibratedCount}
              hint="报告中标注「未校准」"
              tone="amber"
            />
            <Stat
              label="覆盖年份"
              value={new Set(items.map((b) => b.year)).size}
              hint="按年份/地区取最新"
              tone="blue"
            />
          </div>

          <Card
            title="指标库"
            subtitle="校准时至少补：来源、年份、样本量；p25 ≤ p50 ≤ p75。"
            actions={
              <div className="filter-bar">
                <Input
                  placeholder="搜索名称或 key"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <label className="checkbox-line compact">
                  <input
                    type="checkbox"
                    checked={onlyUncalibrated}
                    onChange={(e) => setOnlyUncalibrated(e.target.checked)}
                  />
                  只看未校准
                </label>
              </div>
            }
          >
            {filtered.length === 0 ? (
              <Empty title="没有匹配的指标" hint="换个关键词，或取消「只看未校准」。" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>指标</th>
                      <th>方向</th>
                      <th>p25</th>
                      <th>p50</th>
                      <th>p75</th>
                      <th>年份 / 地区</th>
                      <th>来源</th>
                      <th>状态</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((b) => (
                      <tr key={b.id}>
                        <td>
                          <div className="bench-metric">
                            <strong>{b.metric_name}</strong>
                            <span className="mono muted">{b.metric_key}</span>
                          </div>
                        </td>
                        <td className="nowrap">{DIRECTION_LABEL[b.direction] ?? b.direction}</td>
                        <td>{b.p25 ?? '—'}</td>
                        <td>{b.p50 ?? '—'}</td>
                        <td>{b.p75 ?? '—'}</td>
                        <td className="muted">
                          {b.year} / {b.region}
                        </td>
                        <td className="muted clamp">{b.source}</td>
                        <td>
                          <Badge tone={b.calibrated ? 'green' : 'amber'}>
                            {b.calibrated ? '已校准' : '未校准'}
                          </Badge>
                        </td>
                        <td className="actions-cell">
                          <Button size="sm" variant="ghost" onClick={() => openEdit(b)}>
                            编辑
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => void remove(b)}>
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

          <Notice tone="amber">
            当前 20 项是行业经验值（calibrated=false）。正式对客前应累计 ≥20 个真实项目样本，
            把来源、年份、样本量补齐后再标记「已校准」。
          </Notice>
        </>
      ) : null}

      <Modal
        open={open}
        title={editing ? `编辑标杆：${editing.metric_name}` : '新增行业标杆'}
        subtitle="p25 / p50 / p75 必须递增；校准状态由人工确认，不由系统推断。"
        onClose={() => setOpen(false)}
        wide
        footer={
          <>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        {formError ? <ErrorBox error={formError} /> : null}
        <div className="form-grid">
          <Field label="指标名称" required>
            <Input
              value={form.metric_name}
              onChange={(e) => setForm({ ...form, metric_name: e.target.value })}
              placeholder="如：空驶率"
            />
          </Field>
          <Field label="指标 key" required>
            <Input
              value={form.metric_key}
              onChange={(e) => setForm({ ...form, metric_key: e.target.value })}
              placeholder="如：empty_run_rate"
            />
          </Field>
          <Field label="单位" required>
            <Input
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
              placeholder="% / 分钟 / 单"
            />
          </Field>
          <Field label="方向">
            <Select
              value={form.direction}
              onChange={(e) => setForm({ ...form, direction: e.target.value })}
            >
              <option value="lower_better">越低越好</option>
              <option value="higher_better">越高越好</option>
            </Select>
          </Field>
          <Field label="p25" required>
            <Input
              type="number"
              step="any"
              value={form.p25}
              onChange={(e) => setForm({ ...form, p25: e.target.value })}
            />
          </Field>
          <Field label="p50" required>
            <Input
              type="number"
              step="any"
              value={form.p50}
              onChange={(e) => setForm({ ...form, p50: e.target.value })}
            />
          </Field>
          <Field label="p75" required>
            <Input
              type="number"
              step="any"
              value={form.p75}
              onChange={(e) => setForm({ ...form, p75: e.target.value })}
            />
          </Field>
          <Field label="年份" required>
            <Input
              type="number"
              value={form.year}
              onChange={(e) => setForm({ ...form, year: e.target.value })}
            />
          </Field>
          <Field label="地区">
            <Input
              value={form.region}
              onChange={(e) => setForm({ ...form, region: e.target.value })}
            />
          </Field>
          <Field label="子行业">
            <Input
              value={form.sub_industry}
              onChange={(e) => setForm({ ...form, sub_industry: e.target.value })}
            />
          </Field>
          <Field label="样本量">
            <Input
              type="number"
              value={form.sample_size}
              onChange={(e) => setForm({ ...form, sample_size: e.target.value })}
              placeholder="校准后建议填写"
            />
          </Field>
          <Field label="来源" required className="span-2">
            <Input
              value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value })}
              placeholder="如：2026 中国物流与采购联合会报告 / 20 个项目样本"
            />
          </Field>
          <Field label="来源链接" className="span-2">
            <Input
              value={form.source_url}
              onChange={(e) => setForm({ ...form, source_url: e.target.value })}
              placeholder="https://…"
            />
          </Field>
        </div>
        <label className="checkbox-line" style={{ marginTop: 12 }}>
          <input
            type="checkbox"
            checked={form.calibrated}
            onChange={(e) => setForm({ ...form, calibrated: e.target.checked })}
          />
          已校准（勾选后报告不再标注「未校准」）
        </label>
      </Modal>
    </div>
  );
}
