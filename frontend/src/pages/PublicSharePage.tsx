import { lazy, Suspense } from 'react';
import { api } from '../api';
import { useLoad } from '../hooks';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Spinner,
} from '../ui';
import { fmtDateTime } from '../utils';

const MarkdownView = lazy(() =>
  import('../components/MarkdownView').then((m) => ({ default: m.MarkdownView })),
);

export function PublicSharePage({ token }: { token: string }) {
  const { data, error, loading, reload } = useLoad(
    () => api.publicShare(token),
    [token],
  );

  if (loading) return <Spinner label="加载分享内容…" />;
  if (error || !data) {
    return (
      <div className="public-page">
        <div className="public-head">
          <span className="brand-mark">AI</span>
          <div>
            <strong>交付云 · 只读分享</strong>
            <small>链接无效或已失效</small>
          </div>
        </div>
        <Card title="无法打开分享">
          <ErrorBox error={error ?? new Error('分享内容不存在')} onRetry={() => void reload()} />
          <p className="hint-line">请联系项目顾问重新生成分享链接。</p>
        </Card>
      </div>
    );
  }

  const d = data.deliverable;
  const s = data.share;

  return (
    <div className="public-page">
      <div className="public-head">
        <span className="brand-mark">AI</span>
        <div>
          <strong>交付云 · 只读分享</strong>
          <small>
            {data.project.client} · {data.project.name}
          </small>
        </div>
      </div>

      <Card
        title={`${d.title} v${d.version}`}
        subtitle={`分享给 ${s.shared_to_name} · 分享于 ${fmtDateTime(s.shared_at)}`}
        actions={
          <div className="generate-bar">
            <Button
              size="sm"
              onClick={() => window.open(api.publicShareDocxUrl(token), '_blank', 'noopener')}
            >
              下载 Word
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => window.open(api.publicSharePdfUrl(token), '_blank', 'noopener')}
            >
              下载 PDF
            </Button>
          </div>
        }
      >
        <div className="inline-stats">
          <span>访问次数 <strong>{s.view_count}</strong></span>
          {s.expires_at ? (
            <Badge tone="gray">有效期至 {fmtDateTime(s.expires_at)}</Badge>
          ) : (
            <Badge tone="gray">长期有效</Badge>
          )}
          {s.note ? <span className="muted">{s.note}</span> : null}
        </div>

        <Suspense fallback={<Spinner label="渲染文档…" />}>
          <MarkdownView markdown={d.markdown} />
        </Suspense>
      </Card>

      <p className="hint-line center">
        此链接为只读分享，未经授权请勿转发；如有疑问请联系项目顾问。
      </p>
    </div>
  );
}
