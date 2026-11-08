"""最小 SMTP 接收端，用于联调邮件告警。

只用于本地验证：收到邮件写入 data/mock_smtp.jsonl，不真正投递。

运行：
    python3 scripts/mock_smtp.py 8025
"""
from __future__ import annotations

import asyncore
import json
import smtpd
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "data" / "mock_smtp.jsonl"


class Server(smtpd.SMTPServer):
    def process_message(self, peer, mailfrom, rcpttos, data, **kwargs):
        text = data.decode("utf-8", "replace") if isinstance(data, bytes) else data
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "peer": peer,
                "mailfrom": mailfrom,
                "rcpttos": rcpttos,
                "text": text,
            }, ensure_ascii=False) + "\n")
        return None


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8025
    Server(("127.0.0.1", port), None)
    print(f"mock SMTP listening on 127.0.0.1:{port}")
    asyncore.loop()


if __name__ == "__main__":
    main()
