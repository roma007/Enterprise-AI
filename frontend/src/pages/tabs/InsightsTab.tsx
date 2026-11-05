import { useState } from 'react';
import { api } from '../../api';
import { useLoad } from '../../hooks';
import type { InsightLevel, InsightMetric } from '../../types';
import { Badge, Button, Card, Empty, ErrorBox, Spinner } from '../../ui';

const LEVEL_LABEL: Record<InsightLevel, string> = {
  positive: '已验证',
  warning: '需关注',
  critical: '需立即处理',
  info: '说明',
};

const LEVEL_TONE: Record<InsightLevel, 'green' | 'amber' | 'red' | 'gray'> = {
  positive: 'green',
  warning: 'amber',
  critical: 'red',
  info: 'gray',
};

const STATUS_LABEL: Record<InsightMetric['status'], string> = {
  achieved: '达标',
  behind: '未达',
  unknown: '缺数据',
};

const STATUS_TONE: Record<InsightMetric['status'], 'green' | 'amber' | 'gray'> = {
  achieved: 'green',
  behind: 'amber',
  unknown: 'gray',
};

const fmt = (value: number | null, unit: string) =>
  value == null ? '—' : `${Number(value)}${unit}`;

export function InsightsTab({ engagementId }: { engagementId: string }) {
  const { data, error, loading, reload } = useLoad(
    () => api.getInsights(engagementId),
    [engagementId],
  );
  const [busy, setBusy] = useState<'md' | 'docx' | null>(null);
  const [opError, setOpError] = useState<unknown>(null);

  const download = async (kind: 'md' | 'docx') => {
    setBusy(kind);
    setOpError(null);
    try {
      const blob =
        kind === 'md'
          ? await api.exportInsightsMarkdown(engagementId)
          : await api.exportInsightsDocx(engagementId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `经营洞察-${data?.engagement.client_name ?? '项目'}.${kind}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;
  if (!data) return null;

  const critical = data.insights.filter((item) => item.level === 'critical');
  const warning = data.insights.filter((item) => item.level === 'warning');
  const positive = data.insights.filter((item) => item.level === 'positive');

  return (
    <div className="tab-body">
      <div className="page-head" style={{ marginBottom: 12 }}>
        <div>
          <div className="eyebrow">S5 · 经营洞察</div>
          <h1>经营洞察</h1>
          <p className="page-sub">
            由规则引擎基于项目数据生成；每条结论可追到指标、方案、POC、交付与风险记录。
          </p>
        </div>
        <div className="row">
          <Button size="sm" disabled={busy !== null} onClick={() => void download('md')}>
            {busy === 'md' ? '导出中…' : '导出 Markdown'}
          </Button>
          <Button size="sm" disabled={busy !== null} onClick={() => void download('docx')}>
            {busy === 'docx' ? '导出中…' : '导出 Word'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void reload()}>
            刷新
          </Button>
        </div>
      </div>

      {opError ? <ErrorBox error={opError} /> : null}

      <div className="stat-grid">
        <div className="stat">
          <span className="stat-label">指标达标</span>
          <strong>{data.metrics.filter((m) => m.status === 'achieved').length}/{data.metrics.length}</strong>
          <span className="stat-hint">按目标与最新快照判断</span>
        </div>
        <div className="stat">
          <span className="stat-label">需立即处理</span>
          <strong>{critical.length}</strong>
          <span className="stat-hint">偏差 ≥20% 或 POC/交付阻断</span>
        </div>
        <div className="stat">
          <span className="stat-label">需关注</span>
          <strong>{warning.length}</strong>
          <span className="stat-hint">指标、风险、变更、数据前置</span>
        </div>
        <div className="stat">
          <span className="stat-label">已验证</span>
          <strong>{positive.length}</strong>
          <span className="stat-hint">POC、UAT、签收、达标指标</span>
        </div>
      </div>

      <Card title="结论" subtitle="给老板看的 3–5 句话，不堆指标。">
        {data.summary.length ? (
          <ul className="plain-list">
            {data.summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <Empty title="暂无足够数据" hint="先补齐方案、POC、交付或指标数据。" />
        )}
      </Card>

      <Card title="指标对比" subtitle="基线 → 目标 → 最新；未达目标会进入风险与建议。">
        {data.metrics.length === 0 ? (
          <Empty title="还没有指标目标" hint="在「运营」页签先建立指标目标与周期快照。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>指标</th>
                  <th>基线</th>
                  <th>目标</th>
                  <th>最新</th>
                  <th>状态</th>
                  <th>偏差</th>
                </tr>
              </thead>
              <tbody>
                {data.metrics.map((m) => (
                  <tr key={m.key}>
                    <td><strong>{m.name}</strong></td>
                    <td className="muted">{fmt(m.baseline, m.unit)}</td>
                    <td>{fmt(m.target, m.unit)}</td>
                    <td>{fmt(m.latest, m.unit)}</td>
                    <td><Badge tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Badge></td>
                    <td className="muted">{m.gap_pct == null ? '—' : `${m.gap_pct}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="洞察与风险" subtitle="按严重程度排序；每条都带建议动作。">
        {data.insights.length === 0 ? (
          <Empty title="暂无洞察" hint="数据补齐后自动生成。" />
        ) : (
          <div className="editor-stack">
            {data.insights.map((item) => (
              <div key={`${item.code}-${item.title}`} className="insight-row">
                <Badge tone={LEVEL_TONE[item.level]}>{LEVEL_LABEL[item.level]}</Badge>
                <div style={{ flex: 1 }}>
                  <strong>{item.title}</strong>
                  <p className="muted" style={{ margin: '4px 0 0' }}>{item.detail}</p>
                  {item.action ? (
                    <p style={{ margin: '6px 0 0', fontSize: 12 }}>
                      <strong>建议：</strong>{item.action}
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="建议动作" subtitle="按优先级去重；可直接带到经营会。">
        {data.recommendations.length ? (
          <ul className="plain-list">
            {data.recommendations.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">暂无需要立即处理的建议。</p>
        )}
      </Card>

      <p className="muted small">
        证据：机会点 {data.evidence.opportunities}；方案 {data.evidence.solutions}；实验{' '}
        {data.evidence.experiments}；任务 {data.evidence.plan_tasks}；UAT{' '}
        {data.evidence.uat_cases}；指标 {data.evidence.metrics}；使用记录{' '}
        {data.evidence.usage_records}；风险 {data.evidence.renewal_risks}。
      </p>
    </div>
  );
}
