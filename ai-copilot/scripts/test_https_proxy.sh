#!/usr/bin/env bash
# D5 自检：用真实 nginx + 自签证书验证 HTTPS 反向代理。
#
# 验证：
#   1. nginx 配置语法
#   2. HTTPS 健康检查 200
#   3. HTTP 自动 301 到 HTTPS
#   4. 登录 Cookie 带 Secure（应用侧 COOKIE_SECURE=true）
#   5. /metrics token 保护在反代后仍有效
#
# 用法：./scripts/test_https_proxy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
HTTP_PORT="${HTTP_PORT:-18080}"
HTTPS_PORT="${HTTPS_PORT:-18443}"
UP_PORT="${UP_PORT:-18797}"
UP=""

cleanup() {
  if [ -f "$TMP/nginx.pid" ]; then
    kill "$(cat "$TMP/nginx.pid")" 2>/dev/null || true
  fi
  if [ -n "$UP" ]; then
    kill "$UP" 2>/dev/null || true
    wait "$UP" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

for bin in nginx openssl curl; do
  command -v "$bin" >/dev/null || { echo "✗ 缺少 $bin"; exit 1; }
done

echo "1. 生成自签证书"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" >/dev/null 2>&1

echo "2. 启动 ai-copilot（COOKIE_SECURE=true, METRICS_TOKEN=testtoken）"
cd "$ROOT"
METRICS_TOKEN=testtoken COOKIE_SECURE=true \
  PYTHONPATH=. .venv/bin/python -m uvicorn app.main:app \
  --port "$UP_PORT" --log-level warning >"$TMP/up.log" 2>&1 &
UP=$!
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$UP_PORT/api/health" && break
  sleep 0.25
done
curl -s -o /dev/null "http://127.0.0.1:$UP_PORT/api/health" || {
  echo "✗ 上游没起来"; tail -20 "$TMP/up.log"; exit 1; }

echo "3. 渲染 nginx 配置并检查语法"
mkdir -p "$TMP/client" "$TMP/proxy" "$TMP/fastcgi" "$TMP/uwsgi" "$TMP/scgi"
sed \
  -e "s|__SERVER_NAME__|localhost|g" \
  -e "s|__CERT__|$TMP/cert.pem|g" \
  -e "s|__KEY__|$TMP/key.pem|g" \
  -e "s|__UPSTREAM__|127.0.0.1:$UP_PORT|g" \
  -e "s|__HTTP_PORT__|$HTTP_PORT|g" \
  -e "s|__HTTPS_PORT__|$HTTPS_PORT|g" \
  "$ROOT/ops/nginx/copilot.conf" >"$TMP/site.conf"

cat >"$TMP/nginx.conf" <<EOF
worker_processes 1;
pid $TMP/nginx.pid;
error_log $TMP/error.log warn;
events { worker_connections 64; }
http {
  access_log off;
  client_body_temp_path $TMP/client;
  proxy_temp_path $TMP/proxy;
  fastcgi_temp_path $TMP/fastcgi;
  uwsgi_temp_path $TMP/uwsgi;
  scgi_temp_path $TMP/scgi;
  include $TMP/site.conf;
}
EOF

nginx -t -c "$TMP/nginx.conf" -p "$TMP" 2>&1 | sed 's/^/   /'
nginx -c "$TMP/nginx.conf" -p "$TMP"
sleep 1

fail=0
chk() { if [ "$2" = "1" ]; then echo "  ✓ $1"; else echo "  ✗ $1"; fail=1; fi; }

echo "4. 验证"
code=$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$HTTPS_PORT/api/health")
[ "$code" = "200" ] && chk "HTTPS 健康检查 200" 1 || chk "HTTPS 健康检查（$code）" 0

hsts=$(curl -skI "https://127.0.0.1:$HTTPS_PORT/api/health" | tr -d '\r' | grep -ci '^strict-transport-security:')
[ "$hsts" -ge 1 ] && chk "HSTS 响应头存在" 1 || chk "HSTS 响应头存在" 0

loc=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://127.0.0.1:$HTTP_PORT/api/health")
echo "$loc" | grep -q '^301 https://' && chk "HTTP 301 到 HTTPS" 1 || chk "HTTP 301 到 HTTPS（$loc）" 0

cookie=$(curl -sk -D - -o /dev/null -X POST "https://127.0.0.1:$HTTPS_PORT/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@local","password":"admin12345x"}' | tr -d '\r' | grep -i '^set-cookie:')
echo "$cookie" | grep -qi 'secure' && chk "登录 Cookie 带 Secure" 1 || chk "登录 Cookie 带 Secure" 0

code=$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$HTTPS_PORT/metrics")
[ "$code" = "401" ] && chk "反代后 /metrics 无 token 401" 1 || chk "反代后 /metrics 无 token（$code）" 0
code=$(curl -sk -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer testtoken' \
  "https://127.0.0.1:$HTTPS_PORT/metrics")
[ "$code" = "200" ] && chk "反代后 /metrics 带 token 200" 1 || chk "反代后 /metrics 带 token（$code）" 0
curl -sk -H 'Authorization: Bearer testtoken' "https://127.0.0.1:$HTTPS_PORT/metrics" \
  | grep -q '^copilot_up 1' && chk "指标内容正确" 1 || chk "指标内容正确" 0

echo
if [ "$fail" = "0" ]; then echo "全部通过"; else echo "有失败项"; exit 1; fi
