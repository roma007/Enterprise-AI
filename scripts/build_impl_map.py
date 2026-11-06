#!/usr/bin/env python3
"""把《实施全景图.md》生成可离线打开的 HTML。

单一事实源是 Markdown；HTML 只是渲染产物，不要手改。
用法：
    python3 scripts/build_impl_map.py
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MD_PATH = ROOT / "实施全景图.md"
HTML_PATH = ROOT / "实施全景图.html"


def count_status(md: str) -> dict:
    """只统计表格里的状态列和列表项复选框，避免把说明文字里的示例算进去。"""
    done = todo = 0
    for line in md.splitlines():
        if line.lstrip().startswith("|"):
            if re.search(r"\|\s*\[x\]\s*\|", line, flags=re.IGNORECASE):
                done += 1
            elif re.search(r"\|\s*\[ \]\s*\|", line):
                todo += 1
        elif re.match(r"^\s*-\s*\[x\]", line, flags=re.IGNORECASE):
            done += 1
        elif re.match(r"^\s*-\s*\[ \]", line):
            todo += 1
    total = done + todo
    return {
        "done": done,
        "todo": todo,
        "total": total,
        "percent": round(done * 100 / total, 1) if total else 0.0,
        "partial": md.count("🟡"),
        "blocked": md.count("⛔"),
    }


def build() -> Path:
    if not MD_PATH.exists():
        raise SystemExit(f"找不到 {MD_PATH}")
    md = MD_PATH.read_text(encoding="utf-8")
    stats = count_status(md)
    title = "Enterprise AI 实施全景图"
    first = re.search(r"^#\s+(.+)$", md, flags=re.MULTILINE)
    if first:
        title = first.group(1).strip()

    def pick(pattern: str, default: str) -> str:
        m = re.search(pattern, md)
        return m.group(1).strip() if m else default

    version = pick(r"\*\*版本\*\*：([^｜\n]+)", "v1.0")
    updated = pick(r"\*\*更新\*\*：([^｜\n]+)", "2026-11-07")
    baseline = pick(r"\*\*基线\*\*：`([^`]+)`", "c3b37ac")

    payload = json.dumps(md, ensure_ascii=False)
    generated = datetime.now().strftime("%Y-%m-%d %H:%M")
    stat_json = json.dumps(stats, ensure_ascii=False)

    html = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{
    color-scheme: light;
    --bg: #f4f6f9; --card: #fff; --ink: #16202a; --muted: #5b6b7c;
    --line: #dbe2ea; --brand: #1f4e79; --ok: #2f855a; --warn: #b7791f; --bad: #c53030;
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: var(--bg); color: var(--ink);
         font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         line-height: 1.7; }}
  header {{ position: sticky; top: 0; z-index: 20; background: rgba(255,255,255,.96);
            backdrop-filter: blur(10px); border-bottom: 1px solid var(--line);
            padding: 14px 26px; }}
  header h1 {{ font-size: 19px; margin: 0 0 4px; }}
  header .meta {{ color: var(--muted); font-size: 12px; }}
  .progress {{ display: flex; align-items: center; gap: 12px; margin-top: 10px; flex-wrap: wrap; }}
  .bar {{ flex: 1 1 280px; height: 10px; background: #e8eef5; border-radius: 999px; overflow: hidden; }}
  .bar > i {{ display: block; height: 100%; background: linear-gradient(90deg,#2f855a,#48bb78);
              width: {stats['percent']}%; }}
  .pill {{ font-size: 12px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line);
           background: #fff; color: var(--muted); white-space: nowrap; }}
  .pill b {{ color: var(--ink); }}
  .toolbar {{ display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }}
  .toolbar button {{ border: 1px solid var(--line); background: #fff; color: var(--ink);
                     font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 8px;
                     cursor: pointer; }}
  .toolbar button.on {{ background: var(--brand); border-color: var(--brand); color: #fff; }}
  .layout {{ max-width: 1500px; margin: 0 auto; padding: 22px 26px 80px; display: grid;
             grid-template-columns: minmax(0, 1fr) 250px; gap: 22px; align-items: start; }}
  main {{ background: var(--card); border: 1px solid var(--line); border-radius: 14px;
          padding: 26px 32px; box-shadow: 0 1px 3px rgba(16,24,40,.05); min-width: 0; }}
  nav.toc {{ position: sticky; top: 150px; background: var(--card); border: 1px solid var(--line);
             border-radius: 12px; padding: 14px 16px; font-size: 12px; max-height: calc(100vh - 180px);
             overflow: auto; }}
  nav.toc h3 {{ font-size: 12px; margin: 0 0 8px; color: var(--muted); letter-spacing: .04em; }}
  nav.toc a {{ display: block; color: var(--ink); text-decoration: none; padding: 3px 0;
               border-left: 2px solid transparent; padding-left: 8px; }}
  nav.toc a.lv3 {{ padding-left: 20px; color: var(--muted); }}
  nav.toc a:hover {{ border-left-color: var(--brand); color: var(--brand); }}
  h1, h2, h3, h4 {{ line-height: 1.35; }}
  h1 {{ font-size: 26px; margin: 0 0 14px; }}
  h2 {{ font-size: 19px; margin: 34px 0 10px; padding-top: 8px; border-top: 1px solid var(--line); }}
  h3 {{ font-size: 15px; margin: 24px 0 8px; }}
  p, li, td, th {{ font-size: 13.5px; }}
  blockquote {{ margin: 14px 0; padding: 10px 16px; background: #f7fafc;
                border-left: 4px solid var(--brand); color: #334155; }}
  blockquote p {{ margin: 4px 0; }}
  table {{ width: max-content; min-width: 100%; border-collapse: collapse; margin: 12px 0 18px; display: block; overflow-x: auto; }}
  th, td {{ border: 1px solid var(--line); padding: 7px 9px; text-align: left; vertical-align: top; }}
  th {{ background: #f1f5f9; font-weight: 600; white-space: nowrap; }}
  tr:nth-child(even) td {{ background: #fbfdff; }}
  code {{ background: #eef2f7; padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }}
  pre {{ background: #0f172a; color: #e2e8f0; padding: 14px 16px; border-radius: 10px; overflow: auto; }}
  pre code {{ background: none; color: inherit; padding: 0; }}
  .mermaid {{ background: #fff; border: 1px solid var(--line); border-radius: 10px;
              padding: 12px; margin: 14px 0; overflow: auto; text-align: center; }}
  input[type=checkbox] {{ width: 14px; height: 14px; accent-color: var(--ok); }}
  tr.done-row td {{ color: #64748b; }}
  tr.todo-row td {{ background: #fffdf5; }}
  tr.blocked-row td {{ background: #fff5f5; }}
  .hide-done tr.done-row {{ display: none; }}
  .hide-done li.done-row {{ display: none; }}
  .only-todo tr.done-row {{ display: none; }}
  .only-todo li.done-row {{ display: none; }}
  .only-done table.checklist tr:not(.done-row):not(.header-row) {{ display: none; }}
  .only-done li.todo-row {{ display: none; }}
  .gen {{ color: var(--muted); font-size: 11px; margin-top: 8px; }}
  .error {{ color: var(--bad); font-weight: 600; }}
  @media screen {{ main > h1:first-of-type {{ display: none; }} }}
  @media (max-width: 980px) {{
    .layout {{ grid-template-columns: 1fr; }}
    nav.toc {{ position: static; max-height: 220px; order: -1; }}
  }}
  @media print {{
    header, nav.toc, .toolbar {{ display: none; }}
    .layout {{ display: block; padding: 0; }}
    main {{ border: 0; box-shadow: none; padding: 0; }}
    table {{ display: table; overflow: visible; }}
    tr {{ break-inside: avoid; }}
    .mermaid {{ break-inside: avoid; }}
  }}
</style>
</head>
<body>
<header>
  <h1>{title}</h1>
  <div class="meta">版本 {version} ｜ 更新 {updated} ｜ 基线 <code>{baseline}</code> ｜ 本页由 Markdown 自动生成，请编辑 <code>实施全景图.md</code></div>
  <div class="progress">
    <div class="bar"><i></i></div>
    <span class="pill">完成 <b>{stats['done']}</b> / {stats['total']}（{stats['percent']}%）</span>
    <span class="pill">未完成 <b>{stats['todo']}</b></span>
    <span class="pill">图中 🟡 <b>{stats['partial']}</b></span>
    <span class="pill">图中 ⛔ <b>{stats['blocked']}</b></span>
  </div>
  <div class="toolbar">
    <button data-filter="all" class="on">全部</button>
    <button data-filter="only-todo">只看未完成</button>
    <button data-filter="only-done">只看已完成</button>
    <button id="btnPrint">打印 / 存 PDF</button>
  </div>
  <div class="gen">生成时间：{generated}</div>
</header>

<div class="layout">
  <main id="content"></main>
  <nav class="toc"><h3>目录</h3><div id="toc"></div></nav>
</div>

<script type="text/markdown" id="md">{payload}</script>
<script src="frontend/node_modules/marked/lib/marked.umd.js"></script>
<script src="frontend/node_modules/mermaid/dist/mermaid.min.js"></script>
<script>
(function () {{
  const STATS = {stat_json};

  function loadScript(src) {{
    return new Promise((resolve, reject) => {{
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    }});
  }}

  async function ensureLibs() {{
    if (!window.marked) {{
      await loadScript('https://cdn.jsdelivr.net/npm/marked@16/lib/marked.umd.js');
    }}
    if (!window.mermaid) {{
      await loadScript('https://cdn.jsdelivr.net/npm/mermaid@12/dist/mermaid.min.js');
    }}
  }}

  function buildToc(root) {{
    const toc = document.getElementById('toc');
    const nodes = root.querySelectorAll('h2, h3');
    let i = 0;
    nodes.forEach((h) => {{
      i += 1;
      if (!h.id) h.id = 'sec-' + i;
      const a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      a.className = h.tagName === 'H3' ? 'lv3' : '';
      toc.appendChild(a);
    }});
  }}

  function markRows(root) {{
    // 表格里的 `[x]` / `[ ]` 不是列表任务项，marked 不会渲染成复选框；
    // 这里把状态列转成真正的复选框，才能做“只看未完成/已完成”筛选。
    root.querySelectorAll('td').forEach((td) => {{
      const t = (td.textContent || '').trim();
      if (t === '[x]' || t === '[X]') {{
        td.innerHTML = '<input type="checkbox" checked disabled aria-label="已完成">';
      }} else if (t === '[ ]') {{
        td.innerHTML = '<input type="checkbox" disabled aria-label="未完成">';
      }}
    }});

    root.querySelectorAll('table').forEach((table) => {{
      if (table.querySelector('input[type=checkbox]')) table.classList.add('checklist');
    }});
    root.querySelectorAll('tr').forEach((tr) => {{
      if (tr.querySelector('th')) tr.classList.add('header-row');
      const cb = tr.querySelector('input[type=checkbox]');
      if (!cb) return;
      tr.classList.add(cb.checked ? 'done-row' : 'todo-row');
      if (/⛔/.test(tr.textContent || '')) tr.classList.add('blocked-row');
    }});
    root.querySelectorAll('li').forEach((li) => {{
      const cb = li.querySelector('input[type=checkbox]');
      if (!cb) return;
      li.classList.add(cb.checked ? 'done-row' : 'todo-row');
    }});
  }}

  function applyFilter(mode) {{
    const content = document.getElementById('content');
    content.classList.remove('only-todo', 'only-done');
    if (mode === 'only-todo') content.classList.add('only-todo');
    if (mode === 'only-done') content.classList.add('only-done');
    document.querySelectorAll('.toolbar button[data-filter]').forEach((b) => {{
      b.classList.toggle('on', b.dataset.filter === mode);
    }});
  }}

  async function init() {{
    try {{
      await ensureLibs();
    }} catch (e) {{
      document.getElementById('content').innerHTML =
        '<p class="error">缺少 marked / mermaid，且 CDN 加载失败。请在有网络时打开，或在仓库根目录安装前端依赖后重试。</p>';
      return;
    }}

    marked.setOptions({{ gfm: true, breaks: false }});
    const md = JSON.parse(document.getElementById('md').textContent);
    const content = document.getElementById('content');
    content.innerHTML = marked.parse(md);

    content.querySelectorAll('pre code.language-mermaid').forEach((code) => {{
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = code.textContent;
      code.parentElement.replaceWith(div);
    }});

    buildToc(content);
    markRows(content);

    document.querySelectorAll('.toolbar button[data-filter]').forEach((b) => {{
      b.onclick = () => applyFilter(b.dataset.filter);
    }});
    document.getElementById('btnPrint').onclick = () => window.print();

    mermaid.initialize({{
      startOnLoad: false,
      securityLevel: 'loose',
      theme: 'base',
      themeVariables: {{
        fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
        fontSize: '14px'
      }},
      flowchart: {{ useMaxWidth: true, htmlLabels: true, nodeSpacing: 40, rankSpacing: 45, wrappingWidth: 280 }}
    }});
    try {{
      await mermaid.run({{ querySelector: '.mermaid' }});
    }} catch (e) {{
      console.warn('Mermaid 渲染失败', e);
    }}
  }}

  init();
}})();
</script>
</body>
</html>
"""
    HTML_PATH.write_text(html, encoding="utf-8")
    return HTML_PATH


if __name__ == "__main__":
    path = build()
    md = MD_PATH.read_text(encoding="utf-8")
    s = count_status(md)
    print(f"生成 {path}")
    print(f"完成 {s['done']} / {s['total']}（{s['percent']}%）；未完成 {s['todo']}；外部/阻塞标记 🟡 {s['partial']} / ⛔ {s['blocked']}")
    sys.exit(0)
