import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import type { ImportKind } from '../types';
import { Button, ErrorBox, Modal, Notice } from '../ui';

const LABEL: Record<ImportKind, string> = {
  pains: '痛点',
  inventory: '四维盘点',
  opportunities: '机会点',
};

const COLUMNS: Record<ImportKind, string[]> = {
  pains: ['编号', '描述', '环节', '频次', '严重度', '量化影响', '来源类型', '来源说明', '状态'],
  inventory: ['维度', '类别', '名称', '属性(JSON)', '完整度', '已核实', '隐性', '发现方式'],
  opportunities: [
    '编号', '名称', '描述', '价值', '可行性', '紧迫度', '评分理由',
    '数据状态', '目标期', '阶段', '技术阻断', '阻断说明',
  ],
};

const REQUIRED: Record<ImportKind, string[]> = {
  pains: ['描述', '来源类型', '来源说明'],
  inventory: ['维度', '名称'],
  opportunities: ['名称', '价值', '可行性', '评分理由'],
};

interface RowIssue {
  row: number;
  field: string;
  message: string;
}

export function ImportModal({
  open,
  onClose,
  engagementId,
  kind,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  engagementId: string;
  kind: ImportKind;
  onImported: () => Promise<void> | void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{ inserted: number; rows: number } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setUploading(false);
    setResult(null);
    setError(null);
  }, [open, kind]);

  const columns = COLUMNS[kind];
  const required = REQUIRED[kind];
  const issues: RowIssue[] =
    error instanceof ApiError && Array.isArray(error.details?.errors)
      ? error.details.errors
      : [];

  const upload = async () => {
    if (!file) {
      setError(new Error('请选择 CSV 或 Excel 文件'));
      return;
    }
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.importRows(engagementId, kind, file);
      setResult(res);
      await onImported();
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`导入${LABEL[kind]}`}
      subtitle="支持 CSV / Excel（.xlsx / .xls）；先把数据按模板列填好，表头保持中文。"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button variant="primary" disabled={uploading} onClick={() => void upload()}>
            {uploading ? '导入中…' : '开始导入'}
          </Button>
        </>
      }
    >
      <div className="import-columns">
        {columns.map((c) => (
          <span
            key={c}
            className={`import-chip ${required.includes(c) ? 'import-chip-req' : ''}`}
          >
            {c}
            {required.includes(c) ? ' *' : ''}
          </span>
        ))}
      </div>
      <p className="hint-line">
        带 * 的列必填。编号留空会自动生成（痛点 P-001、机会点 OP-01）。导入是整批校验：
        有一行不合格就整批不写入，并返回行号。
      </p>

      <div className="import-actions">
        <a className="btn btn-secondary btn-sm" href={api.importTemplateUrl(kind)}>
          下载 CSV 模板
        </a>
        <label className="file-input">
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <span>{file ? file.name : '选择 CSV / Excel 文件'}</span>
        </label>
      </div>

      {result && (
        <Notice tone="green">
          导入成功：<strong>{result.inserted}</strong> 条（文件共 {result.rows} 行数据）。
          列表与 G1 指标已刷新。
        </Notice>
      )}

      {error ? <ErrorBox error={error} /> : null}
      {issues.length > 0 && (
        <div className="import-errors">
          <table>
            <thead>
              <tr>
                <th>行号</th>
                <th>字段</th>
                <th>问题</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((i, idx) => (
                <tr key={`${i.row}-${i.field}-${idx}`}>
                  <td className="mono">{i.row}</td>
                  <td>{i.field}</td>
                  <td>{i.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="hint-line">
        频次可填：每天 / 每周 / 每月 / 偶尔；来源类型：访谈 / 观察 / 数据；
        维度：业务 / 数据 / 系统 / 组织；目标期：一期 / 二期 / 观望。
      </p>
    </Modal>
  );
}
