"""B4 自检：回写发件箱、幂等键、失败重试。

不依赖真实交付平台：起一个本地 HTTP stub 模拟平台返回，
验证的是**我们的发送逻辑**（请求格式、token、状态流转）。

用法：
    PYTHONPATH=. .venv/bin/python scripts/test_delivery.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# 必须在 import app.* 之前指定独立数据库，避免污染 data/copilot.db
TMP_DB = Path(tempfile.mkdtemp(prefix="delivery-test-")) / "test.db"
os.environ["DB_PATH"] = str(TMP_DB)
os.environ.pop("DELIVERY_PLATFORM_URL", None)
os.environ.pop("DELIVERY_HOOK_TOKEN", None)
os.environ.pop("DELIVERY_EXPERIMENT_ID", None)

from app import delivery  # noqa: E402
from app.store import init_db, outbox_status  # noqa: E402

init_db()

RECORDS: list[dict] = []
STATE = {"code": 201}

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(n)
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = None
        RECORDS.append({
            "path": self.path,
            "token": self.headers.get("x-copilot-token"),
            "body": body,
        })
        code = STATE["code"]
        payload = {"ok": True, "run_no": 7, "duplicate": code == 200,
                   "poc_run_id": "run-7"}
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # 静音
        return


server = HTTPServer(("127.0.0.1", 0), Handler)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

delivery.PLATFORM_URL = f"http://127.0.0.1:{port}"
delivery.HOOK_TOKEN = "test-token"
delivery.EXPERIMENT_ID = "11111111-1111-4111-8111-111111111111"
delivery.TIMEOUT = 5

EVAL = {
    "tuned": {
        "samples": 30, "field_accuracy": 1.0, "blocking_accuracy": 1.0,
        "record_exact_rate": 1.0,
    },
    "holdout": {
        "engine": "rule-based-v1", "mode": "merged", "samples": 16,
        "field_accuracy": 0.987, "blocking_accuracy": 0.969,
        "record_exact_rate": 0.875, "evaluated_fields": 240,
        "warning": "合成样本结果，不构成对外结论",
        "by_field": [
            {"field": "delivery_addr", "accuracy": 0.8, "missing": 2},
            {"field": "seal_no", "accuracy": 0.9, "missing": 1},
        ],
    },
}

print("配置")
chk("三项齐全才启用", delivery.enabled())
cfg = delivery.config_status()
chk("config_status 无缺失", cfg["enabled"] and not cfg["missing"])

print("入发件箱 + 幂等")
q1 = delivery.enqueue(EVAL)
chk("首次入箱", q1["created"] is True)
chk("幂等键 32 位", len(q1["idempotency_key"]) == 32, q1["idempotency_key"])
chk("payload 带实验 id", q1["payload"]["experiment_id"] == delivery.EXPERIMENT_ID)
chk("指标来自留出集", q1["payload"]["metrics"]["samples"] == 16)
chk("附调优集对照", q1["payload"]["metrics"]["tuned"]["samples"] == 30)
chk("最弱字段进 payload", len(q1["payload"]["metrics"]["weakest_fields"]) == 2)

q2 = delivery.enqueue(EVAL)
chk("同结果不入第二条", q2["created"] is False)
chk("幂等键一致", q2["idempotency_key"] == q1["idempotency_key"])

print("首次发送（201）")
res = delivery.flush()
chk("发送成功 1 条", res["sent"] == 1, str(res))
chk("stub 收到 1 次", len(RECORDS) == 1)
chk("路径正确", RECORDS[0]["path"] == "/api/hooks/copilot/eval")
chk("token 正确", RECORDS[0]["token"] == "test-token")
chk("平台拿到 run_no", res["details"][0]["run_no"] == 7)
st = outbox_status()
chk("发件箱状态 sent=1", st["counts"]["sent"] == 1, str(st["counts"]))

print("平台 500：应留在 pending 等重试")
STATE["code"] = 500
EVAL2 = json.loads(json.dumps(EVAL))
EVAL2["holdout"]["field_accuracy"] = 0.95  # 改一个数 → 新幂等键
delivery.enqueue(EVAL2)
res = delivery.flush()
chk("记为待重试", res["retry"] == 1, str(res))
chk("不丢，仍在 pending", outbox_status()["counts"]["pending"] == 1)

print("平台恢复：重试成功")
STATE["code"] = 201
res = delivery.flush()
chk("重试发送成功", res["sent"] == 1, str(res))
chk("pending 清零", outbox_status()["counts"]["pending"] == 0)

print("平台 400：契约错误不重试")
STATE["code"] = 400
EVAL3 = json.loads(json.dumps(EVAL))
EVAL3["holdout"]["field_accuracy"] = 0.90
delivery.enqueue(EVAL3)
res = delivery.flush()
chk("记为永久失败", res["failed"] == 1, str(res))
chk("不再留在 pending", outbox_status()["counts"]["pending"] == 0)
chk("failed 计数 1", outbox_status()["counts"]["failed"] == 1)

print("失败项修好后可重新排队")
q3 = delivery.enqueue(EVAL3)
chk("failed 项重新入队为 pending", q3["created"] is False and q3["status"] == "pending",
    str({k: q3[k] for k in ("created", "status")}))
STATE["code"] = 201
res = delivery.flush()
chk("重新发送成功", res["sent"] == 1, str(res))
chk("failed 计数归零", outbox_status()["counts"]["failed"] == 0)

print("未配置时明确拒绝")
delivery.PLATFORM_URL = ""
chk("enabled=False", not delivery.enabled())
res = delivery.flush()
chk("flush 返回未配置", res.get("ok") is False and "未配置" in res.get("error", ""))

server.shutdown()
print()
print("全部通过" if ok else "有失败项")
sys.exit(0 if ok else 1)
