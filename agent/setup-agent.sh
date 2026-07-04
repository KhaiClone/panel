#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  bot-panel agent — fresh VPS setup (Ubuntu 22.04 / 24.04)
#
#  Usage:  sudo bash setup-agent.sh <PANEL_IP> [AGENT_PORT] [REPO_URL]
#  Example: sudo bash setup-agent.sh 160.191.87.150 4200 git@github.com:khaiclone/panel
#
#  What it does:
#    1. Installs Node.js 22, git, PM2, UFW
#    2. Creates /root/bots and /root/sites
#    3. Clones the panel repo (agent lives inside it) to /root/panel
#    4. Generates a random AGENT_API_KEY and writes agent/.env
#    5. Firewall: allow SSH from anywhere, agent port ONLY from the panel IP
#    6. Starts the agent under PM2 and enables boot persistence
#
#  The generated AGENT_API_KEY is printed at the end — paste it into the
#  panel's Nodes page when registering this VPS.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PANEL_IP="${1:?Usage: sudo bash setup-agent.sh <PANEL_IP> [AGENT_PORT] [REPO_URL]}"
AGENT_PORT="${2:-4200}"
REPO_URL="${3:-git@github.com:khaiclone/panel}"
INSTALL_DIR="/root/panel"
BOTS_DIR="/root/bots"
SITES_DIR="/root/sites"

echo "──────────────────────────────────────────────"
echo " bot-panel agent setup"
echo "   panel IP   : $PANEL_IP"
echo "   agent port : $AGENT_PORT"
echo "   repo       : $REPO_URL"
echo "──────────────────────────────────────────────"

# 1. Base packages ────────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ufw ca-certificates

if ! command -v node >/dev/null 2>&1; then
    echo "[setup] Installing Node.js 22 (NodeSource)..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi
echo "[setup] node $(node -v) / npm $(npm -v)"

if ! command -v pm2 >/dev/null 2>&1; then
    echo "[setup] Installing PM2..."
    npm install -g pm2
fi

# 2. Directories ──────────────────────────────────────────────────────────────
mkdir -p "$BOTS_DIR" "$SITES_DIR"

# 3. Clone repo (agent lives inside the panel repo) ───────────────────────────
if [ ! -d "$INSTALL_DIR" ]; then
    echo "[setup] Cloning $REPO_URL ..."
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
else
    echo "[setup] $INSTALL_DIR already exists — pulling latest"
    git -C "$INSTALL_DIR" pull
fi

cd "$INSTALL_DIR/agent"
npm install --omit=dev

# 4. Agent .env ───────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    AGENT_API_KEY=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
    cat > .env <<EOF
AGENT_PORT=$AGENT_PORT
AGENT_API_KEY=$AGENT_API_KEY
BOTS_ROOT_DIR=$BOTS_DIR
SITES_ROOT_DIR=$SITES_DIR
EOF
    echo "[setup] Wrote agent/.env with a fresh AGENT_API_KEY"
else
    AGENT_API_KEY=$(grep '^AGENT_API_KEY=' .env | cut -d= -f2)
    echo "[setup] agent/.env already exists — keeping current key"
fi

# 5. Firewall ─────────────────────────────────────────────────────────────────
echo "[setup] Configuring UFW..."
ufw allow 22/tcp
ufw allow from "$PANEL_IP" to any port "$AGENT_PORT" proto tcp
ufw --force enable
ufw status | head -10

# 6. PM2 ──────────────────────────────────────────────────────────────────────
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

echo ""
echo "──────────────────────────────────────────────"
echo " ✅ Agent is running on port $AGENT_PORT"
echo ""
echo " Register this node in the panel with:"
echo "   Host    : $(curl -s -4 ifconfig.me || hostname -I | awk '{print $1}')"
echo "   Port    : $AGENT_PORT"
echo "   API key : $AGENT_API_KEY"
echo "──────────────────────────────────────────────"
