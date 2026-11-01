"""企业微信入口（D3）。

为什么要做这个：绕过率只有在"入口唯一"时才成立。
如果有人的单走微信、有人的单走系统，你就永远算不出真实节省。

实现范围（刻意做小）：
- 明文模式回调（企业微信后台可配置），够内部试点用
- 签名校验 sha1(sort(token, timestamp, nonce))
- 被动回复：把解析结果拼成一条文本消息

**不支持**：AES 加密模式。上生产前需要接官方加解密库，
这一条写在 README 的"已知局限"里，不假装支持。
"""
from __future__ import annotations

import hashlib
import time
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

from .schema import LABELS


def verify_signature(token: str, signature: str, timestamp: str, nonce: str) -> bool:
    """企业微信回调签名校验。token 为空时跳过（本地调试用）。"""
    if not token:
        return True
    raw = "".join(sorted([token, timestamp or "", nonce or ""]))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest() == (signature or "")


def parse_message(xml_text: str) -> dict:
    """解析企业微信推送的 XML（明文模式）。"""
    out = {"msg_type": "", "content": "", "from_user": "", "to_user": ""}
    if not xml_text:
        return out
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return out
    for tag, key in (("MsgType", "msg_type"), ("Content", "content"),
                     ("FromUserName", "from_user"), ("ToUserName", "to_user")):
        node = root.find(tag)
        if node is not None and node.text:
            out[key] = node.text.strip()
    return out


def _cdata(v: str) -> str:
    return f"<![CDATA[{v.replace(']]>', ']]]]><![CDATA[>')}]]>"


def build_text_reply(to_user: str, from_user: str, content: str) -> str:
    return (
        "<xml>"
        f"<ToUserName>{_cdata(to_user)}</ToUserName>"
        f"<FromUserName>{_cdata(from_user)}</FromUserName>"
        f"<CreateTime>{int(time.time())}</CreateTime>"
        "<MsgType><![CDATA[text]]></MsgType>"
        f"<Content>{_cdata(content)}</Content>"
        "</xml>"
    )


LEVEL_TEXT = {
    "auto": "✅ 自动通过（高风险字段全部确定，可直接归档）",
    "single": "🟡 需单人确认（有一处提醒）",
    "double": "🟠 需双人复核（有字段把握不足 80%）",
    "blocked": "🔴 有阻断问题，必须先改",
}


def format_result(draft, run_id: str = "") -> str:
    """把解析结果拼成一条能直接发回微信的消息。"""
    lines = [f"托书已识别（{draft.elapsed_ms} ms）", LEVEL_TEXT.get(draft.review_level, draft.review_level), ""]

    show = ("client", "booking_no", "container_type", "container_qty",
            "container_no", "seal_no", "closing_time", "pickup_addr", "delivery_addr")
    for k in show:
        fv = draft.fields.get(k)
        if fv and fv.value:
            pct = int(fv.confidence * 100)
            lines.append(f"{LABELS[k]}：{fv.value}（{pct}%）")

    hard = [c for c in draft.checks if c.level == "error"]
    if hard:
        lines.append("")
        for c in hard[:3]:
            lines.append(f"⚠️ {c.message}")

    if run_id:
        lines.append("")
        lines.append(f"单号：{run_id}")
    lines.append("回复「确认」入库，或直接在系统里修改。")
    return "\n".join(lines)


def format_help() -> str:
    return (
        "把托书直接发给我就行：\n"
        "· 文字直接粘贴\n"
        "· 图片直接拍照发送\n"
        "· Excel/PDF 直接拖进来\n\n"
        "我会返回结构化结果，你点确认后入库。"
    )
