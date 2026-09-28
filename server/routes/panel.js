const express = require("express");
const panelService = require("../services/panelService");
const integrations = require("../services/integrationService");
const panelMigration = require("../services/panelMigration");
const panelDomains = require("../services/panelDomains");
const nodeService = require("../services/nodeService");
const sharedStore = require("../services/sharedStore");
const discordBus = require("../services/discordBus");
const decorSitePublisher = require("../services/decorSitePublisher");
const apiKeys = require("../services/apiKeyService");
const callbacks = require("../services/callbackService");
const executor = require("../services/executor");
const { setEnvKey } = require("../utils/envText");
const db = require("../db");
const router = express.Router();

// This router runs no shell and touches no filesystem. Everything it does to
// the panel's own machine goes through that machine's agent (services/panelService).

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
//  Panel domains — one or more per node (services/panelDomains.js). On the node
//  running the panel they proxy to it, on every other node they redirect to it.
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/panel/domains → { domains, nodes, panelNodeId, publicUrl } */
router.get("/domains", async (req, res, next) => {
    try {
        const rows = await panelDomains.list();
        const nodes = await nodeService.getNodes();
        const panelNodeId = nodeService.panelNodeId();
        const here = nodes.find((n) => n._id === panelNodeId) || null;
        const names = new Map(nodes.map((n) => [n._id, n.name]));
        res.json({
            domains: rows.map((d) => ({ ...d, nodeName: names.get(d.nodeId) || null, isPanelNode: d.nodeId === panelNodeId })),
            nodes: nodes.map((n) => ({ _id: n._id, name: n.name, host: n.host, isPanelNode: n._id === panelNodeId })),
            panelNodeId,
            publicUrl: panelDomains.publicUrl(rows, here),
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/panel/domains   Body: { domain, nodeId? }
 * nodeId = the node the domain's DNS points at (default: the panel's node).
 */
router.post("/domains", async (req, res, next) => {
    try {
        const entry = await panelDomains.add({ domain: req.body?.domain, nodeId: req.body?.nodeId });
        console.log(`[Panel] Domain added: ${entry.domain} (node ${entry.nodeId})`);
        res.json(entry);
    } catch (err) {
        next(err);
    }
});

/** DELETE /api/panel/domains/:domain */
router.delete("/domains/:domain", async (req, res, next) => {
    try {
        const domain = decodeURIComponent(req.params.domain);
        await panelDomains.remove(domain);
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
//  POST /api/panel/domains/:domain/ssl   Body: { email? }
//  Let's Encrypt for the domain, on the node its DNS points at.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/domains/:domain/ssl", async (req, res, next) => {
    try {
        const domain = decodeURIComponent(req.params.domain);
        const entry = await panelDomains.issueCert(domain, req.body?.email || null);
        console.log(`[Panel] SSL enabled for domain: ${domain}`);
        res.json({ ok: true, domain, sslEnabled: !!entry?.sslEnabled });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Panel gateway — every agent's 127.0.0.1:4201 door to wherever the panel
//  runs (agent/services/panelGateway.js). GET /api/panel/gateway → one row per node.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/gateway", async (req, res, next) => {
    try {
        const nodes = (await nodeService.getNodes()).filter((n) => n.enabled !== false);
        const rows = await Promise.all(
            nodes.map(async (n) => {
                try {
                    const g = await nodeService.agentRequest(n, "get", "/lease/gateway", { timeout: 8000 });
                    return { nodeId: n._id, name: n.name, ...g };
                } catch (err) {
                    return { nodeId: n._id, name: n.name, error: err.status === 404 ? "agent too old (needs 1.8.0)" : err.message };
                }
            }),
        );
        res.json({ nodes: rows });
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

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * POST /api/panel/api-keys
 * Body: { botId, label?, writeEnv = true, envKey = "PANEL_API_KEY", urlKey = "PANEL_API_URL" | null }
 * New key for a project. With writeEnv it goes straight into that project's
 * .env as envKey (through its agent) and is never shown; without, the response
 * carries it once. urlKey (when set) also points the project at the panel
 * gateway on its own node — http://127.0.0.1:4201 — so it never needs the
 * panel's address. A failed .env write revokes the key again.
 */
router.post("/api-keys", async (req, res, next) => {
    try {
        const { botId, label, writeEnv = true } = req.body || {};
        const envKey = String(req.body?.envKey || "PANEL_API_KEY").trim();
        const urlKey = req.body?.urlKey === null ? null : String(req.body?.urlKey || "PANEL_API_URL").trim();
        if (writeEnv && !ENV_NAME_RE.test(envKey)) return res.status(400).json({ error: `Invalid .env key name: "${envKey}"` });
        if (writeEnv && urlKey && !ENV_NAME_RE.test(urlKey)) return res.status(400).json({ error: `Invalid .env key name: "${urlKey}"` });

        const { key, record } = await apiKeys.create({ botId, label });
        if (!writeEnv) return res.status(201).json({ record, key });

        const bot = await db.findOne("bots", { _id: record.botId });
        let gatewayUrl = null;
        try {
            let current = "";
            try {
                current = (await executor.fsRead(bot, ".env")).content || "";
            } catch (err) {
                if (err.status !== 404) throw err;
            }
            let text = setEnvKey(current, envKey, key);
            if (urlKey) {
                const node = await nodeService.getNode(bot.nodeId);
                const g = await nodeService.agentRequest(node, "get", "/lease/gateway", { timeout: 8000 }).catch(() => null);
                if (!g?.localUrl) {
                    throw new Error(`the panel gateway is not running on ${node.name}${g?.error ? ` (${g.error})` : " — update its agent to 1.8.0"}`);
                }
                gatewayUrl = g.localUrl;
                text = setEnvKey(text, urlKey, gatewayUrl);
            }
            await executor.fsWrite(bot, ".env", text);
        } catch (err) {
            await apiKeys.revoke(record._id).catch(() => {});
            return res.status(502).json({ error: `Could not write ${bot.name}'s .env (${err.message}) — the key was revoked, nothing changed` });
        }
        console.log(`[ApiKeys] New key ${record.prefix}… for ${bot.name}, written to its .env as ${envKey}${gatewayUrl ? ` (+ ${urlKey}=${gatewayUrl})` : ""}`);
        res.status(201).json({ record, wroteEnv: envKey, gateway: gatewayUrl ? { key: urlKey, url: gatewayUrl } : null });
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
//  Shared data (services/sharedStore.js) and the Discord bus (services/discordBus.js)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/panel/shared — names, owners, sizes; bus status and recent traffic; decor site. */
router.get("/shared", async (req, res, next) => {
    try {
        const bots = await db.find("bots");
        const names = new Map(bots.map((b) => [b._id, b.name]));
        const caps = discordBus.capabilities();
        res.json({
            names: sharedStore.overview().map((n) => ({ ...n, ownerName: names.get(n.owner) || null })),
            bus: discordBus.status(),
            capabilities: Object.entries(caps).map(([botId, c]) => ({ botId, name: names.get(botId) || null, ...c })),
            recent: discordBus.recent(20).map((r) => ({ ...r, targetName: names.get(r.target) || null })),
            decorSite: decorSitePublisher.status(),
        });
    } catch (err) {
        next(err);
    }
});

/** POST /api/panel/shared/declare { name, kind: "collection" | "value", botId } — reserve a name for a project. */
router.post("/shared/declare", async (req, res, next) => {
    try {
        const { name, kind, botId } = req.body || {};
        if (!(await db.findOne("bots", { _id: botId }))) return res.status(404).json({ error: "Project not found" });
        res.json(sharedStore.declare(name, kind, botId));
    } catch (err) {
        next(err);
    }
});

/** POST /api/panel/shared/ping { botId } — a harmless round trip over the Discord bus. */
router.post("/shared/ping", async (req, res, next) => {
    try {
        const started = Date.now();
        const result = await discordBus.request(req.body?.botId, "ping", { at: started }, { timeoutMs: 30_000 });
        res.json({ ok: true, ms: Date.now() - started, result });
    } catch (err) {
        next(err);
    }
});

/** POST /api/panel/shared/decor-site/publish — push the decor snapshot now (even if unchanged). */
router.post("/shared/decor-site/publish", async (req, res, next) => {
    try {
        res.json(await decorSitePublisher.publish({ force: true }));
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
