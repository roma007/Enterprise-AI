import { useMemo } from 'react';
import type { Dependency, OpportunitySummary } from '../types';

const COLUMNS = [
  { key: 'phase1', label: '一期' },
  { key: 'phase2', label: '二期' },
  { key: 'watch', label: '观望' },
  { key: 'none', label: '未排期' },
] as const;

const NODE_W = 190;
const NODE_H = 54;
const COL_W = 250;
const ROW_H = 76;
const PAD_X = 36;
const PAD_TOP = 58;

const EDGE_COLOR: Record<string, string> = {
  requires: '#2563eb',
  blocks: '#dc2626',
  enables: '#0d9488',
};

const EDGE_LABEL: Record<string, string> = {
  requires: '依赖',
  blocks: '阻断',
  enables: '使能',
};

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function DependencyGraph({
  opportunities,
  dependencies,
}: {
  opportunities: OpportunitySummary[];
  dependencies: Dependency[];
}) {
  const layout = useMemo(() => {
    const colOf = (phase: string | null | undefined) => {
      const idx = COLUMNS.findIndex((c) => c.key === (phase ?? 'none'));
      return idx === -1 ? 3 : idx;
    };

    const byCol = new Map<number, OpportunitySummary[]>();
    for (const o of opportunities) {
      const c = colOf(o.targetPhase);
      byCol.set(c, [...(byCol.get(c) ?? []), o]);
    }

    // 只展示有节点的期次列，避免空列把图撑宽
    const activeColumns = COLUMNS.map((col, idx) => ({ ...col, idx })).filter(
      (col) => (byCol.get(col.idx)?.length ?? 0) > 0,
    );
    const activeIndex = new Map(activeColumns.map((col, i) => [col.idx, i]));

    const positions = new Map<
      string,
      { x: number; y: number; phase: string | null; title: string }
    >();
    let maxRows = 1;
    for (const [col, list] of byCol) {
      maxRows = Math.max(maxRows, list.length);
      const shownCol = activeIndex.get(col) ?? 0;
      list.forEach((o, row) => {
        positions.set(o.code, {
          x: PAD_X + shownCol * COL_W,
          y: PAD_TOP + row * ROW_H,
          phase: o.targetPhase,
          title: o.title,
        });
      });
    }

    const width =
      PAD_X * 2 + Math.max(1, activeColumns.length) * COL_W - (COL_W - NODE_W);
    const height = PAD_TOP + maxRows * ROW_H + 24;
    return { positions, width, height, activeColumns };
  }, [opportunities]);

  if (!dependencies.length) {
    return (
      <div className="dep-graph-empty">
        <p>还没有依赖关系</p>
        <span>在下方添加"依赖 / 阻断 / 使能"，这里会生成关系图。</span>
      </div>
    );
  }

  return (
    <div className="dep-graph">
      <div className="dep-graph-scroll">
        <svg
          className="dep-svg"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label="机会点依赖关系图"
        >
          <defs>
            {Object.entries(EDGE_COLOR).map(([type, color]) => (
              <marker
                key={type}
                id={`dep-arrow-${type}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
              </marker>
            ))}
          </defs>

          {layout.activeColumns.map((col, idx) => (
            <g key={col.key}>
              <text
                x={PAD_X + idx * COL_W + NODE_W / 2}
                y={26}
                textAnchor="middle"
                className="dep-col-label"
              >
                {col.label}
              </text>
              <line
                x1={PAD_X + idx * COL_W}
                y1={36}
                x2={PAD_X + idx * COL_W + NODE_W}
                y2={36}
                className="dep-col-line"
              />
            </g>
          ))}

          {dependencies.map((d) => {
            const from = layout.positions.get(d.from_code);
            const to = layout.positions.get(d.to_code);
            if (!from || !to) return null;

            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            const back = x2 <= x1;
            const midX = (x1 + x2) / 2;
            const path = back
              ? `M ${x1} ${y1} C ${x1 + 70} ${y1 - 56}, ${x2 - 70} ${y2 - 56}, ${x2} ${y2}`
              : `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;

            return (
              <g key={d.id} className={`dep-edge dep-edge-${d.type}`}>
                <path
                  d={path}
                  markerEnd={`url(#dep-arrow-${d.type})`}
                  stroke={EDGE_COLOR[d.type] ?? '#64748b'}
                />
                <title>
                  {`${d.from_code} → ${d.to_code}：${EDGE_LABEL[d.type] ?? d.type}${
                    d.note ? `（${d.note}）` : ''
                  }`}
                </title>
              </g>
            );
          })}

          {[...layout.positions.entries()].map(([code, p]) => (
            <g
              key={code}
              className={`dep-node dep-node-${p.phase ?? 'none'}`}
              transform={`translate(${p.x},${p.y})`}
            >
              <rect width={NODE_W} height={NODE_H} rx={12} />
              <text x={12} y={21} className="dep-code">
                {code}
              </text>
              <text x={12} y={40} className="dep-title">
                {truncate(p.title, 17)}
              </text>
            </g>
          ))}
        </svg>
      </div>

      <div className="dep-legend">
        {Object.entries(EDGE_LABEL).map(([type, label]) => (
          <span key={type}>
            <i className={`dep-line dep-line-${type}`} />
            {label}
          </span>
        ))}
        {COLUMNS.map((c) => (
          <span key={c.key}>
            <i className={`dep-swatch dep-swatch-${c.key}`} />
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}
