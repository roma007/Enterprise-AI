// 抓 ai-copilot 界面截图给 PPT / 培训材料用。
// 输出固定 2880×1800（1440×900 视口 @2x），与 ppt_assets 里其它界面图一致。
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
const OUT = path.join(here, 'ppt_assets/ui-copilot-reconcile.png');

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

  const page = await context.newPage();
  await page.goto(`${BASE}/reconcile`, { waitUntil: 'domcontentloaded' });
  // 截图里不要演示提示条
  await page.addStyleTag({ content: '#toast{display:none !important}' });
  await page.click('#btnDemo');
  await page.waitForSelector('#result', { state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('#rows tr').length >= 10);

  // 截图时把输入框压低，让「输入 → 结果」在一屏内都看得到，避免表格被截断
  await page.addStyleTag({
    content: '#stmt{height:92px !important;min-height:92px !important}',
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  );

  await page.screenshot({ path: OUT, type: 'png' });
  console.log(`saved ${OUT}`);
} finally {
  await browser.close();
}
