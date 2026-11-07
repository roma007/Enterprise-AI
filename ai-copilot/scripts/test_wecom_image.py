"""企微图片链路自检：解析、幂等、素材下载、token 缓存、主动推送。

不依赖真实企业微信：用 httpx.MockTransport 模拟 gettoken / media/get /
message/send，用独立临时数据库验证幂等与 inbound 回填。

用法：
    PYTHONPATH=. .venv/bin/python scripts/test_wecom_image.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.pop("DATABASE_URL", None)
os.environ["DB_PATH"] = str(Path(tempfile.mkdtemp(prefix="wecom-image-")) / "test.db")
# 必须在 import app.* 之前清空，保证回调走明文 + 未配置分支
for key in ("WECOM_TOKEN", "WECOM_CORPID", "WECOM_ENCODING_AES_KEY",
            "WECOM_SECRET", "WECOM_AGENTID"):
    os.environ[key] = ""

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402

from app import wecom, wecom_api  # noqa: E402
from app.config import settings  # noqa: E402
from app.store import (  # noqa: E402
    claim_wecom_msg, init_db, mark_wecom_msg, record_inbound, update_inbound_text,
)
from app.db import connect  # noqa: E402

init_db()

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


IMAGE_XML = """<xml>
<ToUserName><![CDATA[corp]]></ToUserName>
<FromUserName><![CDATA[zhangsan]]></FromUserName>
<CreateTime>1730000000</CreateTime>
<MsgType><![CDATA[image]]></MsgType>
<PicUrl><![CDATA[https://example.invalid/pic]]></PicUrl>
<MediaId><![CDATA[MEDIA123]]></MediaId>
<MsgId>900001</MsgId>
<AgentID>1000002</AgentID>
</xml>"""

msg = wecom.parse_message(IMAGE_XML)
chk("解析 image：MsgType", msg["msg_type"] == "image")
chk("解析 image：MediaId", msg["media_id"] == "MEDIA123")
chk("解析 image：MsgId", msg["msg_id"] == "900001")
chk("解析 image：FromUser", msg["from_user"] == "zhangsan")

long_text = "箱" * 1200
clipped = wecom.clip_text(long_text, 2000)
chk("文本按 2048 字节截断", len(clipped.encode("utf-8")) <= 2003,
    f"实际 {len(clipped.encode('utf-8'))} 字节")

chk("MsgId 首次领取成功", claim_wecom_msg("idem-1", "image") is True)
chk("MsgId 重复领取被拒", claim_wecom_msg("idem-1", "image") is False)
mark_wecom_msg("idem-1", "done", "run-1")

inbound = record_inbound("[图片待识别] media_id=MEDIA123", source="wecom-image")
update_inbound_text(inbound["id"], "客户：宏远国际货代 箱号：CSQU3054383")
with connect() as conn:
    row = conn.execute(
        "SELECT preview, text_hash, run_id FROM inbound WHERE id=?", (inbound["id"],)
    ).fetchone()
chk("inbound 回填原文", row["preview"].startswith("客户：宏远"), row["preview"][:18])
chk("inbound 保留同一行", row["run_id"] is None)

# ---- 企业微信 API（MockTransport） ----
settings.wecom_corpid = "corp"
settings.wecom_secret = "secret"
settings.wecom_agentid = "1000002"
wecom_api.reset_cache()

state = {"token_calls": 0, "media_calls": 0, "send": None}
MEDIA_BYTES = b"\x89PNG\r\n\x1a\nfake"


def handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == "/cgi-bin/gettoken":
        state["token_calls"] += 1
        return httpx.Response(200, json={
            "errcode": 0, "access_token": f"tok{state['token_calls']}",
            "expires_in": 7200,
        })
    if path == "/cgi-bin/media/get":
        state["media_calls"] += 1
        token = request.url.params.get("access_token")
        if state["media_calls"] == 1:
            return httpx.Response(200, json={
                "errcode": 42001, "errmsg": "access_token expired",
            })
        assert token == "tok2", token
        return httpx.Response(
            200, content=MEDIA_BYTES,
            headers={"content-type": "image/png",
                     "content-disposition":
                         "attachment; filename*=UTF-8''%E6%89%98%E4%B9%A6.png"},
        )
    if path == "/cgi-bin/message/send":
        state["send"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(200, json={"errcode": 0, "errmsg": "ok"})
    return httpx.Response(404)


client = httpx.Client(
    transport=httpx.MockTransport(handler),
    base_url="https://qyapi.weixin.qq.com",
    follow_redirects=True,
)

data, filename, ctype = wecom_api.download_media("MEDIA123", client=client)
chk("素材下载成功", data == MEDIA_BYTES)
chk("文件名来自 Content-Disposition", filename == "托书.png", filename)
chk("token 过期自动刷新并重试", state["token_calls"] == 2, str(state["token_calls"]))
chk("content-type 保留", ctype == "image/png")

data2, _, _ = wecom_api.download_media("MEDIA123", client=client)
chk("token 缓存命中（不再取 token）", state["token_calls"] == 2, str(state["token_calls"]))
chk("素材可重复下载", data2 == MEDIA_BYTES)

wecom_api.send_text("zhangsan", long_text, client=client)
payload = state["send"] or {}
chk("主动推送 touser", payload.get("touser") == "zhangsan")
chk("主动推送 agentid", payload.get("agentid") == 1000002)
sent = (payload.get("text") or {}).get("content", "")
chk("主动推送内容已截断", len(sent.encode("utf-8")) <= 2003,
    f"实际 {len(sent.encode('utf-8'))} 字节")


def bad_handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/cgi-bin/gettoken":
        return httpx.Response(200, json={"errcode": 0, "access_token": "tok",
                                         "expires_in": 7200})
    return httpx.Response(200, json={"errcode": 40007, "errmsg": "invalid media_id"})


bad_client = httpx.Client(
    transport=httpx.MockTransport(bad_handler),
    base_url="https://qyapi.weixin.qq.com",
)
try:
    wecom_api.download_media("bad", client=bad_client)
    chk("非法 media_id 抛错", False)
except wecom_api.WeComAPIError as exc:
    chk("非法 media_id 抛错", exc.code == 40007, str(exc.code))

# ---- 未配置时的回调行为（不下载、不推送，但必须回可读提示） ----
settings.wecom_corpid = ""
settings.wecom_secret = ""
settings.wecom_agentid = ""
wecom_api.reset_cache()

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

with TestClient(app) as api:
    first = api.post("/api/wecom/callback", content=IMAGE_XML,
                     headers={"content-type": "application/xml"})
    chk("未配置图片通道：返回提示", "图片识别通道还没配置好" in first.text,
        first.text[:40].replace("\n", " "))
    second = api.post("/api/wecom/callback", content=IMAGE_XML,
                      headers={"content-type": "application/xml"})
    chk("同一 MsgId 重试不重复回复", second.text.strip() == "")

# ---- 后台任务：下载 → OCR → 入库 → 推送（全部用假实现，不碰网络） ----
from types import SimpleNamespace  # noqa: E402

import app.main as main  # noqa: E402

TEXT = ("客户：宏远国际货代\n委托单号：HY2026110501\n箱型：40HQ\n箱量：1\n"
        "箱号：CSQU3054383\n提货地：北仑二期堆场\n卸货地：宁波北仑春晓工业园3号仓\n"
        "截港时间：2026-12-07 18:00")
captured: dict[str, str] = {}

orig_download = main.wecom_api.download_media
orig_save = main.storage.save
orig_ocr = main.ocr.extract
orig_send = main.wecom_api.send_text
try:
    main.wecom_api.download_media = lambda media_id: (b"img", "x.png", "image/png")
    main.storage.save = lambda data, filename, scope="booking": "booking/x.png"
    main.ocr.extract = lambda filename, data: SimpleNamespace(
        text=TEXT, pages=1, used_ocr=True, note=""
    )
    main.wecom_api.send_text = lambda user, content: captured.update(
        user=user, content=content
    )

    inb = record_inbound("[图片待识别]", source="wecom-image")
    main._process_wecom_image(msg_id="bg-1", media_id="M", from_user="zhangsan",
                              inbound_id=inb["id"], actor="wecom:zhangsan")
    with connect() as conn:
        run = conn.execute(
            "SELECT id, raw_text FROM runs WHERE actor='wecom:zhangsan'"
            " ORDER BY ts DESC LIMIT 1"
        ).fetchone()
        linked = conn.execute(
            "SELECT run_id FROM inbound WHERE id=?", (inb["id"],)
        ).fetchone()
    chk("后台任务生成 run", bool(run) and "CSQU3054383" in (run["raw_text"] or ""))
    chk("inbound 关联到 run",
        bool(linked) and bool(run) and linked["run_id"] == run["id"])
    chk("后台任务主动推送结果", captured.get("user") == "zhangsan"
        and "CSQU3054383" in captured.get("content", ""))

    captured.clear()

    def boom(media_id):
        raise wecom_api.WeComAPIError("download failed")

    main.wecom_api.download_media = boom
    claim_wecom_msg("bg-2", "image")
    inb2 = record_inbound("[图片待识别]", source="wecom-image")
    main._process_wecom_image(msg_id="bg-2", media_id="M", from_user="zhangsan",
                              inbound_id=inb2["id"], actor="wecom:zhangsan")
    with connect() as conn:
        status = conn.execute(
            "SELECT status FROM wecom_msgs WHERE msg_id='bg-2'"
        ).fetchone()
    chk("下载失败落 failed 状态", bool(status) and status["status"] == "failed")
    chk("失败也会通知用户", "图片没识别成功" in captured.get("content", ""))
finally:
    main.wecom_api.download_media = orig_download
    main.storage.save = orig_save
    main.ocr.extract = orig_ocr
    main.wecom_api.send_text = orig_send

print("全部通过" if ok else "有失败项")
raise SystemExit(0 if ok else 1)
