# 会客包 / 报告导出

> 由同目录上一级的 Markdown / HTML 源文件导出；源文件可继续编辑后重新导出。

| 文件 | 来源 | 页数 | 用途 |
| --- | --- | --- | --- |
| `15_本轮能力说明_管理层版.pdf` | `../15_本轮能力说明_管理层版.md` | 3 | 客户管理层阅读版 |
| `16_本轮能力一页纸.pdf` | `../16_本轮能力一页纸.html` | 1 | 单页摘要，可直接发送 |
| `本轮能力说明_合并版.pdf` | 封面 + 15 + 16 | 5 | 对外发送的合并版 |
| `客户老板版_系统能力介绍_2026-11-05.pptx` | `make_capability_ppt.py` + `ppt_assets/` | 13 | 给客户老板讲价值、能力、表现、路径、参与人员、分阶段配合与风控（不含开发进度） |
| `客户老板版_讲稿.md` | 与 PPT 对应的逐页文字稿 | 13 节 | 改文字/讲稿可直接编辑 |

> **2026-11-07 修订**：删除原第 6 页「从数据到结论（经营洞察）」。该页用的是诊断平台 S5 截图（供应商内部工具，客户不登录），且含报价与续约风险等内部信息；删除后页数 14 → 13，后续页码与讲稿同步顺延。同一轮校正第 5 页文案：「把差异分到动作」→「分到处理决定」，「有负责人」→「有处理记录」；演示数据改为 8 条一致、2 条金额不符、1 条系统无此单、1 条客户漏单。
>
> **可编辑性**：`客户老板版_系统能力介绍_2026-11-05.pptx` 是原生 PowerPoint 文件，文字、表格、流程图均为可编辑对象；只有第 4–5 页的 2 张界面截图是图片（第 4 页为企业微信对话，第 5 页为对账界面），其余内容都可以直接在 PowerPoint 里改。
>
> 第 4 页企微对话截图源文件为 `ppt_assets/wecom-chat-demo.png`：截自本机企业微信真实对话，内容为【合成演示】数据，已裁掉左侧联系人列表。

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
