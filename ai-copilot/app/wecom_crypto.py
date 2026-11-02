"""企业微信回调加解密（B3）。

企业微信「安全模式」的协议细节（官方文档「加解密方案说明」）：

1. `AESKey = Base64_Decode(EncodingAESKey + "=")`，32 字节
2. 明文结构：`随机16字节 + msg_len(4字节, 网络序) + msg + receiveid`
3. 用 AES-256-CBC 加密，`IV = AESKey[:16]`
4. 填充用 PKCS#7，但**块大小是 32 字节**（不是常见的 16）
5. 回调签名：`sha1(sort(token, timestamp, nonce, encrypt))`
6. `receiveid`：自建应用填 CorpID

为什么单独放一个文件：
- 这段协议细节多、错一个字节就全错，和消息拼装混在一起很难测
- `cryptography` 是可选依赖：不配加密模式就不需要装

已验证：用官方文档给出的测试向量（见 scripts/test_wecom_crypto.py），
签名、解密 echostr、加密再解密往返都通过。
"""
from __future__ import annotations

import base64
import hashlib
import os
import struct
import time
import xml.etree.ElementTree as ET

BLOCK_SIZE = 32


class WeComCryptoError(RuntimeError):
    pass


def available() -> bool:
    try:
        import cryptography  # noqa: F401
        return True
    except ImportError:
        return False


def _aes(encoding_aes_key: str):
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except ImportError as exc:
        raise WeComCryptoError(
            "企业微信加密模式需先安装 cryptography：pip install cryptography"
        ) from exc

    if len(encoding_aes_key) != 43:
        raise WeComCryptoError("EncodingAESKey 必须是 43 位")
    try:
        key = base64.b64decode(encoding_aes_key + "=")
    except Exception as exc:  # noqa: BLE001
        raise WeComCryptoError("EncodingAESKey 不是合法的 Base64") from exc
    if len(key) != 32:
        raise WeComCryptoError("EncodingAESKey 解码后必须 32 字节")
    cipher = Cipher(algorithms.AES(key), modes.CBC(key[:16]))
    return cipher


def _pkcs7_pad(data: bytes) -> bytes:
    n = BLOCK_SIZE - len(data) % BLOCK_SIZE
    return data + bytes([n]) * n


def _pkcs7_unpad(data: bytes) -> bytes:
    if not data:
        raise WeComCryptoError("密文为空")
    n = data[-1]
    if n < 1 or n > BLOCK_SIZE or n > len(data):
        raise WeComCryptoError("PKCS#7 填充非法")
    return data[:-n]


def signature(token: str, timestamp: str, nonce: str, encrypt: str) -> str:
    raw = "".join(sorted([token or "", timestamp or "", nonce or "", encrypt or ""]))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def verify(token: str, msg_signature: str, timestamp: str, nonce: str,
           encrypt: str) -> bool:
    if not token:
        return True
    return signature(token, timestamp, nonce, encrypt) == (msg_signature or "")


def _b64d(s: str) -> bytes:
    """企业微信的 Base64 常常省略尾部 '='，这里补回来。"""
    return base64.b64decode(s + "=" * (-len(s) % 4))


def decrypt_with_key(encrypt: str, encoding_aes_key: str, receive_id: str) -> str:
    cipher = _aes(encoding_aes_key)
    try:
        raw = cipher.decryptor().update(_b64d(encrypt))
    except Exception as exc:  # noqa: BLE001
        raise WeComCryptoError("密文 Base64 非法") from exc
    raw = _pkcs7_unpad(raw)
    if len(raw) < 20:
        raise WeComCryptoError("明文长度不足")
    # 前 16 字节是随机串，之后才是 msg_len（官方文档第三步）
    content = raw[16:]
    msg_len = struct.unpack(">I", content[:4])[0]
    if 4 + msg_len > len(content):
        raise WeComCryptoError("msg_len 非法")
    msg = content[4:4 + msg_len]
    got_id = content[4 + msg_len:].decode("utf-8", errors="ignore")
    if receive_id and got_id and got_id != receive_id:
        raise WeComCryptoError(f"receiveid 不匹配：{got_id}")
    return msg.decode("utf-8", errors="ignore")


def encrypt_with_key(msg: str, encoding_aes_key: str, receive_id: str) -> str:
    cipher = _aes(encoding_aes_key)
    body = msg.encode("utf-8")
    payload = os.urandom(16) + struct.pack(">I", len(body)) + body + receive_id.encode()
    payload = _pkcs7_pad(payload)
    out = cipher.encryptor().update(payload)
    return base64.b64encode(out).decode()


def decrypt_echo(echostr: str, encoding_aes_key: str, receive_id: str) -> str:
    """URL 验证：echostr 是密文，解密后原样返回。"""
    return decrypt_with_key(echostr, encoding_aes_key, receive_id)


def build_encrypted_reply(inner_xml: str, token: str, encoding_aes_key: str,
                          receive_id: str) -> str:
    """把明文回复包成企业微信要求的加密信封。"""
    encrypt = encrypt_with_key(inner_xml, encoding_aes_key, receive_id)
    ts = str(int(time.time()))
    nonce = base64.b64encode(os.urandom(9)).decode().replace("=", "")[:16]
    sig = signature(token, ts, nonce, encrypt)
    return (
        "<xml>"
        f"<Encrypt><![CDATA[{encrypt}]]></Encrypt>"
        f"<MsgSignature><![CDATA[{sig}]]></MsgSignature>"
        f"<TimeStamp>{ts}</TimeStamp>"
        f"<Nonce><![CDATA[{nonce}]]></Nonce>"
        "</xml>"
    )


def extract_encrypt(xml_text: str) -> str:
    """从外层 XML 里取 Encrypt 节点。"""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise WeComCryptoError("回调 XML 无法解析") from exc
    node = root.find("Encrypt")
    if node is None or not (node.text or "").strip():
        raise WeComCryptoError("回调缺少 Encrypt 节点")
    return node.text.strip()
