import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { httpError } from './s1';

function firstExisting(paths: string[]): string | null {
  return paths.find((p) => p && existsSync(p)) ?? null;
}

function playwrightCandidates(): string[] {
  const roots = [
    join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? '',
  ].filter(Boolean);
  const out: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (!dir.startsWith('chromium-')) continue;
      const base = join(root, dir);
      out.push(
        join(base, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        join(base, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
        join(base, 'chrome-linux/chrome'),
        join(base, 'chrome-win/chrome.exe'),
      );
    }
  }
  return out;
}

/** 查找可用的无头 Chromium：环境变量 > 系统安装 > Playwright 缓存。 */
export function findPdfBrowser(): string | null {
  const fromEnv = (process.env.PDF_CHROME_PATH ?? '').trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;

  const system =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ];

  return firstExisting([...system, ...playwrightCandidates()]);
}

function renderWithBrowser(
  browser: string,
  htmlPath: string,
  pdfPath: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--no-pdf-header-footer',
        '--virtual-time-budget=3000',
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(htmlPath).href,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk).slice(0, 2000);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`PDF 渲染超时（${timeoutMs}ms）`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(pdfPath)) {
        resolve();
        return;
      }
      reject(new Error(`Chromium 退出码 ${code}：${stderr.slice(0, 500)}`));
    });
  });
}

/** 把打印版 HTML 渲染成 PDF；没有可用浏览器时抛 503。 */
export async function htmlToPdf(html: string, timeoutMs = 30_000): Promise<Buffer> {
  const browser = findPdfBrowser();
  if (!browser) {
    throw httpError(
      503,
      'PDF_ENGINE_UNAVAILABLE',
      '当前环境没有可用的 Chromium；请安装 Chrome 或设置 PDF_CHROME_PATH',
    );
  }

  const dir = await mkdtemp(join(tmpdir(), 'ai-delivery-pdf-'));
  const htmlPath = join(dir, 'document.html');
  const pdfPath = join(dir, 'document.pdf');
  try {
    await writeFile(htmlPath, html, 'utf8');
    await renderWithBrowser(browser, htmlPath, pdfPath, timeoutMs);
    return await readFile(pdfPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
