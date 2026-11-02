"""D4 指标自检：格式、标签转义、HTTP 计数。

不启动服务：直接调 render()，重点验证 Prometheus 能解析的格式约束：
- 每个指标名只有一组 HELP/TYPE
- 标签值转义正确
- 计数在 observe() 后出现
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.pop("DATABASE_URL", None)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import metrics  # noqa: E402

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


metrics.observe("get", "/api/audit/abcdef123456", 200, 12.5)
metrics.observe("GET", "/api/audit/abcdef123456", 500, 7.5)
out = metrics.render()
lines = out.splitlines()

chk("以 copilot_up 开头", lines[0].startswith("# HELP copilot_up") and "copilot_up 1" in out)
chk("版本标签存在", 'copilot_info{version=' in out)
chk("数据库大小分 main/wal/shm",
    out.count('copilot_db_size_bytes{') == 3)
chk("HTTP 请求计数出现",
    'copilot_http_requests_total{method="GET",route="/api/audit/:id",status="200"} 1' in out)
chk("耗时 summary 出现",
    'copilot_http_request_duration_seconds_count{method="GET",route="/api/audit/:id"} 2' in out)

names = [ln.split()[2] for ln in lines if ln.startswith("# TYPE ")]
chk("每个指标名只有一组 TYPE", len(names) == len(set(names)),
    f"{len(names)} 组 / {len(set(names))} 唯一")

# 标签转义：不该出现未转义的引号
metrics.observe("GET", '/api/x"quote', 200, 1)
out2 = metrics.render()
chk("标签引号被转义", '\\"' in out2)

print()
print("全部通过" if ok else "有失败项")
sys.exit(0 if ok else 1)
