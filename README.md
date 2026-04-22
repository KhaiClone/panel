# 🤖 Bot Panel

> A self-hosted admin panel for managing Discord bots on a VPS — built with **Node.js + Express** (backend), **React + Vite + Tailwind** (frontend), and a **Discord buyer bot** for customer-facing control.

![Node](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen?logo=node.js)
![PM2](https://img.shields.io/badge/Process%20Manager-PM2-blue?logo=pm2)
![React](https://img.shields.io/badge/Frontend-React%2018-61DAFB?logo=react)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## ✨ Features

### Admin Panel
- 🔐 JWT-authenticated login (bcrypt password hash)
- 📊 Live CPU & RAM ring charts (polled every 4 s)
- 🤖 Bot grid with live PM2 status badges (online / stopped / errored)
- 🔍 Search & filter bots by name or status
- ➕ Create bots via git clone **or** import an existing local folder
- 📂 Group bots with color-coded labels
- 🧠 Per-bot PM2 memory limit (`--max-memory-restart`)
- 💾 PM2 state is auto-saved after every start / stop / restart / delete
- ▶️ One-click Start / Stop / Restart / Pull & Update per bot
- 📋 Log viewer — snapshot (last 200 lines) + live SSE streaming
- 🗂️ In-browser `.env` file editor
- ⚙️ Settings tab — edit name, start script, group, memory limit, expiry date
- ⏰ Expiry date stored correctly across timezones (no drift on repeated saves)
- 🗃️ Hourly DB backup sent to Discord as a JSON attachment
- ⚠️ Discord webhook expiry warnings at 7 d / 3 d / 1 d
- 🗑️ Auto-removal of expired bots (stops PM2, deletes files, alerts Discord)
- 📐 Collapsible sidebar (click `‹` / `›` to toggle)

### Buyer Discord Bot
- `/mybots` — list all bots with status + expiry countdown
- `/start <bot_id>` / `/stop <bot_id>` / `/restart <bot_id>`
- `/expiry` — view subscription time remaining for all bots

---

## 📁 Directory Structure

```
root/
├── bots/                          ← Buyer bot repos live here
│   └── {buyerID}/
│       └── {botID}/               ← git clone target
│
└── bot-panel/                     ← This project
    ├── server/
    │   ├── db/
    │   │   ├── index.js           ← Shared QuickDB singleton
    │   │   └── QuickDB.js         ← Extended QuickDB class
    │   ├── middleware/
    │   │   ├── auth.js            ← JWT verification middleware
    │   │   └── errorHandler.js    ← Global Express error handler
    │   ├── routes/
    │   │   ├── auth.js            ← POST /api/auth/login, GET /api/auth/verify
    │   │   ├── bots.js            ← Full bot CRUD + start/stop/restart/update/env
    │   │   ├── groups.js          ← Group CRUD (name + color)
    │   │   ├── logs.js            ← Snapshot + SSE live log streaming
    │   │   └── system.js          ← CPU & RAM stats
    │   ├── services/
    │   │   ├── pm2Service.js      ← All PM2 CLI operations (auto pm2 save)
    │   │   ├── gitService.js      ← git clone, git pull, npm install
    │   │   ├── discordService.js  ← Webhook alerts + backup file sender
    │   │   ├── expiryService.js   ← Hourly expiry check + auto-removal
    │   │   └── backupService.js   ← Hourly DB dump to Discord
    │   └── index.js               ← Express entry point
    │
    ├── discord-bot/               ← Buyer-facing Discord bot
    │   ├── commands/
    │   │   ├── mybots.js          ← /mybots — list all buyer's bots
    │   │   ├── start.js           ← /start <bot_id>
    │   │   ├── stop.js            ← /stop <bot_id>
    │   │   ├── restart.js         ← /restart <bot_id>
    │   │   └── expiry.js          ← /expiry — check subscription time left
    │   ├── events/
    │   │   ├── ready.js           ← Auto-registers slash commands on login
    │   │   └── interactionCreate.js ← Routes slash commands
    │   ├── utils/
    │   │   └── helpers.js         ← Shared DB/PM2 access + format utils
    │   └── index.js               ← Bot entry point
    │
    ├── client/                    ← React SPA (Vite + Tailwind)
    │   ├── src/
    │   │   ├── api/client.js      ← Axios instance with JWT interceptor
    │   │   ├── context/AuthContext.jsx ← Global auth state
    │   │   ├── pages/
    │   │   │   ├── Login.jsx      ← Admin login page
    │   │   │   ├── Dashboard.jsx  ← Bot grid + system stats
    │   │   │   └── BotDetail.jsx  ← Per-bot controls, logs, env, settings
    │   │   ├── components/
    │   │   │   ├── Layout.jsx     ← Collapsible sidebar + page wrapper
    │   │   │   ├── BotCard.jsx    ← Bot card with status + quick actions
    │   │   │   ├── StatsWidget.jsx ← CPU/RAM ring charts
    │   │   │   ├── LogViewer.jsx  ← Snapshot + live SSE log viewer
    │   │   │   ├── EnvEditor.jsx  ← .env file textarea editor
    │   │   │   ├── CreateBotModal.jsx ← New bot form (git clone / local import)
    │   │   │   ├── GroupManager.jsx   ← Group CRUD with color picker
    │   │   │   └── ConfirmModal.jsx   ← Reusable confirm dialog
    │   │   ├── App.jsx            ← Router + auth guard
    │   │   └── main.jsx           ← React entry point
    │   └── package.json
    │
    ├── data/                      ← Auto-created — holds panel.sqlite
    ├── .env                       ← Your secrets (never commit this)
    ├── .env.example               ← Template to copy from
    ├── .gitignore
    ├── ecosystem.config.js        ← PM2 config for panel + buyer bot
    ├── package.json
    └── README.md
```

---

## ⚙️ Setup

### 1. Prerequisites

- Node.js >= 18
- PM2 installed globally:
  ```bash
  npm install -g pm2
  ```
- Git available on the server

### 2. Clone & Install

```bash
cd /root
git clone <this-repo-url> bot-panel
cd bot-panel

# Install server dependencies
npm install

# Install client dependencies and build the React app
cd client && npm install && npm run build && cd ..
```

### 3. Configure Environment

```bash
cp .env.example .env
nano .env
```

| Variable                 | Description                                                        |
|--------------------------|--------------------------------------------------------------------|
| `PORT`                   | Express server port (default: `3000`)                              |
| `NODE_ENV`               | `production` or `development`                                      |
| `ADMIN_USERNAME`         | Panel login username                                               |
| `ADMIN_PASSWORD_HASH`    | bcrypt hash of your admin password (see below)                     |
| `JWT_SECRET`             | Long random secret for signing JWTs                                |
| `BOTS_ROOT_DIR`          | Absolute path to bots folder, e.g. `/root/bots`                    |
| `DISCORD_ALERT_WEBHOOK`  | Webhook URL for expiry warnings and removal alerts                 |
| `DISCORD_BACKUP_WEBHOOK` | Webhook URL for hourly DB backups                                  |
| `BUYER_BOT_TOKEN`        | Discord bot token for the buyer-facing bot                         |

**Generate your password hash:**

```bash
node -e "const b=require('bcryptjs'); console.log(b.hashSync('YOUR_PASSWORD_HERE', 10));"
```

Paste the output into `ADMIN_PASSWORD_HASH` in your `.env`.

### 4. Create Bots Root Directory

```bash
mkdir -p /root/bots
```

### 5. Start with PM2

```bash
# Start both the panel server and buyer Discord bot
pm2 start ecosystem.config.js

# Persist the PM2 process list so everything restarts on reboot
pm2 save
pm2 startup
# → copy and run the command PM2 prints
```

Access the panel at: `http://your-server-ip:3000`

---

## 🔧 Development Mode

```bash
# Terminal 1 — backend with auto-reload
npm run dev:server

# Terminal 2 — React dev server with HMR
npm run dev:client

# Terminal 3 — buyer Discord bot with auto-reload
npm run dev:bot
```

The Vite dev server runs at `http://localhost:5173` and proxies `/api` to `http://localhost:3000`.

---

## 🗃️ Database Schema

All data is stored in `data/panel.sqlite` via QuickDB.

### Bots collection

```js
{
  _id:         string,        // nanoid(24) — auto-assigned
  buyerID:     string,        // Discord user ID of the buyer
  botID:       string,        // Short slug, e.g. "my-bot"
  name:        string,        // Display name
  repoUrl:     string|null,   // Git clone URL (null for local bots)
  branch:      string|null,   // Git branch (null for local bots)
  startScript: string,        // Entry file, e.g. "index.js"
  pm2Name:     string,        // "{buyerID}-{botID}" — unique PM2 identifier
  source:      "git"|"local", // How the bot was added
  localPath:   string|null,   // Absolute path (local bots only)
  groupId:     string|null,   // _id of the assigned Group, or null
  maxMemory:   string|null,   // PM2 memory limit e.g. "300M", "1G", or null
  expiresAt:   number|null,   // Unix timestamp (ms) or null for no expiry
  createdAt:   number,        // Unix timestamp (ms)
}
```

### Groups collection

```js
{
  _id:       string,  // nanoid(24)
  name:      string,  // Display name e.g. "Premium"
  color:     string,  // Hex color e.g. "#6366f1"
  createdAt: number,
}
```

---

## 🔒 Security Notes

- The JWT expires after **24 hours** — admins must re-login after that
- The `.env` file is in `.gitignore` — **never commit it**
- The panel API is protected by JWT on all routes except `/api/auth/login`
- SSE log streaming authenticates via a query-param token (browsers cannot set `Authorization` headers on `EventSource`)
- Consider placing the panel behind **nginx + HTTPS** in production

### Nginx Example

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

        # Required for SSE (log streaming) — disable buffering
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

# Rebuild the React client after making frontend changes
cd client && npm run build

# Manually trigger a backup right now
node -e "require('./server/services/backupService').performBackup()"

# Manually trigger an expiry check
node -e "require('./server/services/expiryService').checkExpiry()"
```

---

## 📦 Tech Stack

| Layer           | Technology                              |
|-----------------|-----------------------------------------|
| Backend         | Node.js, Express, JWT, bcryptjs         |
| Database        | QuickDB (SQLite) with custom extension  |
| Process Mgmt    | PM2 (via CLI, auto-save on every change)|
| Git Ops         | git CLI (clone, pull)                   |
| Discord (admin) | Webhook (alerts + backups)              |
| Discord (buyer) | discord.js v14 (slash commands)         |
| Frontend        | React 18, Vite, Tailwind CSS            |
| Scheduling      | node-cron                               |
| System Info     | systeminformation                       |

---

## 📝 Changelog

### v1.3.0
- ✅ **Sidebar toggle** — collapse/expand the left menu to a slim icon rail
- ✅ **PM2 auto-save** — `pm2 save` is called automatically after every start / stop / restart / delete / memory-limit change
- ✅ **Expiry date timezone fix** — expiry date no longer drifts on repeated saves (was caused by UTC vs local time mismatch in `datetime-local` inputs)

### v1.2.0
- ✅ **Bot groups** — categorize bots with custom color-coded labels
- ✅ **Memory limits** — set per-bot `--max-memory-restart` for PM2
- ✅ **Local folder import** — register an existing server folder as a bot without git clone
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
