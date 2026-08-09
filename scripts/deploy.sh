#!/usr/bin/env bash
# CommandCode Proxy v2 一键部署脚本（Debian/Ubuntu）
# 用法: sudo bash deploy.sh [端口]
set -euo pipefail

PORT="${1:-55990}"
APP_DIR="/opt/ccproxy"
BIN_SRC="/tmp/command-code-proxy"   # 上传的二进制位置

echo "==> 1/4 创建目录"
mkdir -p "$APP_DIR/data"

echo "==> 2/4 安装二进制"
install -m 0755 "$BIN_SRC" "$APP_DIR/command-code-proxy"

echo "==> 3/4 安装 systemd 服务"
cat > /etc/systemd/system/ccproxy.service <<EOF
[Unit]
Description=CommandCode Proxy v2 (Multi-Key OpenAI Proxy)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/ccproxy
ExecStart=/opt/ccproxy/command-code-proxy -data-dir /opt/ccproxy/data -host 0.0.0.0 -port ${PORT}
Restart=always
RestartSec=5
TimeoutStopSec=10
KillSignal=SIGTERM
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ccproxy

echo "==> 4/4 启动服务"
systemctl restart ccproxy
sleep 2
systemctl status ccproxy --no-pager | head -8 || true

echo ""
echo "✅ 部署完成"
echo "   服务:   systemctl {status|restart|stop} ccproxy"
echo "   日志:   journalctl -u ccproxy -f"
echo "   面板:   http://<服务器IP>:${PORT}/   （添加你的 CommandCode Key）"
echo "   API:    http://<服务器IP>:${PORT}/v1"
