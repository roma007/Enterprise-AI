#!/usr/bin/env bash
# 演示前 30 秒自检：服务活着、解析通路通、规则能挑错、评测能跑。
# 用法：./scripts/smoke.sh [base_url]
set -uo pipefail
BASE="${1:-http://127.0.0.1:8790}"
fail=0

chk() { # name, ok
  if [ "$2" = "1" ]; then echo "  ✓ $1"; else echo "  ✗ $1"; fail=1; fi
}

echo "smoke: $BASE"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")
[ "$code" = "200" ] && chk "health" 1 || chk "health ($code)" 0

good=$(curl -s -X POST "$BASE/api/extract" -H 'Content-Type: application/json' -d '{
 "text":"客户：宏远国际货代\n委托单号：HY2026110501\n箱型：40HQ\n箱量：1\n箱号：CSQU3054383\n封号：SL8823101\n提箱地：北仑二期堆场\n卸货地：宁波北仑春晓工业园3号仓\n截港时间：2026-12-07 18:00"
}')
echo "$good" | grep -q '"container_no":{"value":"CSQU3054383"' \
  && chk "解析出箱号" 1 || chk "解析出箱号" 0

bad=$(curl -s -X POST "$BASE/api/extract" -H 'Content-Type: application/json' -d '{
 "text":"客户：联盛物流\n委托单号：LS-1111\n箱型：40GP\n箱量：1\n箱号：MSCU1234560\n提箱地：北仑三期堆场\n卸货地：宁波奉化\n截港时间：2026-12-05 17:00"
}')
echo "$bad" | grep -q 'E_CONTAINER_CHECKSUM' && chk "箱号校验位能挑错" 1 || chk "箱号校验位能挑错" 0

past=$(curl -s -X POST "$BASE/api/extract" -H 'Content-Type: application/json' -d '{
 "text":"客户：嘉禾货运\n委托单号：JH-1028\n箱型：40HQ\n箱量：1\n箱号：CSQU3054383\n提箱地：北仑二期堆场\n卸货地：宁波北仑明州路\n截港时间：2020-01-01 18:00"
}')
echo "$past" | grep -q 'E_CLOSING_PASSED' && chk "截港过期能报警" 1 || chk "截港过期能报警" 0

ev=$(curl -s -X POST "$BASE/api/eval")
echo "$ev" | grep -q '"holdout"' && chk "评测可运行" 1 || chk "评测可运行" 0

# OCR 为可选依赖：装了才测，没装明确跳过
ocr_ready=$(curl -s "$BASE/api/meta" | grep -o '"ocr_ready": *true' || true)
if [ -n "$ocr_ready" ]; then
  img="$(dirname "$0")/../samples/fixtures/booking_sample.png"
  if [ -f "$img" ]; then
    up=$(curl -s -X POST "$BASE/api/extract/upload" -F "file=@$img")
    echo "$up" | grep -q 'CSQU3054383' && chk "OCR 识别箱号" 1 || chk "OCR 识别箱号" 0
  else
    chk "OCR 测试图存在（先跑 scripts/make_test_image.py）" 0
  fi
else
  echo "  - OCR 未安装，跳过上传测试"
fi

echo
if [ "$fail" = "0" ]; then echo "全部通过，可以去见客户。"; else echo "有失败项，先修再出门。"; exit 1; fi
