#!/usr/bin/env bash
# 演示前 30 秒自检：服务活着、登录可用、解析通路通、规则能挑错、评测能跑。
# 用法：
#   ADMIN_PASSWORD=xxx ./scripts/smoke.sh [base_url]
# 未提供密码时只跑公开检查，并明确提示跳过项。
set -uo pipefail
BASE="${1:-http://127.0.0.1:8790}"
COOKIE="$(mktemp)"

# 读项目根目录的 .env（里面有 ADMIN_EMAIL / ADMIN_PASSWORD）
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi
fail=0

chk() {
  if [ "$2" = "1" ]; then echo "  ✓ $1"; else echo "  ✗ $1"; fail=1; fi
}

echo "smoke: $BASE"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")
[ "$code" = "200" ] && chk "health（公开）" 1 || chk "health（${code}）" 0

# 鉴权
authed=0
if [ -n "${ADMIN_PASSWORD:-}" ]; then
  EMAIL="${ADMIN_EMAIL:-admin@local}"
  body=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$ADMIN_PASSWORD")
  if curl -s -c "$COOKIE" -X POST "$BASE/api/auth/login" \
      -H 'Content-Type: application/json' -d "$body" | grep -q '"ok": *true'; then
    chk "登录（${EMAIL}）" 1
    authed=1
  else
    chk "登录（${EMAIL}）" 0
  fi
else
  echo "  - 未设置 ADMIN_PASSWORD，跳过需要登录的检查"
fi

if [ "$authed" = "1" ]; then
  unauth=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/metrics")
  [ "$unauth" = "401" ] && chk "未登录被拦截（401）" 1 || chk "未登录被拦截（得到 ${unauth}）" 0

  good=$(curl -s -b "$COOKIE" -X POST "$BASE/api/extract" -H 'Content-Type: application/json' -d '{
 "text":"客户：宏远国际货代\n委托单号：HY2026110501\n箱型：40HQ\n箱量：1\n箱号：CSQU3054383\n封号：SL8823101\n提箱地：北仑二期堆场\n卸货地：宁波北仑春晓工业园3号仓\n截港时间：2026-12-07 18:00"}')
  echo "$good" | grep -q '"container_no":{"value":"CSQU3054383"' \
    && chk "解析出箱号" 1 || chk "解析出箱号" 0

  bad=$(curl -s -b "$COOKIE" -X POST "$BASE/api/extract" -H 'Content-Type: application/json' -d '{
 "text":"客户：联盛物流\n委托单号：LS-1111\n箱型：40GP\n箱量：1\n箱号：MSCU1234560\n提箱地：北仑三期堆场\n卸货地：宁波奉化\n截港时间：2026-12-05 17:00"}')
  echo "$bad" | grep -q 'E_CONTAINER_CHECKSUM' && chk "箱号校验位能挑错" 1 || chk "箱号校验位能挑错" 0

  past=$(curl -s -b "$COOKIE" -X POST "$BASE/api/extract" -H 'Content-Type: application/json' -d '{
 "text":"客户：嘉禾货运\n委托单号：JH-1028\n箱型：40HQ\n箱量：1\n箱号：CSQU3054383\n提箱地：北仑二期堆场\n卸货地：宁波北仑明州路\n截港时间：2020-01-01 18:00"}')
  echo "$past" | grep -q 'E_CLOSING_PASSED' && chk "截港过期能报警" 1 || chk "截港过期能报警" 0

  ev=$(curl -s -b "$COOKIE" -X POST "$BASE/api/eval")
  echo "$ev" | grep -q '"holdout"' && chk "评测可运行" 1 || chk "评测可运行" 0

  ocr_ready=$(curl -s "$BASE/api/health" | grep -o '"ready": *true' || true)
  if [ -n "$ocr_ready" ]; then
    img="$(dirname "$0")/../samples/fixtures/booking_sample.png"
    if [ -f "$img" ]; then
      up=$(curl -s -b "$COOKIE" -X POST "$BASE/api/extract/upload" -F "file=@$img")
      echo "$up" | grep -q 'CSQU3054383' && chk "OCR 识别箱号" 1 || chk "OCR 识别箱号" 0
    else
      chk "OCR 测试图存在（先跑 scripts/make_test_image.py）" 0
    fi
  else
    echo "  - OCR 未安装，跳过上传测试"
  fi
fi

# 存储后端自检（不依赖服务，直接跑脚本）
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -x "$ROOT_DIR/.venv/bin/python" ]; then
  if (cd "$ROOT_DIR" && PYTHONPATH=. .venv/bin/python scripts/test_storage.py >/dev/null 2>&1); then
    chk "存储后端自检（local + s3 假客户端）" 1
  else
    chk "存储后端自检（local + s3 假客户端）" 0
  fi

  if (cd "$ROOT_DIR" && PYTHONPATH=. .venv/bin/python scripts/test_metrics.py >/dev/null 2>&1); then
    chk "指标格式自检（Prometheus）" 1
  else
    chk "指标格式自检（Prometheus）" 0
  fi

  if (cd "$ROOT_DIR" && PYTHONPATH=. .venv/bin/python scripts/test_hardening.py >/dev/null 2>&1); then
    chk "上生产加固自检（WAL/外键/登录锁定/清理/备份）" 1
  else
    chk "上生产加固自检（WAL/外键/登录锁定/清理/备份）" 0
  fi

  if (cd "$ROOT_DIR" && PYTHONPATH=. .venv/bin/python scripts/test_address.py >/dev/null 2>&1); then
    chk "地址校验自检（B5）" 1
  else
    chk "地址校验自检（B5）" 0
  fi

  if (cd "$ROOT_DIR" && PYTHONPATH=. .venv/bin/python scripts/test_fees.py >/dev/null 2>&1); then
    chk "异常费用自检（B6）" 1
  else
    chk "异常费用自检（B6）" 0
  fi

  if (cd "$ROOT_DIR" && PYTHONPATH=. .venv/bin/python scripts/test_delivery.py >/dev/null 2>&1); then
    chk "回写发件箱自检（幂等 + 重试）" 1
  else
    chk "回写发件箱自检（幂等 + 重试）" 0
  fi

  if (cd "$ROOT_DIR" && PYTHONPATH=. .venv/bin/python -c "from app import wecom_crypto; raise SystemExit(0 if wecom_crypto.available() else 9)") 2>/dev/null; then
    if (cd "$ROOT_DIR" && PYTHONPATH=. .venv/bin/python scripts/test_wecom_crypto.py >/dev/null 2>&1); then
      chk "企微加解密自检（官方向量）" 1
    else
      chk "企微加解密自检（官方向量）" 0
    fi
  else
    echo "  - 未安装 cryptography，跳过企微加解密自检"
  fi
fi

rm -f "$COOKIE"
echo
if [ "$fail" = "0" ]; then echo "全部通过，可以去见客户。"; else echo "有失败项，先修再出门。"; exit 1; fi
