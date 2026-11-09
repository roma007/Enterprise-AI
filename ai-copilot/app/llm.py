"""模型网关。

目标：任何 OpenAI 兼容接口都能接（OpenAI / DeepSeek / 通义 / 智谱 / vLLM / Ollama）。
失败或无配置时由上层回退到规则引擎，绝不让演示因为网络挂掉。

工程上必须有的三件事：
1. 超时与重试上限（演示现场不能卡死）
2. token 计量（成本必须可核算，否则 ROI 算不出来）
3. 数据脱敏钩子（报关、客户名单不能出境）
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass

import httpx

from .config import ROOT, settings

_CACHE_PATH = ROOT / "data" / "llm_cache.json"
_cache: dict[str, dict] | None = None


def _load_cache() -> dict[str, dict]:
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            _cache = {}
    return _cache


def _save_cache() -> None:
    if _cache is None:
        return
    _CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _CACHE_PATH.write_text(json.dumps(_cache, ensure_ascii=False), encoding="utf-8")


def _cache_key(system: str, user: str) -> str:
    raw = f"{settings.model}\x00{system}\x00{user}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


@dataclass
class LLMResult:
    text: str
    tokens: int
    ok: bool = True
    error: str = ""
    cached: bool = False


# ---------- 脱敏 ----------

_PHONE_RE = re.compile(r"(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)")


def mask(text: str) -> str:
    """最小脱敏：手机号中四位。可按客户要求扩展（公司名、报关单号）。"""
    return _PHONE_RE.sub(r"\1****\2", text)


def _headers() -> dict:
    h = {
        "Authorization": f"Bearer {settings.api_key}",
        "Content-Type": "application/json",
        "User-Agent": settings.user_agent,
    }
    if settings.session_header:
        h[settings.session_header] = settings.session_id
    h.update(settings.extra_headers)
    return h


def _post(payload: dict) -> LLMResult:
    try:
        with httpx.Client(timeout=settings.timeout) as client:
            resp = client.post(
                f"{settings.base_url}/chat/completions", json=payload, headers=_headers()
            )
            resp.raise_for_status()
            data = resp.json()
        choices = data.get("choices") or []
        if not choices:
            return LLMResult(text="", tokens=0, ok=False, error="empty_choices")
        text = (choices[0].get("message") or {}).get("content") or ""
        tokens = int((data.get("usage") or {}).get("total_tokens", 0))
        return LLMResult(text=text, tokens=tokens, ok=True)
    except Exception as exc:  # noqa: BLE001 - 演示场景下任何异常都应降级
        return LLMResult(text="", tokens=0, ok=False, error=f"{type(exc).__name__}: {exc}")


def chat_json(system: str, user: str) -> LLMResult:
    if not settings.llm_enabled:
        return LLMResult(text="", tokens=0, ok=False, error="llm_disabled")

    # 演示现场必须秒出：同一份托书 + 同一模型 + 同一提示词，直接命中缓存。
    # key 包含 prompt 全文，改了提示词自动失效，不会拿旧结果骗人。
    key = _cache_key(system, user)
    cache = _load_cache()
    if key in cache:
        item = cache[key]
        from . import llm_usage
        llm_usage.record(0, ok=True, cached=True)
        return LLMResult(text=item["text"], tokens=int(item.get("tokens", 0)), ok=True, cached=True)

    base = {
        "model": settings.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0,
        "max_tokens": settings.max_tokens,
    }

    # 先要求 JSON 模式；部分网关不认 response_format，失败再去掉重试一次。
    res = _post({**base, "response_format": {"type": "json_object"}})
    if not res.ok:
        res2 = _post(base)
        res = res2 if res2.ok else LLMResult(text="", tokens=0, ok=False,
                                            error=f"{res.error} | {res2.error}")
    if res.ok and res.text:
        cache[key] = {"text": res.text, "tokens": res.tokens}
        _save_cache()
    from . import llm_usage
    llm_usage.record(res.tokens, ok=res.ok)
    return res


def parse_json_loose(text: str) -> dict:
    """模型偶尔会带 ```json 包裹或前后废话，这里容错解析。"""
    if not text:
        return {}
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.MULTILINE).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if not m:
            return {}
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return {}
