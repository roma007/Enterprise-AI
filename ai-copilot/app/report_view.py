"""把 report_md() 生成的 Markdown 渲染成一页可读的运行月报。

输出结构是我们自己固定的（标题 / 表格 / 引用 / 列表 / 粗体），
不引入 Markdown 依赖，避免为了一个报告页增加部署成本。
所有文本先做 HTML 转义，再加最小样式。
"""
from __future__ import annotations

import html
import re

_H = re.compile(r"^(#{1,4})\s+(.*)$")
_UL = re.compile(r"^[-*]\s+(.*)$")
_TABLE_SEP = re.compile(r"^\|?[\s:|-]+\|?$")


def _inline(text: str) -> str:
    t = html.escape(text, quote=False)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    return t


def _cells(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def _table(rows: list[str]) -> str:
    out = ["<table>"]
    header_done = False
    for idx, row in enumerate(rows):
        if _TABLE_SEP.match(row.strip()) and "-" in row:
            continue
        cells = _cells(row)
        if not header_done:
            out.append("<thead><tr>" + "".join(f"<th>{_inline(c)}</th>" for c in cells) + "</tr></thead><tbody>")
            header_done = True
        else:
            out.append("<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in cells) + "</tr>")
    if header_done:
        out.append("</tbody>")
    out.append("</table>")
    return "".join(out)


def _is_block(line: str) -> bool:
    s = line.strip()
    return bool(
        _H.match(s)
        or s.startswith(">")
        or s.startswith("|")
        or _UL.match(s)
        or s in {"---", "***"}
    )


def md_to_html(md: str) -> str:
    lines = md.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        raw = lines[i].rstrip()
        s = raw.strip()
        if not s:
            i += 1
            continue

        m = _H.match(s)
        if m:
            level = len(m.group(1))
            out.append(f"<h{level}>{_inline(m.group(2))}</h{level}>")
            i += 1
            continue

        if s in {"---", "***"}:
            out.append("<hr />")
            i += 1
            continue

        if s.startswith(">"):
            buf = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip().lstrip(">").strip())
                i += 1
            out.append("<blockquote>" + "<br />".join(_inline(x) for x in buf) + "</blockquote>")
            continue

        if s.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i].strip())
                i += 1
            out.append(_table(rows))
            continue

        um = _UL.match(s)
        if um:
            items = []
            while i < len(lines) and _UL.match(lines[i].strip()):
                items.append(_UL.match(lines[i].strip()).group(1))
                i += 1
            out.append("<ul>" + "".join(f"<li>{_inline(x)}</li>" for x in items) + "</ul>")
            continue

        buf = [s]
        i += 1
        while i < len(lines) and lines[i].strip() and not _is_block(lines[i]):
            buf.append(lines[i].strip())
            i += 1
        out.append(f"<p>{_inline(' '.join(buf))}</p>")

    return "\n".join(out)


_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>智单 · 运行月报</title>
<link rel="stylesheet" href="/static/nav.css?v=20261107d" />
<script src="/static/nav.js?v=20261107d" defer></script>
<style>
  :root{{--bg:#f5f6f8;--panel:#fff;--line:#e3e6ea;--ink:#1b2430;--muted:#6b7684;--brand:#1f4e79}}
  *{{box-sizing:border-box}}
  body{{margin:0;background:var(--bg);color:var(--ink);
       font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}}
  header{{background:var(--panel);border-bottom:1px solid var(--line);padding:10px 20px;
          display:flex;gap:12px;align-items:center}}
  header h1{{font-size:15px;margin:0}}
  header .sub{{color:var(--muted);font-size:12px}}
  .btn{{font:inherit;font-size:12.5px;padding:6px 12px;border-radius:7px;border:1px solid var(--line);
        background:#fff;color:var(--ink);text-decoration:none;cursor:pointer}}
  .btn:hover{{border-color:var(--brand);color:var(--brand)}}
  .wrap{{max-width:980px;margin:0 auto;padding:16px}}
  .card{{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:22px 28px}}
  .report h1{{font-size:22px;margin:0 0 6px}}
  .report h2{{font-size:16px;margin:26px 0 10px;padding-bottom:6px;border-bottom:1px solid #eef0f3}}
  .report table{{width:100%;border-collapse:collapse;font-size:13.5px;margin:8px 0 4px}}
  .report th,.report td{{border-bottom:1px solid #eef0f3;padding:8px 10px;text-align:left;vertical-align:top}}
  .report th{{background:#fafbfc;color:var(--muted);font-weight:600}}
  .report blockquote{{margin:10px 0;padding:8px 12px;background:#f7f9fb;border-left:3px solid var(--brand);
                      color:#48586a;font-size:13px}}
  .report p{{margin:10px 0}}
  .report ul{{margin:8px 0 8px 20px}}
  .report code{{background:#f1f3f6;padding:1px 5px;border-radius:4px;font-size:12.5px}}
  @media (max-width:900px){{ .card{{padding:16px}} }}
  @media print{{
    body{{background:#fff}} .card{{border:0;padding:0}} .btn{{display:none}}
  }}
</style>
</head>
<body class="app-shell">
<header>
  <h1>运行月报</h1>
  <span class="sub">按当前数据库实时生成；口径见文末</span>
  <span style="flex:1"></span>
  <a class="btn" href="/api/report.md">下载 Markdown</a>
  <button class="btn" type="button" onclick="window.print()">打印</button>
</header>
<div class="wrap">
  <article class="card report">
{body}
  </article>
</div>
</body>
</html>
"""


def render_page(markdown_text: str) -> str:
    return _PAGE.format(body=md_to_html(markdown_text))
