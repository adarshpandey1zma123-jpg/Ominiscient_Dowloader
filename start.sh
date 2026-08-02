#!/bin/bash
echo "[WARP] Initializing Cloudflare WARP SOCKS5 Proxy..."
warp-svc > /dev/null 2>&1 &
sleep 2
warp-cli --accept-tos registration new > /dev/null 2>&1 || true
warp-cli --accept-tos mode proxy > /dev/null 2>&1 || warp-cli --accept-tos set-mode proxy > /dev/null 2>&1 || true
warp-cli --accept-tos proxy port 4001 > /dev/null 2>&1 || warp-cli --accept-tos set-proxy-port 4001 > /dev/null 2>&1 || true
warp-cli --accept-tos connect > /dev/null 2>&1 || true

echo "[Server] Launching Node.js engine..."
exec node server.js
