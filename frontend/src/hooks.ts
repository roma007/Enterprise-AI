import { useCallback, useEffect, useRef, useState } from 'react';

export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  // loader 由调用方内联传入，依赖显式列出，避免每次渲染都重新请求
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await loader());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void run();
  }, [run]);

  return { data, error, loading, reload: run, setData };
}

export function useForm<T extends Record<string, any>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const set = (key: keyof T, value: any) =>
    setValues((prev) => ({ ...prev, [key]: value }));
  const reset = () => setValues(initial);
  return { values, set, reset, setValues };
}


export interface PageResult<T> {
  items: T[];
  total: number;
}

/**
 * 分页列表：首屏加载 + 追加加载。
 * fetchPage 通过 ref 保持最新，deps 变化时回到第一页。
 */
export function usePaged<T>(
  fetchPage: (limit: number, offset: number) => Promise<PageResult<T>>,
  deps: unknown[],
  pageSize = 100,
) {
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchRef.current(pageSize, 0);
      setItems(page.items);
      setTotal(page.total);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [pageSize]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    void reload();
  }, deps);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchRef.current(pageSize, items.length);
      setItems((prev) => [...prev, ...page.items]);
      setTotal(page.total);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  }, [items.length, pageSize, loadingMore]);

  return {
    items,
    total,
    error,
    loading,
    loadingMore,
    hasMore: items.length < total,
    reload,
    loadMore,
  };
}


/** 简单防抖：搜索框输入后延迟发请求。 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}