#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  bot-panel agent — undo what setup-agent.sh did on this machine
#
#  Usage:  sudo bash uninstall-agent.sh <USER> [--keep-packages] [--keep-ssh-keys] [--keep-firewall]
#          <USER> is the account the agent ran as: "root", or e.g. "khaidev"
#
#  The panel runs this itself when a node is removed with the VPS cleaned up
#  (the node's page → Remove). By hand: remove the node on the panel first
#  ("Only from the panel"), so the other nodes drop it from the WireGuard mesh.
#
#  Always removed — what is there only for the panel:
#    - panel-agent, lavalink and (when the agent started it) spotify-tokener
#      from that user's PM2, and pm2-logrotate when
#      the agent installed it; that user's PM2 itself and its boot service
#      when nothing else is left in it
#    - wg0, if /etc/wireguard/wg0.conf was written by bot-panel
#    - the UFW rules for the agent port and WireGuard (51820/udp), and every
#      rule the panel added for another node ("bot-panel: panel access")
#    - the panel's nginx site (panel-self.conf), and the certificates named
#      with --cert
#    - ~/panel, ~/lavalink, ~/.panel-node, and ~/bots / ~/sites when empty
#    - /etc/sudoers.d/bot-panel-agent-<user>
#
#  Removed unless kept:
#    --keep-ssh-keys  SSH keys the panel copied over (those with a "# GitHub
#                     key:" entry in ~/.ssh/config), their config entries, and
#                     the panel's git identity
#    --keep-firewall  the 80/443 rules when the setup added those, and UFW is
#                     turned off again if the setup is what turned it on
#    --keep-packages  packages: exactly those apt's history.log shows the setup
#                     NEWLY installed (nginx, certbot, WireGuard, Java, Chrome,
#                     Node.js and their dependencies…), the global PM2 it
#                     installed, and the NodeSource and Google Chrome apt
#                     sources. Packages that were already there are kept, and
#                     so is every upgrade. apt is asked first, and nothing is
#                     removed if it would take anything else with it.
#
#  What the panel adds when it runs this:
#    --cert DOMAIN    also delete this certificate (one of the node's panel domains)
#    --report URL     POST the output so far to URL after every part
#                     (text/plain, ?status=running|done|failed)
#    --detach         check, then go on in a systemd unit of its own and return at
#                     once: started by the agent, the run would otherwise die with
#                     it — stopping the user's PM2 service kills all it started
#
#  It never installed nvm, so it does not touch nvm.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

USAGE="Usage: sudo bash uninstall-agent.sh <USER> [--keep-packages] [--keep-ssh-keys] [--keep-firewall]   (the user the agent ran as)"
TARGET_USER="${1:-}"
case "$TARGET_USER" in ""|-*) echo "$USAGE" >&2; exit 1 ;; esac
shift
KEEP_PACKAGES=no
KEEP_SSH=no
KEEP_FIREWALL=no
DETACH=no
REPORT_URL=""
CERTS=()
ARGS=("$TARGET_USER") # what a detached run starts with: everything but --detach
while [ $# -gt 0 ]; do
    case "$1" in
        --keep-packages) KEEP_PACKAGES=yes ;;
        --keep-ssh-keys) KEEP_SSH=yes ;;
        --keep-firewall) KEEP_FIREWALL=yes ;;
        --detach) DETACH=yes; shift; continue ;;
        --cert)
            # Becomes a path under /etc/letsencrypt/live — a domain name and nothing else.
            if [ $# -lt 2 ] || ! [[ "$2" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]]; then echo "--cert needs a domain name" >&2; exit 1; fi
            CERTS+=("$2"); ARGS+=("$1" "$2"); shift 2; continue ;;
        --report)
            if [ $# -lt 2 ] || ! [[ "$2" =~ ^https?://[^[:space:]]+$ ]]; then echo "--report needs an http(s) URL" >&2; exit 1; fi
            REPORT_URL="$2"; ARGS+=("$1" "$2"); shift 2; continue ;;
        *) echo "Unknown option: $1" >&2; echo "$USAGE" >&2; exit 1 ;;
    esac
    ARGS+=("$1")
    shift
done
if [ "$(id -u)" != "0" ]; then
    echo "Run it as root: sudo bash $0 ${ARGS[*]}" >&2
    exit 1
fi
H=$(getent passwd "$TARGET_USER" | cut -d: -f6 || true)
if [ -z "$H" ]; then
    echo "No such user: $TARGET_USER" >&2
    exit 1
fi
DIR="$H/panel"
STATE="/var/lib/bot-panel-agent/state"
state() { grep -s "^$1=" "$STATE" | head -1 | cut -d= -f2; }

as_user() {
    if [ "$TARGET_USER" = "root" ]; then "$@"; else sudo -u "$TARGET_USER" -H "$@"; fi
}
say() { echo "[uninstall] $*"; }

# Never on the machine that runs the panel: its checkout and SSH keys are the
# panel's own.
if as_user pm2 describe bot-panel >/dev/null 2>&1 || grep -qs '^PANEL_DIR=.\+' "$DIR/agent/.env"; then
    echo "This looks like the node that runs the panel (bot-panel in PM2, or PANEL_DIR set) — not touching it." >&2
    echo "Move the panel away first (Panel Settings → Move Panel)." >&2
    exit 1
fi

AGENT_PORT=$(grep -s '^AGENT_PORT=' "$DIR/agent/.env" | cut -d= -f2)
AGENT_PORT="${AGENT_PORT:-4200}"

# ── --detach: the checks passed — go on in a unit of our own ─────────────────
# From a copy in /tmp: the run deletes the checkout this file lives in.
if [ "$DETACH" = "yes" ]; then
    if [ ! -f "$0" ]; then
        echo "--detach needs the script as a file: sudo bash uninstall-agent.sh …" >&2
        exit 1
    fi
    COPY=$(mktemp /tmp/bot-panel-uninstall.XXXXXX)
    cp "$0" "$COPY"
    # The pause lets the agent answer the panel before its PM2 process goes.
    RUN=(/bin/bash -c 'sleep 3; exec /bin/bash "$0" "$@"' "$COPY" "${ARGS[@]}")
    UNIT="bot-panel-uninstall-$(date +%s)"
    if command -v systemd-run >/dev/null 2>&1 &&
        systemd-run --unit="$UNIT" --collect --quiet --description="bot-panel agent uninstall ($TARGET_USER)" "${RUN[@]}"; then
        echo "Detached: $UNIT (its output: journalctl -u $UNIT)"
    else
        # No systemd: out of the agent's process tree at least.
        setsid nohup "${RUN[@]}" >"$COPY.log" 2>&1 </dev/null &
        echo "Detached: pid $! (its output: $COPY.log)"
    fi
    exit 0
fi

# ── --report: the output so far, to the panel ────────────────────────────────
# Through curl, or python3 when the package step has just removed curl. A panel
# that cannot be reached three times in a row is not tried again: every try can
# cost half a minute.
LOG=""
FINISHED=no
REPORT_MISSES=0
if [ -n "$REPORT_URL" ]; then
    LOG=$(mktemp /tmp/bot-panel-uninstall-log.XXXXXX)
    exec > >(tee -a "$LOG") 2>&1
fi
report() {
    [ -n "$REPORT_URL" ] || return 0
    sleep 1 # tee's last lines
    local body sent=no
    body=$(mktemp)
    tail -c 60000 "$LOG" >"$body"
    if command -v curl >/dev/null 2>&1 &&
        curl -fsS -m 15 -o /dev/null -X POST -H "content-type: text/plain; charset=utf-8" \
            --data-binary "@$body" "$REPORT_URL?status=$1" 2>/dev/null; then
        sent=yes
    elif python3 - "$REPORT_URL?status=$1" "$body" 2>/dev/null <<'PY'
import sys, urllib.request
with open(sys.argv[2], "rb") as fh:
    data = fh.read()
req = urllib.request.Request(sys.argv[1], data=data, method="POST", headers={"content-type": "text/plain; charset=utf-8"})
urllib.request.urlopen(req, timeout=15).read()
PY
    then
        sent=yes
    fi
    rm -f "$body"
    if [ "$sent" = "yes" ]; then
        REPORT_MISSES=0
    elif [ $((++REPORT_MISSES)) -ge 3 ]; then
        echo "[uninstall] the panel cannot be reached at ${REPORT_URL%/*}/… — not reporting any more"
        REPORT_URL=""
    fi
}
on_exit() {
    if [ "$FINISHED" != "yes" ]; then
        echo "[uninstall] stopped before the end"
        report failed
    fi
    [ -n "$LOG" ] && rm -f "$LOG"
    # The copy --detach made.
    case "$0" in /tmp/bot-panel-uninstall.*) rm -f "$0" ;; esac
}
trap on_exit EXIT

# ── When the setup ran, and which packages it newly installed ────────────────
# From apt's own history: every run of the setup's install command (and the
# Java / NodeSource / Node.js installs that follow it within the hour). Only
# "Install:" lines count — "Upgrade:" lines are left alone.
SETUP_STARTED="$(state SETUP_STARTED)"
PKGS=""
if command -v python3 >/dev/null 2>&1; then
    APT_INFO=$(python3 - "$SETUP_STARTED" <<'PY'
import datetime, glob, gzip, os, re, sys

since = sys.argv[1] if len(sys.argv) > 1 else ""
records = []
for f in sorted(glob.glob("/var/log/apt/history.log*"), key=os.path.getmtime):
    opener = gzip.open if f.endswith(".gz") else open
    try:
        with opener(f, "rt", errors="replace") as fh:
            text = fh.read()
    except OSError:
        continue
    for block in re.split(r"\n\s*\n", text):
        rec = {}
        for line in block.strip().splitlines():
            key, _, value = line.partition(": ")
            rec[key.strip()] = value.strip()
        if "Start-Date" in rec:
            records.append(rec)

def when(rec):
    try:
        return datetime.datetime.strptime(re.sub(r"\s+", " ", rec["Start-Date"]), "%Y-%m-%d %H:%M:%S").timestamp()
    except ValueError:
        return None

MAIN = re.compile(r"^apt-get install -y curl git ufw ca-certificates nginx certbot\b")
SETUP = [
    MAIN,
    re.compile(r"^apt-get install -y openjdk-17-jre-headless$"),
    re.compile(r"^apt-get install -y aria2$"),
    re.compile(r"^apt-get install -y \S*/google-chrome-stable_current_amd64\.deb$"),
    re.compile(r"^apt-get install -y nodejs$"),
    re.compile(r"install -y .*ca-certificates curl gnupg"),  # NodeSource's own prerequisites
]
starts = [t for t in (when(r) for r in records if MAIN.search(r.get("Commandline", ""))) if t]
if since.isdigit():
    starts.append(float(since))
windows = [(s - 60, s + 3600) for s in starts]

pkgs = []
for rec in records:
    t = when(rec)
    if t is None or not any(a <= t <= b for a, b in windows):
        continue
    if not any(p.search(rec.get("Commandline", "")) for p in SETUP):
        continue
    for m in re.finditer(r"([^\s,(]+) \(", rec.get("Install", "")):
        if m.group(1) not in pkgs:
            pkgs.append(m.group(1))

print(int(min(starts)) if starts else "")
print(" ".join(pkgs))
PY
)
    [ -z "$SETUP_STARTED" ] && SETUP_STARTED=$(printf '%s\n' "$APT_INFO" | sed -n 1p)
    # history.log says "nginx-common:amd64" even for Architecture: all packages,
    # which dpkg does not match by that name — use the bare name for this
    # machine's own architecture.
    NATIVE=$(dpkg --print-architecture 2>/dev/null || echo amd64)
    for p in $(printf '%s\n' "$APT_INFO" | sed -n 2p); do
        case "$p" in *":$NATIVE"|*":all") p="${p%:*}" ;; esac
        PKGS="${PKGS:+$PKGS }$p"
    done
fi
# A firewall that is to stay keeps its program, even one the setup installed.
if [ "$KEEP_FIREWALL" = "yes" ]; then
    PKGS=$(printf '%s\n' $PKGS | grep -vx 'ufw' | xargs)
fi
NODE_FROM_SETUP=no
case " $PKGS " in *" nodejs "*) NODE_FROM_SETUP=yes ;; esac
[ "$(state NODESOURCE_ADDED)" = "yes" ] && NODE_FROM_SETUP=yes
SETUP_STARTED="${SETUP_STARTED:-0}"
# True when $1 was last changed after the setup started.
since_setup() { [ "$SETUP_STARTED" -gt 0 ] && [ -e "$1" ] && [ "$(stat -c %Y "$1")" -ge "$SETUP_STARTED" ]; }

echo "──────────────────────────────────────────────"
echo " bot-panel agent uninstall for $TARGET_USER ($H), agent port $AGENT_PORT"
[ "$SETUP_STARTED" -gt 0 ] && echo " setup ran at $(date -d "@$SETUP_STARTED" '+%Y-%m-%d %H:%M')"
KEPT=""
[ "$KEEP_SSH" = "yes" ] && KEPT="$KEPT, SSH keys"
[ "$KEEP_FIREWALL" = "yes" ] && KEPT="$KEPT, firewall"
[ "$KEEP_PACKAGES" = "yes" ] && KEPT="$KEPT, packages"
echo " kept: ${KEPT:+${KEPT#, }}${KEPT:-nothing — everything the setup did is undone}"
echo "──────────────────────────────────────────────"
report running

# 1. PM2 ──────────────────────────────────────────────────────────────────────
if command -v pm2 >/dev/null 2>&1; then
    for p in panel-agent lavalink; do
        if as_user pm2 describe "$p" >/dev/null 2>&1; then
            as_user pm2 delete "$p" >/dev/null && say "PM2: removed $p"
        fi
    done
    # spotify-tokener only when the agent started it (its script sits in
    # ~/lavalink/spotify-tokener) — one set up by hand under that name stays.
    if as_user pm2 describe spotify-tokener 2>/dev/null | grep -q "lavalink/spotify-tokener/.noflex-start.sh"; then
        as_user pm2 delete spotify-tokener >/dev/null && say "PM2: removed spotify-tokener"
    elif as_user pm2 describe spotify-tokener >/dev/null 2>&1; then
        say "PM2: spotify-tokener was not started by the agent — kept"
    fi
    # pm2-logrotate, when the agent is what installed it (it leaves this marker then).
    if [ -f "$H/.pm2/.bot-panel-logrotate" ]; then
        as_user pm2 uninstall pm2-logrotate >/dev/null 2>&1 && say "PM2: removed pm2-logrotate"
        rm -f "$H/.pm2/.bot-panel-logrotate"
    fi
    as_user pm2 save --force >/dev/null 2>&1
    if [ "$(as_user pm2 jlist 2>/dev/null)" = "[]" ]; then
        if [ -f "/etc/systemd/system/pm2-$TARGET_USER.service" ]; then
            pm2 unstartup systemd -u "$TARGET_USER" --hp "$H" >/dev/null 2>&1 && say "PM2: boot service pm2-$TARGET_USER removed"
        fi
        as_user pm2 kill >/dev/null 2>&1
        rm -rf "$H/.pm2" && say "PM2: nothing else ran for $TARGET_USER — removed $H/.pm2"
    else
        say "PM2: $TARGET_USER still runs other processes — PM2 and its boot service kept"
    fi
fi
report running

# 2. WireGuard ────────────────────────────────────────────────────────────────
if head -1 /etc/wireguard/wg0.conf 2>/dev/null | grep -q "Generated by bot-panel"; then
    wg-quick down wg0 >/dev/null 2>&1
    systemctl disable wg-quick@wg0 >/dev/null 2>&1
    rm -f /etc/wireguard/wg0.conf
    say "WireGuard: wg0 down, disabled, config removed"
fi

# 3. Firewall ─────────────────────────────────────────────────────────────────
# By number, highest first, so the numbers of the rest do not shift. The agent
# port, WireGuard and the rules the panel added for other nodes ("bot-panel:
# panel access") are of no use once this machine has left the panel.
if command -v ufw >/dev/null 2>&1; then
    NUMS=$(ufw status numbered 2>/dev/null | grep -E "(^|[^0-9])($AGENT_PORT/tcp|51820/udp)([^0-9]|$)|# bot-panel: panel access" | sed -n 's/^\[ *\([0-9]\+\)\].*/\1/p' | sort -rn)
    for n in $NUMS; do ufw --force delete "$n" >/dev/null; done
    [ -n "$NUMS" ] && say "UFW: removed the rules for $AGENT_PORT/tcp, 51820/udp and the panel's access rules"
    if [ "$KEEP_FIREWALL" = "yes" ]; then
        say "UFW: the 80/443 rules and UFW on/off kept (--keep-firewall)"
    else
        # HTTP(S): only when the setup's own run added the rule (recorded then).
        for p in 80 443; do
            if [ "$(state "UFW_ADDED_$p")" = "yes" ]; then
                ufw --force delete allow "$p/tcp" >/dev/null 2>&1 && say "UFW: removed the $p/tcp rule the setup added"
            fi
        done
        # Off again if the setup turned it on: recorded by the setup, or — for a
        # setup from before that record — ufw.conf, which `ufw enable` rewrites
        # only when UFW actually goes from off to on.
        if ufw status 2>/dev/null | grep -q "Status: active"; then
            WAS="$(state UFW_WAS_ACTIVE)"
            if [ "$WAS" = "no" ] || { [ -z "$WAS" ] && since_setup /etc/ufw/ufw.conf; }; then
                ufw --force disable >/dev/null && say "UFW: turned off again (the setup turned it on)"
            fi
        fi
    fi
fi
report running

# 4. SSH keys the panel copied ────────────────────────────────────────────────
CFG="$H/.ssh/config"
if [ "$KEEP_SSH" = "yes" ]; then
    say "SSH: the panel's keys and git identity kept (--keep-ssh-keys)"
else
    if [ -f "$CFG" ]; then
        for name in $(sed -n 's/^# GitHub key: \([A-Za-z0-9_.-]\+\)$/\1/p' "$CFG"); do
            rm -f "$H/.ssh/$name" "$H/.ssh/$name.pub"
            # The entry the agent wrote: the marker, "Host github.com-<name>" and its
            # indented lines. As the user, so the rewritten file stays theirs.
            as_user sed -i "/^# GitHub key: ${name//./\\.}\$/,/^    IdentitiesOnly yes\$/d" "$CFG"
            say "SSH: removed key $name"
        done
        # Nothing but blank lines left: the agent created it.
        if ! grep -q '[^[:space:]]' "$CFG"; then rm -f "$CFG" && say "SSH: removed the now empty $CFG"; fi
    fi
    rmdir "$H/.ssh" 2>/dev/null && say "SSH: removed the now empty $H/.ssh"
    # The panel's git identity, when that is all ~/.gitconfig holds and it dates from the setup.
    if since_setup "$H/.gitconfig" && ! grep -vqE '^\[user\]$|^[[:space:]]*(name|email) = |^[[:space:]]*$' "$H/.gitconfig"; then
        rm -f "$H/.gitconfig" && say "git: removed $H/.gitconfig (only the panel's user.name/email)"
    fi
fi

# 5. The panel's nginx site and certificates ──────────────────────────────────
# panel-self.conf serves this node's panel domains (agent services/nginx.js);
# the panel forgets those domains with the node.
if [ -f /etc/nginx/sites-enabled/panel-self.conf ]; then
    rm -f /etc/nginx/sites-enabled/panel-self.conf
    say "nginx: removed the panel's site (panel-self.conf)"
    if nginx -t >/dev/null 2>&1; then systemctl reload nginx >/dev/null 2>&1; fi
fi
for d in "${CERTS[@]}"; do
    if [ -d "/etc/letsencrypt/live/$d" ] && command -v certbot >/dev/null 2>&1; then
        if certbot delete --cert-name "$d" --non-interactive >/dev/null 2>&1; then
            say "certbot: deleted the certificate for $d"
        else
            say "certbot: could not delete the certificate for $d — see: certbot certificates"
        fi
    fi
done
report running

# 6. Files ────────────────────────────────────────────────────────────────────
if [ -f "$DIR/agent/index.js" ]; then
    rm -rf "$DIR" && say "Removed $DIR"
elif [ -e "$DIR" ]; then
    say "$DIR is not a bot-panel checkout — left alone"
fi
for d in "$H/lavalink" "$H/.panel-node"; do
    [ -e "$d" ] && rm -rf "$d" && say "Removed $d"
done
for d in "$H/bots" "$H/sites"; do
    if [ -d "$d" ]; then
        if rmdir "$d" 2>/dev/null; then say "Removed $d (empty)"; else say "$d is not empty — kept"; fi
    fi
done
SUDOERS="/etc/sudoers.d/bot-panel-agent-$(printf %s "$TARGET_USER" | tr -c 'a-zA-Z0-9_-' '_')"
[ -f "$SUDOERS" ] && rm -f "$SUDOERS" && say "Removed $SUDOERS"
# npm's cache from the setup's installs, when Node.js itself came with the setup.
if [ "$TARGET_USER" = "root" ] && [ "$NODE_FROM_SETUP" = "yes" ] && [ -d /root/.npm ]; then
    rm -rf /root/.npm && say "Removed /root/.npm"
fi
# node-gyp's Node headers from compiling node-pty — the versions fetched since the setup.
if [ -d "$H/.cache/node-gyp" ]; then
    for d in "$H/.cache/node-gyp"/*; do
        since_setup "$d" && rm -rf "$d" && say "Removed $d"
    done
    rmdir "$H/.cache/node-gyp" "$H/.cache" 2>/dev/null
fi
report running

# 7. Packages ─────────────────────────────────────────────────────────────────
PURGED=no
OTHERS=$(ls -d /root/panel/agent /home/*/panel/agent 2>/dev/null | grep -v "^$DIR/agent$" || true)
if [ "$KEEP_PACKAGES" = "yes" ]; then
    say "Packages: kept (--keep-packages)"
elif [ -n "$OTHERS" ]; then
    say "Packages: kept — another agent is still installed here: $OTHERS"
    say "          remove it too (sudo bash uninstall-agent.sh <its user>), then run this again"
else
    # Global PM2 first, while npm is still here: set down by the setup when it
    # says so, or when Node.js came with the setup (nothing else had npm then),
    # or when it dates from the setup.
    NPM_ROOT=$(npm root -g 2>/dev/null || true)
    if [ -n "$NPM_ROOT" ] && [ -d "$NPM_ROOT/pm2" ]; then
        if [ "$(state PM2_INSTALLED)" = "yes" ] || [ "$NODE_FROM_SETUP" = "yes" ] || since_setup "$NPM_ROOT/pm2"; then
            npm uninstall -g pm2 >/dev/null 2>&1 && say "Removed the global PM2 ($NPM_ROOT/pm2)"
        fi
    fi

    # Only what is still installed, then ask apt what a purge would take.
    INSTALLED=""
    for p in $PKGS; do
        dpkg-query -W -f='${db:Status-Abbrev}' "$p" 2>/dev/null | grep -q '^ii' && INSTALLED="$INSTALLED $p"
    done
    if [ -z "$INSTALLED" ]; then
        say "Packages: nothing the setup installed is left${PKGS:+ (it had installed:$PKGS)}"
        [ -z "$PKGS" ] && say "          (no setup install found in /var/log/apt/history.log — nothing removed)"
    else
        BASES=" $(for p in $INSTALLED; do printf '%s ' "${p%%:*}"; done)"
        EXTRA=$(apt-get -s purge $INSTALLED 2>/dev/null | awk '/^Purg /{print $2}' | while read -r p; do
            case "$BASES" in *" ${p%%:*} "*) ;; *) printf '%s ' "$p" ;; esac
        done)
        if [ -n "$EXTRA" ]; then
            say "Packages: NOT removed — apt would also remove: $EXTRA"
            say "          (installed after the setup and depending on its packages). Remove those yourself first, or keep the packages."
        else
            say "Packages: removing what the setup installed:$INSTALLED"
            if DEBIAN_FRONTEND=noninteractive apt-get purge -y $INSTALLED >/dev/null; then
                PURGED=yes
                say "Packages: removed"
            else
                say "Packages: apt-get purge failed — see above; nothing else is cleaned up"
            fi
        fi
    fi

    if [ "$PURGED" = "yes" ] || [ -z "$INSTALLED" ]; then
        # Leftovers of removed packages that apt leaves behind (files created
        # after installing, so not theirs). Only for packages the setup installed.
        case " $PKGS " in *" nodejs "*)
            rmdir /usr/lib/node_modules 2>/dev/null ;;
        esac
        if [ "$NODE_FROM_SETUP" = "yes" ]; then
            rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/sources.list.d/nodesource.sources \
                  /etc/apt/keyrings/nodesource.gpg /usr/share/keyrings/nodesource.gpg \
                  /etc/apt/preferences.d/nodejs /etc/apt/preferences.d/nsolid
            say "Removed the NodeSource apt source"
        fi
        # Chrome's package registers Google's apt repository on install.
        case " $PKGS " in *" google-chrome-stable "*)
            rm -f /etc/apt/sources.list.d/google-chrome.list /etc/apt/sources.list.d/google-chrome.sources
            say "Removed the Google Chrome apt source" ;;
        esac
        case " $PKGS " in *" nginx-common "*|*" nginx "*)
            rm -rf /etc/nginx /var/log/nginx /var/lib/nginx
            rm -f /var/www/html/index.nginx-debian.html
            rmdir /var/www/html /var/www 2>/dev/null
            say "Removed nginx's leftover config and logs" ;;
        esac
        case " $PKGS " in *" certbot "*)
            if [ -n "$(ls -A /etc/letsencrypt/live 2>/dev/null | grep -v '^README$')" ]; then
                say "Kept /etc/letsencrypt — it holds certificates"
            else
                rm -rf /etc/letsencrypt /var/lib/letsencrypt /var/log/letsencrypt
            fi ;;
        esac
        rmdir /etc/wireguard 2>/dev/null
        rm -rf /var/lib/bot-panel-agent
    fi
fi

echo "──────────────────────────────────────────────"
echo " Done. UFW is $(ufw status 2>/dev/null | head -1 | sed 's/Status: //' || echo 'not installed')."
echo " Kept on purpose: packages that were there before the setup, every upgrade,"
echo " the SSH rule in UFW, apt's package lists${KEPT:+ — and, as asked: ${KEPT#, }}."
echo "──────────────────────────────────────────────"
FINISHED=yes
report done
