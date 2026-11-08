// 抓 /track /dispatch /profit 三张界面图，给客户版 PPT 第 12 页用。
// 输出 1600×900（与已有 ai-*.png 一致）。
//
// 用法：
//   node 会客包/reports/capture_ops.mjs [base_url]
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
if (!PASSWORD) {
  console.error('缺少 ADMIN_PASSWORD：请设置环境变量，或在 ai-copilot/.env 里配置');
  process.exit(1);
}

const PPT = path.join(here, 'ppt_assets');
const shots = [
  {
    name: '客户查询',
    url: '/track',
    out: path.join(PPT, 'ai-track.png'),
    async prep(page) {
      await page.click('#btnDemo');
      await page.waitForSelector('#out', { state: 'visible' });
      await page.waitForFunction(() => document.querySelector('#answer')?.textContent?.trim());
      await page.evaluate(() => window.scrollTo(0, 0));
    },
  },
  {
    name: '调度优化',
    url: '/dispatch',
    out: path.join(PPT, 'ai-dispatch.png'),
    async prep(page) {
      await page.waitForSelector('#out', { state: 'visible' });
      await page.waitForFunction(() => document.querySelectorAll('#assign tr').length > 2);
      await page.evaluate(() => window.scrollTo(0, 0));
    },
  },
  {
    name: '盈利分析',
    url: '/profit',
    out: path.join(PPT, 'ai-profit.png'),
    async prep(page) {
      await page.waitForSelector('#out', { state: 'visible' });
      await page.waitForFunction(() => document.querySelectorAll('#customers tr').length > 2);
      await page.evaluate(() => window.scrollTo(0, 0));
    },
  },
];

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge' });
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
  });
  const login = await context.request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!login.ok()) throw new Error(`登录失败：HTTP ${login.status()} ${await login.text()}`);

  for (const shot of shots) {
    const page = await context.newPage();
    await page.goto(`${BASE}${shot.url}`, { waitUntil: 'domcontentloaded' });
    await shot.prep(page);
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    );
    fs.mkdirSync(path.dirname(shot.out), { recursive: true });
    await page.screenshot({ path: shot.out, type: 'png' });
    console.log(`saved ${shot.out}`);
    console.log(`  ↑ ${shot.name}`);
    await page.close();
  }
} finally {
  await browser.close();
}
