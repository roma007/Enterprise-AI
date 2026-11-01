import { expect, test, type Page } from '@playwright/test';

const DEMO_EMAIL = 'zhang@hengzhi.ai';
const DEMO_PASSWORD = 'demo1234';

async function ensureLoggedIn(page: Page) {
  await page.goto('/');
  const email = page.locator('input[type="email"]');
  if (await email.count()) {
    await email.fill(DEMO_EMAIL);
    await page.locator('input[type="password"]').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: /登录/ }).click();
  }
  await expect(page.getByRole('heading', { name: '项目列表' })).toBeVisible();
}

async function openSeedProject(page: Page) {
  await ensureLoggedIn(page);
  await page.getByText('宏远国际物流').first().click();
  await expect(page.getByRole('heading', { name: /宏远物流 AI 化诊断/ })).toBeVisible();
}

test.describe('关键路径冒烟', () => {
  test('项目列表与 seed 项目可打开', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await ensureLoggedIn(page);
    await expect(page.getByText('宏远国际物流').first()).toBeVisible();
    await expect(page.getByText('项目总数')).toBeVisible();

    await page.getByText('宏远国际物流').first().click();
    await expect(page.getByRole('heading', { name: /宏远物流 AI 化诊断/ })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('项目页签按需加载并展示关键区域', async ({ page }) => {
    await openSeedProject(page);

    await page.getByRole('button', { name: /^痛点/ }).click();
    await expect(page.getByText('痛点清单')).toBeVisible();

    await page.getByRole('button', { name: '方案设计' }).click();
    await expect(page.getByText('G2 方案门禁')).toBeVisible();

    await page.getByRole('button', { name: '交付' }).click();
    await expect(page.getByText('G4 交付门禁')).toBeVisible();

    await page.getByRole('button', { name: '运营' }).click();
    await expect(page.getByText('G5 价值实现门禁')).toBeVisible();

    await page.getByRole('button', { name: 'AI 助手' }).click();
    await expect(page.getByText('按项目数据与知识库生成草稿')).toBeVisible();

    await page.getByRole('button', { name: '报告', exact: true }).click();
    await expect(page.getByText('生成交付物')).toBeVisible();
  });

  test('项目列表服务端搜索', async ({ page }) => {
    await ensureLoggedIn(page);
    const search = page.getByPlaceholder('搜索项目或客户');
    await search.fill('不存在的项目-xyz');
    await expect(page.getByText('还没有项目')).toBeVisible();

    await search.fill('宏远');
    await expect(page.getByText('宏远国际物流').first()).toBeVisible();
  });

  test('记住上次打开的页签', async ({ page }) => {
    await openSeedProject(page);
    await page.getByRole('button', { name: '运营' }).click();
    await expect(page.getByText('G5 价值实现门禁')).toBeVisible();

    await page.reload();
    await expect(page.getByText('G5 价值实现门禁')).toBeVisible();
    await expect(page.getByRole('button', { name: '运营' })).toHaveClass(/tab-active/);
  });

  test('知识库检索与知识卡片', async ({ page }) => {
    await ensureLoggedIn(page);
    await page.goto('/#/knowledge');
    await expect(page.getByRole('heading', { name: '知识库' })).toBeVisible();

    const search = page.getByPlaceholder('搜索标题、摘要、正文');
    await search.fill('托书');
    await expect(page.getByText('托书 / 订单自动结构化录入')).toBeVisible();
  });

  test('交付物可导出服务端 PDF', async ({ request }) => {
    const generated = await request.post('/api/deliverables/generate', {
      data: {
        engagementId: 'a4000000-0000-4000-8000-000000000001',
        type: 'diagnosis_report',
      },
    });
    expect(generated.status()).toBe(201);
    const { id } = await generated.json();

    const createdJob = await request.post(`/api/deliverables/${id}/pdf-jobs`);
    expect(createdJob.status()).toBe(202);
    const { id: jobId } = (await createdJob.json()).item;

    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/pdf-jobs/${jobId}`);
          return (await res.json()).item.status;
        },
        { timeout: 30_000 },
      )
      .toBe('done');

    const file = await request.get(`/api/pdf-jobs/${jobId}/file`);
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toContain('application/pdf');
    const body = await file.body();
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(body.length).toBeGreaterThan(20_000);

    const sync = await request.get(`/api/deliverables/${id}/export.pdf`);
    expect(sync.status()).toBe(200);
    expect(sync.headers()['x-pdf-cache']).toBe('HIT');
  });

  test('客户只读分享链接无需登录即可查看', async ({ page, request }) => {
    const engagementId = 'a4000000-0000-4000-8000-000000000001';
    const generated = await request.post('/api/deliverables/generate', {
      data: { engagementId, type: 'diagnosis_report' },
    });
    expect(generated.status()).toBe(201);
    const { id } = await generated.json();
    await request.patch(`/api/deliverables/${id}/status`, { data: { status: 'approved' } });

    const stakeholders = await request.get(`/api/engagements/${engagementId}/stakeholders`);
    const signer = (await stakeholders.json()).items[0];
    expect(signer?.id).toBeTruthy();

    const share = await request.post(`/api/deliverables/${id}/shares`, {
      data: { shared_to: signer.id, channel: 'email', expires_in_days: 7 },
    });
    expect(share.status()).toBe(201);
    const shareBody = await share.json();
    const token = shareBody.item.token;
    const shareId = shareBody.item.id;
    expect(token).toBeTruthy();

    await page.goto(`/#/share/${token}`);
    await expect(page.getByText('交付云 · 只读分享')).toBeVisible();
    await expect(page.getByRole('button', { name: '下载 Word' })).toBeVisible();
    await expect(page.getByRole('button', { name: '下载 PDF' })).toBeVisible();
    await expect(page.locator('input[type="email"]')).toHaveCount(0);

    const views = await request.get(`/api/shares/${shareId}/views`);
    expect(views.status()).toBe(200);
    const viewBody = await views.json();
    expect(viewBody.summary.views).toBeGreaterThanOrEqual(1);
    expect(viewBody.items[0].ip).toBeTruthy();
  });

  test('登录会话页可查看并标识当前会话', async ({ page, request }) => {
    const login = await request.post('/api/auth/login', {
      data: { email: 'admin@hengzhi.ai', password: 'demo1234' },
    });
    expect(login.status()).toBe(200);
    const { token, user } = await login.json();
    await page.addInitScript(
      ({ token, user }) => {
        localStorage.setItem('ai-delivery-token', token);
        localStorage.setItem('ai-delivery-user', user);
      },
      { token, user: JSON.stringify(user) },
    );

    await page.goto('/#/sessions');
    await expect(page.getByRole('heading', { name: '登录会话' })).toBeVisible();
    await expect(page.getByText('当前会话').first()).toBeVisible();
    await expect(page.getByRole('button', { name: '全部退出' })).toBeVisible();
    await expect(page.getByRole('button', { name: '修改密码' })).toBeVisible();
  });

  test('管理员可打开用户管理页', async ({ page, request }) => {
    const login = await request.post('/api/auth/login', {
      data: { email: 'admin@hengzhi.ai', password: 'demo1234' },
    });
    const { token, user } = await login.json();
    await page.addInitScript(
      ({ token, user }) => {
        localStorage.setItem('ai-delivery-token', token);
        localStorage.setItem('ai-delivery-user', user);
      },
      { token, user: JSON.stringify(user) },
    );

    await page.goto('/#/users');
    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();
    await expect(page.getByRole('button', { name: /新建用户/ })).toBeVisible();
    await expect(page.getByRole('table').getByText('系统管理员')).toBeVisible();
  });

  test('审计日志可访问并展示请求 ID 列', async ({ page, request }) => {
    await ensureLoggedIn(page);
    // 先制造一条可审计的写操作（校验失败的 400 也会留痕）
    await request.post('/api/benchmarks', { data: {} });
    await page.goto('/#/audit');
    await page.getByRole('button', { name: '刷新' }).click();
    await expect(page.getByRole('heading', { name: '审计日志' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '请求 ID' })).toBeVisible();
  });
});
