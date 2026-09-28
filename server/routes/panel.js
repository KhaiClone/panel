const express = require("express");
const panelService = require("../services/panelService");
const integrations = require("../services/integrationService");
const panelMigration = require("../services/panelMigration");
const apiKeys = require("../services/apiKeyService");
const callbacks = require("../services/callbackService");
const executor = require("../services/executor");
const { setEnvKey } = require("../utils/envText");
const db = require("../db");
const router = express.Router();

// This router runs no shell and touches no filesystem. Everything it does to
// the panel's own machine goes through that machine's agent (services/panelService).
const PANEL_DOMAINS_KEY = "panel_domains";
const panelPort = () => parseInt(process.env.PORT) || 3000;

/** Parse .env text into the {key, value} rows the editor expects. */
const parseEnv = (raw) => {
    const entries = [];
    for (const line of String(raw).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const idx = line.indexOf("=");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        if (key) entries.push({ key, value: line.slice(idx + 1) });
    }
    return entries;
};

/**
 * Merge edited rows back into the original text, keeping comments and blank
 * lines exactly where they were. Keys absent from `entries` are dropped; new
 * ones are appended.
 */
const mergeEnv = (raw, entries) => {
    const newMap = new Map(entries.map((e) => [e.key.trim(), e.value]));
    const existingKeys = new Set();
    const outLines = [];

    for (const line of String(raw).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) { outLines.push(line); continue; }
        const idx = line.indexOf("=");
        if (idx === -1) { outLines.push(line); continue; }
        const key = line.slice(0, idx).trim();
        existingKeys.add(key);
        if (newMap.has(key)) outLines.push(`${key}=${newMap.get(key)}`);
        // a key missing from newMap was deleted in the editor — omit it
    }
    for (const { key, value } of entries) {
        const k = key.trim();
        if (!existingKeys.has(k)) outLines.push(`${k}=${value}`);
    }
    return outLines.join("\n").replace(/\n+$/, "") + "\n";
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/panel/status
//  Returns the panel's PM2 process status, CPU, memory, uptime, etc.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/status", async (req, res, next) => {
    try {
        const status = await panelService.getPanelStatus();
        res.json(status);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/panel/restart
//  Restart the panel process via PM2.
//  Response is sent BEFORE the restart happens (delayed by ~1.5s).
// ─────────────────────────────────────────────────────────────────────────────
router.post("/restart", async (req, res, next) => {
    try {
        const result = await panelService.restartPanel();
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/panel/update-agents
//  git pull + npm install + restart the agent on every node, and wait for each
//  restarted one to answer again. The Panel page calls this BEFORE /rebuild —
//  as its own request, so neither step runs into the proxy's read timeout.
//  Response: { agents: [{ nodeId, name, isPanelNode, ok, message }] }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/update-agents", async (req, res, next) => {
    try {
        res.json({ agents: await panelService.updateAgents() });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/panel/rebuild
//  Run `npm run build` then restart. Build output is returned.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/rebuild", async (req, res, next) => {
    try {
        const result = await panelService.rebuildPanel();
        if (!result.success) {
            return res.status(500).json(result);
        }
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/panel/logs?lines=100
//  Fetch last N lines of panel PM2 logs.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/logs", async (req, res, next) => {
    try {
        const lines = Math.min(parseInt(req.query.lines) || 100, 500);
        const logs = await panelService.getPanelLogs(lines);
        res.json({ logs });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/panel/env
//  Read the server .env file and return key-value pairs (comments preserved
//  in the written file but not returned here).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/env", async (req, res, next) => {
    try {
        res.json(parseEnv(await panelService.readEnv()));
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUT /api/panel/env
//  Write key-value pairs back to .env, preserving comment/blank lines in their
//  original positions. New keys are appended at the end.
// ─────────────────────────────────────────────────────────────────────────────
router.put("/env", async (req, res, next) => {
    try {
        const { entries } = req.body;
        if (!Array.isArray(entries)) {
            return res.status(400).json({ error: "entries must be an array of {key, value}" });
        }
        for (const e of entries) {
            if (!e.key || typeof e.key !== "string" || e.key.includes("=") || e.key.includes("\n")) {
                return res.status(400).json({ error: `Invalid key: "${e.key}"` });
            }
        }

        // Read-modify-write through the agent; it keeps a .env.bak-<ts> for us.
        const raw = await panelService.readEnv();
        const { backup } = await panelService.writeEnv(mergeEnv(raw, entries));

        res.json({ ok: true, backup });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/panel/domains
//  List all custom domains configured for this panel.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/domains", async (req, res, next) => {
    try {
        const domains = (await db.get(PANEL_DOMAINS_KEY)) || [];
        res.json(domains);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/panel/domains
//  Add a custom domain for the panel. Writes an nginx reverse-proxy config.
//  Body: { domain: string }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/domains", async (req, res, next) => {
    try {
        const { domain } = req.body;
        if (!domain || typeof domain !== "string") {
            return res.status(400).json({ error: "domain is required" });
        }
        const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
        if (!clean || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) {
            return res.status(400).json({ error: "Invalid domain name" });
        }

        const existing = (await db.get(PANEL_DOMAINS_KEY)) || [];
        if (existing.find(d => d.domain === clean)) {
            return res.status(409).json({ error: "Domain already added" });
        }

        const newEntry = { domain: clean, sslEnabled: false, addedAt: Date.now() };
        const updated = [...existing, newEntry];

        await panelService.writePanelVhost(updated.map(d => d.domain), panelPort());
        await db.set(PANEL_DOMAINS_KEY, updated);

        console.log(`[Panel] Domain added: ${clean}`);
        res.json(newEntry);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /api/panel/domains/:domain
//  Remove a custom domain and update the nginx config.
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/domains/:domain", async (req, res, next) => {
    try {
        const domain = decodeURIComponent(req.params.domain);
        const existing = (await db.get(PANEL_DOMAINS_KEY)) || [];
        const filtered = existing.filter(d => d.domain !== domain);

        if (filtered.length === existing.length) {
            return res.status(404).json({ error: "Domain not found" });
        }

        await panelService.writePanelVhost(filtered.map(d => d.domain), panelPort());
        await db.set(PANEL_DOMAINS_KEY, filtered);

        console.log(`[Panel] Domain removed: ${domain}`);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/panel/logrotate
//  Install state, PM2 status and current settings of pm2-logrotate.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/logrotate", async (req, res, next) => {
    try {
        res.json(await panelService.logrotateStatus());
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/panel/logrotate/install
//  Install pm2-logrotate and apply default limits (50M / keep 7 / gzip).
// ─────────────────────────────────────────────────────────────────────────────
router.post("/logrotate/install", async (req, res, next) => {
    try {
        console.log("[LogRotate] Installing pm2-logrotate…");
        const status = await panelService.logrotateInstall();
        console.log("[LogRotate] Installed and configured");
        res.json(status);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUT /api/panel/logrotate
//  Update settings. Body: { max_size?, retain?, compress?, rotateInterval?,
//  workerInterval?, rotateModule? } — values are validated by the service.
// ─────────────────────────────────────────────────────────────────────────────
router.put("/logrotate", async (req, res, next) => {
    try {
        const status = await panelService.logrotateSet(req.body || {});
        res.json(status);
    } catch (err) {
        if (/Unknown setting|Invalid value|No settings/.test(err.message)) {
            return res.status(400).json({ error: err.message });
        }
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/panel/domains/:domain/ssl
//  Run certbot to issue SSL for the given panel domain.
//  Body: { email?: string }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/domains/:domain/ssl", async (req, res, next) => {
    try {
        const domain = decodeURIComponent(req.params.domain);
        const existing = (await db.get(PANEL_DOMAINS_KEY)) || [];
        const entry = existing.find(d => d.domain === domain);

        if (!entry) {
            return res.status(404).json({ error: "Domain not found" });
        }

        const { email } = req.body;
        await panelService.enablePanelSSL(domain, email || null);

        const updated = existing.map(d => d.domain === domain ? { ...d, sslEnabled: true } : d);
        await db.set(PANEL_DOMAINS_KEY, updated);

        console.log(`[Panel] SSL enabled for domain: ${domain}`);
        res.json({ ok: true, domain, sslEnabled: true });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Integrations — where the panel reaches arnto-auto / shop / assistant
//  (services/integrationService.js)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/panel/integrations — one row per integration, with its resolved URL. */
router.get("/integrations", async (req, res, next) => {
    try {
        res.json(await integrations.list());
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/panel/integrations/:name
 * Body: { botId, port } to link it to a project, or { botId: null } to go back
 * to the .env URL.
 */
router.put("/integrations/:name", async (req, res, next) => {
    try {
        const { botId, port } = req.body || {};
        await integrations.setLink(req.params.name, botId ? { botId, port } : null);
        res.json(await integrations.list());
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  API keys — one per project calling /api/external/* (services/apiKeyService.js)
//  and the callbacks those projects registered (services/callbackService.js)
// ─────────────────────────────────────────────────────────────────────────────

const apiKeysOverview = async () => ({
    keys: await apiKeys.list(),
    callbacks: await callbacks.audit(),
    sharedKey: !!process.env.PANEL_API_KEY,
});

/** GET /api/panel/api-keys — keys (never the secrets) + loopback callbacks and their owners. */
router.get("/api-keys", async (req, res, next) => {
    try {
        res.json(await apiKeysOverview());
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/panel/api-keys   Body: { botId, label?, writeEnv = true, envKey = "PANEL_API_KEY" }
 * New key for a project. With writeEnv it goes straight into that project's
 * .env as envKey (through its agent) and is never shown; without, the response
 * carries it once. A failed .env write revokes the key again.
 */
router.post("/api-keys", async (req, res, next) => {
    try {
        const { botId, label, writeEnv = true } = req.body || {};
        const envKey = String(req.body?.envKey || "PANEL_API_KEY").trim();
        if (writeEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
            return res.status(400).json({ error: `Invalid .env key name: "${envKey}"` });
        }
        const { key, record } = await apiKeys.create({ botId, label });
        if (!writeEnv) return res.status(201).json({ record, key });

        const bot = await db.findOne("bots", { _id: record.botId });
        try {
            let current = "";
            try {
                current = (await executor.fsRead(bot, ".env")).content || "";
            } catch (err) {
                if (err.status !== 404) throw err;
            }
            await executor.fsWrite(bot, ".env", setEnvKey(current, envKey, key));
        } catch (err) {
            await apiKeys.revoke(record._id).catch(() => {});
            return res.status(502).json({ error: `Could not write ${bot.name}'s .env (${err.message}) — the key was revoked, nothing changed` });
        }
        console.log(`[ApiKeys] New key ${record.prefix}… for ${bot.name}, written to its .env as ${envKey}`);
        res.status(201).json({ record, wroteEnv: envKey });
    } catch (err) {
        next(err);
    }
});

/** DELETE /api/panel/api-keys/:id — revoke. */
router.delete("/api-keys/:id", async (req, res, next) => {
    try {
        await apiKeys.revoke(req.params.id);
        res.json(await apiKeysOverview());
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Moving the panel to another node (services/panelMigration.js)
//  GET stays reachable while the panel is moving or has been replaced — see
//  middleware/lifecycleGate.js — so the page can follow the move to the end.
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/panel/migration — state, the running/last job, nodes, recent moves. */
router.get("/migration", async (req, res, next) => {
    try {
        res.json(await panelMigration.overview());
    } catch (err) {
        next(err);
    }
});

/** POST /api/panel/migration/preflight   Body: { targetNodeId } — read-only checks. */
router.post("/migration/preflight", async (req, res, next) => {
    try {
        if (!req.body?.targetNodeId) return res.status(400).json({ error: "targetNodeId is required" });
        res.json(await panelMigration.runPreflight(req.body.targetNodeId));
    } catch (err) {
        next(err);
    }
});

/** POST /api/panel/migration/prepare   Body: { targetNodeId } — starts in the background. */
router.post("/migration/prepare", async (req, res, next) => {
    try {
        if (!req.body?.targetNodeId) return res.status(400).json({ error: "targetNodeId is required" });
        res.status(202).json(await panelMigration.startPrepare(req.body.targetNodeId));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/panel/migration/start   Body: { targetNodeId, confirmName }
 * The move itself, in the background. confirmName must equal the target's name.
 */
router.post("/migration/start", async (req, res, next) => {
    try {
        const { targetNodeId, confirmName } = req.body || {};
        if (!targetNodeId) return res.status(400).json({ error: "targetNodeId is required" });
        res.status(202).json(await panelMigration.startMove(targetNodeId, { confirmName }));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
