"""关务 HS 候选助手（AI-46 的骨架）。

原则：
- HS 编码必须来自客户词库/历史报关记录，不由模型凭空生成。
- 模型只能在候选里选一个并解释；选不中/不在候选里就回退规则排序。
- 低置信度必须转报关行/人工确认；不自动申报。

当前提供的是：
- 客户 HS 词库的导入/查询；
- 规则关键词匹配；
- 可选模型在候选中选择 + 解释；
- 合成示例词库（代码需客户报关行确认）。
"""
from __future__ import annotations

import csv
import io
import json
import re
from pathlib import Path

from . import llm
from .config import ROOT, settings

DICT_PATH = ROOT / "data" / "customs" / "hs_dict.json"

# 仅示例：4 位章节，真实申报需客户 10 位编码与报关行确认
_DEMO = [
    {"code": "8516", "name": "电热器具（示例）", "keywords": ["电热", "微波炉", "电饭锅", "热水器", "烤箱"]},
    {"code": "8418", "name": "冷藏/冷冻设备（示例）", "keywords": ["冰箱", "冷柜", "冷藏", "冷冻"]},
    {"code": "8450", "name": "洗衣机（示例）", "keywords": ["洗衣机", "洗涤"]},
    {"code": "9403", "name": "家具（示例）", "keywords": ["家具", "桌", "椅", "柜", "床"]},
    {"code": "6204", "name": "女式服装（示例）", "keywords": ["女装", "连衣裙", "女裤", "裙子"]},
    {"code": "3901", "name": "初级形状乙烯聚合物（示例）", "keywords": ["塑料粒子", "聚乙烯", "PE"]},
    {"code": "7208", "name": "铁/非合金钢平板轧材（示例）", "keywords": ["钢材", "钢板", "热轧", "冷轧"]},
    {"code": "8708", "name": "机动车零件（示例）", "keywords": ["汽车零件", "汽车配件", "零部件"]},
    {"code": "6907", "name": "陶瓷砖（示例）", "keywords": ["瓷砖", "陶瓷砖", "地砖"]},
    {"code": "3926", "name": "其他塑料制品（示例）", "keywords": ["塑料制品", "塑料壳", "塑料件"]},
]


def _load() -> list[dict]:
    try:
        data = json.loads(DICT_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _save(items: list[dict]) -> None:
    DICT_PATH.parent.mkdir(parents=True, exist_ok=True)
    DICT_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def list_items() -> list[dict]:
    return _load()


def seed_demo() -> dict:
    if _load():
        return {"added": 0, "items": _load()}
    _save([dict(x) for x in _DEMO])
    return {"added": len(_DEMO), "items": _load()}


def import_csv(text: str) -> dict:
    text = (text or "").lstrip("\ufeff")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ValueError("CSV 没有表头，需要 code,name,keywords")
    items = _load()
    by_code = {str(x.get("code")): x for x in items}
    added = 0
    for row in reader:
        code = str(row.get("code") or "").strip()
        name = str(row.get("name") or "").strip()
        if not code or not name:
            continue
        raw = str(row.get("keywords") or "")
        keywords = [x.strip() for x in re.split(r"[|,，、;；\s]+", raw) if x.strip()]
        by_code[code] = {"code": code, "name": name, "keywords": keywords}
        added += 1
    _save(list(by_code.values()))
    return {"added": added, "items": len(by_code)}


def _tokens(text: str) -> set[str]:
    text = (text or "").lower()
    words = re.findall(r"[a-z0-9]{2,}", text)
    grams: list[str] = []
    for seg in re.findall(r"[\u4e00-\u9fff]+", text):
        grams.extend(seg[i:i + 2] for i in range(max(1, len(seg) - 1)))
    return set(words + grams)


def candidates(description: str, top_k: int = 5) -> list[dict]:
    text = (description or "").strip()
    if not text:
        raise ValueError("商品描述不能为空")
    q = _tokens(text)
    out = []
    for item in _load():
        hits = [k for k in item.get("keywords", []) if k and k.lower() in text.lower()]
        score = len(hits)
        # 只认关键词；不做字面 bigram 兜底，避免「航天器零件」误匹配汽车零件
        if score:
            out.append({**item, "score": score, "hits": hits,
                        "confidence": min(0.95, 0.55 + 0.12 * score)})
    out.sort(key=lambda x: (-x["score"], x["code"]))
    return out[:max(1, top_k)]


def _llm_choose(description: str, items: list[dict]) -> dict:
    if not settings.llm_enabled or not items:
        return {"code": "", "explanation": "", "engine": "rule"}
    payload = [{"code": x["code"], "name": x["name"]} for x in items]
    res = llm.chat_json(
        "你是报关归类助手。只能从候选编码中选一个，不得发明新编码。"
        '只输出 JSON：{"code":"...","explanation":"..."}。'
        "如果候选都不合适，code 留空。",
        json.dumps({"description": description, "candidates": payload}, ensure_ascii=False),
    )
    if not res.ok:
        return {"code": "", "explanation": "", "engine": "rule"}
    data = llm.parse_json_loose(res.text)
    code = str((data or {}).get("code") or "").strip()
    explanation = str((data or {}).get("explanation") or "").strip()
    if code not in {x["code"] for x in items}:
        return {"code": "", "explanation": "", "engine": "rule"}
    return {"code": code, "explanation": explanation[:300], "engine": "llm"}


def suggest(description: str, use_llm: bool = True) -> dict:
    items = candidates(description)
    if not items:
        return {"description": description, "candidates": [], "selected": None,
                "explanation": "词库里没有匹配项；请补充商品关键词或导入客户 HS 词库。",
                "engine": "rule", "warning": "不猜编码，交给报关行确认。"}
    choice = _llm_choose(description, items) if use_llm else {"code": "", "explanation": "", "engine": "rule"}
    selected = next((x for x in items if x["code"] == choice["code"]), None)
    if selected is None:
        selected = items[0]
        explanation = (f"按词库关键词匹配，最接近 {selected['code']}（{selected['name']}）；"
                       f"命中：{'、'.join(selected['hits']) or '名称相似'}。请报关行复核。")
        engine = "rule"
    else:
        explanation = choice["explanation"] or f"模型在候选中选择 {selected['code']}，需报关行复核。"
        engine = "llm"
    return {
        "description": description,
        "candidates": items,
        "selected": selected,
        "explanation": explanation,
        "engine": engine,
        "warning": "HS 编码必须由客户词库/历史报关记录支撑；本结果只是候选，不自动申报。",
    }


def demo() -> dict:
    seed_demo()
    text = "家用微波炉，电热器具，出口英国"
    return {"text": text, "result": suggest(text, use_llm=False), "items": list_items()}
