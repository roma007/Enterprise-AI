"""协丰公开资料：只读缓存，不在页面请求时联网。

优先级：
1. `data/xiefeng_public.json`（`scripts/fetch_xiefeng_public.py` 抓取，运行时覆盖）
2. `samples/xiefeng_public.json`（仓库内种子，保证离线/CI 可复现）
3. 内置最小事实（再兜底，不编造数字）

边界：
- 公开网页只用于会前研究，不对外发送；事实需客户确认。
- 抓取失败不阻塞页面，页面显示“种子资料/抓取失败”，不假装是实时数据。
"""
from __future__ import annotations

import json
from pathlib import Path

from .config import ROOT

LIVE_PATH = ROOT / "data" / "xiefeng_public.json"
SEED_PATH = ROOT / "samples" / "xiefeng_public.json"

_FALLBACK = {
    "company": "佛山市顺德区协丰物流有限公司",
    "fetched_at": "",
    "sources": [
        {
            "name": "公开企业信息页",
            "url": "",
            "ok": False,
            "title": "佛山市顺德区协丰物流有限公司",
            "signals": ["普通货运", "装卸", "仓储", "国际货物运输代理", "代理报关"],
        }
    ],
    "signals": {
        "business": ["普通货运", "装卸", "仓储", "国际货物运输代理", "代理报关"],
        "ports": ["北滘港", "顺德新港"],
        "routes": ["湾区一港通", "顺德新港—香港水泥罐船"],
    },
    "note": "内置最小公开事实；未联网抓取，引用前需客户确认。",
}


def _read(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) else None


def load() -> dict:
    live = _read(LIVE_PATH)
    if live:
        live["source_mode"] = "live"
        return live
    seed = _read(SEED_PATH)
    if seed:
        seed["source_mode"] = "seed"
        return seed
    out = dict(_FALLBACK)
    out["source_mode"] = "fallback"
    return out


def summary() -> dict:
    data = load()
    sources = data.get("sources") or []
    return {
        "company": data.get("company") or "",
        "fetched_at": data.get("fetched_at") or "",
        "source_mode": data.get("source_mode") or "fallback",
        "source_total": len(sources),
        "source_ok": sum(1 for x in sources if x.get("ok")),
        "sources": sources,
        "signals": data.get("signals") or {},
        "note": data.get("note") or "",
    }
