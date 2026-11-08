import { chromium } from '/Users/mengfeng/我的文档/源码/Enterprise AI/frontend/node_modules/playwright/index.mjs';
import path from 'path';

const BASE = 'http://127.0.0.1:8790';
const OUT = '/Users/mengfeng/我的文档/源码/Enterprise AI/会客包/reports/ppt_assets';

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  const email = page.locator('input[type=email], #email').first();
  const pass = page.locator('input[type=password], #password').first();
  await email.fill('admin@local');
  await pass.fill('admin12345x');
  await page.locator('form').first().evaluate(f => f.requestSubmit());
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });
}

async function shot(page, url, action, name, wait = 1400) {
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  if (action) {
    try { await page.locator(action).click({ timeout: 3000 }); } catch (_) {}
  }
  await page.waitForTimeout(wait);
  await page.screenshot({ path: path.join(OUT, name), fullPage: false });
  console.log('shot', name);
}

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await login(page);

await shot(page, '/track', '#btnDemo', 'ai-track.png');
await shot(page, '/dispatch', '#btnRun', 'ai-dispatch.png', 2000);
await shot(page, '/forecast', '#btnRun', 'ai-forecast.png', 1800);
await shot(page, '/customs', '#btnDemo', 'ai-customs.png');

await browser.close();
