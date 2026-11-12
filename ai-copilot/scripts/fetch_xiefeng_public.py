"""抓取协丰物流的公开网页资料，生成 `data/xiefeng_public.json`。

用途：会前研究，不对外发送；只抓公开页面，不登录、不绕过权限。
运行时页面不联网：优先读本脚本生成的缓存，离线时回退 `samples/xiefeng_public.json`。
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "data" / "xiefeng_public.json"

SOURCES = [
    {"name": "界面新闻：水上春运", "url": "https://www.jiemian.com/article/2829159.html"},
    {"name": "腾讯新闻：顺德新港—香港水泥罐船航线", "url": "https://news.qq.com/rain/a/20231116A0ALCK00"},
    {"name": "淘美国际物流企业页", "url": "https://www.taomeixh.com/qiye/qiye/63072.html"},
    {"name": "顺德区跨境货运代理协会", "url": "http://www.sdiffa.net/wap/shownews.asp?id=21"},
    {"name": "北滘青企协会", "url": "http://yeabj.com/col.jsp?id=107"},
]

KEYWORDS = [
    "协丰", "集装箱", "拼货箱", "散货", "北滘港", "顺德新港", "水泥罐船",
    "湾区一港通", "组合港", "水水中转", "顺德新港—香港水泥罐船",
    "报关", "报检", "仓储", "装卸", "国际货物运输代理", "普通货运", "汽车租赁",
]
PORTS = ["北滘港", "顺德新港", "盐田港", "蛇口港", "南沙港"]
ROUTES = ["湾区一港通", "组合港", "水水中转", "顺德新港—香港水泥罐船"]

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " \
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.description = ""
        self._in_title = False
        self._skip = 0
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            attrs_d = {k.lower(): (v or "") for k, v in attrs}
            if attrs_d.get("name", "").lower() == "description":
                self.description = attrs_d.get("content", "")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "svg"} and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        text = data.strip()
        if not text:
            return
        if self._in_title:
            self.title += text
        else:
            self._parts.append(text)

    @property
    def text(self) -> str:
        return _norm(" ".join(self._parts))


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(text or "")).strip()


def _decode(content: bytes) -> str:
    for encoding in ("utf-8", "gb18030"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="ignore")


def _fetch(source: dict) -> dict:
    item = {
        "name": source["name"],
        "url": source["url"],
        "ok": False,
        "status": 0,
        "title": "",
        "description": "",
        "signals": [],
        "excerpt": "",
        "error": "",
    }
    try:
        with httpx.Client(follow_redirects=True, timeout=25,
                          headers={"User-Agent": _UA}) as client:
            resp = client.get(source["url"])
        item["status"] = resp.status_code
        if resp.status_code != 200:
            item["error"] = f"HTTP {resp.status_code}"
            return item
        parser = _Text()
        parser.feed(_decode(resp.content))
        text = parser.text
        item["title"] = _norm(parser.title)
        item["description"] = _norm(parser.description)
        haystack = f"{item['title']} {item['description']} {text}"
        item["signals"] = [word for word in KEYWORDS if word in haystack]
        pos = text.find("协丰")
        if pos < 0:
            pos = 0
        item["excerpt"] = text[max(0, pos - 80):pos + 260]
        item["ok"] = bool(item["title"] or item["signals"])
        return item
    except Exception as exc:  # noqa: BLE001 - 抓取失败不应中断其它来源
        item["error"] = f"{type(exc).__name__}: {exc}"
        return item


def _signals(sources: list[dict]) -> dict:
    seen = {word for src in sources for word in src.get("signals") or []}
    routes = [x for x in ROUTES if x in seen]
    if "水泥罐船" in seen and "顺德新港—香港水泥罐船" not in routes:
        routes.append("顺德新港—香港水泥罐船")
    return {
        "business": [x for x in KEYWORDS if x in seen and x not in PORTS and x not in routes],
        "ports": [x for x in PORTS if x in seen],
        "routes": routes,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--seed", action="store_true",
                        help="同时写 samples/xiefeng_public.json（仓库种子）")
    args = parser.parse_args()

    sources = [_fetch(src) for src in SOURCES]
    ok = [x for x in sources if x["ok"]]
    data = {
        "company": "佛山市顺德区协丰物流有限公司",
        "fetched_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source_mode": "live",
        "sources": sources,
        "signals": _signals(sources),
        "note": "公开网页抓取，仅用于会前研究；事实需客户确认，不对外发送。",
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"写入 {out}：{len(ok)}/{len(sources)} 个来源成功")
    for src in sources:
        print(f"  {'✓' if src['ok'] else '✗'} {src['name']} "
              f"({src['status'] or src['error']}) signals={len(src['signals'])}")

    if args.seed:
        seed = ROOT / "samples" / "xiefeng_public.json"
        seed_data = dict(data)
        seed_data["source_mode"] = "seed"
        seed.write_text(json.dumps(seed_data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"写入种子 {seed}")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
