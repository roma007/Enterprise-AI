"""最小 TMS 接收端，用于联调 AI-26 通用写回。

不是客户 TMS，只验证：
- 固定契约 JSON 能收到
- Bearer token 校验
- 2xx / 5xx 分类
- 幂等键与 payload 落盘

运行：
    MOCK_TMS_TOKEN=dev-token python3 scripts/mock_tms.py 8898
接收：
    POST http://127.0.0.1:8898/hook
    POST http://127.0.0.1:8898/fail   （固定 500，用于重试验证）
"""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "data" / "mock_tms.jsonl"
TOKEN = os.getenv("MOCK_TMS_TOKEN", "").strip()


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code: int, body: dict) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/fail":
            self._reply(500, {"ok": False, "error": "mock tms internal error"})
            return
        if self.path not in ("/hook", "/"):
            self._reply(404, {"ok": False, "error": "not found"})
            return

        if TOKEN:
            auth = self.headers.get("Authorization", "")
            if auth != f"Bearer {TOKEN}":
                self._reply(401, {"ok": False, "error": "bad token"})
                return

        try:
            size = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(size) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._reply(400, {"ok": False, "error": "bad json"})
            return

        if not payload.get("test"):
            LOG.parent.mkdir(parents=True, exist_ok=True)
            with LOG.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(payload, ensure_ascii=False) + "\n")

        key = payload.get("idempotency_key") or "test"
        self._reply(200, {"ok": True, "tms_id": f"MOCK-{str(key)[:12]}",
                          "received": bool(payload.get("booking"))})

    def log_message(self, *args) -> None:  # noqa: D401
        return


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8898
    print(f"mock TMS listening on http://127.0.0.1:{port}/hook (token={'set' if TOKEN else 'none'})")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
