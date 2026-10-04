# 🤖 Bot Panel

> A self-hosted admin panel for managing Discord bots **and websites** on a VPS — built with **Node.js + Express** (backend), **React 18 + Vite + Tailwind** (frontend), and a **Discord buyer bot** for customer-facing control.

![Node](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen?logo=node.js)
![PM2](https://img.shields.io/badge/Process%20Manager-PM2-blue)
![React](https://img.shields.io/badge/Frontend-React%2018-61DAFB?logo=react)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## ✨ Features

### Admin Panel — Bot Management
- 🔐 JWT-authenticated login (bcrypt password hash, 24 h token lifetime)
- 📊 Live CPU & RAM ring charts polled every 4 s with 120-sample trend history
- 🤖 Bot grid with live PM2 status badges (online / stopped / errored)
- 🔍 Search & filter bots by name, status, group, or tag
- ➕ Create bots via git clone **or** import an existing local folder
- 📂 Group bots with color-coded labels
- 🏷️ Tag system — assign multiple tags per bot for fine-grained categorization
- 🧠 Per-bot PM2 memory limit (`--max-memory-restart`)
- 💾 PM2 state is auto-saved after every start / stop / restart / delete
- ▶️ One-click Start / Stop / Restart / Pull & Update per bot
- 🔄 Restart rate limiter — auto-stops a bot after ≥ 5 restarts within 60 s
- 📋 Log viewer — snapshot (last 200 lines) + live SSE streaming
- 📁 File manager — full directory browser inside each bot folder
- 🖊️ CodeMirror 6 in-browser code editor with syntax highlighting for 15+ languages
- 🗄️ SQLite viewer — browse and query `.db` / `.sqlite` files directly in the browser
- 🗂️ In-browser `.env` file editor
- ⚙️ Settings tab — edit name, start script, group, tags, memory limit, expiry date
- ⏰ Expiry date stored correctly across timezones (no UTC drift on repeated saves)
- ⚠️ Discord webhook expiry warnings at 7 d / 3 d / 1 d
- 🗑️ Auto-removal of expired bots (stops PM2, deletes files, alerts Discord)
- 🔔 In-panel notification center — warnings, memory alerts, system events
- 📦 Bulk operations — start / stop / restart / install / update / remove multiple bots at once

### Admin Panel — Website Hosting
- 🌐 Host **static sites** (served by `http-server` via PM2, or nginx when a domain is assigned)
- 🖥️ Host **fullstack sites** (PM2 process + optional nginx reverse-proxy)
- 🔗 Domain assignment — auto-generates and applies nginx vhost configuration
- 🔒 SSL/HTTPS support via nginx + Let's Encrypt (custom nginx config blocks supported)
- 🌍 Domains page — unified view of all active domains across every project
- 🚪 Auto UFW port management — opens / closes firewall rules automatically

### Admin Panel — Infrastructure
- 🔀 Reverse-proxy manager — configure a shared nginx upstream per bot/site
- 📡 System overview page — CPU / RAM / disk with per-process breakdown and trend graphs
- 🔑 SSH key manager — generate, store, and test deploy keys for private GitHub repos
- ⚙️ Git config editor — set global `user.name` / `user.email` for git operations
- 🛠️ Panel self-management — restart or rebuild the panel itself from the UI, view/edit panel `.env`
- 🗃️ Hourly backup to Discord (databases + `.env`, verified pieces) and one-click rollback from a message link
- 🧮 Memory monitor service — runs every minute; restarts any bot that exceeds its limit and fires a notification
- 🎵 Lavalink fleet — one audio server per node, one shared config edited on the panel, and a 02:00 daily release check that updates every node and reports to Discord

### Buyer Discord Bot
- `/mybots` — list all buyer's bots with status + expiry countdown
- `/start <bot_id>` / `/stop <bot_id>` / `/restart <bot_id>`
- `/expiry` — view subscription time remaining for all bots

### External API
- API-key authenticated REST endpoints (for integrations like **ArnTo-Auto** Discord bot)
- Allows external services to query and control bots without a panel login

---

## 📁 Directory Structure

```
root/
├── bots/                            ← Buyer bot repos live here
│   └── {buyerID}/{botID}/           ← git clone target
│
└── bot-panel/                       ← This project
    ├── server/
    │   ├── db/
    │   │   ├── index.js             ← Shared QuickDB singleton
    │   │   └── QuickDB.js           ← Extended QuickDB class
    │   ├── middleware/
    │   │   ├── auth.js              ← JWT verification middleware
    │   │   ├── apiKey.js            ← API key middleware (external routes)
    │   │   └── errorHandler.js      ← Global Express error handler
    │   ├── routes/
    │   │   ├── auth.js              ← POST /api/auth/login, GET /api/auth/verify
    │   │   ├── bots.js              ← Full bot CRUD + start/stop/restart/update/env/fs/websites
    │   │   ├── groups.js            ← Group CRUD (name + color)
    │   │   ├── tags.js              ← Tag CRUD
    │   │   ├── bulk.js              ← Bulk start/stop/restart/install/update/remove
    │   │   ├── logs.js              ← Snapshot + SSE live log streaming
    │   │   ├── system.js            ← CPU, RAM, disk stats
    │   │   ├── panel.js             ← Panel self-management (restart, rebuild, env, logs)
    │   │   ├── github.js            ← SSH key + git config management
    │   │   ├── proxy.js             ← Egress proxy — pin a bot's public IP to a VPS
    │   │   ├── proxies.js           ← Proxy pool the panel egresses through + per-feature switches
    │   │   ├── notifications.js     ← In-panel notification inbox
    │   │   └── external.js          ← External API (API-key protected)
    │   ├── services/
    │   │   ├── discordService.js    ← Webhook alerts
    │   │   ├── expiryService.js     ← Hourly expiry check + auto-removal
    │   │   ├── backupService.js     ← Hourly backup to Discord + rollback
    │   │   ├── backupArchive.js     ← Backup file format + restore at start
    │   │   ├── memoryMonitorService.js ← Per-minute memory overflow checker
    │   │   ├── githubService.js     ← SSH key generation + ~/.ssh/config manager
    │   │   └── panelService.js      ← Panel restart / client rebuild helpers
    │   └── index.js                 ← Express entry point
    │
    ├── discord-bot/                 ← Buyer-facing Discord bot
    │   ├── commands/
    │   │   ├── mybots.js            ← /mybots
    │   │   ├── start.js             ← /start <bot_id>
    │   │   ├── stop.js              ← /stop <bot_id>
    │   │   ├── restart.js           ← /restart <bot_id>
    │   │   └── expiry.js            ← /expiry
    │   ├── events/
    │   │   ├── ready.js             ← Auto-registers slash commands on login
    │   │   └── interactionCreate.js ← Routes slash commands
    │   ├── utils/helpers.js
    │   └── index.js
    │
    ├── client/                      ← React SPA (Vite + Tailwind)
    │   └── src/
    │       ├── api/client.js        ← Axios instance with JWT interceptor
    │       ├── context/
    │       │   ├── AuthContext.jsx  ← Global auth state
    │       │   └── DataContext.jsx  ← Shared bot/group/tag data + polling
    │       ├── pages/
    │       │   ├── Login.jsx        ← Admin login page
    │       │   ├── BotDetail.jsx    ← Per-bot controls, logs, env, files, settings
    │       │   ├── SitesPage.jsx    ← Website management
    │       │   ├── DomainsPage.jsx  ← Unified domain list
    │       │   ├── SystemPage.jsx   ← System stats + per-process table + trend charts
    │       │   ├── GroupsPage.jsx   ← Group management
    │       │   ├── TagsPage.jsx     ← Tag management
    │       │   ├── MultiManage.jsx  ← Bulk operations UI
    │       │   ├── ProxyPage.jsx    ← Egress proxy per bot
    │       │   ├── ProxiesPage.jsx  ← Proxy pool (static / rotating) + Auto Quest egress
    │       │   └── PanelManage.jsx  ← Panel self-management
    │       ├── components/
    │       │   ├── Layout.jsx          ← Collapsible sidebar + page wrapper
    │       │   ├── BotCard.jsx         ← Bot card with status + quick actions
    │       │   ├── StatsWidget.jsx     ← CPU/RAM ring charts
    │       │   ├── LogViewer.jsx       ← Snapshot + live SSE log viewer
    │       │   ├── EnvEditor.jsx       ← .env textarea editor
    │       │   ├── FileEditor.jsx      ← Full filesystem browser + CodeMirror editor
    │       │   ├── CodeMirrorEditor.jsx ← CodeMirror 6 wrapper (15+ language modes)
    │       │   ├── SQLiteViewer.jsx    ← In-browser SQLite table viewer (sql.js)
    │       │   ├── CreateBotModal.jsx  ← New bot/site form (git clone / local import)
    │       │   ├── GroupManager.jsx    ← Group CRUD with color picker
    │       │   ├── TrendModal.jsx      ← CPU/RAM trend line chart overlay
    │       │   └── ConfirmModal.jsx    ← Reusable confirm dialog
    │       ├── App.jsx              ← Router + auth guard
    │       └── main.jsx
    │
    ├── data/                        ← Auto-created — holds panel.sqlite
    ├── .env                         ← Your secrets (never commit this)
    ├── .env.example                 ← Template to copy from
    ├── .gitignore
    ├── ecosystem.config.js          ← PM2 config for panel + buyer bot
    └── package.json
```

---

## ⚙️ Setup

### 1. Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js ≥ 18 | |
| PM2 (global) | `npm install -g pm2` |
| Git | Available in `PATH` |
| nginx | Only required if you host websites |
| UFW | Only required for auto firewall management |

### 2. Clone & Install

```bash
cd /root
git clone <this-repo-url> bot-panel
cd bot-panel

# Install server dependencies
npm install

# Install & build the React frontend
cd client && npm install && npm run build && cd ..
```

### 3. Configure Environment

```bash
cp .env.example .env
nano .env
```

| Variable                 | Required | Description                                                   |
|--------------------------|----------|---------------------------------------------------------------|
| `PORT`                   | Yes      | Express server port (default: `3000`)                         |
| `NODE_ENV`               | Yes      | `production` or `development`                                 |
| `ADMIN_USERNAME`         | Yes      | Panel login username — the panel's ONLY account               |
| `ADMIN_PASSWORD_HASH`    | Yes      | bcrypt hash of that account's password (see below)            |
| `JWT_SECRET`             | Yes      | Long random string for signing JWTs                           |
| `PANEL_NODE_ID`          | Yes      | `_id` of the node record this panel runs on                   |
| `PANEL_DISCORD_TOKEN`    | No       | The panel's own Discord bot — posts commands on the bus       |
| `PANEL_BUS_CHANNEL_ID`   | No       | Private channel of the Discord bus (see Shared Data below)    |
| `DISCORD_ALERT_WEBHOOK`  | No       | Webhook URL for expiry warnings and removal alerts            |
| `DISCORD_BACKUP_WEBHOOK` | No       | Webhook URL for the hourly backup (DBs + `.env` — keep it private) |
| `QUEST_ENC_SECRET`       | Auto Quest | Encrypts stored Discord tokens (64 hex chars)               |
| `DECOR_SITE_GITHUB_TOKEN`| No       | Publishes the decor site's data snapshot (fine-grained, Contents r/w) |
| `PANEL_API_KEY`          | No       | Legacy shared key for `/api/external/*` — projects use their own keys |
| `CLIENT_URL`             | No       | Vite dev server URL — only needed in development              |

`BOTS_ROOT_DIR` / `SITES_ROOT_DIR` belong to each node's **agent** `.env`, not the panel's.

**Generate your password hash:**

```bash
node -e "const b=require('bcryptjs'); console.log(b.hashSync('YOUR_PASSWORD_HERE', 10));"
```

Paste the output into `ADMIN_PASSWORD_HASH` in your `.env`, then restart the panel.

> **The panel is single-account.** `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH` *are* the
> account — there is no users table, no roles and no way to create a second login.
> Changing the password means regenerating the hash and restarting.

### 4. Create the Bots Root Directory

```bash
mkdir -p /root/bots
# If hosting websites separately:
mkdir -p /root/sites
```

### 5. Start with PM2

```bash
# Start panel server + buyer Discord bot
pm2 start ecosystem.config.js

# Persist across reboots
pm2 save
pm2 startup
# → copy and run the command PM2 prints
```

Access the panel at: `http://your-server-ip:3000`

---

## 🔧 Development Mode

```bash
# Run both backend and frontend simultaneously
npm run dev

# Or separately:
# Terminal 1 — backend with nodemon
npm run dev:server

# Terminal 2 — React dev server with HMR
npm run dev:client
```

The Vite dev server runs at `http://localhost:5173` and proxies `/api` to `http://localhost:3000`.

---

## 🗃️ Database Schema

All data is stored in `data/panel.sqlite` via QuickDB (SQLite).

### `bots` collection

```js
{
  _id:           string,        // nanoid(24) — auto-assigned
  buyerID:       string,        // Discord user ID of the buyer
  botID:         string,        // Short slug, e.g. "my-bot"
  name:          string,        // Display name
  repoUrl:       string|null,   // Git clone URL (null for local bots)
  branch:        string|null,   // Git branch (null for local bots)
  startScript:   string,        // Entry file, e.g. "index.js"
  pm2Name:       string,        // "{buyerID}-{botID}" — unique PM2 identifier
  source:        "git"|"local", // How the bot was added
  localPath:     string|null,   // Absolute path (local bots only)
  groupId:       string|null,   // _id of the assigned Group, or null
  tags:          string[],      // Array of Tag _ids
  maxMemory:     string|null,   // PM2 memory limit e.g. "300M", "1G", or null
  expiresAt:     number|null,   // Unix timestamp (ms) or null = no expiry
  createdAt:     number,        // Unix timestamp (ms)
  websiteConfig: object|null,   // Only set for website projects (see below)
  nodeId:        string,        // "local" or a Node _id — which VPS runs this bot
}
```

### `nodes` collection

```js
{
  _id:       string,  // nanoid(24)
  name:      string,  // e.g. "VPS 2"
  host:      string,  // Agent IP/host
  port:      number,  // Agent port
  apiKey:    string,  // Shared secret for the agent (never sent to the client)
  enabled:   boolean, // Disabled nodes are skipped by the scheduler
  createdAt: number,
}
```

### `websiteConfig` (embedded in bot record)

```js
{
  mode:        "static"|"fullstack", // Serving mode
  port:        number,               // Port the process listens on
  distFolder:  string,               // Relative or absolute path to built assets
  domain:      string|null,          // Custom domain (triggers nginx vhost)
  sslEnabled:  boolean,              // Whether HTTPS is configured
  extraConfig: string|null,          // Custom nginx location blocks
}
```

### `groups` collection

```js
{
  _id:       string,  // nanoid(24)
  name:      string,  // e.g. "Premium"
  color:     string,  // Hex e.g. "#6366f1"
  createdAt: number,
}
```

### `tags` collection

```js
{
  _id:       string,  // nanoid(24)
  name:      string,
  color:     string,  // Hex color
  createdAt: number,
}
```

### `notifications` collection

```js
{
  _id:       string,
  message:   string,
  type:      "info"|"warning"|"error",
  read:      boolean,
  createdAt: number,
}
```

---

## 🖧 Multi-VPS (Nodes)

The panel can spread **Discord bots** across multiple VPS. Each worker VPS runs
the lightweight **agent** (`agent/` in this repo) that executes PM2/git/file/log
operations on behalf of the panel.

- **Placement**: when creating a git-deployed Discord bot, choose a node in the
  create form or leave it on **Auto** — the scheduler scores every online node
  (free RAM 50%, free CPU 30%, free disk 20%; nodes under 5 GB free disk are
  excluded) and picks the best one. `POST /api/bots` also accepts an optional
  `nodeId` ("auto", "local", or a node `_id`).
- **Websites, services, and local imports always run on the panel VPS** —
  they depend on nginx/UFW/DNS there.
- **Existing bots** are migrated to `nodeId: "local"` on first startup and
  behave exactly as before.

### Adding a node — one command

**Systems → Add node → One command**: enter a name and the new VPS's public IP.
The panel shows one command. Run it on that VPS (Ubuntu 22.04/24.04), logged in
as the account that should own the agent:

```bash
curl -sSL 'https://panel.example.com/api/join/<token>/install.sh' -o join-node.sh && sudo bash join-node.sh
```

It is `agent/setup-agent.sh` with the settings filled in by the panel. It installs
Node 22, PM2, git, nginx, certbot, WireGuard, Java 17 and build tools (the
agent's terminal module compiles on install). It clones the repo at
the **panel's own commit**, generates the agent key and opens the agent port to
the panel's IP only. It also opens the port sshd listens on, and 80/443 for
nginx (panel domains, websites, and certbot's check). Then it starts the
agent and registers it. The panel then sets the node up and the script prints
each step (the modal shows the same):

**Which account.** The agent runs as the user who typed `sudo`: the repo goes in
`~/panel`, projects in `~/bots` and `~/sites`, and the agent and Lavalink run in
that user's PM2 (`pm2 ls` as that user), with a `pm2-<user>` boot service. The
agent runs ufw, wg, nginx and certbot through `sudo` with no one there to type a
password, so the script adds `/etc/sudoers.d/bot-panel-agent-<user>` for exactly
those commands. That list includes cp/mv/bash, so it is root-equivalent for that
user, the same trust an agent running as root has. From a root shell (`su -`)
it all goes to root. `AGENT_USER=<name>` picks another account. The script
stops before changing anything when the agent port is already taken, for example
on a machine that is a node already.

| Step | What happens |
|------|--------------|
| SSH keys and git config | Every key on the panel's GitHub Keys page is copied over |
| WireGuard mesh | An overlay IP is assigned (10.88.0.x) and the mesh is re-pushed to every node |
| Follow this panel (lease) | Claimed at the current epoch at once; its gateway `127.0.0.1:4201` learns the panel's address |
| Panel reachable for the panel gateway | `ufw allow in on wg0 from <new overlay IP> to any port <PORT>` on the panel's node, then probed from the new node (an agent older than 1.10.0 there adds the rule without `in on wg0`) |
| PM2 log rotation | pm2-logrotate in the agent's PM2: max 50M per log, keep 7, gzip (see below) |
| Lavalink | Installed and started when auto-install is on |

**pm2-logrotate on every node.** Every agent installs pm2-logrotate into its
own PM2 a few seconds after it starts, when the module is missing. A node
therefore has it from its setup, and the nodes that exist already get it on
their next agent restart (**Rebuild & Restart** restarts them all). An existing
install and its settings are left alone. `PM2_LOGROTATE=off` in the agent's
`.env` opts a node out.

A failed step is reported but does not undo the others. Its page (WireGuard,
Lavalink, GitHub Keys) can retry it.

**The token.** It works once and expires after 30 minutes. The panel stores only
its sha256, and it is bound to the IP typed into the form: the panel calls the
agent at that IP itself to check the key, so a leaked command cannot register
any other machine. The agent key travels encrypted with the token (AES-256-GCM).
Over plain HTTP anyone who reads the traffic can read both, so the form warns
when the panel has no HTTPS address. If a run fails before the node is saved
(firewall, agent not up), the command stays valid: fix the cause and run it
again. The repo URL comes from the panel checkout's `origin` as public https;
set `NODE_JOIN_REPO_URL` in the panel's `.env` to override it.

### Adding a node — by hand

```bash
# On the fresh worker VPS (Ubuntu 22.04/24.04), as the account that should own the agent:
curl -fsSL https://raw.githubusercontent.com/<your-repo>/main/agent/setup-agent.sh -o setup-agent.sh
sudo bash setup-agent.sh <PANEL_IP> [AGENT_PORT] [REPO_URL]
```

Then **Systems → Add node → Manual**, and paste the host/port/API key the script
printed. The connection is verified before the node is saved, and the same setup
steps run in the background.

### Removing a node

Remove it on the panel first (the node's page → **Remove**; refused while
projects still live on it). The other nodes then drop it from the WireGuard
mesh. Then, on the machine:

```bash
curl -fsSL https://raw.githubusercontent.com/<your-repo>/main/agent/uninstall-agent.sh -o uninstall-agent.sh
sudo bash uninstall-agent.sh <USER>   # the account the agent ran as, e.g. root
```

It undoes the setup, keeping only what was there before it:

- **PM2**: panel-agent, lavalink and the agent's own spotify-tokener leave that user's PM2, and pm2-logrotate
  does too when the agent installed it. That user's PM2 and its boot service go
  too when nothing else is left in it.
- **Network**: a bot-panel `wg0` and the UFW rules for the agent port and
  51820/udp are removed, and so are the 80/443 rules when the setup added them.
  UFW is turned off again if the setup is what turned it on.
- **Files**: the SSH keys the panel copied, `~/panel` and `~/lavalink` are
  removed, and so are `~/bots` / `~/sites` when they are empty.
- **Packages**: exactly the packages apt's `history.log` shows the setup *newly*
  installed are purged (nginx, certbot, WireGuard, Java, Chrome, build tools, Node.js and their
  dependencies). So are the global PM2 and the NodeSource and Google Chrome apt sources. Packages
  that were already there and every upgrade stay. apt is asked first, and
  nothing is purged if it would take anything else with it. `--keep-packages`
  skips this part.

It refuses to run on the node that hosts the panel. The setup keeps what it
found (UFW on or off, Node/PM2 present or not) in
`/var/lib/bot-panel-agent/state`. For a machine set up before that record
existed, the script works it out from apt's history and file dates.

### Node API summary

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/nodes` | All nodes with live status/stats/bot counts |
| `POST` | `/api/nodes` | Register node (connection-tested first) |
| `PUT` | `/api/nodes/:id` | Update node (enable/disable, key rotation) |
| `DELETE` | `/api/nodes/:id` | Remove node (blocked while bots live on it) |
| `POST` | `/api/nodes/:id/test` | Live connection + stats check |
| `GET` | `/api/nodes/invites` | Join invites of the last 24 h |
| `POST` | `/api/nodes/invites` | `{ name, ip, port?, origin? }` → `{ invite, token, command, secure }` (token shown once) |
| `GET` | `/api/nodes/invites/:id` | Status and setup steps |
| `DELETE` | `/api/nodes/invites/:id` | Revoke a pending invite |
| `GET` | `/api/join/:token/install.sh` | Public: the setup script for that invite |
| `POST` | `/api/join/:token` | Public: the script's callback `{ apiKey (encrypted with the token), agentPort }` |
| `GET` | `/api/join/:token` | Public: setup progress, for the script |

---

## 🚚 Moving the Panel to Another Node

The panel is a control plane, so it can run on any node. **Panel Settings →
Move Panel** moves it: pick the new host, **Check**, **Prepare**, then type the
node's name to **Move**. Bots never stop — they are PM2 processes on their own
nodes. Quests and badge orders pause for the few minutes of the move and resume
on the new panel.

**Before the first move**, run **Rebuild & Restart** once so every agent
knows the lease, `/panel-host`, the panel gateway and the per-node panel vhost
(agent ≥ 1.8.0).

| Step | What happens | Panel keeps working? |
|------|--------------|----------------------|
| Check | Read-only: target online and prepared, same commit, port free, disk/RAM, every agent reachable *from the target*, every node's gateway able to reach the target, callbacks, SSH keys, the target's domains resolving to it | Yes |
| Prepare | UFW rule on every other agent for the target's IP, then on the target: `git pull`, deps, client build, HTTPS certificates for its own domains | Yes |
| Move | Pause background work → snapshot `panel.sqlite` / `samples.sqlite` → `.env` with the new `PANEL_NODE_ID` → import on the target (WireGuard when reachable, always AES-GCM with its agent key) → start it → wait until it reports active | Writes refused for a few minutes |

**Fencing.** Every panel has an *epoch*; every agent remembers the highest one it
has been claimed by and answers `409 PANEL_SUPERSEDED` to anything older. The
new panel boots at epoch + 1, claims every agent, and from that moment the old
panel is locked out of all nodes — it stops its background work and is then
retired (`pm2 delete`, `.env` → `.env.retired-<ts>`, `data/` kept). Before that
commit point any failure rolls back and the old panel carries on; after it
nothing is rolled back, so two panels never both run expiry or quests.

**Domains belong to nodes, DNS never changes.** Under **Panel Settings →
Custom Domains** every domain is added *for a node* — the one its A record
points at, for good (e.g. `panel.example.com` → sangs, `panel-poke.example.com`
→ pokeclaw). On the node running the panel its domains serve the panel; on
every other node they `302` to it. Each node's `panel-self.conf` is rendered by
its agent from that list, with the HTTPS block added for any domain that has a
certificate on disk — so rewriting it never drops HTTPS. Certificates are issued
with `certbot certonly --nginx` (plus a reload deploy hook for renewals) on the
domain's own node: Prepare does it for the target in advance, and after the
move the new panel flips every node's vhost (proxy here, redirect elsewhere). A
replaced panel's `/api/health` reports `movedTo`, and its banner links there.

**Panel gateway.** Projects that call the panel (arnto-auto → `/api/external/*`)
use `PANEL_API_URL=http://127.0.0.1:4201`. Every agent listens there (loopback
only, `PANEL_GATEWAY_PORT` in the agent's `.env`) and forwards each request
unchanged to the panel holding its node — the claim carries that address:
`127.0.0.1:<PORT>` on the panel's own node, its WireGuard IP elsewhere, re-sent
every 5 minutes. After a move the gateways follow at once; no project `.env`
changes, whichever side moved. The panel port must accept the other nodes over
`wg0`; Check prints the `ufw` command for any node that cannot reach the target.
**Panel Settings → Panel Gateway** shows each node's gateway and where it points.

**The bots.** The panel never calls a bot, so moving it changes nothing for
them: they reach it through their gateway and receive its commands on the Discord
bus (see *Shared Data & Discord Bus*). Their shared data is in
`data/shared.sqlite`, which the move carries — mandatory, and encrypted with the
target agent's key (it holds customer orders); a failure rolls the move back.

**The target** needs nginx + certbot when it has a domain
(`apt install nginx certbot python3-certbot-nginx`) and must accept ports 80 and
443 (or the panel port, without a domain). Check probes them from the current
host: a timeout means a firewall drops them.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Public: `{ ok, state, epoch, movedTo? }` — `state` is `starting`, `active`, `maintenance` or `fenced`; a fenced panel names the new address |
| `GET` | `/api/panel/domains` | `{ domains, nodes, panelNodeId, publicUrl }` |
| `POST` | `/api/panel/domains` | `{ domain, nodeId }` — nodeId = where its DNS points (default: the panel's node) |
| `POST` | `/api/panel/domains/:domain/ssl` | Let's Encrypt on the domain's node |
| `GET` | `/api/panel/gateway` | Each node's panel gateway: listening, forwarding to, reachable |
| `GET` | `/api/panel/migration` | State, running/last job, nodes, recent moves |
| `POST` | `/api/panel/migration/preflight` | `{ targetNodeId }` → checks |
| `POST` | `/api/panel/migration/prepare` | `{ targetNodeId }` — runs in the background |
| `POST` | `/api/panel/migration/start` | `{ targetNodeId, confirmName }` — the move, in the background |

Limits: `panel.sqlite` travels as JSON (the agent accepts 15 MB); history is
streamed and skipped with a warning if it fails. Moving back is the same
procedure in the other direction.

---

## 🗄️ Shared Data & Discord Bus

The panel is the hub: **bots call the panel, the panel never calls a bot.**

**Shared data.** Collections a bot and the panel both use (the shop's `orders` +
`nextOrderId`, the assistant's `decors`, `importedDecors`, `prices`,
`decorCategories`) live in the panel's `data/shared.sqlite` — one row per record,
never the whole array per write. A bot keeps its QuickDB calls unchanged: its
`extensions/QuickDB.js` (canonical copy `bot-lib/QuickDB.js`) sends the names listed
in `PANEL_SHARED` to `/api/external/data` through its gateway, with its own key;
every other name stays in its `json.sqlite`. Reads are `GET` (still answered while
the panel moves), writes `POST`; when the panel is unreachable a read answers the
last value the bot saw, a write fails. Only the owning project can touch a name.

To move a collection: **Panel Settings → Shared Data** → *Declare* it for the
project, add it to that project's `PANEL_SHARED`, restart the project — its first
start uploads its local copy once (`adoptShared()`), and from then on the panel is
the only truth. The Decors and Orders pages read the panel's copy directly.

**Discord bus.** When the panel needs a bot to act (complete an order, DM a buyer,
report quest progress, resolve a decor), its own Discord bot (`PANEL_DISCORD_TOKEN`)
posts a command in one private channel (`PANEL_BUS_CHANNEL_ID`), mentioning the
target bot; the bot runs it and replies to that message. Both envelopes are
HMAC-signed with the target project's key, so a message from anyone else is
ignored. A bot (`bot-lib/PanelBus.js`) announces the commands it handles when it
starts; the panel only uses the bus for a bot that did. Every 5 minutes, and on
start, a bot re-reads the last 3 days of the channel, so a command posted while it
was down still runs — each id once. The outbox lives in `shared.sqlite` and travels
with a move. Every bot must be a member of the server that holds the channel (the
arnto bots keep it via `PANEL_BUS_GUILD_ID` instead of leaving). *Ping* on the Panel
page is a harmless round trip.

| Bot | Shared data (`PANEL_SHARED`) | Bus commands |
|-----|-------------------------------|--------------|
| ArnTo-Shop | `orders`, `nextOrderId` | `order.create`, `order.complete`, `order.cancel` |
| ArnTo-assistant | `decors`, `importedDecors`, `prices`, `decorCategories` | `decor.preview`, `decor.import`, `decor.gift.deliver` |
| ArnTo-Auto | — | `quest.event`, `badge.event`, `dm.send` |

**Sealed commands.** A payload only the target may read (gift links) goes out as
`{ sealed }` — AES-256-GCM under a key derived from the target project's own API key,
applied before the outbox row is written (`discordBus.request(…, { sealed: true })`).
The channel, `shared.sqlite` and its backups see ciphertext; `bot-lib/PanelBus.js`
opens it before the handler runs. Bots need the current `PanelBus.js` to receive one.

A bot's `.env`: `PANEL_API_URL=http://127.0.0.1:4201`, `PANEL_API_KEY=<its own key>`,
`PANEL_SHARED=…`, optionally `PANEL_SHARED_TTL_MS` (read cache) and `PANEL_BUS_GUILD_ID`.

The public decor site reads `GET /api/public/decors` and `/api/public/decors/categories`
(no auth, read-only) live on every visit, through its own Vercel function that finds
the active panel. Its fallback, `data/decors.json` + `data/categories.json`, is
committed a minute after the decor data changes, when `DECOR_SITE_GITHUB_TOKEN` is
set. `shared.sqlite` is also in the hourly Discord backup (see Backup & Rollback).

**Decor sale switches.** Every decor and bundle, loaded or imported, can stop being sold
one way: `noLoginWithNitro`, `noLoginWithoutNitro`, `noGift` (a bundle's Gift Bundle) on
its record — absent = sold. Set them on the Decors page (card chips, the detail window,
or "Hàng loạt" for a theme / the current filter). A switched-off way sells for 0 in
`/api/public/decors`; the decor site shows "Không bán loại này" (or "Ngừng bán" when all
three are off) and the assistant's `/decor-find` says the same. `/decor-load` copies the
flags onto the decors it rewrites — deploy the assistant before using them on loaded
decors, or the next load wipes them. The price table's "unpriced" warning only counts
ways that are sold (a bundle that sells a way needs its members' tiers for it).
`PATCH /api/decors/:sku_id` (one; `category_sku_id` for imported only) and
`PATCH /api/decors` `{ sku_ids, …flags }` (many).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/external/data` | Project key: its names + the bus channel and the panel's bot id |
| `POST` | `/api/external/data` | `{ op: "hello", commands }` — a bot announces its bus commands |
| `GET` | `/api/external/data/:name?op=get\|find\|findOne&query=` | Read |
| `POST` | `/api/external/data/:name` | `{ op, query, data, items, value, by }` — write; `op: "adopt"` once |
| `GET` | `/api/panel/shared` | Names, owners, sizes, bus status, recent commands, decor site |
| `POST` | `/api/panel/shared/declare` | `{ name, kind, botId }` |
| `POST` | `/api/panel/shared/ping` | `{ botId }` — round trip over the bus |

**Auto Deco Gift.** Buyers pick decors on ArnTo-Auto's Discord panel (`/dg-setup`) and
pay by QR there; the panel connects the three bots (`server/services/decorGiftService.js`):

1. Auto reads `GET /api/external/decor-gift/catalog` — decors sold as Gift (switch on,
   priced; bundles at their Gift Bundle price), grouped by theme like the decor site,
   with a list thumbnail and the `/decor-find` picture.
2. Paid → `POST …/orders` → the shop's `order.create` opens a real `arnto_N` order in its
   waiting list, like `/new` without a ticket, and DMs the bill. Idempotent on `paymentId`.
   The order carries `source: "decoGift"`, has no ✅/❌ buttons, and the Orders page will
   not complete or cancel it (409).
3. An admin presses Duyệt in Auto's staff channel and types one gift link per decor →
   `POST …/orders/:orderId/deliver` → the assistant DMs them (`decor.gift.deliver`,
   sealed, once per order) → the shop completes the order. A closed DM comes back as
   `{ delivered: false, reason: "dm_blocked" }` and nothing is completed.
4. Hủy → `POST …/orders/:orderId/cancel` → the shop's `order.cancel`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/external/decor-gift/catalog` | `{ categories: [{ sku_id, name, count }], decors: [{ sku_id, name, type, typeLabel, category, price, thumb, image, members? }] }` |
| `POST` | `/api/external/decor-gift/orders` | `{ paymentId, buyerId, sellerId, items, total }` → `{ orderId, messageId, waitingUrl }` |
| `POST` | `/api/external/decor-gift/orders/:orderId/deliver` | `{ buyerId, items: [{ name, type, link }] }` → `{ delivered, completed, reason?, error? }` |
| `POST` | `/api/external/decor-gift/orders/:orderId/complete` | Shop completes (retry after a delivery whose completion failed) |
| `POST` | `/api/external/decor-gift/orders/:orderId/cancel` | Shop cancels |

---

## 💬 Message Templates (Embeds page)

Every message a bot sends — embeds, plain text, button labels, menu texts — is a
**template** the **Embeds** page (`/embeds`) edits, Discohook-style, with a live
Discord-looking preview. The panel stores only what the admin changed; the
default stays in the bot's code.

- **Language** — `bot-lib/uiTemplate.js`, one file shared by the bots and the page
  (`client/src/lib/uiTemplate.js` is generated from it: `node scripts/sync-ui-template.js`).
  `{order.orderId}` variables, `{price|money}` filters (money, vnd, number, time:R,
  date, trunc:n, default:"…", join, upper…), `{#if a == "x"}…{#elseif}…{#else}…{/if}`,
  `{#each items}{@number}. {name}{/each}`. An unknown name stays as typed, so a
  typo shows instead of vanishing. A message template is
  `{ content, embeds, components, selects }`; embeds, fields and buttons take an
  `if`, a field an `each`. Buttons are the bot's **slots** (the template sets label /
  emoji / style / place — a slot the template does not place is still appended, a
  template can never drop a button the bot needs) plus plain link buttons.
- **Cards** — Components V2 views whose layout the bot builds (lists, menus) are
  edited as their words: colour, text slots, button labels, menu texts.
- **Bots** — `bot-lib/MessageTemplates.js` (copied into each bot's `extensions/`
  with `uiTemplate.js`). The bot's `templates/*.js` declare key, group, label,
  variables (typed: `"order"`, `"user?"`, `"decoItem[]"` — whole objects, so later
  templates can use fields today's text does not) and the default. On start it
  uploads the catalog; it polls every 15 s through its gateway and keeps the last
  copy locally, so a panel that is away changes nothing. An admin version that
  does not parse or breaks a Discord limit **falls back to the default**.
- **Variables everywhere** — `{bot.*}`, `{guild.*}`, `{now}`, the bot's own globals
  (ArnTo-Shop: `{shop.*}`, ArnTo-Auto: `{auto.*}`, ArnTo-assistant: `{assistant.*}`) and the admin's **custom variables** `{custom.*}`
  (Embeds → Biến tùy chỉnh) — e.g. one colour used by every embed.
- **Posted panels** — panels a bot posted (`/ticket-setup`, `/dg-setup`, `/quest-setup`,
  `/rb-setup`, `/badge-setup`, `/panel-setup`) are tracked;
  Embeds → Panel đã gửi re-renders them (bus `ui.refresh`) or adopts an older one by
  its message link (`ui.adopt`).

- **The panel's own messages** — expiry alerts (webhook + the buyer's DM), the Lavalink
  report and the backup message are templates too: `server/templates/panel.js`, listed as
  the project **Bot Panel** (`__panel` in `ui_catalog`, registered on start) and rendered
  in-process by `services/panelTemplates.js` with the same fallback rules.

Everything is converted: ArnTo-Shop (96 messages), ArnTo-Auto (117: Auto Quest, Robux,
Badge, Deco Gift, the bot-management panel, AutoBank's webhook log), ArnTo-assistant
(23: wallet DMs and salary log, ticket tools, scratch cards, `/fdone`, the secret form,
decor views and admin replies, the Deco Gift link DM — a gift link an edited template
drops is appended anyway) and the panel (5). A panel posted before its bot was converted
is not tracked — adopt it once by its link. Protocol text other bots parse (`!dms`,
`!blcadd`, `$mn`, `$rq`, `!done`, `!payed`) and developer commands are not templates.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/external/ui/catalog` | Bot: `{ types, globals, templates, hash }` — keys are global, a key another bot owns is 409 |
| `GET` | `/api/external/ui?version=&hash=` | Bot: its overrides + custom variables, or `{ unchanged }`; `needCatalog` when its hash is stale |
| `POST` | `/api/external/ui/posted` | Bot: `{ posted: [{ key, channelId, messageId }] }` |
| `GET` | `/api/ui` | Page: every catalog, overrides, custom variables, posted panels |
| `POST` | `/api/ui/check` | `{ key, value }` → `{ errors, warnings }` |
| `PUT` | `/api/ui/templates/:key` | `{ value }` — parse errors and empty messages refused; limits broken with the preview data only warn |
| `DELETE` | `/api/ui/templates/:key` | Back to the bot's default |
| `PUT` | `/api/ui/custom` | `{ vars }` |
| `POST` | `/api/ui/posted/refresh` | `{ botId?, keys? }` |
| `POST` | `/api/ui/posted/adopt` | `{ key, link }` |

Checks: `node scripts/uiTemplate.test.js`, `node scripts/messageTemplates.test.js`,
`node scripts/uiTemplateService.test.js`, `node scripts/panelTemplates.test.js`.

---

## 💾 Backup & Rollback

Same mechanism as `template-discord-bot` (its `BACKUP.md`), extended to the panel's
two databases. Format and restore: `server/services/backupArchive.js`; sending,
reading a message back and the rollback flow: `server/services/backupService.js`.

**Backup** — every hour at :30 (`BACKUP_INTERVAL_HOURS`), only while the panel is
active, ONE message to `DISCORD_BACKUP_WEBHOOK`:

```
20261002-1430__b7f3a1c9__env.txt
20261002-1430__b7f3a1c9__panel-000-of-001.gz
20261002-1430__3c9e0d12__shared-000-of-001.gz
```

Each database is a `VACUUM INTO` snapshot (consistent while the panel writes, WAL
included), gzipped, cut in 9 MB pieces. `<hash8>` = first 8 hex of the SHA-256 of the
**uncompressed** database (env.txt carries the panel's). More than 9 pieces → nothing is
sent and the log says so. `samples.sqlite` (resource history) is not backed up. Each
sent message is recorded in `data/backup-index.json` (message ids — attachment URLs
expire after 24 h), outside `panel.sqlite` so a rollback does not erase the list.

**Rollback from the panel** — Panel Settings → Backup & Rollback: paste the message's
link (Copy Message Link) or pick one from the list → **Check backup** downloads the
files through the backup webhook (it can read what it sent; else through the panel's
Discord bot), verifies every piece and checksum and shows what differs from now
(records per collection, `.env` key names — never values). Choose `panel.sqlite`,
`shared.sqlite`, `.env` (off by default) → **Roll back & restart** stages the files in
`restore/` and has the agent restart the panel.

**Rollback by hand** (panel down) — download every file of the message, put them in
`restore/` in the panel directory, `pm2 restart bot-panel`. Leaving out `env.txt`
keeps the current `.env`; leaving out a database's pieces keeps that database.

**On start** (`server/index.js`, first line, before dotenv): nothing happens unless
`restore/` holds backup files. Then: newest backup only; any missing piece, checksum
mismatch or non-SQLite data → **nothing is touched**, the panel starts with its data and
Panel Settings shows why. Otherwise the current files are renamed `*.bak-<ts>` (with
their `-wal`/`-shm`/`-journal`), the restored ones are put in place, and the sources
in `restore/` are deleted — which also disarms it for the next restart. Two things are
never rolled back, because they say which panel this is: the **fencing epoch** in
`panel.sqlite` keeps the current (higher) value — an older one would get the panel
fenced by its own agents — and `.env` keeps this machine's `PANEL_NODE_ID`. A backup
taken while the panel ran on another node gets the node fix-up of a move (the old
node's loopback `controlHost` cleared, this node's set). Result: `data/restore-last.json`.

Disaster recovery on a NEW machine works the same way, with one limit: a backup older
than the last panel move carries an older epoch, and the agents will fence it.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/panel/backups` | Schedule, last run, recent backups, files in `restore/`, last restore |
| `POST` | `/api/panel/backups/run` | Send a backup now |
| `POST` | `/api/panel/backups/inspect` | `{ source }` — download, verify, compare; writes nothing |
| `POST` | `/api/panel/backups/restore` | `{ source, parts: { panel, shared, env } }` — stage in `restore/` + restart |
| `DELETE` | `/api/panel/backups/pending` | Drop the files waiting in `restore/` |

Checks: `node scripts/backupArchive.test.js`.

---

## 🎵 Lavalink

Every node runs its own Lavalink, so a music bot connects to `127.0.0.1:<port>`
on the machine it already lives on instead of reaching across the internet to
another VPS.

- **The page.** Two tabs. **Node** is a table, one row per node (state, players,
  version, RAM, uptime, restarts, tokener); a row opens into its controls, the
  tokener switch and a **live log** of Lavalink or the tokener — the last 200
  lines, then every new one as pm2 writes it (SSE through the agent's
  `pm2 logs`, closed when the row closes). Status refreshes itself every 30s
  while the page is visible. **Cấu hình** holds the shared config.
- **One config for the whole fleet.** The panel owns `application.yml`: you edit
  port, password, heap, sources and plugins once on **/lavalink**, and the same
  rendered file is pushed to every node. A node whose file differs shows as
  *config drift*. The rendering is deterministic — the panel compares
  `sha256(application.yml)` against what each agent reports.
- **Two editors, one config.** The page switches between the panel's form
  fields and the `application.yml` itself. In file mode the file is the source
  of truth — the port, password, sources and plugin list are read back *out of
  it* (the health check uses those same values), and the form fields stay live:
  each one splices over the exact bytes of the value it targets, so comments,
  indentation and every block the form does not model survive untouched. Saving
  with nothing changed leaves the file byte-identical, so no node is falsely
  marked as drifted. Switching back to form mode can only render what the form
  models, so the panel lists what would be lost (plugin settings blocks, a
  proxy, a source with no checkbox) and waits for confirmation.
- **A new node installs itself.** Registering a node fires a best-effort install
  (latest release + config + PM2 start), the same way it fires the SSH key sync
  and the WireGuard mesh push. Registration never fails because of it; the page
  shows the outcome and offers a manual **Install**.
- **Daily release check at 02:00 Asia/Ho_Chi_Minh.** The panel reads the latest
  `lavalink-devs/Lavalink` release from GitHub and, if it is newer, updates the
  nodes **one at a time**: the agent downloads the jar, verifies its size and ZIP
  header, keeps the old one as `Lavalink.jar.prev`, restarts, then polls
  Lavalink's own `/version`. A failed health check rolls that node back to the
  previous jar — so a bad release costs one node's restart, never the fleet.
  Turn it off with the **auto-update** switch and the job only reports.
- **Discord report** to `DISCORD_LAVALINK_WEBHOOK` (falls back to
  `DISCORD_ALERT_WEBHOOK`). Quiet by design: nothing is sent when every node is
  already up to date.
- **Java is not installed for you.** Lavalink v4 needs Java 17+. The agent
  reports a missing or too-old runtime and the page shows the `apt` command —
  installing system packages from an HTTP call is outside the agent's job.
- **The pm2 memory ceiling is always explicit.** pm2 7 applies a 200MB
  `max_memory_restart` of its own when none is given (pm2 6 did not), and a JVM
  crosses that before it finishes booting — the node boots, reports ready, is
  SIGKILLed and restarts every 30 seconds with nothing in its log. The agent
  passes `2 × heap` (minimum 1G) so "no flag" is never relied on.
- **Spotify needs spotify-tokener next to Lavalink.** LavaSrc loads Spotify
  playlists and searches with the web player's anonymous token, which Spotify
  only gives a real browser — so the config points `customTokenEndpoint` at a
  small service driving headless Chrome (`agent/spotify-tokener.js`, a Node port
  of [topi314/spotify-tokener](https://github.com/topi314/spotify-tokener)).
  When `plugins.lavasrc.spotify.customTokenEndpoint` is `http://localhost:<port>`
  (or `127.0.0.1`), the agent runs it on that port as pm2 `spotify-tokener`
  whenever Lavalink runs: started before Lavalink, proven with a real token
  after, stopped with it, restarted by **Restart**, removed when the config
  stops asking for it. Without it every Spotify link fails while YouTube keeps
  working. The port comes from the one shared `application.yml`, so every node
  runs the same tokener. Chrome is a system package like Java: the setup
  installs Google Chrome on amd64, and the page shows the command for nodes
  that lack it (then **Sync** starts the tokener). The Lavalink logs include
  the tokener's.
- **A tokener the panel did not start is never touched.** Something already
  answering on that port (the Go original, a container) or a pm2 process named
  `spotify-tokener` that the panel did not register means the node has one:
  the page shows it, the panel starts nothing next to it, and never stops,
  replaces or removes it. Only the process registered from
  `~/lavalink/spotify-tokener` is the panel's.
- **Per-node switch.** Each node card has an on/off switch for the tokener, on
  by default. Off removes the panel's own tokener on that node at once, without
  touching Lavalink; on starts it (if Lavalink runs) and proves it with a token.

Agent env (all optional):

```bash
LAVALINK_DIR=~/lavalink       # fixed directory — never taken from a request
LAVALINK_PM2_NAME=lavalink
SPOTIFY_TOKENER_PM2_NAME=spotify-tokener
SPOTIFY_TOKENER_CHROME_PATH=  # default: the first Chrome/Chromium found on PATH
```

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/lavalink` | Shared settings + latest known release |
| `PUT` | `/api/lavalink/settings` | Patch settings (`sync: true` pushes to all nodes) |
| `GET` | `/api/lavalink/yaml` | The exact `application.yml` nodes should hold |
| `GET` | `/api/lavalink/status` | Per-node state, version and drift |
| `POST` | `/api/lavalink/sync` | Push the config to every node |
| `POST` | `/api/lavalink/check-update` | Run the 02:00 job now |
| `POST` | `/api/lavalink/nodes/:id/install` | First-time setup (or clean reinstall) |
| `POST` | `/api/lavalink/nodes/:id/update` | Bring one node to the latest release |
| `POST` | `/api/lavalink/nodes/:id/sync` | Push the config to one node |
| `POST` | `/api/lavalink/nodes/:id/tokener` | Per-node spotify-tokener switch (`{ enabled }`) |
| `POST` | `/api/lavalink/nodes/:id/:action` | `start` · `stop` · `restart` · `rollback` |
| `GET` | `/api/lavalink/nodes/:id/logs` | That node's Lavalink logs |
| `GET` | `/api/lavalink/nodes/:id/logs/stream` | Live log over SSE (`which=lavalink\|tokener`, `lines`, `token`) |

---

## 🔒 Security Notes

- The panel has a **single account**, defined entirely by `ADMIN_USERNAME` and
  `ADMIN_PASSWORD_HASH` in `.env`. There are no user records, no roles and no
  registration — a valid JWT is full access
- The JWT expires after **24 hours** — you must re-login after that
- The `.env` file is in `.gitignore` — **never commit it**
- All API routes are JWT-protected except `/api/auth/login`
- External API routes (`/api/external/*`) take an `x-api-key`: a project's own key (stored as sha256 + an AES-GCM copy under `JWT_SECRET`; revocable one by one), or the legacy shared `PANEL_API_KEY` if set (never for shared data)
- The Discord bus channel carries buyer ids and DM text: keep it private to the bots; commands and replies are HMAC-signed with the target's key
- The backup channel holds `panel.sqlite` (agent keys), `shared.sqlite` (orders) AND `.env` (`JWT_SECRET`, `QUEST_ENC_SECRET` — the keys to every encrypted token): anyone who can read it owns the panel. Keep it private
- SSE log streaming authenticates via a query-param token (browsers cannot set `Authorization` headers on `EventSource`)
- Helmet is used to set secure HTTP headers (CSP disabled intentionally to serve the React SPA)
- **Place the panel behind nginx + HTTPS in production** (see example below)

### Nginx Reverse-Proxy Example (HTTPS)

```nginx
server {
    listen 80;
    server_name panel.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name panel.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/panel.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.yourdomain.com/privkey.pem;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;

        # Required for SSE log streaming — disable response buffering
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }
}
```

---

## 🛠️ Useful Commands

```bash
# View panel logs
pm2 logs bot-panel

# View buyer bot logs
pm2 logs buyer-bot

# Restart everything
pm2 restart all

# Save PM2 process list after manual changes
pm2 save

# Rebuild the React client after frontend changes
cd client && npm run build

# Generate a new bcrypt password hash
node -e "const b=require('bcryptjs'); console.log(b.hashSync('YOUR_PASSWORD', 10));"

# Manually send a backup (or: Panel Settings → Backup & Rollback → Backup now)
node -e "require('dotenv').config();require('./server/services/backupService').performBackup()"

# Manually trigger an expiry check
node -e "require('./server/services/expiryService').checkExpiry()"

# Manually run the memory overflow check
node -e "require('./server/services/memoryMonitorService').checkMemoryOverflow()"
```

---

## 📦 Tech Stack

| Layer              | Technology                                                          |
|--------------------|---------------------------------------------------------------------|
| Backend            | Node.js, Express, JWT, bcryptjs, Helmet, Multer                     |
| Database           | QuickDB (SQLite via better-sqlite3)                                 |
| Process management | PM2 (CLI, auto-save on every change)                                |
| Git operations     | git CLI (clone, pull, SSH key management)                           |
| Web server         | nginx (auto-managed vhost generation + reload)                      |
| Firewall           | UFW (auto open/close ports for website projects)                    |
| Discord (alerts)   | Webhook (expiry warnings + DB backups)                              |
| Discord (buyer)    | discord.js v14 (slash commands)                                     |
| Frontend           | React 18, Vite 5, Tailwind CSS 3, react-router-dom v6              |
| Code editor        | CodeMirror 6 (JS, TS, Python, CSS, HTML, JSON, SQL, YAML, and more) |
| SQLite browser     | sql.js (WebAssembly SQLite, runs entirely in the browser)           |
| Scheduling         | node-cron                                                           |
| System info        | systeminformation                                                   |

---

## 📡 API Reference (Summary)

All routes require `Authorization: Bearer <token>` unless noted.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/login` | Login — returns JWT (no auth required) |
| `GET` | `/api/auth/verify` | Verify token validity |
| `GET` | `/api/bots` | List all bots |
| `POST` | `/api/bots` | Create bot (git clone or local import) |
| `GET` | `/api/bots/:id` | Get single bot |
| `PUT` | `/api/bots/:id` | Update bot settings |
| `DELETE` | `/api/bots/:id` | Delete bot (stops PM2 + removes files) |
| `POST` | `/api/bots/:id/start` | Start bot |
| `POST` | `/api/bots/:id/stop` | Stop bot |
| `POST` | `/api/bots/:id/restart` | Restart bot |
| `POST` | `/api/bots/:id/update` | Git pull + npm install + restart (a stopped bot stays stopped) |
| `GET` | `/api/bots/:id/node-versions` | Node.js versions for the picker: pin, system node, installed on the node, latest per major |
| `PUT` | `/api/bots/:id/node-version` | Pin an exact Node.js version (downloaded to the node first) or `null` for the system node |
| `GET` | `/api/bots/:id/env` | Read `.env` file |
| `PUT` | `/api/bots/:id/env` | Write `.env` file |
| `GET` | `/api/bots/:id/fs/list` | List directory contents |
| `GET` | `/api/bots/:id/fs/read` | Read file content |
| `PUT` | `/api/bots/:id/fs/write` | Write file content |
| `POST` | `/api/bots/:id/fs/create` | Create file or directory |
| `DELETE` | `/api/bots/:id/fs/delete` | Delete file or directory |
| `PUT` | `/api/bots/:id/fs/rename` | Rename / move file |
| `POST` | `/api/bots/:id/fs/upload` | Upload file via multipart |
| `GET` | `/api/bots/:id/fs/download` | Download file |
| `PUT` | `/api/bots/:id/website-config` | Update website config |
| `POST` | `/api/bots/:id/domain` | Assign / remove domain |
| `GET` | `/api/bots/domains` | List all active domains |
| `POST` | `/api/bulk/:action` | Bulk action (start/stop/restart/install/update/remove) |
| `GET` | `/api/groups` | List groups |
| `POST` | `/api/groups` | Create group |
| `PUT` | `/api/groups/:id` | Update group |
| `DELETE` | `/api/groups/:id` | Delete group |
| `GET` | `/api/tags` | List tags |
| `POST` | `/api/tags` | Create tag |
| `PUT` | `/api/tags/:id` | Update tag |
| `DELETE` | `/api/tags/:id` | Delete tag |
| `GET` | `/api/logs/:id` | Snapshot logs |
| `GET` | `/api/logs/:id/stream` | SSE live log stream (token via query param) |
| `GET` | `/api/system/stats` | CPU / RAM / disk stats |
| `GET` | `/api/panel/status` | Panel PM2 status |
| `POST` | `/api/panel/restart` | Restart the panel process |
| `POST` | `/api/panel/update-agents` | Update + restart the agent on every node (the Panel page runs this before `/rebuild`) |
| `POST` | `/api/panel/rebuild` | Rebuild React client |
| `GET` | `/api/panel/logs` | Panel process logs |
| `GET` | `/api/panel/env` | Read panel `.env` |
| `PUT` | `/api/panel/env` | Write panel `.env` |
| `GET` | `/api/github/keys` | List SSH deploy keys |
| `POST` | `/api/github/keys` | Generate + add SSH key |
| `DELETE` | `/api/github/keys/:name` | Remove SSH key |
| `POST` | `/api/github/keys/:name/test` | Test SSH key connection |
| `GET` | `/api/github/git-config` | Read global git config |
| `PUT` | `/api/github/git-config` | Update global git config |
| `GET` | `/api/proxy` | Bots + their egress VPS |
| `GET` | `/api/proxies` | List pool proxies (credentials masked) |
| `POST` | `/api/proxies` | Add a proxy (static or rotating) |
| `POST` | `/api/proxies/bulk` | Import a pasted list |
| `PATCH` | `/api/proxies/:id` | Update a proxy (omit `password` to keep it) |
| `DELETE` | `/api/proxies/:id` | Remove a proxy |
| `POST` | `/api/proxies/:id/test` | Check which IP it egresses from |
| `POST` | `/api/proxies/:id/rotate` | Fetch its rotate link now (refused while in use) |
| `GET` | `/api/proxies/settings/:feature` | Egress switches + current pool |
| `PATCH` | `/api/proxies/settings/:feature` | Toggle VPS nodes / custom proxies / order |
| `GET` | `/api/notifications` | List notifications |
| `POST` | `/api/notifications/read` | Mark notifications as read |
| `DELETE` | `/api/notifications/:id` | Delete notification |
| `*` | `/api/external/*` | External API (requires `x-api-key` header) |

---

## 📝 Changelog

### v2.0.0
- ✅ **Website hosting** — static and fullstack project support with nginx integration
- ✅ **Domain management** — assign custom domains, auto nginx vhost, SSL support
- ✅ **UFW integration** — automatic firewall rule management for website ports
- ✅ **File manager** — full directory browser inside each bot/site folder
- ✅ **CodeMirror 6 editor** — syntax highlighting for JS, TS, Python, CSS, HTML, JSON, SQL, YAML, Rust, PHP, Java, C++, Markdown, XML
- ✅ **SQLite viewer** — browse tables and run queries on `.db` files in the browser (WebAssembly)
- ✅ **Tags system** — multi-tag support per bot for finer-grained categorization
- ✅ **Bulk operations** — start/stop/restart/install/update/remove multiple bots at once
- ✅ **SSH key manager** — generate, store, and test deploy keys for private GitHub repos
- ✅ **Git config editor** — set global `user.name` / `user.email`
- ✅ **Memory monitor service** — per-minute overflow check with auto-restart + notification
- ✅ **Restart rate limiter** — auto-stops bots that crash-loop (≥ 5 restarts in 60 s)
- ✅ **Notification center** — in-panel inbox for warnings, memory alerts, and system events
- ✅ **Panel self-management** — restart/rebuild the panel, view/edit panel `.env` from within the UI
- ✅ **External API** — API-key authenticated endpoints for third-party integrations
- ✅ **System page** — detailed CPU/RAM/disk view with per-process table and trend charts
- ✅ **Trend charts** — 120-sample history stored in localStorage, opened in a modal overlay
- ✅ **Domains overview page** — see all active domains across every project in one place
- ✅ **Reverse-proxy page** — manage shared nginx upstream configuration

### v1.3.0
- ✅ **Sidebar toggle** — collapse/expand the left menu to a slim icon rail
- ✅ **PM2 auto-save** — `pm2 save` called automatically after every state-changing operation
- ✅ **Expiry date timezone fix** — expiry no longer drifts on repeated saves

### v1.2.0
- ✅ **Bot groups** — categorize bots with custom color-coded labels
- ✅ **Memory limits** — per-bot `--max-memory-restart` for PM2
- ✅ **Local folder import** — register an existing server folder without git clone
- ✅ System resource widget (CPU & RAM)

### v1.1.0
- ✅ Live SSE log streaming
- ✅ `.env` in-browser editor
- ✅ Buyer Discord bot with slash commands

### v1.0.0
- ✅ Initial release — bot CRUD, git clone, PM2 control, JWT auth, expiry system, Discord backup

---

## 📄 License

MIT — use freely, attribution appreciated.
