import type { Benchmark } from '../types';

export type Position = 'excellent' | 'good' | 'median' | 'lagging' | 'unknown';

/**
 * 与数据库函数 benchmark_position() 完全一致的分位判定。
 * 边界规则（P2）：触发「落后」的那条边界归落后，其余边界归优。
 *   lower_better：<=p25 优秀 | <=p50 良好 | <p75 中位 | >=p75 落后
 *   higher_better：>=p75 优秀 | >=p50 良好 | >p25 中位 | <=p25 落后
 */
export function positionOf(b: Benchmark, value: number | null | undefined): Position {
  if (value === null || value === undefined) return 'unknown';
  const { p25, p50, p75, direction } = b;
  if (p25 === null || p50 === null || p75 === null) return 'unknown';

  if (direction === 'lower_better') {
    if (value <= p25) return 'excellent';
    if (value <= p50) return 'good';
    if (value < p75) return 'median';
    return 'lagging';
  }
  if (value >= p75) return 'excellent';
  if (value >= p50) return 'good';
  if (value > p25) return 'median';
  return 'lagging';
}

export const POSITION_LABEL: Record<Position, string> = {
  excellent: '优秀',
  good: '良好',
  median: '中位',
  lagging: '落后',
  unknown: '无基准',
};
