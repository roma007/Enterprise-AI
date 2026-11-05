import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from '../api';
import { useLoad } from '../hooks';
import type { EngagementDetail, Gate, GateItem } from '../types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Modal,
  PageHeader,
  Progress,
  Spinner,
  Stat,
  Tabs,
} from '../ui';
import {
  confidenceTone,
  engagementStatusLabel,
  fmtDate,
  fmtMoney,
  gateStatusLabel,
  gateTone,
  impactLabel,
  oppStageLabel,
  phaseLabel,
  priorityLabel,
  priorityTone,
  stageLabel,
  stageTone,
  subIndustryLabel,
} from '../utils';
// 返回 any：各页签 props 不同，边界处统一放宽；懒加载仍是静态可分析的。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TAB_LOADERS: Record<string, () => Promise<any>> = {
  people: () => import('./tabs/PeopleTab'),
  pains: () => import('./tabs/PainsTab'),
  inventory: () => import('./tabs/InventoryTab'),
  process: () => import('./tabs/ProcessTab'),
  opportunities: () => import('./tabs/OpportunitiesTab'),
  solutions: () => import('./tabs/SolutionsTab'),
  quotes: () => import('./tabs/QuotesTab'),
  poc: () => import('./tabs/PocTab'),
  delivery: () => import('./tabs/DeliveryTab'),
  value: () => import('./tabs/ValueTab'),
  insights: () => import('./tabs/InsightsTab'),
  ai: () => import('./tabs/AiTab'),
  members: () => import('./tabs/MembersTab'),
  risks: () => import('./tabs/RisksTab'),
  reports: () => import('./tabs/ReportsTab'),
  confirmations: () => import('./tabs/ConfirmationsTab'),
};

const lazyTab = (key: keyof typeof TAB_LOADERS, exportName: string): any =>
  lazy(async () => {
    const mod = await TAB_LOADERS[key]();
    return { default: mod[exportName] };
  });

const PeopleTab = lazyTab('people', 'PeopleTab');
const PainsTab = lazyTab('pains', 'PainsTab');
const InventoryTab = lazyTab('inventory', 'InventoryTab');
const ProcessTab = lazyTab('process', 'ProcessTab');
const OpportunitiesTab = lazyTab('opportunities', 'OpportunitiesTab');
const RisksTab = lazyTab('risks', 'RisksTab');
const ReportsTab = lazyTab('reports', 'ReportsTab');
const ConfirmationsTab = lazyTab('confirmations', 'ConfirmationsTab');
const SolutionsTab = lazyTab('solutions', 'SolutionsTab');
const QuotesTab = lazyTab('quotes', 'QuotesTab');
const PocTab = lazyTab('poc', 'PocTab');
const DeliveryTab = lazyTab('delivery', 'DeliveryTab');
const ValueTab = lazyTab('value', 'ValueTab');
const InsightsTab = lazyTab('insights', 'InsightsTab');
const AiTab = lazyTab('ai', 'AiTab');
const MembersTab = lazyTab('members', 'MembersTab');

type TabKey =
  | 'overview'
  | 'people'
  | 'pains'
  | 'inventory'
  | 'process'
  | 'opportunities'
  | 'solutions'
  | 'quotes'
  | 'poc'
  | 'delivery'
  | 'value'
  | 'insights'
  | 'ai'
  | 'members'
  | 'risks'
  | 'reports'
  | 'confirmations';

const TAB_KEYS: TabKey[] = [
  'overview',
  'people',
  'pains',
  'inventory',
  'process',
  'opportunities',
  'solutions',
  'quotes',
  'poc',
  'delivery',
  'value',
  'insights',
  'ai',
  'members',
  'risks',
  'reports',
  'confirmations',
];

const tabStorageKey = (id: string) => `ai-delivery:tab:${id}`;

export function EngagementPage({
  id,
  onBack,
  review,
  view,
  initialTab,
}: {
  id: string;
  onBack: () => void;
  review?: string;
  view?: string;
  initialTab?: string;
}) {
  const [tab, setTab] = useState<TabKey>(() => {
    if (review) return 'poc';
    if (initialTab && TAB_KEYS.includes(initialTab as TabKey)) {
      return initialTab as TabKey;
    }
    try {
      const saved = window.localStorage.getItem(tabStorageKey(id)) as TabKey | null;
      return saved && TAB_KEYS.includes(saved) ? saved : 'overview';
    } catch {
      return 'overview';
    }
  });

  useEffect(() => {
    if (review) {
      setTab('poc');
      return;
    }
    if (initialTab && TAB_KEYS.includes(initialTab as TabKey)) {
      setTab(initialTab as TabKey);
    }
  }, [review, initialTab]);

  useEffect(() => {
    try {
      window.localStorage.setItem(tabStorageKey(id), tab);
    } catch {
      /* ignore private mode */
    }
  }, [id, tab]);

  const prefetchTab = (key: string) => {
    const loader = TAB_LOADERS[key];
    if (loader) void loader().catch(() => undefined);
  };
  const { data, error, loading, reload } = useLoad<EngagementDetail>(
    () => api.getEngagement(id),
    [id],
  );
  const [selectedOpp, setSelectedOpp] = useState<string | null>(null);

  const goOpportunity = (oppId: string) => {
    setSelectedOpp(oppId);
    setTab('opportunities');
  };

  if (loading && !data) return <div className="page"><Spinner /></div>;
  if (error && !data)
    return (
      <div className="page">
        <Button onClick={onBack}>← 返回</Button>
        <ErrorBox error={error} onRetry={() => void reload()} />
      </div>
    );
  if (!data) return null;

  const e = data.engagement;

  return (
    <div className="page">
      <div className="crumb">
        <button className="link-btn" onClick={onBack}>
          ← 项目列表
        </button>
      </div>

      <PageHeader
        eyebrow={
          <span className="eyebrow-inline">
            {e.client_name}
            {e.sub_industry && (
              <span className="muted"> · {subIndustryLabel(e.sub_industry)}</span>
            )}
          </span>
        }
        title={e.name}
        subtitle={
          <span className="header-meta">
            <Badge tone={stageTone(e.stage)}>{stageLabel(e.stage)}</Badge>
            <Badge tone={e.status === 'active' ? 'green' : 'gray'}>
              {engagementStatusLabel(e.status)}
            </Badge>
            <span className="muted">
              {fmtDate(e.start_date)} → {fmtDate(e.target_end_date)}
            </span>
            {e.annual_revenue ? (
              <span className="muted">年营收 {fmtMoney(e.annual_revenue, 0)}</span>
            ) : null}
          </span>
        }
        actions={
          <>
            <Button onClick={() => void reload()}>刷新</Button>
            <Button variant="primary" onClick={() => setTab('reports')}>
              生成报告
            </Button>
          </>
        }
      />

      <Tabs
        active={tab}
        onChange={(k) => setTab(k as TabKey)}
        onPrefetch={prefetchTab}
        items={[
          { key: 'overview', label: '概览' },
          { key: 'people', label: '干系人与访谈' },
          { key: 'pains', label: '痛点', count: data.counts.painPoints },
          { key: 'inventory', label: '四维盘点' },
          { key: 'process', label: '业务流程', count: data.counts.processNodes },
          { key: 'opportunities', label: '机会点与 ROI', count: data.counts.opportunities },
          { key: 'solutions', label: '方案设计' },
          { key: 'quotes', label: '报价' },
          { key: 'poc', label: 'POC 验证' },
          { key: 'delivery', label: '交付' },
          { key: 'value', label: '运营' },
          { key: 'insights', label: '洞察' },
          { key: 'ai', label: 'AI 助手' },
          { key: 'members', label: '成员' },
          { key: 'risks', label: '风险与局限', count: data.counts.limitations },
          { key: 'reports', label: '报告' },
          { key: 'confirmations', label: '确认与签收' },
        ]}
      />

      <Suspense fallback={<Spinner label="加载页签…" />}>
      {tab === 'overview' && (
        <Overview
          detail={data}
          onChanged={() => void reload()}
          onGoOpportunity={goOpportunity}
          onGoTab={setTab}
        />
      )}
      {tab === 'people' && <PeopleTab engagementId={id} onChanged={() => void reload()} />}
      {tab === 'pains' && <PainsTab engagementId={id} onChanged={() => void reload()} />}
      {tab === 'inventory' && <InventoryTab engagementId={id} onChanged={() => void reload()} />}
      {tab === 'process' && <ProcessTab engagementId={id} onChanged={() => void reload()} />}
      {tab === 'opportunities' && (
        <OpportunitiesTab
          engagementId={id}
          selectedId={selectedOpp}
          onSelect={setSelectedOpp}
          onChanged={() => void reload()}
        />
      )}
      {tab === 'solutions' && (
        <SolutionsTab
          engagementId={id}
          detail={data}
          onChanged={() => void reload()}
          onGoReports={() => setTab('reports')}
        />
      )}
      {tab === 'quotes' && (
        <QuotesTab
          engagementId={id}
          onChanged={() => void reload()}
          onGoReports={() => setTab('reports')}
        />
      )}
      {tab === 'poc' && (
        <PocTab
          engagementId={id}
          detail={data}
          initialReviewId={review}
          initialViewId={view}
          onChanged={() => void reload()}
          onGoReports={() => setTab('reports')}
        />
      )}
      {tab === 'delivery' && (
        <DeliveryTab
          engagementId={id}
          onChanged={() => void reload()}
          onGoReports={() => setTab('reports')}
        />
      )}
      {tab === 'value' && (
        <ValueTab
          engagementId={id}
          detail={data}
          onChanged={() => void reload()}
          onGoReports={() => setTab('reports')}
        />
      )}
      {tab === 'insights' && <InsightsTab engagementId={id} />}
      {tab === 'ai' && (
        <AiTab engagementId={id} detail={data} onChanged={() => void reload()} />
      )}
      {tab === 'members' && <MembersTab engagementId={id} />}
      {tab === 'risks' && <RisksTab engagementId={id} detail={data} onChanged={() => void reload()} />}
      {tab === 'reports' && <ReportsTab engagementId={id} detail={data} onChanged={() => void reload()} />}
      {tab === 'confirmations' && (
        <ConfirmationsTab engagementId={id} onChanged={() => void reload()} />
      )}
      </Suspense>
    </div>
  );
}

function Overview({
  detail,
  onChanged,
  onGoOpportunity,
  onGoTab,
}: {
  detail: EngagementDetail;
  onChanged: () => void;
  onGoOpportunity: (id: string) => void;
  onGoTab: (tab: TabKey) => void;
}) {
  const [editingGate, setEditingGate] = useState<Gate | null>(null);
  const checks = useLoad(
    () => api.consistencyChecks(detail.engagement.id),
    [detail.engagement.id],
  );

  const reportable = detail.opportunities.filter(
    (o) => o.targetPhase === 'phase1' || o.targetPhase === 'phase2',
  );

  return (
    <div className="tab-body">
      <div className="stat-grid">
        <Stat label="机会点" value={detail.counts.opportunities} hint={`${detail.counts.reportable} 个进入路线`} tone="brand" />
        <Stat label="痛点" value={detail.counts.painPoints} hint="全部需有来源" />
        <Stat label="基线" value={detail.counts.baselines} hint="ROI 的证据基础" tone="blue" />
        <Stat label="局限" value={detail.counts.limitations} hint="金额 / 范围 / 方法 / 内部" tone="amber" />
        <Stat label="流程节点" value={detail.counts.processNodes} hint="业务现状" />
        <Stat label="行业基准" value={detail.counts.benchmarks} hint="物流指标库" tone="green" />
      </div>

      <div className="two-col">
        <Card
          title="G1 诊断门禁"
          subtitle="门禁不是审批，是证据检查；量化项会随录入数据自动刷新。"
          actions={
            <Button
              size="sm"
              onClick={async () => {
                await api.refreshGates(detail.engagement.id);
                checks.reload();
                onChanged();
              }}
            >
              刷新指标
            </Button>
          }
        >
          <div className="gate-list">
            {detail.gates.map((g) => {
              const total = g.checklist.length;
              const passed = g.checklist.filter((i) => i.passed).length;
              return (
                <div key={g.id} className="gate-row">
                  <div className="gate-top">
                    <strong>{g.code}</strong>
                    <Badge tone={gateTone(g.status)}>{gateStatusLabel(g.status)}</Badge>
                    <span className="muted">
                      {total ? `${passed}/${total} 项` : '无清单'}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setEditingGate(g)}>
                      编辑
                    </Button>
                  </div>
                  {total > 0 && <Progress value={passed} max={total} />}
                  {g.checklist.filter((i) => !i.passed).length > 0 && (
                    <div className="gate-fails">
                      {g.checklist
                        .filter((i) => !i.passed)
                        .slice(0, 4)
                        .map((i) => (
                          <span key={i.item} className="gate-fail">
                            {i.item}
                            {i.actual !== undefined && i.required !== undefined
                              ? `（${i.actual}/${i.required}）`
                              : ''}
                          </span>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        <Card
          title="生成前校验"
          subtitle="14 项一致性校验，有 block 时生成接口会返回 422。"
          actions={
            <Button size="sm" variant="ghost" onClick={() => onGoTab('reports')}>
              去报告
            </Button>
          }
        >
          {checks.loading && <Spinner label="校验中…" />}
          {checks.error ? <ErrorBox error={checks.error} onRetry={() => void checks.reload()} /> : null}
          {checks.data && (
            <>
              <div className="check-summary">
                <span className="check-pill check-pass">{checks.data.summary.pass} pass</span>
                <span className="check-pill check-warn">{checks.data.summary.warn} warn</span>
                <span className="check-pill check-block">{checks.data.summary.block} block</span>
              </div>
              <div className="check-list">
                {checks.data.checks.map((c) => (
                  <div key={c.code} className="check-row">
                    <span className={`check-dot check-dot-${c.outcome}`} />
                    <strong>{c.code}</strong>
                    <span className="check-title">{c.title}</span>
                    {c.outcome !== 'pass' && <span className="check-msg">{c.message}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      <Card
        title="机会点"
        subtitle="按 V × F × U 排序；点一行进入 ROI 编辑。"
        actions={
          <Button size="sm" variant="ghost" onClick={() => onGoTab('opportunities')}>
            全部
          </Button>
        }
      >
        {detail.opportunities.length === 0 ? (
          <Empty title="还没有机会点" hint="至少建 3 个机会点，G1 才会通过。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>编号</th>
                  <th>机会点</th>
                  <th>得分</th>
                  <th>档位</th>
                  <th>路线</th>
                  <th>阶段</th>
                  <th>可实现</th>
                  <th>回本</th>
                  <th>置信度</th>
                </tr>
              </thead>
              <tbody>
                {detail.opportunities.map((o) => (
                  <tr key={o.id} className="row-click" onClick={() => onGoOpportunity(o.id)}>
                    <td className="mono">{o.code}</td>
                    <td>{o.title}</td>
                    <td>{o.score}</td>
                    <td>
                      <Badge tone={priorityTone(o.priorityBand)}>{priorityLabel(o.priorityBand)}</Badge>
                    </td>
                    <td>{phaseLabel(o.targetPhase)}</td>
                    <td>{oppStageLabel(o.stage)}</td>
                    <td className="money">{o.roi ? fmtMoney(o.roi.realizedValue) : '—'}</td>
                    <td>{o.roi?.paybackMonths != null ? `${o.roi.paybackMonths} 个月` : '—'}</td>
                    <td>
                      {o.roi ? (
                        <Badge tone={confidenceTone(o.roi.confidence)}>
                          {o.roi.confidence}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint-line">
          进入路线 {reportable.length} 个；只有进入路线且完成 ROI 的机会点会出现在报告的组合测算里。
        </p>
      </Card>

      <Card title="局限分流" subtitle="金额类紧跟 ROI、范围类紧跟痛点、方法类进附录、内部项不进客户文档。">
        {detail.limitations.length === 0 ? (
          <Empty title="暂无局限记录" hint="低置信度基线必须进入局限，否则 C6 会 block。" />
        ) : (
          <div className="limitation-grid">
            {detail.limitations.map((l) => (
              <div key={l.id} className="limitation-item">
                <div className="limitation-head">
                  <Badge tone={l.impactClass === 'internal' ? 'gray' : l.impactClass === 'amount' ? 'amber' : 'blue'}>
                    {impactLabel(l.impactClass)}
                  </Badge>
                  {!l.inCustomerDoc && <Badge tone="gray">不进客户文档</Badge>}
                </div>
                <strong>{l.title}</strong>
                <span className="muted">{l.affectedRefs.join('、') || '全局'}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <GateEditor
        gate={editingGate}
        engagementId={detail.engagement.id}
        onClose={() => setEditingGate(null)}
        onSaved={() => {
          setEditingGate(null);
          onChanged();
          checks.reload();
        }}
      />
    </div>
  );
}

function GateEditor({
  gate,
  engagementId,
  onClose,
  onSaved,
}: {
  gate: Gate | null;
  engagementId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState('pending');
  const [items, setItems] = useState<GateItem[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!gate) return;
    setStatus(gate.status);
    setItems(gate.checklist.map((i) => ({ ...i })));
    setError(null);
  }, [gate]);

  if (!gate) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateGate(engagementId, gate.code, { status, checklist: items });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!gate}
      title={`${gate.code} 门禁`}
      subtitle="勾选表示证据已齐；状态改为 passed 前，所有项必须通过。"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      {error ? <ErrorBox error={error} /> : null}
      <div className="form-grid">
        <label className="field">
          <span className="field-label">门禁状态</span>
          <select className="input select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">待办</option>
            <option value="in_review">审核中</option>
            <option value="passed">已通过</option>
            <option value="rejected">已驳回</option>
          </select>
        </label>
      </div>
      <div className="gate-edit-list">
        {items.map((item, idx) => (
          <label key={item.item} className="gate-edit-item">
            <input
              type="checkbox"
              checked={item.passed}
              onChange={(e) =>
                setItems((prev) =>
                  prev.map((x, i) => (i === idx ? { ...x, passed: e.target.checked } : x)),
                )
              }
            />
            <span className="gate-edit-text">{item.item}</span>
            {item.actual !== undefined && item.required !== undefined && (
              <span className="muted">
                {item.actual}/{item.required}
              </span>
            )}
            {item.note && <span className="muted">{item.note}</span>}
          </label>
        ))}
        {items.length === 0 && <Empty title="这个门禁没有清单" />}
      </div>
    </Modal>
  );
}
