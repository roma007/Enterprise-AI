import { expect, test, type Page, type APIRequestContext } from '@playwright/test';

async function login(
  page: Page,
  request: APIRequestContext,
): Promise<{ token: string; user: any }> {
  const res = await request.post('/api/auth/login', {
    data: { email: 'admin@hengzhi.ai', password: 'demo1234' },
  });
  expect(res.status()).toBe(200);
  const { token, user } = await res.json();
  await page.addInitScript(
    ({ token, user }) => {
      localStorage.setItem('ai-delivery-token', token);
      localStorage.setItem('ai-delivery-user', user);
    },
    { token, user: JSON.stringify(user) },
  );
  return { token, user };
}

test.describe('审计边界场景', () => {
  test('视图导入拒绝高版本并给出可读错误', async ({ page, request }) => {
    await login(page, request);
    await page.goto('/#/audit');
    await expect(
      page.getByRole('heading', { name: '审计日志', level: 1 }),
    ).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
      name: 'audit-views-v999.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          kind: 'audit-filter-views',
          version: 999,
          views: [{ name: 'future-view', status: '4xx' }],
        }),
      ),
    });
    await expect(
      page.getByText('视图文件版本不受支持，请用当前版本重新导出'),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('视图导入缺少 views 数组时提示明确', async ({ page, request }) => {
    await login(page, request);
    await page.goto('/#/audit');
    await expect(
      page.getByRole('heading', { name: '审计日志', level: 1 }),
    ).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
      name: 'audit-views-empty.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ version: 1 })),
    });
    await expect(page.getByText('文件缺少 views 数组')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('审计日期范围倒置时后端拒绝', async ({ page, request }) => {
    await login(page, request);
    await page.goto('/#/audit');
    await expect(
      page.getByRole('heading', { name: '审计日志', level: 1 }),
    ).toBeVisible();

    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill('2026-12-31');
    await dates.nth(1).fill('2026-01-01');
    await expect(
      page.getByText('开始日期不能晚于结束日期').first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('导出任务可打开过期清理入口', async ({ page, request }) => {
    await login(page, request);
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto('/#/audit');
    await expect(
      page.getByRole('heading', { name: '审计日志', level: 1 }),
    ).toBeVisible();

    await page.getByRole('button', { name: '异步导出' }).click();
    const modal = page.locator('.modal');
    await expect(
      modal.getByRole('heading', { name: '导出任务' }),
    ).toBeVisible();
    await modal.getByRole('button', { name: '清理过期导出' }).click();
    await expect(
      modal.getByText(/没有超过 \d+ 天的导出任务|已清理 \d+ 个导出任务/),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('报价版本对比', () => {
  test('可打开两个报价版本的差异弹窗', async ({ page, request }) => {
    const { token } = await login(page, request);
    const headers = { authorization: `Bearer ${token}` };
    const engagements = await request.get('/api/engagements', { headers });
    expect(engagements.status()).toBe(200);
    const engagementId = (await engagements.json()).items[0].id as string;

    const createQuote = async (notes: string) => {
      const res = await request.post(`/api/engagements/${engagementId}/quotes`, {
        headers,
        data: { notes },
      });
      expect(res.status()).toBe(201);
      return (await res.json()).item.id as string;
    };

    const q1 = await createQuote('e2e 报价对比 v1');
    const q2 = await createQuote('e2e 报价对比 v2');
    try {
      const item1 = await request.post(`/api/quotes/${q1}/items`, {
        headers,
        data: {
          kind: 'one_time',
          description: 'e2e 实施费',
          qty: 1,
          unit_price: 10,
        },
      });
      expect(item1.status()).toBe(201);
      const item2 = await request.post(`/api/quotes/${q2}/items`, {
        headers,
        data: {
          kind: 'one_time',
          description: 'e2e 实施费',
          qty: 1,
          unit_price: 12,
        },
      });
      expect(item2.status()).toBe(201);

      await page.goto(`/#/engagements/${engagementId}`);
      await page.getByRole('button', { name: '报价', exact: true }).click();
      await expect(page.getByText('报价单', { exact: true }).first()).toBeVisible();
      await page.getByRole('button', { name: '对比版本' }).click();
      await expect(
        page.getByRole('heading', { name: '报价版本对比' }),
      ).toBeVisible();
      await expect(
        page.getByText(/一次性投入 \d+ 万 → \d+ 万/),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('e2e 实施费').first()).toBeVisible();
      await expect(page.getByRole('button', { name: '下载 Word' })).toBeVisible();
    } finally {
      await request.delete(`/api/quotes/${q1}`, { headers });
      await request.delete(`/api/quotes/${q2}`, { headers });
    }
  });
});
