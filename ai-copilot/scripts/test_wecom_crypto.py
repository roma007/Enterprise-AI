"""B3 自检：企业微信安全模式加解密。

用官方文档「加解密方案说明」的 POST 示例验证：
- 签名算法（token / timestamp / nonce / encrypt 字典序拼接后 sha1）
- AES-256-CBC + PKCS#7(32 字节块) 解密
- receiveid 校验
- 加密 → 解密往返（URL 验证用的 echostr 也走同一条链路）

用法：
    PYTHONPATH=. .venv/bin/python scripts/test_wecom_crypto.py

需要可选依赖：pip install cryptography
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import wecom_crypto as wc  # noqa: E402

# 企业微信官方文档示例
TOKEN = "QDG6eK"
CORP_ID = "wx5823bf96d3bd56c7"
AES_KEY = "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C"
MSG_SIG = "477715d11cdb4164915debcba66cb864d751f3e6"
TIMESTAMP = "1409659813"
NONCE = "1372623149"
ENCRYPT = (
    "RypEvHKD8QQKFhvQ6QleEB4J58tiPdvo+rtK1I9qca6aM/wvqnLSV5zEPeusUiX5L5X/0lWfrf0QADHHhGd3QczcdCUp"
    "j911L3vg3W/sYYvuJTs3TUUkSUXxaccAS0qhxchrRYt66wiSpGLYL42aM6A8dTT+6k4aSknmPj48kzJs8qLjvd4Xgpue"
    "06DOdnLxAUHzM6+kDZ+HMZfJYuR+LtwGc2hgf5gsijff0ekUNXZiqATP7PF5mZxZ3Izoun1s4zG4LUMnvw2r+KqCKIw+"
    "3IQH03v+BCA9nMELNqbSf6tiWSrXJB3LAVGUcallcrw8V2t9EL4EhzJWrQUax5wLVMNS0+rUPA3k22Ncx4XXZS9o0MB"
    "H27Bo6BpNelZpS+/uh9KsNlY6bHCmJU9p8g7m3fVKn28H3KDYA5Pl/T8Z1ptDAVe0lXdQ2YoyyH2uyPIGHBZZIs2pDB"
    "S8R07+qN+E7Q=="
)

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


if not wc.available():
    print("  ✗ 未安装 cryptography：pip install cryptography")
    sys.exit(1)

print("官方测试向量（POST 回调示例）")
chk("签名一致", wc.signature(TOKEN, TIMESTAMP, NONCE, ENCRYPT) == MSG_SIG)
chk("验签通过", wc.verify(TOKEN, MSG_SIG, TIMESTAMP, NONCE, ENCRYPT))
chk("篡改签名被拒", not wc.verify(TOKEN, "0" * 40, TIMESTAMP, NONCE, ENCRYPT))

plain = wc.decrypt_with_key(ENCRYPT, AES_KEY, CORP_ID)
chk("解密成功", bool(plain))
chk("解密内容含 hello", "<Content><![CDATA[hello]]></Content>" in plain)
chk("ToUserName 是 CorpID", f"<ToUserName><![CDATA[{CORP_ID}]]></ToUserName>" in plain)

print("加密 → 解密往返")
inner = (
    "<xml><ToUserName><![CDATA[wx5823bf96d3bd56c7]]></ToUserName>"
    "<FromUserName><![CDATA[user001]]></FromUserName>"
    "<CreateTime>1409659813</CreateTime>"
    "<MsgType><![CDATA[text]]></MsgType>"
    "<Content><![CDATA[一个40HQ，箱号CSQU3054383]]></Content>"
    "<MsgId>4561255354251345929</MsgId></xml>"
)
enc = wc.encrypt_with_key(inner, AES_KEY, CORP_ID)
chk("加密结果非空且非明文", bool(enc) and inner not in enc)
chk("解密回原文", wc.decrypt_with_key(enc, AES_KEY, CORP_ID) == inner)
chk("中文往返正常", "箱号CSQU3054383" in wc.decrypt_with_key(enc, AES_KEY, CORP_ID))

print("URL 验证（echostr）")
echo = "1616140317555161061"
echo_enc = wc.encrypt_with_key(echo, AES_KEY, CORP_ID)
chk("echostr 解密回原值", wc.decrypt_echo(echo_enc, AES_KEY, CORP_ID) == echo)

print("异常路径")
try:
    wc.decrypt_with_key(enc, AES_KEY, "wx_wrong_corp")
    chk("receiveid 不匹配被拒", False)
except wc.WeComCryptoError:
    chk("receiveid 不匹配被拒", True)

try:
    wc.decrypt_with_key("not-base64!!", AES_KEY, CORP_ID)
    chk("非法密文被拒", False)
except wc.WeComCryptoError:
    chk("非法密文被拒", True)

try:
    wc.extract_encrypt("<xml><Foo>1</Foo></xml>")
    chk("缺少 Encrypt 节点被拒", False)
except wc.WeComCryptoError:
    chk("缺少 Encrypt 节点被拒", True)

print()
print("全部通过" if ok else "有失败项")
sys.exit(0 if ok else 1)
