#!/bin/bash
# AgentX Host Agent — Linux systemd installer
# Usage: sudo bash install.sh <AGENTX_SERVER_URL> [AGENT_TOKEN]
#
# Example:
#   sudo bash install.sh http://192.168.1.100:3000 mysecrettoken

set -e

AGENTX_SERVER="${1:-}"
AGENT_TOKEN="${2:-}"
INSTALL_DIR="/opt/agentx-host-agent"
SERVICE_NAME="agentx-host-agent"
NODE_BIN=$(which node 2>/dev/null || echo "")

if [ -z "$AGENTX_SERVER" ]; then
  echo "Usage: sudo bash install.sh <AGENTX_SERVER_URL> [AGENT_TOKEN]"
  echo "Example: sudo bash install.sh http://192.168.1.100:3000"
  exit 1
fi

if [ -z "$NODE_BIN" ]; then
  echo "Error: Node.js not found. Install Node.js 18+ first."
  exit 1
fi

echo "Installing AgentX Host Agent..."
echo "  Server: $AGENTX_SERVER"
echo "  Install dir: $INSTALL_DIR"

# Copy files
mkdir -p "$INSTALL_DIR"
cp agent.js package.json "$INSTALL_DIR/"

# Install dependencies
cd "$INSTALL_DIR"
npm install --production --silent

# Create systemd service
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=AgentX Host Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${INSTALL_DIR}/agent.js
Restart=always
RestartSec=10
Environment=AGENTX_SERVER=${AGENTX_SERVER}
Environment=AGENT_TOKEN=${AGENT_TOKEN}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl start "$SERVICE_NAME"

echo ""
echo "Done! AgentX Host Agent installed and running."
echo "  Status: systemctl status $SERVICE_NAME"
echo "  Logs:   journalctl -u $SERVICE_NAME -f"
echo "  Stop:   systemctl stop $SERVICE_NAME"
echo "  Remove: systemctl disable $SERVICE_NAME && rm -rf $INSTALL_DIR /etc/systemd/system/${SERVICE_NAME}.service"
