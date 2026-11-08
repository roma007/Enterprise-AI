"""企业知识库与问答（AI-44）。

边界：
- 只回答知识库里有的内容；没有就明确说“没有找到”，不编。
- 回答必须带引用；无引用/引用越界时回退为原文摘录。
- 无模型时退化为关键词检索 + 摘录，仍可用。
- 合成演示文档必须标注【演示】。
"""
from __future__ import annotations

import json
import math
import re
import uuid
from datetime import datetime
from pathlib import Path

from . import llm
from .config import ROOT, settings

KB_DIR = ROOT / "data" / "kb"
MAX_DOC_CHARS = 200_000


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _tokens(text: str) -> set[str]:
    text = (text or "").lower()
    words = re.findall(r"[a-z0-9]{2,}", text)
    grams: list[str] = []
    for seg in re.findall(r"[\u4e00-\u9fff]+", text):
        if len(seg) == 1:
            grams.append(seg)
        else:
            grams.extend(seg[i:i + 2] for i in range(len(seg) - 1))
    return set(words + grams)


def _chunks(text: str, size: int = 500, overlap: int = 80) -> list[str]:
    parts = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    out: list[str] = []
    for part in parts or [text.strip()]:
        if len(part) <= size:
            if part:
                out.append(part)
            continue
        step = max(1, size - overlap)
        for start in range(0, len(part), step):
            piece = part[start:start + size].strip()
            if piece:
                out.append(piece)
            if start + size >= len(part):
                break
    return out


def _path(doc_id: str) -> Path:
    return KB_DIR / f"{doc_id}.json"


def _load(doc_id: str) -> dict | None:
    try:
        return json.loads(_path(doc_id).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def list_docs() -> list[dict]:
    if not KB_DIR.exists():
        return []
    out = []
    for path in sorted(KB_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        out.append({
            "id": doc.get("id"), "title": doc.get("title"),
            "tags": doc.get("tags", []), "created_at": doc.get("created_at"),
            "chars": len(doc.get("text", "")), "chunks": len(doc.get("chunks", [])),
        })
    return out


def add_doc(title: str, text: str, tags: list[str] | None = None) -> dict:
    title = (title or "").strip()
    text = (text or "").strip()
    if not title:
        raise ValueError("标题不能为空")
    if not text:
        raise ValueError("内容不能为空")
    if len(text) > MAX_DOC_CHARS:
        raise ValueError(f"文档太长（最多 {MAX_DOC_CHARS} 字）")
    doc_id = uuid.uuid4().hex[:10]
    doc = {
        "id": doc_id,
        "title": title,
        "tags": [str(x).strip() for x in (tags or []) if str(x).strip()],
        "created_at": _now(),
        "text": text,
        "chunks": _chunks(text),
    }
    KB_DIR.mkdir(parents=True, exist_ok=True)
    _path(doc_id).write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    return {k: v for k, v in doc.items() if k not in ("text", "chunks")}


def delete_doc(doc_id: str) -> bool:
    path = _path(doc_id)
    if not path.exists():
        return False
    path.unlink()
    return True


def _score(question: str, doc: dict, chunk: str) -> float:
    q = _tokens(question)
    if not q:
        return 0.0
    body = _tokens(doc.get("title", "") + " " + " ".join(doc.get("tags", [])) + " " + chunk)
    hit = len(q & body)
    if hit == 0:
        return 0.0
    # 精确短语加权，长 chunk 做轻微惩罚
    bonus = 2.0 if question.strip().lower() in (chunk or "").lower() else 0.0
    return (hit + bonus) / (1.0 + math.log(1.0 + len(chunk) / 300.0))


def search(question: str, top_k: int = 4) -> list[dict]:
    hits = []
    for meta in list_docs():
        doc = _load(meta["id"])
        if not doc:
            continue
        for idx, chunk in enumerate(doc.get("chunks", [])):
            score = _score(question, doc, chunk)
            if score > 0:
                hits.append({
                    "doc_id": doc["id"], "title": doc["title"],
                    "chunk": idx, "text": chunk, "score": round(score, 4),
                })
    hits.sort(key=lambda x: x["score"], reverse=True)
    # 同一文档最多取 2 段，避免一个文档霸屏
    out, per_doc = [], {}
    for hit in hits:
        if per_doc.get(hit["doc_id"], 0) >= 2:
            continue
        out.append(hit)
        per_doc[hit["doc_id"]] = per_doc.get(hit["doc_id"], 0) + 1
        if len(out) >= max(1, top_k):
            break
    return out


def _citations(hits: list[dict]) -> list[dict]:
    return [{
        "index": i + 1, "doc_id": h["doc_id"], "title": h["title"],
        "text": h["text"][:300], "score": h["score"],
    } for i, h in enumerate(hits)]


def _extractive(hits: list[dict]) -> dict:
    lines = ["根据知识库，找到以下相关内容："]
    for i, h in enumerate(hits[:3], start=1):
        lines.append(f"[{i}] {h['title']}：{h['text'][:220]}")
    return {"answer": "\n\n".join(lines), "citations": _citations(hits),
            "engine": "extractive", "used": []}


_SYSTEM = """你是企业知识库问答助手。
规则：
1. 只根据给定的资料回答，不得使用资料以外的知识，不得编造。
2. 如果资料里没有答案，回答“知识库里没有找到相关内容”。
3. 回答必须引用资料编号，不得引用不存在的编号。
4. 只输出 JSON：{"answer":"...","used":[1,2]}。"""


def ask(question: str, top_k: int = 4, use_llm: bool = True) -> dict:
    question = (question or "").strip()
    if not question:
        raise ValueError("问题不能为空")
    hits = search(question, top_k)
    if not hits:
        return {"answer": "知识库里没有找到相关内容。", "citations": [],
                "engine": "none", "used": []}

    if not use_llm or not settings.llm_enabled:
        return _extractive(hits)

    context = "\n\n".join(
        f"[{i}] 《{h['title']}》\n{h['text'][:800]}" for i, h in enumerate(hits, start=1)
    )
    res = llm.chat_json(_SYSTEM, f"资料：\n{context}\n\n问题：{question}")
    if not res.ok:
        return _extractive(hits)
    data = llm.parse_json_loose(res.text)
    answer = str((data or {}).get("answer") or "").strip()
    used_raw = (data or {}).get("used") if isinstance(data, dict) else None
    used = []
    if isinstance(used_raw, list):
        for x in used_raw:
            try:
                n = int(x)
            except (TypeError, ValueError):
                continue
            if 1 <= n <= len(hits) and n not in used:
                used.append(n)
    if not answer:
        return _extractive(hits)
    if "没有找到" in answer:
        return {"answer": answer, "citations": [], "engine": "llm", "used": []}
    if not used:
        # 有答案但没引用：不采信，回退原文
        return _extractive(hits)
    cited = [_citations(hits)[n - 1] for n in used]
    return {"answer": answer[:1200], "citations": cited, "engine": "llm", "used": used}


_DEMO_DOCS = [
    ("【演示】客户对账 SOP", ["对账", "应收"], """
对账周期：每月 3 日前出上月对账单，5 个工作日内客户确认。
差异处理：金额不符先查运单和合同价；系统无此单查是否漏录；客户漏单要追。
催收：逾期 30 天提醒，60 天电话催收，90 天重点催收并暂停接新单。
截港提醒：截港前 24 小时必须确认装箱和报关状态；截港提前时先保已放行货物。
"""),
    ("【演示】报关资料清单", ["报关", "单证"], """
出口报关基础资料：商业发票、装箱单、合同、报关委托书、申报要素。
HS 编码：按品名、材质、用途、功能归类；不确定时查历史申报记录，并请报关行复核。
申报要素：品名、品牌、型号、材质、用途、原理、功率等按税号要求填写。
查验：收到查验通知后，先核对箱号、封号、装箱单，再安排查验。
"""),
    ("【演示】异常费用口径", ["费用", "异常"], """
压车费：因客户或工厂原因导致车辆等候，按等候时长计费，需现场照片/时间记录。
改单费：客户变更卸货地、箱型、船期等产生，按合同或报价单确认。
退关费：因单证、查验、客户原因退关产生，需保留海关/码头凭证。
截港/甩柜：先确认是否可改配；不可改配时按合同与客户协商费用承担。
"""),
]


def seed_demo() -> dict:
    existing = {d["title"] for d in list_docs()}
    added = []
    for title, tags, text in _DEMO_DOCS:
        if title not in existing:
            added.append(add_doc(title, text, tags))
    return {"added": len(added), "docs": list_docs()}


def demo_questions() -> list[str]:
    return ["截港提前怎么办？", "报关需要哪些资料？", "压车费怎么算？"]
