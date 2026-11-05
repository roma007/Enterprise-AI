# 会客包 / 报告导出

> 由同目录上一级的 Markdown / HTML 源文件导出；源文件可继续编辑后重新导出。

| 文件 | 来源 | 页数 | 用途 |
| --- | --- | --- | --- |
| `15_本轮能力说明_管理层版.pdf` | `../15_本轮能力说明_管理层版.md` | 3 | 客户管理层阅读版 |
| `16_本轮能力一页纸.pdf` | `../16_本轮能力一页纸.html` | 1 | 单页摘要，可直接发送 |
| `本轮能力说明_合并版.pdf` | 封面 + 15 + 16 | 5 | 对外发送的合并版 |
| `客户老板版_系统能力介绍_2026-11-05.pptx` | `make_capability_ppt.py` + `ppt_assets/` | 14 | 给客户老板讲价值、能力、表现、路径、参与人员、分阶段配合与风控（不含开发进度） |
| `客户老板版_讲稿.md` | 与 PPT 对应的逐页文字稿 | 14 节 | 改文字/讲稿可直接编辑 |

> **可编辑性**：`客户老板版_系统能力介绍_2026-11-05.pptx` 是原生 PowerPoint 文件，文字、表格、流程图均为可编辑对象；只有第 4–6 页的 3 张系统界面截图是图片，其余内容都可以直接在 PowerPoint 里改。

## 重新导出

用系统中的 Edge 作为无头浏览器（本机无 Playwright Chromium 时）：

```js
const { chromium } = require('<frontend>/node_modules/playwright');
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
await page.goto('file:///<绝对路径>/16_本轮能力一页纸.html');
await page.pdf({ path: '...pdf', printBackground: true, preferCSSPageSize: true });
await browser.close();
```

Markdown 先转 HTML：

```bash
pandoc ../15_本轮能力说明_管理层版.md -f gfm -t html5 -o /tmp/15-body.html
```

合并 PDF 需要 `pypdf`：

```python
from pypdf import PdfWriter, PdfReader
w = PdfWriter()
for f in ['cover.pdf', '15.pdf', '16.pdf']:
    for p in PdfReader(f).pages:
        w.add_page(p)
w.write('本轮能力说明_合并版.pdf')
```


## 老板版 PPT

```bash
ai-copilot/.venv/bin/python 会客包/reports/make_capability_ppt.py
```

依赖 `python-pptx`；图表 PNG 由 `ppt_assets/*.html` 通过 Edge/Playwright 截图生成。

演示数据生成见根目录 [`DEMO_DATA.md`](../DEMO_DATA.md)。
