import { useMemo, useState } from 'react';
import { api } from '../../api';
import { useLoad } from '../../hooks';
import type { ProcessModel, Stakeholder } from '../../types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Modal,
  Notice,
  Select,
  Spinner,
  Textarea,
} from '../../ui';
import { jsonPretty, nodeTypeLabel, parseJson } from '../../utils';

interface Bundle {
  model: ProcessModel;
  stakeholders: Stakeholder[];
}

function toEditorJson(model: ProcessModel) {
  const index = new Map(model.nodes.map((n, i) => [n.id, i]));
  return jsonPretty({
    nodes: model.nodes.map((n) => ({
      lane: n.lane,
      name: n.name,
      node_type: n.node_type,
      owner_role: n.owner_role,
      duration_min: n.duration_min,
      abnormal_rate: n.abnormal_rate,
      is_implicit: n.is_implicit,
      discovered_by: n.discovered_by,
      sort_order: n.sort_order,
    })),
    edges: model.edges.map((e) => ({
      from: index.get(e.from_node_id) ?? 0,
      to: index.get(e.to_node_id) ?? 0,
      label: e.label,
      condition: e.condition,
    })),
  });
}

export function ProcessTab({
  engagementId,
  onChanged,
}: {
  engagementId: string;
  onChanged: () => void;
}) {
  const { data, error, loading, reload } = useLoad<Bundle>(async () => {
    const [m, s] = await Promise.all([
      api.getProcessModel(engagementId),
      api.listStakeholders(engagementId),
    ]);
    return { model: m, stakeholders: s.items };
  }, [engagementId]);

  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [confirmedBy, setConfirmedBy] = useState('');
  const [formError, setFormError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const model = data?.model ?? { item: null, nodes: [], edges: [] };
  const stakeholders = data?.stakeholders ?? [];
  const nodeName = useMemo(
    () => new Map(model.nodes.map((n) => [n.id, n.name])),
    [model.nodes],
  );

  const openEditor = () => {
    setText(toEditorJson(model));
    setConfirmedBy('');
    setFormError(null);
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const parsed = parseJson<{ nodes?: unknown[]; edges?: unknown[] }>(text, {});
      if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
        throw new Error('nodes 必须是非空数组');
      }
      await api.saveProcessModel(engagementId, {
        nodes: parsed.nodes,
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
        confirmed_by: confirmedBy || undefined,
      });
      setOpen(false);
      await reload();
      onChanged();
    } catch (err) {
      setFormError(err);
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;

  return (
    <div className="tab-body">
      <Card
        title="业务流程"
        subtitle="节点和连线来自 process_nodes / process_edges；报告 §3 直接渲染这张图。"
        actions={
          <Button variant="primary" size="sm" onClick={openEditor}>
            {model.item ? '替换流程' : '+ 创建流程'}
          </Button>
        }
      >
        {!model.item ? (
          <Empty
            title="还没有业务流程"
            hint="用 JSON 或前端画布录入；当前 MVP 先提供结构化编辑。"
            action={
              <Button variant="primary" onClick={openEditor}>
                创建流程
              </Button>
            }
          />
        ) : (
          <>
            <div className="inline-stats">
              <span>
                版本 <strong>v{model.item.version}</strong>
              </span>
              <Badge tone={model.item.status === 'confirmed' ? 'green' : 'amber'}>
                {model.item.status === 'confirmed' ? '已确认' : '草稿'}
              </Badge>
              <span>
                节点 <strong>{model.nodes.length}</strong>
              </span>
              <span>
                连线 <strong>{model.edges.length}</strong>
              </span>
            </div>

            <div className="two-col">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>顺序</th>
                      <th>泳道</th>
                      <th>环节</th>
                      <th>类型</th>
                      <th>单均耗时</th>
                      <th>异常率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.nodes.map((n) => (
                      <tr key={n.id}>
                        <td>{n.sort_order ?? '—'}</td>
                        <td>{n.lane}</td>
                        <td>
                          {n.name}
                          {n.is_implicit && <Badge tone="amber">隐性</Badge>}
                        </td>
                        <td>{nodeTypeLabel(n.node_type)}</td>
                        <td>{n.duration_min != null ? `${n.duration_min} 分钟` : '—'}</td>
                        <td>{n.abnormal_rate != null ? `${n.abnormal_rate}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>从</th>
                      <th>到</th>
                      <th>条件</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.edges.map((e) => (
                      <tr key={e.id}>
                        <td>{nodeName.get(e.from_node_id) ?? '—'}</td>
                        <td>{nodeName.get(e.to_node_id) ?? '—'}</td>
                        <td className="muted">{e.condition || e.label || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </Card>

      <Notice tone="blue">
        流程节点颗粒度仍是人工判断：切太细看不懂，切太粗没价值。系统只负责把结构渲染进报告。
      </Notice>

      <Modal
        open={open}
        title={model.item ? '替换业务流程' : '创建业务流程'}
        subtitle="保存后旧版本自动归档；confirmed_by 选择客户侧负责人表示流程已确认。"
        onClose={() => setOpen(false)}
        wide
        footer={
          <>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存流程'}
            </Button>
          </>
        }
      >
        {formError ? <ErrorBox error={formError} /> : null}
        <Field label="确认人（可选）">
          <Select value={confirmedBy} onChange={(e) => setConfirmedBy(e.target.value)}>
            <option value="">暂不确认（保存为草稿）</option>
            {stakeholders.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.title || s.role_type}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="流程 JSON" hint="edges 的 from/to 可以是节点下标（从 0 开始）或 nodes[].key。">
          <Textarea
            className="mono code-area"
            rows={20}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
      </Modal>
    </div>
  );
}
