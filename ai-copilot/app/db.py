"""数据库访问层（C4）。

两种后端，一套调用：
- 默认：SQLite（`DB_PATH`，单机演示）
- 生产：PostgreSQL（`DATABASE_URL=postgres://...`，多实例）

为什么不用 ORM：
- 现有 SQL 很直白，换 ORM 等于重写；这里只做**方言适配**
- 需要兼容的差异只有：占位符、`PRAGMA`、`rowid`、批量建表

上层 `store.py` 继续写 `conn.execute(sql, params)`，由 `Conn` 负责：
- `?` → `%s`（跳过字符串字面量里的问号）
- SQLite 的 `rowid` → PostgreSQL 的 `ctid`（仅用于展示排序，见 `ROW_ORDER`）
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager

from .config import settings

DATABASE_URL = (os.getenv("DATABASE_URL", "") or os.getenv("DB_URL", "")).strip()
BACKEND = "postgres" if DATABASE_URL.startswith(("postgres://", "postgresql://")) else "sqlite"

# PostgreSQL 没有 rowid；ctid 表示物理行位置，用作展示排序的兜底。
ROW_ORDER = "ctid" if BACKEND == "postgres" else "rowid"


def _to_pyformat(sql: str) -> str:
    """把 `?` 占位符换成 `%s`，不碰单引号里的内容。"""
    out: list[str] = []
    in_str = False
    for ch in sql:
        if ch == "'":
            in_str = not in_str
            out.append(ch)
        elif ch == "?" and not in_str:
            out.append("%s")
        else:
            out.append(ch)
    return "".join(out)


def _split_sql(script: str) -> list[str]:
    """按分号拆语句，跳过字符串字面量。"""
    stmts: list[str] = []
    buf: list[str] = []
    in_str = False
    for ch in script:
        if ch == "'":
            in_str = not in_str
        if ch == ";" and not in_str:
            stmt = "".join(buf).strip()
            if stmt:
                stmts.append(stmt)
            buf = []
        else:
            buf.append(ch)
    tail = "".join(buf).strip()
    if tail:
        stmts.append(tail)
    return stmts


class Conn:
    """统一连接对象；对上层暴露与 sqlite3.Connection 相同的最小接口。"""

    def __init__(self, raw):
        self.raw = raw
        self.backend = BACKEND

    def execute(self, sql: str, params=()):
        if self.backend == "postgres":
            sql = _to_pyformat(sql)
            if params:
                return self.raw.execute(sql, tuple(params))
            return self.raw.execute(sql)
        return self.raw.execute(sql, params)

    def executescript(self, script: str) -> None:
        if self.backend == "postgres":
            for stmt in _split_sql(script):
                self.raw.execute(stmt)
        else:
            self.raw.executescript(script)

    def __getattr__(self, name):
        return getattr(self.raw, name)


@contextmanager
def connect():
    """每次操作一个连接；成功提交，异常回滚，最后关闭。"""
    if BACKEND == "postgres":
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:
            raise RuntimeError(
                "使用 PostgreSQL 需先安装：pip install 'psycopg[binary]>=3.2'"
            ) from exc

        raw = psycopg.connect(DATABASE_URL, row_factory=dict_row)
        conn = Conn(raw)
    else:
        raw = sqlite3.connect(settings.db_path, timeout=10)
        raw.row_factory = sqlite3.Row
        raw.execute("PRAGMA busy_timeout=5000")
        raw.execute("PRAGMA foreign_keys=ON")
        raw.execute("PRAGMA synchronous=NORMAL")
        conn = Conn(raw)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def describe() -> dict:
    """健康检查用：不暴露连接串里的密码。"""
    if BACKEND == "postgres":
        return {"backend": "postgres"}
    return {"backend": "sqlite", "path": str(settings.db_path)}
