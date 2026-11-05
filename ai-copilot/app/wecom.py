"""企业微信入口（D3）。

为什么要做这个：绕过率只有在"入口唯一"时才成立。
如果有人的单走微信、有人的单走系统，你就永远算不出真实节省。

两种回调模式：
- **明文模式**：签名 sha1(sort(token, timestamp, nonce))，仅本地调试
- **安全模式**：验 msg_signature + AES 解密，见 app/wecom_crypto.py

消息拼装（被动回复文本）在本模块；加解密单独放，
因为协议细节多、错一个字节就全错，混在一起很难测。
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
        "把托书发给我：\n"
        "· 一条发完：直接粘贴全部内容\n"
        "· 分多条发：先发「分条」，逐条发，最后发「完成」\n"
        "· 图片/PDF：打开 H5 拍照上传，或用批量导入\n\n"
        "我会返回结构化结果，你回复「确认」后入库。"
    )
