"""整体验收 · API 侧（可重复运行）。

覆盖：健康/指标、未登录拦截、四角色权限、解析→确认→撤销、
地址校验、异常费用、学习队列读取、阈值权限、回写状态。

用法：
    PYTHONPATH=. .venv/bin/python scripts/acceptance_api.py
    BASE=http://127.0.0.1:8790 ... 
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

BASE = os.getenv("BASE", "http://127.0.0.1:8790").rstrip("/")
PASS = FAIL = 0


def chk(name: str, cond: bool, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}{('  ' + extra) if extra else ''}")


def opener():
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(CookieJar()))


def call(op, method: str, path: str, body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    try:
        with op.open(req, timeout=180) as r:
            text = r.read().decode()
            return r.status, (text if raw else json.loads(text))
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try:
            return e.code, json.loads(text)
        except json.JSONDecodeError:
            return e.code, text


def login(email: str, password: str):
    op = opener()
    code, body = call(op, "POST", "/api/auth/login",
                      {"email": email, "password": password})
    if code != 200:
        raise SystemExit(f"登录失败 {email}: {code} {body}")
    return op


print("1. 健康与指标")
code, h = call(opener(), "GET", "/api/health")
chk("health 200", code == 200)
chk("数据库 WAL", h.get("db", {}).get("journal_mode") == "wal", str(h.get("db")))
chk("存储健康", h.get("storage", {}).get("ok") is True)
code, m = call(opener(), "GET", "/metrics", raw=True)
chk("metrics 200", code == 200)
chk("copilot_up 1", "copilot_up 1" in m)

print("2. 未登录拦截")
code, _ = call(opener(), "GET", "/api/metrics")
chk("/api/metrics 未登录 401", code == 401, str(code))

print("3. 四角色权限")
admin = login("admin@local", "admin12345x")
op = login("op@local", "op12345abc")
fin = login("fin@local", "fin12345abc")
view = login("view@local", "view12345ab")

TEXT = ("客户：验收测试\n委托单号：ACC-0001\n箱型：40HQ\n箱量：1\n"
        "箱号：CSQU3054383\n提箱地：北仑二期堆场\n卸货地：宁波北仑春晓\n"
        "截港时间：2026-12-31 18:00")

code, _ = call(op, "POST", "/api/extract", {"text": TEXT, "use_llm": False})
chk("operator 解析托书 200", code == 200, str(code))
code, _ = call(op, "POST", "/api/invoice/extract", {"text": "发票号码：1", "use_llm": False})
chk("operator 调发票 403", code == 403, str(code))
code, _ = call(fin, "POST", "/api/extract", {"text": TEXT, "use_llm": False})
chk("finance 调托书 403", code == 403, str(code))
code, _ = call(view, "POST", "/api/extract", {"text": TEXT, "use_llm": False})
chk("viewer 写操作 403", code == 403, str(code))
code, _ = call(fin, "GET", "/api/users")
chk("finance 调用户管理 403", code == 403, str(code))
code, _ = call(admin, "GET", "/api/settings")
chk("admin 读阈值 200", code == 200, str(code))
code, _ = call(fin, "GET", "/api/settings")
chk("finance 读阈值 403", code == 403, str(code))

print("4. 解析 → 确认 → 撤销")
code, d = call(op, "POST", "/api/extract", {"text": TEXT, "use_llm": False})
chk("解析成功", code == 200 and d.get("fields", {}).get("container_no", {}).get("value") == "CSQU3054383")
rid = d["run_id"]
auto = {k: v.get("value") or "" for k, v in d["fields"].items()}
code, c = call(op, "POST", "/api/confirm",
               {"run_id": rid, "auto": auto, "final": auto, "handle_ms": 15000})
chk("operator 确认成功", code == 200 and c.get("version") == 1, str(c)[:120])
code, u = call(op, "POST", f"/api/runs/{rid}/undo", {"note": "验收"})
chk("operator 撤销 403", code == 403, str(code))
code, u = call(admin, "POST", f"/api/runs/{rid}/undo",
               {"note": "验收：确认错了", "version": 1})
chk("admin 撤销成功", code == 200 and u.get("version") == 2, str(u)[:120])
code, a = call(admin, "GET", f"/api/audit/{rid}")
chk("审计含 confirm→undo", [x["action"] for x in a.get("revisions", [])][:2] == ["undo", "confirm"])
chk("撤销后 confirmed=0", a.get("confirmed") == 0, str(a.get("confirmed")))

print("5. 地址校验")
BAD = TEXT.replace("提箱地：北仑二期堆场", "提箱地：北仓二期堆场") \
          .replace("卸货地：宁波北仑春晓", "卸货地：上海市北仑区某路")
code, d = call(op, "POST", "/api/extract", {"text": BAD, "use_llm": False})
codes = {c["code"] for c in d.get("checks", [])}
chk("地址错别字告警", "W_ADDR_TYPO" in codes, str(sorted(codes)))
chk("区县/港区冲突告警",
    "W_ADDR_DISTRICT_MISMATCH" in codes or "W_ADDR_PORT_CONFLICT" in codes)

print("6. 异常费用")
FEE = ("运单号,费用名称,数量,单价,金额\n"
       "ACC-1,运费,1,2600,2600\nACC-1,运费,1,2600,2600\n"
       "ACC-2,运费,1,2800,2900\nACC-3,运费,1,2500,2500\n"
       "ACC-4,运费,1,2550,2550\nACC-5,运费,1,9000,9000")
code, f = call(fin, "POST", "/api/fees/check", {"text": FEE})
chk("费用检查 200", code == 200)
chk("重复收费", "E_FEE_DUPLICATE" in f.get("by_code", {}))
chk("算术不符", "E_FEE_ARITHMETIC" in f.get("by_code", {}))
chk("同批离群", "W_FEE_OUTLIER" in f.get("by_code", {}))
code, _ = call(op, "POST", "/api/fees/check", {"text": FEE})
chk("operator 调费用检查 403", code == 403, str(code))

print("7. 学习队列")
code, st = call(admin, "GET", "/api/learn/stats")
chk("统计可读", code == 200 and "pending" in st)
code, q = call(admin, "GET", "/api/learn/queue?status=pending&limit=1")
if q.get("items"):
    rid2 = q["items"][0]["id"]
    code, item = call(admin, "GET", f"/api/learn/item/{rid2}")
    chk("单条详情含原文与字段名", code == 200 and bool(item.get("field_order")))
else:
    print("  - 队列为空，跳过单条详情")

print("8. 回写状态与指标")
code, ds = call(admin, "GET", "/api/delivery/status")
chk("回写状态可读", code == 200 and "counts" in ds)
chk("发件箱计数存在", set(ds.get("counts", {})) >= {"pending", "sent", "failed"})
code, met = call(admin, "GET", "/api/metrics")
chk("业务指标可读", code == 200 and "tickets_parsed" in met)

print()
print(f"通过 {PASS} 项，失败 {FAIL} 项")
sys.exit(0 if FAIL == 0 else 1)
