/**
 * 企业微信回调的最小反向代理。
 *
 * 只放行 /api/wecom/callback，避免把整个 ai-copilot 暴露到公网。
 *
 *   node scripts/wecom_callback_proxy.mjs
 *   cloudflared tunnel --url http://127.0.0.1:8791 --no-autoupdate
 */
import http from 'node:http';

const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = Number(process.env.COPILOT_PORT || 8790);
const LISTEN_PORT = Number(process.env.WECOM_PROXY_PORT || 8791);
const ALLOW = new Set(['/api/wecom/callback', '/api/health']);

const server = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (!ALLOW.has(path)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  const proxy = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` },
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxy.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`upstream error: ${err.message}`);
  });
  req.pipe(proxy);
});

server.listen(LISTEN_PORT, TARGET_HOST, () => {
  console.log(`wecom callback proxy: http://${TARGET_HOST}:${LISTEN_PORT} -> http://${TARGET_HOST}:${TARGET_PORT}`);
  console.log('allowed: /api/wecom/callback, /api/health');
});
