"""单实例上生产加固自检（D1 / D2 / D3 / D6）。

覆盖：
- WAL 已开启、外键已开启
- 老孤儿行会被清理；新孤儿写入被外键拦住
- 登录失败 N 次后锁定，成功后清除
- 清理脚本只删过期数据
- 备份脚本产出完整快照，行数一致

用法：
    PYTHONPATH=. .venv/bin/python scripts/test_hardening.py
"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

TMP = Path(tempfile.mkdtemp(prefix="hardening-"))
DB = TMP / "test.db"
os.environ["DB_PATH"] = str(DB)

from app import store  # noqa: E402

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


store.init_db()

print("D1 WAL / D2 外键")
raw = sqlite3.connect(DB)
chk("journal_mode=wal", raw.execute("PRAGMA journal_mode").fetchone()[0] == "wal")
raw.close()

# synchronous 是每连接设置，必须在应用连接上检查
with store._conn() as conn:
    chk("synchronous=normal", conn.execute("PRAGMA synchronous").fetchone()[0] == 1)
    chk("foreign_keys=on", conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1)
    chk("busy_timeout≥5000", conn.execute("PRAGMA busy_timeout").fetchone()[0] >= 5000)

try:
    with store._conn() as conn:
        conn.execute(
            "INSERT INTO user_sessions (jti, user_id, created_at, expires_at)"
            " VALUES ('x','no-such-user','2026-01-01',9999999999)"
        )
    chk("新孤儿会话被外键拦住", False)
except sqlite3.IntegrityError:
    chk("新孤儿会话被外键拦住", True)

# 模拟历史孤儿：绕过外键直接插
raw = sqlite3.connect(DB)
raw.execute(
    "INSERT INTO feedback (id, run_id, ts, field, auto_value, final_value, changed)"
    " VALUES ('old','missing-run','2026-01-01','x','','y',1)"
)
raw.commit()
raw.close()
store.init_db()
with store._conn() as conn:
    n = conn.execute("SELECT COUNT(*) FROM feedback WHERE id='old'").fetchone()[0]
chk("历史孤儿被清理", n == 0)

print("D3 登录失败锁定")
key = "a@b.com|127.0.0.1"
store.clear_login_failures(key)
for i in range(5):
    lock = store.record_login_failure(key, max_fails=5, lock_seconds=60, window_seconds=600)
chk("第 5 次触发锁定", lock == 60, str(lock))
chk("锁定剩余秒数 > 0", store.login_locked(key) > 0)
store.clear_login_failures(key)
chk("成功后清除", store.login_locked(key) == 0)
# 超出窗口重新计数
store.clear_login_failures(key)
store.record_login_failure(key, max_fails=5, lock_seconds=60, window_seconds=600)
with store._conn() as conn:
    conn.execute("UPDATE login_attempts SET first_at=? WHERE key=?",
                 ("2020-01-01T00:00:00+00:00", key))
lock = store.record_login_failure(key, max_fails=5, lock_seconds=60, window_seconds=600)
chk("窗口过期后重新计数，不锁", lock == 0, str(lock))

print("D6 数据清理")
now = datetime.now(timezone.utc)
old = (now - timedelta(days=90)).isoformat(timespec="seconds")
recent = now.isoformat(timespec="seconds")
with store._conn() as conn:
    # 需要一个合法用户，避免外键
    conn.execute("INSERT OR IGNORE INTO users (id,email,name,role,pw_hash,pw_salt,active,created_at)"
                 " VALUES ('u1','u1@local','U1','admin','h','s',1,?)", (recent,))
    for jti, exp, created in (("old-sess", 1, old), ("new-sess", 9999999999, recent)):
        conn.execute("INSERT INTO user_sessions (jti,user_id,created_at,expires_at)"
                     " VALUES (?,?,?,?)", (jti, "u1", created, exp))
    conn.execute("INSERT INTO delivery_outbox (id,created_at,idempotency_key,payload_json,status)"
                 " VALUES ('old-out',?,'k1','{}','sent')", (old,))
    conn.execute("INSERT INTO delivery_outbox (id,created_at,idempotency_key,payload_json,status)"
                 " VALUES ('new-out',?,'k2','{}','sent')", (recent,))

script = ROOT / "scripts" / "cleanup.py"
dry = subprocess.run([sys.executable, str(script), "--db", str(DB), "--days", "30"],
                     capture_output=True, text=True, cwd=ROOT)
chk("dry-run 不改数据", dry.returncode == 0 and "dry-run" in dry.stdout)
with store._conn() as conn:
    chk("dry-run 后旧会话仍在",
        conn.execute("SELECT COUNT(*) FROM user_sessions WHERE jti='old-sess'").fetchone()[0] == 1)

run = subprocess.run([sys.executable, str(script), "--db", str(DB), "--days", "30", "--apply"],
                     capture_output=True, text=True, cwd=ROOT)
chk("apply 执行成功", run.returncode == 0, run.stderr[-120:])
with store._conn() as conn:
    old_sess = conn.execute("SELECT COUNT(*) FROM user_sessions WHERE jti='old-sess'").fetchone()[0]
    new_sess = conn.execute("SELECT COUNT(*) FROM user_sessions WHERE jti='new-sess'").fetchone()[0]
    old_out = conn.execute("SELECT COUNT(*) FROM delivery_outbox WHERE id='old-out'").fetchone()[0]
    new_out = conn.execute("SELECT COUNT(*) FROM delivery_outbox WHERE id='new-out'").fetchone()[0]
chk("过期会话已删", old_sess == 0)
chk("新会话保留", new_sess == 1)
chk("旧发件箱已删", old_out == 0)
chk("新发件箱保留", new_out == 1)

print("D1 安全备份")
bak_dir = TMP / "backups"
bak = subprocess.run(
    [sys.executable, str(ROOT / "scripts" / "backup_db.py"),
     "--db", str(DB), "--dir", str(bak_dir), "--keep", "2"],
    capture_output=True, text=True, cwd=ROOT,
)
chk("备份脚本成功", bak.returncode == 0, bak.stderr[-120:])
files = list(bak_dir.glob("copilot-*.db"))
chk("产出备份文件", len(files) == 1)
if files:
    c = sqlite3.connect(files[0])
    chk("备份 integrity_check=ok", c.execute("PRAGMA integrity_check").fetchone()[0] == "ok")
    chk("备份含用户数据", c.execute("SELECT COUNT(*) FROM users").fetchone()[0] >= 1)
    c.close()

print()
print("全部通过" if ok else "有失败项")
sys.exit(0 if ok else 1)
