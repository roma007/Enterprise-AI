import { z } from 'zod';

export interface Page {
  limit: number;
  offset: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** 统一分页参数：默认 200 条，上限 500，避免一次性拉全表。 */
export function parsePage(query: unknown, defaultLimit = 200): Page {
  return z
    .object({
      limit: z.coerce.number().int().min(1).max(500).default(defaultLimit),
      offset: z.coerce.number().int().min(0).default(0),
    })
    .parse(query ?? {});
}

export function pageResult<T>(items: T[], total: number | string, page: Page): Paged<T> {
  return {
    items,
    total: Number(total),
    limit: page.limit,
    offset: page.offset,
  };
}
