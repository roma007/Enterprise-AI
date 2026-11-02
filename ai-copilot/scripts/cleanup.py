"""数据保留与清理（D6）。

只增不删的库，早晚会拖慢备份和查询。这个脚本按保留期清理“确定可以删”的数据：

- 已过期的登录会话
- 已发送/永久失败的交付平台发件箱
- 过期的登录失败记录
- （需显式开启）超过保留期的解析记录及其明细

**默认 dry-run，不动数据。** 加 `--apply` 才执行。

用法：
    make cleanup                          # 看会删多少
    make cleanup-apply                    # 真正执行
    PYTHONPATH=. .venv/bin/python scripts/cleanup.py --days 180 --apply
    PYTHONPATH=. .venv/bin/python scripts/cleanup.py --runs-days 365 --apply
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(ROOT / "data" / "copilot.db"))
    ap.add_argument("--days", type=int, default=180,
                    help="会话/发件箱/登录记录的保留天数")
    ap.add_argument("--runs-days", type=int, default=0,
                    help="解析记录的保留天数；0 = 不清理业务数据")
    ap.add_argument("--apply", action="store_true", help="真正执行（默认只统计）")
    args = ap.parse_args()

    db = Path(args.db)
    if not db.exists():
        print(f"✗ 数据库不存在：{db}")
        return 1

    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=args.days)).isoformat(timespec="seconds")
    runs_cutoff = (now - timedelta(days=args.runs_days)).isoformat(timespec="seconds") \
        if args.runs_days > 0 else ""
    epoch = int(time.time())

    plan = [
        ("过期会话",
         "SELECT COUNT(*) AS n FROM user_sessions WHERE expires_at < ? OR created_at < ?",
         "DELETE FROM user_sessions WHERE expires_at < ? OR created_at < ?",
         (epoch, cutoff)),
        ("已结束发件箱",
         "SELECT COUNT(*) AS n FROM delivery_outbox"
         " WHERE status IN ('sent','failed','sending') AND created_at < ?",
         "DELETE FROM delivery_outbox"
         " WHERE status IN ('sent','failed','sending') AND created_at < ?",
         (cutoff,)),
        ("登录失败记录",
         "SELECT COUNT(*) AS n FROM login_attempts WHERE first_at < ?",
         "DELETE FROM login_attempts WHERE first_at < ?",
         (cutoff,)),
    ]
    if runs_cutoff:
        plan.extend([
            ("解析明细 feedback",
             "SELECT COUNT(*) AS n FROM feedback WHERE run_id IN"
             " (SELECT id FROM runs WHERE ts < ?)",
             "DELETE FROM feedback WHERE run_id IN"
             " (SELECT id FROM runs WHERE ts < ?)", (runs_cutoff,)),
            ("修订流水 run_revisions",
             "SELECT COUNT(*) AS n FROM run_revisions WHERE run_id IN"
             " (SELECT id FROM runs WHERE ts < ?)",
             "DELETE FROM run_revisions WHERE run_id IN"
             " (SELECT id FROM runs WHERE ts < ?)", (runs_cutoff,)),
            ("学习队列 learn_queue",
             "SELECT COUNT(*) AS n FROM learn_queue WHERE run_id IN"
             " (SELECT id FROM runs WHERE ts < ?)",
             "DELETE FROM learn_queue WHERE run_id IN"
             " (SELECT id FROM runs WHERE ts < ?)", (runs_cutoff,)),
            ("解析记录 runs",
             "SELECT COUNT(*) AS n FROM runs WHERE ts < ?",
             "DELETE FROM runs WHERE ts < ?", (runs_cutoff,)),
        ])

    def run(conn) -> tuple[int, bool]:
        print(f"数据库：{'PostgreSQL' if pg else db}")
        print(f"保留期：{args.days} 天" + (f" ｜ 解析记录 {args.runs_days} 天" if runs_cutoff else ""))
        print(f"模式：{'执行' if args.apply else 'dry-run（只统计）'}")
        print()
        total = 0
        for name, count_sql, _delete_sql, params in plan:
            n = conn.execute(count_sql, params).fetchone()["n"]
            total += n
            print(f"  {name:22} {n:>6}")
        print(f"  {'合计':22} {total:>6}")
        if not args.apply:
            print("\n未改动数据。确认无误后加 --apply 执行。")
            return total, False
        if total == 0:
            print("\n没有需要清理的数据。")
            return total, False
        for _, _count_sql, delete_sql, params in plan:
            conn.execute(delete_sql, params)
        return total, True

    pg = (os.getenv("DATABASE_URL", "") or "").startswith(("postgres://", "postgresql://"))
    if pg:
        sys.path.insert(0, str(ROOT))
        from app import db as _db
        with _db.connect() as conn:
            total, changed = run(conn)
        if changed:
            import psycopg
            with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as ac:
                ac.execute("VACUUM")
            print(f"\n✓ 已清理 {total} 行，并执行 VACUUM。")
            print("  建议随后执行一次 `pg_dump` 留档。")
        return 0

    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    try:
        total, changed = run(conn)
        if changed:
            conn.commit()
            conn.execute("VACUUM")
            print(f"\n✓ 已清理 {total} 行，并执行 VACUUM。")
            print("  建议随后执行一次 `make backup` 留档。")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
