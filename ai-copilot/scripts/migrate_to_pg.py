"""SQLite → PostgreSQL 数据迁移（C4）。

特点：
- 默认 dry-run，只统计不写
- 幂等：重复执行按主键 upsert，不会产生重复行
- 按依赖顺序复制，满足外键
- 复制后比对行数；不一致直接报错
- 不删除、不修改 SQLite 源文件

用法：
    # 先建库
    createdb ai_copilot

    # 看会复制多少
    PYTHONPATH=. .venv/bin/python scripts/migrate_to_pg.py \
        --pg postgres://127.0.0.1:5432/ai_copilot

    # 真正执行
    PYTHONPATH=. .venv/bin/python scripts/migrate_to_pg.py \
        --pg postgres://127.0.0.1:5432/ai_copilot --apply
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 依赖顺序：被引用的表在前
TABLES = [
    ("users", "id"),
    ("inbound", "id"),
    ("runs", "id"),
    ("feedback", "id"),
    ("run_revisions", "id"),
    ("learn_queue", "id"),
    ("batches", "id"),
    ("batch_items", "id"),
    ("user_sessions", "jti"),
    ("delivery_outbox", "id"),
    ("login_attempts", "key"),
    ("jobs", "id"),
]


def q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def source_tables(src: sqlite3.Connection) -> set[str]:
    return {r[0] for r in src.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sqlite", default=str(ROOT / "data" / "copilot.db"))
    ap.add_argument("--pg", required=True, help="postgres://user:pass@host/db")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认 dry-run）")
    args = ap.parse_args()

    src_path = Path(args.sqlite)
    if not src_path.exists():
        print(f"✗ SQLite 源库不存在：{src_path}")
        return 1
    if not args.pg.startswith(("postgres://", "postgresql://")):
        print("✗ --pg 必须是 postgres:// 或 postgresql:// 连接串")
        return 1

    src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    have = source_tables(src)

    print(f"源：{src_path}（{src_path.stat().st_size / 1024:.1f} KB）")
    print(f"目标：{args.pg.split('@')[-1]}")
    print(f"模式：{'执行' if args.apply else 'dry-run（只统计）'}")
    print()

    counts: dict[str, int] = {}
    for table, _pk in TABLES:
        if table in have:
            counts[table] = src.execute(
                f"SELECT COUNT(*) FROM {q(table)}").fetchone()[0]
        else:
            counts[table] = -1  # 源库没有
        shown = "—" if counts[table] < 0 else counts[table]
        print(f"  {table:18} {shown:>8}")

    if not args.apply:
        print("\n未写入。确认无误后加 --apply。")
        return 0

    os.environ["DATABASE_URL"] = args.pg
    sys.path.insert(0, str(ROOT))
    from app import db  # noqa: E402
    from app.store import _conn, init_db  # noqa: E402

    if db.BACKEND != "postgres":
        print("✗ 未能切到 PostgreSQL，请检查 DATABASE_URL")
        return 2

    print("\n初始化目标 schema…")
    init_db()

    inserted = {t: 0 for t, _ in TABLES}
    for table, pk in TABLES:
        if table not in have:
            continue
        rows = src.execute(f"SELECT * FROM {q(table)}").fetchall()
        if not rows:
            continue
        src_cols = list(rows[0].keys())
        with _conn() as conn:
            target_cols = {
                r["column_name"] for r in conn.execute(
                    "SELECT column_name FROM information_schema.columns"
                    " WHERE table_schema='public' AND table_name=?", (table,)
                )
            }
            cols = [c for c in src_cols if c in target_cols]
            if pk not in cols:
                print(f"  ! {table} 目标缺少主键 {pk}，跳过")
                continue
            updates = [c for c in cols if c != pk]
            conflict = (
                "DO UPDATE SET " + ", ".join(
                    f"{q(c)}=EXCLUDED.{q(c)}" for c in updates)
                if updates else "DO NOTHING"
            )
            sql = (
                f"INSERT INTO {q(table)} ({', '.join(q(c) for c in cols)})"
                f" VALUES ({', '.join('?' for _ in cols)})"
                f" ON CONFLICT ({q(pk)}) {conflict}"
            )
            for row in rows:
                conn.execute(sql, tuple(row[c] for c in cols))
        inserted[table] = len(rows)
        print(f"  {table:18} 写入 {len(rows):>6}")

    # 阈值文件是 SQLite 时代的配置；PG 用 app_settings 存，首次迁移带过去
    settings_src = ROOT / "data" / "settings.json"
    if settings_src.exists():
        try:
            data = json.loads(settings_src.read_text(encoding="utf-8"))
            with _conn() as conn:
                exists = conn.execute(
                    "SELECT 1 FROM app_settings WHERE key='thresholds'"
                ).fetchone()
                if not exists:
                    conn.execute(
                        "INSERT INTO app_settings (key, value, updated_at, updated_by)"
                        " VALUES ('thresholds',?,?,?)",
                        (json.dumps(data, ensure_ascii=False),
                         data.get("updated_at", ""), "migrate"),
                    )
                    print("  阈值配置   已从 data/settings.json 迁入")
        except (OSError, json.JSONDecodeError) as exc:
            print(f"  ! 阈值文件读取失败，使用默认值：{exc}")

    print("\n校验行数")
    bad = 0
    for table, _pk in TABLES:
        if counts.get(table, -1) <= 0:
            continue
        with _conn() as conn:
            n = conn.execute(f"SELECT COUNT(*) AS n FROM {q(table)}").fetchone()["n"]
        ok = n == counts[table]
        print(f"  {table:18} 源 {counts[table]:>6} / 目标 {n:>6} {'✓' if ok else '✗'}")
        bad += 0 if ok else 1

    if bad:
        print(f"\n✗ {bad} 张表行数不一致，请检查后再切流")
        return 3

    print("\n✓ 迁移完成，行数一致。")
    print("  下一步：")
    print("    1. 用 DATABASE_URL 启动一个只读验证实例，跑 acceptance_api.py")
    print("    2. 确认无误后，把生产的 DATABASE_URL 指向该库")
    print("    3. 保留 SQLite 文件至少一个备份周期")
    return 0


if __name__ == "__main__":
    sys.exit(main())
