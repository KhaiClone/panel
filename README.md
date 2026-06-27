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
- 🗃️ Hourly DB backup sent to Discord as a JSON attachment
- 🧮 Memory monitor service — runs every minute; restarts any bot that exceeds its limit and fires a notification

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
    │   │   ├── proxy.js             ← Reverse-proxy configuration
    │   │   ├── notifications.js     ← In-panel notification inbox
    │   │   └── external.js          ← External API (API-key protected)
    │   ├── services/
    │   │   ├── pm2Service.js        ← All PM2 CLI operations (auto pm2 save)
    │   │   ├── gitService.js        ← git clone, git pull, npm install
    │   │   ├── discordService.js    ← Webhook alerts + backup file sender
    │   │   ├── expiryService.js     ← Hourly expiry check + auto-removal
    │   │   ├── backupService.js     ← Hourly DB dump to Discord
    │   │   ├── memoryMonitorService.js ← Per-minute memory overflow checker
    │   │   ├── githubService.js     ← SSH key generation + ~/.ssh/config manager
    │   │   ├── nginxService.js      ← nginx vhost generation + reload
    │   │   ├── ufwService.js        ← UFW open/close port + free-port finder
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
    │       │   ├── OverviewPage.jsx ← Bot grid + system stats overview
    │       │   ├── BotDetail.jsx    ← Per-bot controls, logs, env, files, settings
    │       │   ├── SitesPage.jsx    ← Website management
    │       │   ├── DomainsPage.jsx  ← Unified domain list
    │       │   ├── SystemPage.jsx   ← System stats + per-process table + trend charts
    │       │   ├── GroupsPage.jsx   ← Group management
    │       │   ├── TagsPage.jsx     ← Tag management
    │       │   ├── MultiManage.jsx  ← Bulk operations UI
    │       │   ├── ProxyPage.jsx    ← Reverse-proxy config
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
| `ADMIN_USERNAME`         | Yes      | Panel login username                                          |
| `ADMIN_PASSWORD_HASH`    | Yes      | bcrypt hash of your admin password (see below)                |
| `JWT_SECRET`             | Yes      | Long random string for signing JWTs                           |
| `BOTS_ROOT_DIR`          | Yes      | Absolute path to bots folder, e.g. `/root/bots`               |
| `SITES_ROOT_DIR`         | No       | Absolute path to websites folder (defaults to `BOTS_ROOT_DIR`)|
| `DISCORD_ALERT_WEBHOOK`  | No       | Webhook URL for expiry warnings and removal alerts            |
| `DISCORD_BACKUP_WEBHOOK` | No       | Webhook URL for hourly DB backups                             |
| `BUYER_BOT_TOKEN`        | No       | Discord bot token for the buyer-facing bot                    |
| `PANEL_API_KEY`          | No       | Secret key for external API integrations                      |
| `PANEL_PM2_NAME`         | No       | PM2 process name for the panel (auto-detected under PM2)      |
| `CLIENT_URL`             | No       | Vite dev server URL — only needed in development              |

**Generate your password hash:**

```bash
node -e "const b=require('bcryptjs'); console.log(b.hashSync('YOUR_PASSWORD_HERE', 10));"
```

Paste the output into `ADMIN_PASSWORD_HASH` in your `.env`.

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

## 🔒 Security Notes

- The JWT expires after **24 hours** — admins must re-login after that
- The `.env` file is in `.gitignore` — **never commit it**
- All API routes are JWT-protected except `/api/auth/login`
- External API routes (`/api/external/*`) are protected by a separate `PANEL_API_KEY` header
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

# Manually trigger a database backup
node -e "require('./server/services/backupService').performBackup()"

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
| `POST` | `/api/bots/:id/update` | Git pull + npm install + restart |
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
| `GET` | `/api/proxy/config` | Get proxy config |
| `PUT` | `/api/proxy/config` | Update proxy config |
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
