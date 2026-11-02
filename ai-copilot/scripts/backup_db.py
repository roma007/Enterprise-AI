"""安全备份 SQLite 数据库（D1）。

为什么不能直接 `cp data/copilot.db`：
- WAL 模式下，最新数据可能还在 `-wal` 文件里，只拷主文件会丢最近写入
- 服务运行中直接拷，可能拿到写到一半的页

`sqlite3.Connection.backup()` 是 SQLite 官方的在线备份 API，
会处理 WAL 与并发写，得到一致性快照。

用法：
    make backup
    PYTHONPATH=. .venv/bin/python scripts/backup_db.py --keep 14
    PYTHONPATH=. .venv/bin/python scripts/backup_db.py --db data/copilot.db --dir backups
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def counts(db: Path) -> dict[str, int]:
    conn = sqlite3.connect(db)
    try:
        out = {}
        for table in ("runs", "feedback", "users", "batches", "learn_queue"):
            try:
                out[table] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            except sqlite3.Error:
                pass
        return out
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(ROOT / "data" / "copilot.db"))
    ap.add_argument("--dir", default=str(ROOT / "backups"))
    ap.add_argument("--keep", type=int, default=14, help="保留最近 N 份（0 = 不清理）")
    args = ap.parse_args()

    if (os.getenv("DATABASE_URL", "") or "").startswith(("postgres://", "postgresql://")) \
            and "--db" not in sys.argv:
        print("当前 DATABASE_URL 指向 PostgreSQL，请使用 pg_dump：")
        print('  pg_dump -Fc "$DATABASE_URL" > backups/copilot-$(date +%F).dump')
        return 2

    src = Path(args.db)
    if not src.exists():
        print(f"✗ 源库不存在：{src}")
        return 1

    dest_dir = Path(args.dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = dest_dir / f"copilot-{stamp}.db"
    if dest.exists():
        dest = dest_dir / f"copilot-{stamp}-{src.stat().st_size}.db"

    # 在线备份：自动包含 WAL 中已提交的数据
    src_conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    dest_conn = sqlite3.connect(dest)
    try:
        src_conn.backup(dest_conn)
        dest_conn.commit()
        check = dest_conn.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        src_conn.close()
        dest_conn.close()

    if check != "ok":
        print(f"✗ 备份完整性检查失败：{check}")
        dest.unlink(missing_ok=True)
        return 2

    before, after = counts(src), counts(dest)
    if before != after:
        print(f"✗ 行数不一致：源 {before} / 备份 {after}")
        return 3

    print(f"✓ 备份完成：{dest}")
    print(f"  大小 {dest.stat().st_size / 1024:.1f} KB ｜ integrity_check=ok")
    print("  行数 " + " ".join(f"{k}={v}" for k, v in after.items()))

    if args.keep > 0:
        files = sorted(dest_dir.glob("copilot-*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in files[args.keep:]:
            old.unlink()
            print(f"  清理旧备份：{old.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
