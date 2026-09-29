#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  bot-panel agent — fresh VPS setup (Ubuntu 22.04 / 24.04)
#
#  Two ways to run it:
#
#   1. One command from the panel (Systems → Add node → One command). The panel
#      serves this file with JOIN_URL / JOIN_TOKEN / REPO_BRANCH / REPO_COMMIT
#      and the arguments filled in; at the end the agent registers itself and
#      the panel does the rest (SSH keys, WireGuard, lease, Lavalink).
#
#   2. By hand:  sudo bash setup-agent.sh <PANEL_IP> [AGENT_PORT] [REPO_URL]
#      Example:  sudo bash setup-agent.sh 160.191.87.150 4200
#      Then paste the Host / Port / API key it prints into Systems → Add node.
#
#  Who the agent runs as: the user who ran sudo — its home, its PM2, its boot
#  service — or root when started from a root shell. AGENT_USER=<name> picks
#  another user. A non-root agent gets passwordless sudo for exactly the
#  commands it runs through sudo (ufw, wg, nginx, certbot, …).
#
#  What it does:
#    1. Installs Node.js 22, git, PM2, UFW, nginx, certbot, WireGuard, Java 17
#    2. Creates ~/bots and ~/sites of that user
#    3. Clones the panel repo (agent lives inside it) to ~/panel — on the
#       panel's own commit when it says which
#    4. Generates a random AGENT_API_KEY and writes agent/.env
#    5. Firewall: SSH from anywhere, agent port ONLY from the panel IP
#    6. Starts the agent under that user's PM2 and enables boot persistence
#    7. (one command only) Registers with the panel and prints what it set up
#
#  agent/uninstall-agent.sh undoes all of it.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
# The sbin directories too, whatever shell this came from: ufw, nginx and
# visudo live there, and the sudoers entry below is built from these paths.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

PANEL_IP="${1:?Usage: sudo bash setup-agent.sh <PANEL_IP> [AGENT_PORT] [REPO_URL]}"
AGENT_PORT="${2:-4200}"
REPO_URL="${3:-https://github.com/khaiclone/panel.git}"
REPO_BRANCH="${REPO_BRANCH:-}"
REPO_COMMIT="${REPO_COMMIT:-}"
JOIN_URL="${JOIN_URL:-}"
JOIN_TOKEN="${JOIN_TOKEN:-}"

if [ "$(id -u)" != "0" ]; then
    if [ -n "$JOIN_URL" ]; then
        echo "Run it as root: sudo bash $0" >&2
    else
        echo "Run it as root: sudo bash $0 <PANEL_IP> [AGENT_PORT] [REPO_URL]" >&2
    fi
    exit 1
fi

RUN_USER="${AGENT_USER:-${SUDO_USER:-root}}"
RUN_HOME=$(getent passwd "$RUN_USER" | cut -d: -f6 || true)
if [ -z "$RUN_HOME" ] || [ ! -d "$RUN_HOME" ]; then
    echo "User \"$RUN_USER\" has no home directory — set AGENT_USER to the account the agent should run as" >&2
    exit 1
fi
INSTALL_DIR="$RUN_HOME/panel"
BOTS_DIR="$RUN_HOME/bots"
SITES_DIR="$RUN_HOME/sites"

# Run a command as the agent's user, with that user's HOME (and so its ~/.pm2).
as_user() {
    if [ "$RUN_USER" = "root" ]; then "$@"; else sudo -u "$RUN_USER" -H "$@"; fi
}

echo "──────────────────────────────────────────────"
echo " bot-panel agent setup"
echo "   runs as    : $RUN_USER ($RUN_HOME)"
echo "   panel IP   : $PANEL_IP"
echo "   agent port : $AGENT_PORT"
echo "   repo       : $REPO_URL${REPO_BRANCH:+ ($REPO_BRANCH)}"
echo "──────────────────────────────────────────────"

# Something already listening on the agent port means this machine is not
# fresh — most likely it is a node already, or an earlier run as another user
# is still up. Stop before touching anything.
if ss -Hltn "sport = :$AGENT_PORT" 2>/dev/null | grep -q .; then
    if ! as_user pm2 describe panel-agent >/dev/null 2>&1; then
        echo "Port $AGENT_PORT is already in use, and not by $RUN_USER's panel-agent:" >&2
        ss -Hltnp "sport = :$AGENT_PORT" >&2 || true
        echo "Is this machine a node already? If an earlier run installed the agent for" >&2
        echo "another user, remove it first: sudo bash agent/uninstall-agent.sh <that user>" >&2
        exit 1
    fi
fi

# 1. Base packages ────────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ufw ca-certificates nginx certbot python3-certbot-nginx python3-venv python3-pip wireguard-tools
# Lavalink needs Java 17+. Not fatal: the node works without it, and the
# Lavalink page shows what is missing.
apt-get install -y openjdk-17-jre-headless || echo "[setup] WARNING: could not install Java 17 — Lavalink will not run until it is installed"

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
as_user mkdir -p "$BOTS_DIR" "$SITES_DIR"

# 3. Clone repo (agent lives inside the panel repo) ───────────────────────────
if [ ! -d "$INSTALL_DIR" ]; then
    echo "[setup] Cloning $REPO_URL into $INSTALL_DIR ..."
    CLONE_ARGS=(--depth 1)
    if [ -n "$REPO_BRANCH" ]; then CLONE_ARGS+=(--branch "$REPO_BRANCH"); fi
    as_user git clone "${CLONE_ARGS[@]}" "$REPO_URL" "$INSTALL_DIR"
elif [ -f "$INSTALL_DIR/agent/index.js" ]; then
    echo "[setup] $INSTALL_DIR already exists — pulling latest"
    as_user git -C "$INSTALL_DIR" pull
else
    echo "$INSTALL_DIR exists and is not a bot-panel checkout — move it away first" >&2
    exit 1
fi

# The panel's own commit, when it says which: a node on other code than the
# panel fails the commit check of a later panel move.
if [ -n "$REPO_COMMIT" ] && [ "$(as_user git -C "$INSTALL_DIR" rev-parse HEAD)" != "$REPO_COMMIT" ]; then
    if as_user git -C "$INSTALL_DIR" fetch --depth 1 origin "$REPO_COMMIT" && as_user git -C "$INSTALL_DIR" reset --hard FETCH_HEAD; then
        echo "[setup] Checked out the panel's commit ${REPO_COMMIT:0:7}"
    else
        echo "[setup] WARNING: could not check out the panel's commit ${REPO_COMMIT:0:7} — staying on $(as_user git -C "$INSTALL_DIR" rev-parse --short HEAD)"
    fi
fi

cd "$INSTALL_DIR/agent"
as_user npm install --omit=dev

# 4. Agent .env ───────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    AGENT_API_KEY=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
    as_user tee .env >/dev/null <<EOF
AGENT_PORT=$AGENT_PORT
AGENT_API_KEY=$AGENT_API_KEY
BOTS_ROOT_DIR=$BOTS_DIR
SITES_ROOT_DIR=$SITES_DIR
EOF
    chmod 600 .env
    echo "[setup] Wrote agent/.env with a fresh AGENT_API_KEY"
else
    AGENT_API_KEY=$(grep '^AGENT_API_KEY=' .env | cut -d= -f2)
    AGENT_PORT=$(grep '^AGENT_PORT=' .env | cut -d= -f2 || true)
    AGENT_PORT="${AGENT_PORT:-4200}"
    echo "[setup] agent/.env already exists — keeping current key (port $AGENT_PORT)"
fi

# 5. Privileges ───────────────────────────────────────────────────────────────
# A non-root agent runs ufw / wg / nginx / certbot and a few file moves into
# /etc through `sudo` (agent/services/ufw.js, wg.js, nginx.js), with no one there
# to type a password. cp/mv/bash as root make this root-equivalent for the user
# — the same trust the agent has when it runs as root.
if [ "$RUN_USER" != "root" ]; then
    SUDO_CMDS=""
    MISSING=""
    for c in ufw wg wg-quick nginx certbot systemctl mkdir cp chmod mv rm test bash; do
        p=$(type -P "$c" || true)
        if [ -n "$p" ]; then SUDO_CMDS="${SUDO_CMDS:+$SUDO_CMDS, }$p"; else MISSING="$MISSING $c"; fi
    done
    if [ -n "$MISSING" ]; then echo "[setup] WARNING: not found, so not allowed through sudo:$MISSING"; fi
    SUDOERS="/etc/sudoers.d/bot-panel-agent-$(printf %s "$RUN_USER" | tr -c 'a-zA-Z0-9_-' '_')"
    TMP_SUDOERS=$(mktemp)
    {
        echo "# bot-panel agent (setup-agent.sh): what the agent runs through sudo."
        echo "# Removed by agent/uninstall-agent.sh."
        echo "$RUN_USER ALL=(root) NOPASSWD: $SUDO_CMDS"
    } > "$TMP_SUDOERS"
    if visudo -cf "$TMP_SUDOERS" >/dev/null; then
        install -m 0440 "$TMP_SUDOERS" "$SUDOERS"
        echo "[setup] $RUN_USER may run the agent's commands through sudo ($SUDOERS)"
    else
        echo "[setup] WARNING: could not write $SUDOERS — firewall, WireGuard and nginx will fail until $RUN_USER has passwordless sudo for them"
    fi
    rm -f "$TMP_SUDOERS"
fi

# 6. Firewall ─────────────────────────────────────────────────────────────────
echo "[setup] Configuring UFW..."
if ufw status | grep -q "Status: inactive"; then
    echo "[setup] UFW was off — turning it on with SSH and the agent port open. Open anything else this machine serves with: sudo ufw allow <port>/tcp"
fi
# Whatever port sshd really listens on — enabling UFW with only 22 open would
# lock out a server whose SSH runs elsewhere.
SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}' || true)
ufw allow "${SSH_PORT:-22}/tcp"
ufw allow from "$PANEL_IP" to any port "$AGENT_PORT" proto tcp
ufw --force enable
ufw status | head -10

# 7. PM2 ──────────────────────────────────────────────────────────────────────
if as_user pm2 describe panel-agent >/dev/null 2>&1; then
    as_user pm2 restart panel-agent --update-env
else
    as_user pm2 start ecosystem.config.js
fi
as_user pm2 save
# Boot persistence — unless this user already has a PM2 boot service of its own.
if [ -f "/etc/systemd/system/pm2-$RUN_USER.service" ]; then
    echo "[setup] pm2-$RUN_USER.service already exists — kept as it is"
else
    pm2 startup systemd -u "$RUN_USER" --hp "$RUN_HOME" || echo "[setup] WARNING: pm2 startup failed — the agent will not start on boot"
fi

# 8. Register with the panel (one-command setup) ──────────────────────────────
if [ -n "$JOIN_URL" ]; then
    echo ""
    echo "[setup] Registering with the panel..."
    # The key leaves this machine encrypted with the join token (AES-256-GCM,
    # the same scheme the panel uses for SSH keys). The panel answers once the
    # node is saved and sets it up in the background; this follows along.
    if AGENT_API_KEY="$AGENT_API_KEY" JOIN_TOKEN="$JOIN_TOKEN" JOIN_URL="$JOIN_URL" AGENT_PORT="$AGENT_PORT" node -e '
        const c = require("./utils/crypto");
        const { JOIN_URL, JOIN_TOKEN, AGENT_API_KEY, AGENT_PORT } = process.env;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const icon = { ok: "✓", warn: "!", error: "✗" };
        const call = async (method, body) => {
            const res = await fetch(JOIN_URL, {
                method,
                headers: { "content-type": "application/json" },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(90_000),
            });
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); } catch { data = { error: `HTTP ${res.status}: ${text.slice(0, 200)}` }; }
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        };
        (async () => {
            const r = await call("POST", { apiKey: c.encrypt(AGENT_API_KEY, JOIN_TOKEN), agentPort: Number(AGENT_PORT) });
            console.log(`  Node "${r.node.name}" registered (${r.node.host}:${r.node.port}) — setting it up:`);
            let shown = 0;
            let misses = 0;
            const until = Date.now() + 15 * 60_000;
            while (Date.now() < until) {
                await sleep(2000);
                let s;
                try { s = await call("GET"); misses = 0; } catch (err) {
                    if (++misses >= 15) throw new Error(`lost the panel (${err.message}) — the node is registered; see the Systems page`);
                    continue;
                }
                for (; shown < (s.steps || []).length && s.steps[shown].status !== "running"; shown++) {
                    const st = s.steps[shown];
                    console.log(`  ${icon[st.status] || "•"} ${st.label}`);
                    if (st.detail) console.log(st.detail.split("\n").map((l) => `      ${l}`).join("\n"));
                }
                if (s.status === "done") return;
            }
            console.log("  … still running after 15 minutes — see the Systems page");
        })().catch((err) => {
            console.error(`  ✗ ${err.message}`);
            process.exit(1);
        });
    '; then
        echo "──────────────────────────────────────────────"
        echo " ✅ Done — the node is on the panel's Systems page."
        echo "    Its processes: pm2 ls   (as $RUN_USER)"
        echo "──────────────────────────────────────────────"
        exit 0
    fi
    echo "──────────────────────────────────────────────"
    echo " ✗ The panel did not register this node. Fix the above and run the same"
    echo "   command again — it stays valid until it expires."
    exit 1
fi

echo ""
echo "──────────────────────────────────────────────"
echo " ✅ Agent is running on port $AGENT_PORT (as $RUN_USER)"
echo ""
echo " Register this node in the panel with:"
echo "   Host    : $(curl -s -4 ifconfig.me || hostname -I | awk '{print $1}')"
echo "   Port    : $AGENT_PORT"
echo "   API key : $AGENT_API_KEY"
echo "──────────────────────────────────────────────"
