import { useEffect, useId, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { cn } from '../utils';

/**
 * 报告渲染：GFM（表格 / 任务列表 / 删除线）。
 * 默认不解析原始 HTML，避免客户数据里的标签被执行；链接统一新窗口打开。
 * ```mermaid 块按需加载 mermaid，并渲染成图片（不注入脚本）。
 */

// mermaid 体积不小（首次约 1MB，含 elk/cytoscape），只在真的出现 Mermaid 块时才加载；
// 同一个图在本会话内缓存渲染结果，不重复下载和计算。
let mermaidLoader: Promise<any> | null = null;
const mermaidSvgCache = new Map<string, string>();

function loadMermaid(): Promise<any> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'strict',
        fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
        themeVariables: { fontSize: '13px' },
        // 不要让 Mermaid 把图拉满容器，否则 13px 字会被放大成巨字
        flowchart: { htmlLabels: false, curve: 'basis', useMaxWidth: false },
      });
      return mermaid;
    });
  }
  return mermaidLoader;
}

export function MarkdownView({
  markdown,
  className,
}: {
  markdown: string;
  className?: string;
}) {
  return (
    <div className={cn('markdown-body', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
          table: ({ node: _node, ...props }) => (
            <div className="md-table-wrap">
              <table {...props} />
            </div>
          ),
          code: ({ node: _node, className, children, ...props }) => {
            const lang = /language-(\w+)/.exec(className ?? '')?.[1];
            if (lang === 'mermaid') {
              return <MermaidBlock chart={String(children).replace(/\n$/, '')} />;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ node, children, ...props }) => {
            const code = (node as any)?.children?.[0];
            const classes = code?.properties?.className;
            if (Array.isArray(classes) && classes.includes('language-mermaid')) {
              // Mermaid 会被 code 组件替换成图片，这里不要再包一层 <pre>
              return <>{children}</>;
            }
            return <pre {...props}>{children}</pre>;
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function MermaidBlock({ chart }: { chart: string }) {
  const reactId = useId().replace(/[^A-Za-z0-9]/g, '');
  const cached = mermaidSvgCache.get(chart) ?? null;
  const [src, setSrc] = useState<string | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    if (mermaidSvgCache.has(chart)) {
      setSrc(mermaidSvgCache.get(chart)!);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    loadMermaid()
      .then(async (mermaid) => {
        const { svg } = await mermaid.render(`mermaid-${reactId}`, chart);
        const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        mermaidSvgCache.set(chart, dataUrl);
        if (!cancelled) setSrc(dataUrl);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [chart, reactId]);

  if (loading) {
    return (
      <div className="mermaid-loading">
        依赖图渲染中…（首次加载 Mermaid 约 1MB，之后走缓存）
      </div>
    );
  }

  if (error) {
    return (
      <div className="mermaid-error">
        <p>依赖图渲染失败：{error}</p>
        <pre>{chart}</pre>
      </div>
    );
  }

  if (!src) return null;
  return <img className="mermaid-img" src={src} alt="机会点依赖关系图" />;
}
