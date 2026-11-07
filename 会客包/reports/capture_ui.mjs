// 抓 ai-copilot 界面截图，给 PPT / 培训材料用。
// 输出固定 2880×1800（1440×900 视口 @2x），与已有界面图一致。
//
// 用法：
//   node 会客包/reports/capture_ui.mjs                 # 默认 http://127.0.0.1:8790
//   node 会客包/reports/capture_ui.mjs http://host:8790
//
// 账号密码从 ai-copilot/.env 的 ADMIN_EMAIL / ADMIN_PASSWORD 读取，也可用同名环境变量覆盖。
// 浏览器默认用系统已装的 Edge（PW_CHANNEL=msedge），没装就传 PW_CHANNEL=chrome。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../frontend/package.json'));
const { chromium } = require('playwright');

function readEnv() {
  const file = path.join(here, '../../ai-copilot/.env');
  const out = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

const BASE = (process.argv[2] || 'http://127.0.0.1:8790').replace(/\/+$/, '');
const env = readEnv();
const EMAIL = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL || 'admin@local';
const PASSWORD = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD || '';

const ASSETS = path.join(here, '../assets');
const PPT = path.join(here, 'ppt_assets');

const shots = [
  {
    name: '托书录入',
    url: '/',
    out: [path.join(ASSETS, 'ui-index.png')],
    async prep(page) {
      // 用内置样例 + 规则引擎（关掉模型增强），截图稳定且不依赖模型配置
      await page.uncheck('#useLlm');
      await page.click('.chip:has-text("标准格式 · 单箱")');
      await page.waitForSelector('#fields .frow');
      await page.waitForFunction(() => document.querySelector('#btnParse').textContent === '解析');
      await page.evaluate(() => window.scrollTo(0, 0));
    },
  },
  {
    name: '自动对账',
    url: '/reconcile',
    out: [
      path.join(ASSETS, 'ui-reconcile.png'),
      path.join(PPT, 'ui-copilot-reconcile.png'), // PPT 第 5 页
    ],
    async prep(page) {
      await page.addStyleTag({ content: '#toast{display:none !important}' });
      await page.click('#btnDemo');
      await page.waitForSelector('#result', { state: 'visible' });
      await page.waitForFunction(() => document.querySelectorAll('#rows tr').length >= 10);
      // 压低输入框，让「输入 → 结果」在一屏内都看得到，避免表格被截断
      await page.addStyleTag({
        content: '#stmt{height:92px !important;min-height:92px !important}',
      });
      await page.evaluate(() => window.scrollTo(0, 0));
    },
  },
  {
    name: '账龄催收',
    url: '/aging',
    out: [path.join(ASSETS, 'ui-aging.png')],
    async prep(page) {
      await page.addStyleTag({ content: '#toast{display:none !important}' });
      await page.click('#btnDemo');
      await page.waitForSelector('#out', { state: 'visible' });
      await page.waitForFunction(() => document.querySelectorAll('#clients tr').length > 1);
      // 输入框压低，让总览和客户表都进画面
      await page.addStyleTag({
        content: '#rows{height:66px !important;min-height:66px !important}',
      });
      await page.evaluate(() => window.scrollTo(0, 0));
    },
  },
];

if (!PASSWORD) {
  console.error('缺少 ADMIN_PASSWORD：请设置环境变量，或在 ai-copilot/.env 里配置');
  process.exit(1);
}

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge' });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });

  const login = await context.request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!login.ok()) throw new Error(`登录失败：HTTP ${login.status()} ${await login.text()}`);

  for (const shot of shots) {
    const page = await context.newPage();
    await page.goto(`${BASE}${shot.url}`, { waitUntil: 'domcontentloaded' });
    await shot.prep(page);
    // 等两帧，确保滚动/样式生效
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    );
    for (const out of shot.out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await page.screenshot({ path: out, type: 'png' });
      console.log(`saved ${out}`);
    }
    console.log(`  ↑ ${shot.name}`);
    await page.close();
  }
} finally {
  await browser.close();
}
