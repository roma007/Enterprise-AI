import { expect, test, type Page, type APIRequestContext } from '@playwright/test';

async function login(
  page: Page,
  request: APIRequestContext,
): Promise<void> {
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
