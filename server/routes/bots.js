const express = require("express");
const router = express.Router();

// This router runs no shell and touches no filesystem: every project operation
// is relayed to the agent on the project's node (see services/executor.js).
const db = require("../db");
const executor = require("../services/executor");
const history = require("../services/historyService");
const schedulerService = require("../services/schedulerService");
const nodeService = require("../services/nodeService");
const { createNotification } = require("./notifications");

// ─── Ownership middleware ─────────────────────────────────────────────────────
// Admin can access any bot. Users can only access their own.
const requireOwnership = async (req, res, next) => {
    if (req.user.role === "admin") return next();
    const bot = await db.findOne("bots", { _id: req.params.id });
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    if (bot.ownerId !== req.user.id) return res.status(403).json({ error: "Access denied" });
    next();
};

// ─── Slot quota middleware ────────────────────────────────────────────────────
// Admin bypasses quota. Users must have a valid, non-expired slot with remaining capacity.
const parseRamMB = (str) => {
    if (!str) return null;
    const m = str.match(/^(\d+)(K|M|G)?$/i);
    if (!m) return null;
    const v = parseInt(m[1]);
    const u = (m[2] || "M").toUpperCase();
    if (u === "K") return v / 1024;
    if (u === "G") return v * 1024;
    return v;
};

const checkSlotQuota = async (req, res, next) => {
    if (req.user.role === "admin") return next();

    const slot = await db.findOne("slots", { userId: req.user.id });
    if (!slot) return res.status(403).json({ error: "No slot assigned to your account. Contact admin." });

    if (slot.expiresAt && slot.expiresAt < Date.now()) {
        return res.status(403).json({ error: "Your slot has expired. Contact admin." });
    }

    const projectType = req.body.projectType || "discord";
    const userBots = await db.find("bots", { ownerId: req.user.id });

    if (projectType === "website") {
        const siteCount = userBots.filter(b => b.projectType === "website").length;
        if (slot.maxSites !== null && siteCount >= slot.maxSites) {
            return res.status(403).json({ error: `Site limit reached (max ${slot.maxSites}). Contact admin to upgrade.` });
        }
    } else {
        const botCount = userBots.filter(b => b.projectType !== "website").length;
        if (slot.maxBots !== null && botCount >= slot.maxBots) {
            return res.status(403).json({ error: `Bot limit reached (max ${slot.maxBots}). Contact admin to upgrade.` });
        }
    }

    // Clamp maxMemory to slot's maxRamPerBot if user tries to set higher
    if (req.body.maxMemory && slot.maxRamPerBot) {
        const reqMB = parseRamMB(req.body.maxMemory);
        const slotMB = parseRamMB(slot.maxRamPerBot);
        if (reqMB !== null && slotMB !== null && reqMB > slotMB) {
            req.body.maxMemory = slot.maxRamPerBot;
        }
    }

    req.slot = slot;
    next();
};

// ─── Restart rate limiter ───────────────────────────────────────────────────
// Tracks timestamps of recent restart attempts per bot id.
// If a bot is restarted >= 5 times within 60 s it is auto-stopped.
const RESTART_WINDOW_MS = 60_000;
const RESTART_MAX = 5;
const restartTimestamps = new Map(); // botId → number[]

/**
 * Record a restart attempt and return true if the bot should be force-stopped.
 * @param {string} botId
 */
const shouldAutoStop = (botId) => {
    const now = Date.now();
    const cutoff = now - RESTART_WINDOW_MS;
    const times = (restartTimestamps.get(botId) || []).filter((t) => t > cutoff);
    times.push(now);
    restartTimestamps.set(botId, times);
    return times.length >= RESTART_MAX;
};

// ─── Website helpers ─────────────────────────────────────────────────────────

/**
 * Assign a port for a website project on the target node.
 * Uses the user-supplied port or auto-assigns a free one on that node.
 * @returns {Promise<number>}
 */
const assignPort = async (requestedPort, nodeId = null) => {
    if (requestedPort) {
        const port = parseInt(requestedPort, 10);
        if (isNaN(port) || port < 1 || port > 65535)
            throw new Error("Invalid port number");
        return port;
    }
    return executor.findFreePortOn(nodeId, 3000, 9000);
};

/**
 * Apply the correct serving infrastructure for a website project — on
 * whichever node the bot lives (executor routes nginx/UFW/PM2 calls):
 *   - static, no domain → http-server via PM2 on wc.port (works with IP:port)
 *   - static, domain    → nginx on port 80 for domain access
 *   - fullstack         → nginx on wc.port (+ port 80 if domain is set)
 *
 * @param {Object} bot - Full bot record (must have pm2Name, nodeId, websiteConfig)
 */
const applyWebsiteInfra = async (bot) => {
    const wc = bot.websiteConfig;

    if (wc.mode === "static" && !wc.domain) {
        // http-server mode: runs as a PM2 process, no nginx needed
        await executor.startHttpServer(bot, wc.distFolder, wc.port);
        await executor.ufwOpenPort(bot, wc.port);
        return;
    }

    // nginx mode: static+domain (listen 80) or fullstack (listen wc.port)
    await executor.nginxWriteConfig(bot, {
        mode: wc.mode,
        port: wc.port,
        apiPort: wc.apiPort || null,
        distFolder: wc.distFolder,
        domain: wc.domain || null,
        extraConfig: wc.extraNginxConfig || null,
    });

    if (wc.mode === "static") {
        // Domain-based static site → nginx handles port 80
        await executor.ufwOpenPort(bot, 80);
    } else {
        await executor.ufwOpenPort(bot, wc.port);
        if (wc.domain && wc.port !== 80) {
            await executor.ufwOpenPort(bot, 80);
        }
    }

    // Restore SSL if it was previously configured — certbot detects the existing
    // cert and updates the nginx config without re-issuing, so this is safe to
    // call on every start/restart.
    if (wc.domain && wc.sslEnabled) {
        await executor.nginxEnableSSL(bot, wc.domain, null);
        await executor.ufwOpenPort(bot, 443);
    }
};

/**
 * Run a website build command in the project dir on its node.
 * The agent's /git/install runs an arbitrary command there, so build and
 * install share one endpoint.
 */
const runBuildCommand = async (bot, buildCommand) => {
    if (!buildCommand) return;
    await executor.installDeps(bot, buildCommand);
};

/**
 * Get live status for any project type.
 * - static, no domain → http-server runs via PM2 → PM2 status
 * - static, domain    → nginx config existence (on the bot's node)
 * - discord / fullstack → PM2 status (routed to the bot's node)
 *
 * `resolver` (from executor.getStatusResolver) batches PM2/nginx list fetches
 * per node — pass it when enriching many bots; omit it for a single bot.
 */
const getLiveStatus = async (bot, resolver = null) => {
    if (bot.projectType === "website" && bot.websiteConfig?.mode === "static" && bot.websiteConfig?.domain) {
        const exists = await executor.nginxConfigExists(bot, resolver ? resolver.nginxListFor(bot) : undefined);
        if (exists === null) return { status: "node-offline", cpu: 0, memory: 0, restarts: 0, uptime: null };
        return { status: exists ? "online" : "stopped", cpu: 0, memory: 0, restarts: 0, uptime: null };
    }
    if (resolver) return resolver.statusFor(bot);
    return executor.getBotStatus(bot);
};

/**
 * Resolve the effective proxychains4 config for a given bot.
 * Returns the proxy config object if the global proxy is enabled AND the bot
 * has proxyEnabled === true. Returns null otherwise.
 */
const getProxyConf = async (bot) => {
    if (!bot.proxyEnabled) return null;
    const globalConf = await db.get("proxy_config");
    if (!globalConf || !globalConf.enabled) return null;
    return globalConf; // { type, host, port, username, password }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  List & Read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/bots/domains
 * Returns all website projects that have a custom domain configured.
 */
router.get("/domains", async (req, res, next) => {
    try {
        const query = req.user.role === "admin" ? {} : { ownerId: req.user.id };
        let bots = await db.find("bots", query);
        // Remote-view context: only domains hosted on the selected node
        if (req.node) {
            bots = bots.filter((b) => {
                try { return nodeService.resolveNodeId(b.nodeId) === req.nodeId; } catch { return false; }
            });
        }
        const domains = bots
            .filter((b) => b.projectType === "website" && b.websiteConfig?.domain)
            .map((b) => ({
                _id: b._id,
                name: b.name,
                domain: b.websiteConfig.domain,
                port: b.websiteConfig.port,
                mode: b.websiteConfig.mode,
                sslEnabled: b.websiteConfig.sslEnabled ?? false,
                pm2Name: b.pm2Name,
            }));
        res.json(domains);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/bots
 * Returns all bots enriched with live PM2 status.
 */
router.get("/", async (req, res, next) => {
    try {
        // Admin sees all bots; users see only their own
        const query = req.user.role === "admin" ? {} : { ownerId: req.user.id };
        let bots = await db.find("bots", query);
        // Remote-view context: only bots living on the selected node
        if (req.node) {
            bots = bots.filter((b) => {
                try { return nodeService.resolveNodeId(b.nodeId) === req.nodeId; } catch { return false; }
            });
        }
        // One PM2 list fetch per node (local + each agent) instead of per bot
        const resolver = await executor.getStatusResolver(bots);
        const nodes = await nodeService.getNodes();
        const nodeNames = Object.fromEntries(nodes.map((n) => [n._id, n.name]));

        const enriched = await Promise.all(
            bots.map(async (bot) => {
                const live = await getLiveStatus(bot, resolver);
                let nodeName = null;
                try { nodeName = nodeNames[nodeService.resolveNodeId(bot.nodeId)] || "unknown node"; } catch { /* PANEL_NODE_ID unset */ }
                return { ...bot, live, nodeName };
            }),
        );

        res.json(enriched);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/bots/:id
 * Returns a single bot by _id with live status.
 */
router.get("/:id", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const live = await getLiveStatus(bot);
        let nodeName = null;
        try {
            const node = await db.findOne("nodes", { _id: nodeService.resolveNodeId(bot.nodeId) });
            nodeName = node?.name || "unknown node";
        } catch { /* PANEL_NODE_ID unset */ }
        res.json({ ...bot, live, nodeName });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/bots/:id/history?range=1h|6h|24h|7d|30d
 * This bot's own CPU/memory history, recorded by samplerService from the PM2
 * numbers on its node. `up` is 1 for each sample where the process was online,
 * so a stopped stretch reads as a real gap in the chart instead of as 0% load.
 */
router.get("/:id/history", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });
        res.json(history.botHistory(bot._id, req.query.range));
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Create Bot — clone from GitHub
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/bots
 * Clone a git repo, install deps, and register the bot in the DB.
 *
 * Body: {
 *   buyerID     string  — Discord user ID of the buyer
 *   botID       string  — Short unique slug for the bot (e.g. "mybot")
 *   name        string  — Display name
 *   repoUrl     string  — Git repository URL
 *   branch      string  — Git branch (default: "main")
 *   startScript string  — Start command (default: "npm start")
 *   installCommand string — Install command (optional, e.g. "npm install", "mvn install", empty to skip)
 *   expiresAt   string  — ISO date string (optional)
 *   groupId     string  — Group _id to assign (optional)
 *   maxMemory   string  — PM2 memory limit e.g. "300M", "1G" (optional)
 * }
 */
router.post("/", checkSlotQuota, async (req, res, next) => {
    try {
        const {
            botID,
            name,
            repoUrl,
            branch = "main",
            startScript = "npm start",
            installCommand,
            expiresAt,
            groupId = null,
            maxMemory = null,
            currentPrice = null,
            tags = [],
            // Website-specific
            projectType = "discord",
            websiteConfig: rawWebsiteConfig,
            serviceConfig: rawServiceConfig,
        } = req.body;

        // For regular users, auto-assign buyerID = their user id
        const buyerID = req.user.role === "admin"
            ? (req.body.buyerID || req.user.id)
            : req.user.id;

        // ownerId: when admin creates a bot for another panel user (buyerID = targetUser._id),
        // assign ownership to that user so they can manage the bot themselves.
        let ownerId = req.user.id;
        if (req.user.role === "admin" && buyerID !== req.user.id) {
            const targetUser = await db.findOne("users", { _id: buyerID });
            if (targetUser) ownerId = targetUser._id;
        }

        // Validate required fields
        if (!botID || !name || !repoUrl) {
            return res.status(400).json({
                error: "botID, name, and repoUrl are required",
            });
        }
        if (projectType === "website") {
            if (rawWebsiteConfig?.mode !== "static" && !rawWebsiteConfig?.distFolder)
                return res.status(400).json({ error: "websiteConfig.distFolder is required for websites" });
            if (rawWebsiteConfig.mode === "fullstack" && !rawWebsiteConfig.apiPort)
                return res.status(400).json({ error: "websiteConfig.apiPort is required for fullstack websites" });
        }
        if (projectType === "service" && rawServiceConfig?.port) {
            const p = parseInt(rawServiceConfig.port, 10);
            if (isNaN(p) || p < 1 || p > 65535)
                return res.status(400).json({ error: "Invalid serviceConfig.port" });
        }

        // Prevent duplicate botID under same buyer
        const existing = await db.findOne("bots", { buyerID, botID });
        if (existing) {
            return res.status(409).json({
                error: `Bot "${botID}" already exists for buyer "${buyerID}"`,
            });
        }

        // Decide which node this project lands on ("auto" → scheduler picks).
        // Only admins may target a specific node; users always go through auto.
        // The remote-view context (X-Panel-Node) acts as the default target when
        // the form doesn't specify one explicitly.
        let placement;
        try {
            const requestedNodeId = req.user.role === "admin"
                ? (req.body.nodeId || (req.node ? req.nodeId : null))
                : null;
            placement = await schedulerService.pickNode({ requestedNodeId, projectType });
        } catch (schedErr) {
            return res.status(400).json({ error: schedErr.message });
        }
        const nodeId = placement.nodeId;
        console.log(`[Bots] Placement for "${botID}": node=${placement.nodeName} (${placement.reason})`);

        const isStaticWebsite = projectType === "website" && rawWebsiteConfig?.mode === "static";
        const nodeRef = { nodeId, buyerID, botID, projectType };

        // 1. Clone on the target node (the agent creates parent dirs itself)
        console.log(`[Bots] Cloning ${repoUrl} on node "${placement.nodeName}"`);
        await executor.cloneRepo(nodeRef, repoUrl, branch);

        // 2. Install dependencies (skip for static websites)
        if (!isStaticWebsite) {
            try {
                console.log(`[Bots] Installing deps for ${botID} on node "${placement.nodeName}"`);
                await executor.installDeps(nodeRef, installCommand);
            } catch (installErr) {
                await executor.fsDelete(nodeRef, "").catch(() => {});
                throw installErr;
            }
        }

        // 3. Build step (website only)
        let websiteConfig = null;
        let serviceConfig = null;
        if (projectType === "website") {
            const mode = rawWebsiteConfig.mode || "static";
            if (!isStaticWebsite && rawWebsiteConfig.buildCommand) {
                console.log(`[Bots] Running build command for ${botID}`);
                try {
                    // Agent /git/install runs any command in the project dir
                    await executor.installDeps(nodeRef, rawWebsiteConfig.buildCommand);
                } catch (buildErr) {
                    await executor.fsDelete(nodeRef, "").catch(() => {});
                    throw buildErr;
                }
            }
            const port = await assignPort(rawWebsiteConfig.port, nodeId);
            websiteConfig = {
                mode,
                port,
                apiPort: rawWebsiteConfig.apiPort ? parseInt(rawWebsiteConfig.apiPort, 10) : null,
                buildCommand: isStaticWebsite ? null : (rawWebsiteConfig.buildCommand || null),
                distFolder: rawWebsiteConfig.distFolder || (isStaticWebsite ? "." : "dist"),
                domain: null,
                sslEnabled: false,
            };
        } else if (projectType === "service" && rawServiceConfig?.port) {
            serviceConfig = { port: parseInt(rawServiceConfig.port, 10) };
        }

        // 4. Save to DB
        const pm2Name = `${buyerID}-${botID}`;
        const botRecord = await db.create("bots", {
            buyerID,
            botID,
            name,
            repoUrl,
            branch,
            startScript,
            installCommand: installCommand !== undefined ? installCommand : "npm install --omit=dev",
            pm2Name,
            source: "git",
            localPath: null,
            nodeId,
            groupId,
            maxMemory,
            currentPrice,
            tags: Array.isArray(tags) ? tags : [],
            expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
            projectType,
            websiteConfig,
            serviceConfig,
            ownerId,
            createdAt: Date.now(),
        });

        // 5. Post-creation infra (on whichever node the project landed)
        if (projectType === "website") {
            await applyWebsiteInfra(botRecord);
            console.log(`[Bots] Website infra applied for "${name}" on port ${websiteConfig.port}`);
        } else if (projectType === "service" && serviceConfig?.port) {
            await executor.ufwOpenPort(botRecord, serviceConfig.port);
            console.log(`[Bots] UFW opened port ${serviceConfig.port} for service "${name}"`);
        }

        console.log(`[Bots] Created ${projectType} "${name}" (${pm2Name})`);
        res.status(201).json(botRecord);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Import Local Folder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/bots/import-local
 * Register a bot from an existing folder on the server (no git clone).
 * The folder may still be a git repo — git pull on update will work normally.
 *
 * Body: {
 *   buyerID     string  — Discord user ID of the buyer
 *   botID       string  — Short unique slug
 *   name        string  — Display name
 *   localPath   string  — Absolute path to the folder on the server
 *   startScript string  — Start command (default: "npm start")
 *   installCommand string — Install command (optional, empty to skip)
 *   expiresAt   string  — ISO date string (optional)
 *   groupId     string  — Group _id (optional)
 *   maxMemory   string  — PM2 memory limit (optional)
 * }
 */
router.post("/import-local", checkSlotQuota, async (req, res, next) => {
    try {
        const {
            botID,
            name,
            localPath,
            startScript = "npm start",
            installCommand,
            expiresAt,
            groupId = null,
            maxMemory = null,
            currentPrice = null,
            tags = [],
            projectType = "discord",
            websiteConfig: rawWebsiteConfig,
            serviceConfig: rawServiceConfig,
        } = req.body;

        const buyerID = req.user.role === "admin"
            ? (req.body.buyerID || req.user.id)
            : req.user.id;

        let ownerId = req.user.id;
        if (req.user.role === "admin" && buyerID !== req.user.id) {
            const targetUser = await db.findOne("users", { _id: buyerID });
            if (targetUser) ownerId = targetUser._id;
        }

        if (!botID || !name || !localPath) {
            return res.status(400).json({
                error: "botID, name, and localPath are required",
            });
        }
        if (projectType === "website") {
            if (rawWebsiteConfig?.mode !== "static" && !rawWebsiteConfig?.distFolder)
                return res.status(400).json({ error: "websiteConfig.distFolder is required for websites" });
            if (rawWebsiteConfig.mode === "fullstack" && !rawWebsiteConfig.apiPort)
                return res.status(400).json({ error: "websiteConfig.apiPort is required for fullstack websites" });
        }
        if (projectType === "service" && rawServiceConfig?.port) {
            const p = parseInt(rawServiceConfig.port, 10);
            if (isNaN(p) || p < 1 || p > 65535)
                return res.status(400).json({ error: "Invalid serviceConfig.port" });
        }

        // The folder lives on the panel's own node. Ask that node's agent whether
        // it exists AND is inside its allowlist — a path outside BOTS/SITES_ROOT_DIR
        // needs to be listed in the agent's EXTRA_ROOTS or nothing can manage it.
        const importRef = { nodeId: nodeService.panelNodeId(), source: "local", localPath };
        try {
            if (!(await executor.fsExists(importRef))) {
                return res.status(400).json({
                    error: `Path "${localPath}" does not exist on the panel's node`,
                });
            }
        } catch (err) {
            return res.status(400).json({
                error: `Cannot use "${localPath}": ${err.message}`,
            });
        }

        // Prevent duplicate botID under same buyer
        const existing = await db.findOne("bots", { buyerID, botID });
        if (existing) {
            return res.status(409).json({
                error: `Bot "${botID}" already exists for buyer "${buyerID}"`,
            });
        }

        // Run install command if provided (skip if explicitly empty/null or static website)
        const isStaticWebsite = projectType === "website" && rawWebsiteConfig?.mode === "static";
        if (!isStaticWebsite && installCommand !== null && installCommand !== "") {
            console.log(`[Bots] Installing deps for local bot ${botID}`);
            await executor.installDeps(importRef, installCommand);
        }

        // Build step (website only, skip for static)
        let websiteConfig = null;
        if (projectType === "website") {
            const mode = rawWebsiteConfig.mode || "static";
            if (mode !== "static" && rawWebsiteConfig.buildCommand) {
                await executor.installDeps(importRef, rawWebsiteConfig.buildCommand);
            }
            const port = await assignPort(rawWebsiteConfig.port);
            websiteConfig = {
                mode,
                port,
                apiPort: rawWebsiteConfig.apiPort ? parseInt(rawWebsiteConfig.apiPort, 10) : null,
                buildCommand: mode === "static" ? null : (rawWebsiteConfig.buildCommand || null),
                distFolder: rawWebsiteConfig.distFolder || (mode === "static" ? "." : "dist"),
                domain: null,
                sslEnabled: false,
            };
        }

        // Build serviceConfig
        let serviceConfig = null;
        if (projectType === "service" && rawServiceConfig?.port) {
            serviceConfig = {
                port: parseInt(rawServiceConfig.port, 10),
                startCommand: rawServiceConfig.startCommand || null,
            };
        }

        // Check if it's a git repo (for informational field)
        const { repoUrl, branch } = await executor.gitInfo(importRef);

        const pm2Name = `${buyerID}-${botID}`;
        const botRecord = await db.create("bots", {
            buyerID,
            botID,
            name,
            repoUrl,
            branch,
            startScript,
            installCommand: installCommand !== undefined ? installCommand : null,
            pm2Name,
            source: "local",
            localPath,
            // Imported folders physically live on the panel's machine, which is
            // an ordinary node — the import is registered against it.
            nodeId: importRef.nodeId,
            groupId,
            maxMemory,
            currentPrice,
            tags: Array.isArray(tags) ? tags : [],
            expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
            projectType,
            websiteConfig,
            serviceConfig,
            ownerId,
            createdAt: Date.now(),
        });

        if (projectType === "website") {
            await applyWebsiteInfra(botRecord);
        }
        if (projectType === "service" && serviceConfig?.port) {
            await executor.ufwOpenPort(botRecord, serviceConfig.port);
        }

        console.log(`[Bots] Imported local ${projectType} "${name}" (${pm2Name}) from ${localPath}`);
        res.status(201).json(botRecord);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Update Metadata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PUT /api/bots/:id
 * Update editable metadata fields.
 *
 * Body: { name?, expiresAt?, startScript?, installCommand?, groupId?, maxMemory? }
 */
router.put("/:id", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { name, expiresAt, startScript, installCommand, groupId, maxMemory, currentPrice, tags } = req.body;

        const updates = {};
        if (name !== undefined) updates.name = name;
        if (startScript !== undefined) updates.startScript = startScript;
        if (installCommand !== undefined) updates.installCommand = installCommand || null;
        if (groupId !== undefined) updates.groupId = groupId;
        if (maxMemory !== undefined) updates.maxMemory = maxMemory || null;
        if (currentPrice !== undefined) updates.currentPrice = currentPrice || null;
        if (tags !== undefined) updates.tags = Array.isArray(tags) ? tags : [];
        if (expiresAt !== undefined) {
            const newExpiry = expiresAt ? new Date(expiresAt).getTime() : null;
            updates.expiresAt = newExpiry;
            // Expiry changed → clear warning history so milestones re-fire as the
            // new deadline approaches (and don't linger from the old one).
            if (newExpiry !== bot.expiresAt) updates.warnedHours = [];
        }

        const updated = await db.findOneAndUpdate(
            "bots",
            { _id: req.params.id },
            updates,
        );

        if (expiresAt !== undefined && (!bot.expiresAt || new Date(expiresAt).getTime() !== bot.expiresAt)) {
            await createNotification(`Bot "${bot.name}" expiry was extended.`, "extend");
        }

        // If maxMemory changed and the bot is running, apply the new limit live
        if (maxMemory !== undefined) {
            const live = await executor.getBotStatus(bot);
            if (live.status === "online") {
                await executor.setMemoryLimit(bot, maxMemory || null);
            }
        }

        res.json(updated);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Delete Bot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DELETE /api/bots/:id
 * Stop the bot, remove from PM2, optionally delete source directory, remove DB record.
 * NOTE: local-sourced bots are NOT deleted from disk.
 */
router.delete("/:id", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        // Stop & unregister from PM2 (on whichever node the bot lives)
        await executor.deleteBot(bot);

        // Project-type cleanup (on whichever node the project lives)
        if (bot.projectType === "website" && bot.websiteConfig) {
            await executor.nginxRemoveConfig(bot);
            // Static+domain uses nginx on port 80 (shared — don't close it)
            const isStaticWithDomain = bot.websiteConfig.mode === "static" && bot.websiteConfig.domain;
            if (!isStaticWithDomain) {
                await executor.ufwClosePort(bot, bot.websiteConfig.port);
            }
        } else if (bot.projectType === "service" && bot.serviceConfig?.port) {
            await executor.ufwClosePort(bot, bot.serviceConfig.port);
        }

        // Only delete source files for git-managed bots
        if (bot.source !== "local") {
            await executor.removeBotFiles(bot);
        }

        // Remove from DB
        await db.findOneAndDelete("bots", { _id: req.params.id });

        console.log(`[Bots] Deleted ${bot.projectType || "discord"} "${bot.name}" (${bot.pm2Name})`);
        res.json({ message: `Bot "${bot.name}" deleted successfully` });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Migrate to another node
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/bots/:id/migrate   body: { targetNodeId }
 * Move a project (with all its data, keeping .git) to another node:
 *   stop source → archive → extract on target → reinstall → start → clean source.
 * The DB record only flips its nodeId on success; on failure the source is
 * left intact and restarted.
 */
router.post("/:id/migrate", requireOwnership, async (req, res, next) => {
    const os = require("os");
    const path2 = require("path");
    const fsp = require("fs");
    let tmpPath = null;
    let sourceStopped = false;
    let bot = null;

    try {
        if (req.user.role !== "admin") return res.status(403).json({ error: "Admins only" });

        bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { targetNodeId } = req.body;
        if (!targetNodeId) return res.status(400).json({ error: "targetNodeId is required" });

        const currentNodeId = nodeService.resolveNodeId(bot.nodeId);
        if (nodeService.resolveNodeId(targetNodeId) === currentNodeId) {
            return res.status(400).json({ error: "Target node is the same as the current node" });
        }

        // The target must exist, be enabled, and answer right now
        const target = await nodeService.getNode(targetNodeId); // throws if unknown
        if (target.enabled === false) return res.status(400).json({ error: `Node "${target.name}" is disabled` });
        const healthy = await nodeService.checkNodeHealth(target);
        if (!healthy) return res.status(400).json({ error: `Node "${target.name}" is offline — cannot migrate there` });

        const sourceRef = { ...bot }; // nodeId = current
        const targetRef = { ...bot, nodeId: targetNodeId };
        const isStaticNoDomain = bot.projectType === "website" && bot.websiteConfig?.mode === "static" && !bot.websiteConfig?.domain;

        // 1. Stop on source (+ tear down its nginx/UFW), keep files for now
        try {
            if (bot.projectType === "website" && bot.websiteConfig) {
                await executor.nginxRemoveConfig(sourceRef).catch(() => {});
                await executor.deleteBot(sourceRef).catch(() => {}); // stops http-server if any
                const isStaticDomain = bot.websiteConfig.mode === "static" && bot.websiteConfig.domain;
                if (!isStaticDomain) await executor.ufwClosePort(sourceRef, bot.websiteConfig.port).catch(() => {});
            } else {
                await executor.deleteBot(sourceRef).catch(() => {});
                if (bot.projectType === "service" && bot.serviceConfig?.port) {
                    await executor.ufwClosePort(sourceRef, bot.serviceConfig.port).catch(() => {});
                }
            }
            sourceStopped = true;
        } catch (e) {
            throw new Error(`Failed to stop the project on the source node: ${e.message}`);
        }

        // 2. Archive source → panel temp file (skip node_modules when reinstallable)
        const excludeNodeModules = !!bot.installCommand;
        tmpPath = path2.join(os.tmpdir(), `migrate-${bot._id}-${Date.now()}.tar.gz`);
        console.log(`[Bots] Migrating "${bot.name}" ${currentNodeId} → ${targetNodeId} (archiving…)`);
        await executor.archiveToFile(sourceRef, tmpPath, { excludeNodeModules });

        // 3. Extract onto the target
        console.log(`[Bots] Migrating "${bot.name}" (restoring on target…)`);
        await executor.extractFromFile(targetRef, tmpPath, { clear: true });

        // 4. Reinstall deps on target (node_modules was excluded) + rebuild websites
        if (excludeNodeModules && !isStaticNoDomain) {
            console.log(`[Bots] Migrating "${bot.name}" (installing deps on target…)`);
            await executor.installDeps(targetRef, bot.installCommand);
        }
        if (bot.projectType === "website" && bot.websiteConfig?.mode !== "static") {
            await runBuildCommand(targetRef, bot.websiteConfig.buildCommand);
        }

        // 5. Flip the DB record to the new node
        const updated = await db.findOneAndUpdate("bots", { _id: bot._id }, { nodeId: targetNodeId });

        // 6. Start on the target
        if (bot.projectType === "website") {
            await applyWebsiteInfra(updated);
        } else if (bot.projectType === "service") {
            const proxyConf = await getProxyConf(updated);
            await executor.startBot(updated, proxyConf);
            if (updated.serviceConfig?.port) await executor.ufwOpenPort(updated, updated.serviceConfig.port);
        } else {
            const proxyConf = await getProxyConf(updated);
            await executor.startBot(updated, proxyConf);
        }

        // 7. Clean up the source node's files (target is confirmed running).
        //    Local-imported folders live at a user-managed path — never delete
        //    them, same as the DELETE route.
        if (bot.source !== "local") {
            await executor.removeBotFiles(sourceRef).catch((e) => console.warn(`[Bots] Source cleanup warning: ${e.message}`));
        }

        await createNotification(`"${bot.name}" was migrated to a new node.`, "info");
        console.log(`[Bots] Migrated "${bot.name}" → ${targetNodeId}`);
        res.json({ message: "Migration complete", bot: updated });
    } catch (err) {
        // Rollback: DB was not changed unless we reached step 5; try to bring the
        // source back online so the user isn't left with a stopped project.
        if (bot && sourceStopped) {
            try {
                const still = await db.findOne("bots", { _id: bot._id });
                if (still && nodeService.resolveNodeId(still.nodeId) === nodeService.resolveNodeId(bot.nodeId)) {
                    if (bot.projectType === "website") await applyWebsiteInfra(bot).catch(() => {});
                    else await executor.startBot(bot, await getProxyConf(bot)).catch(() => {});
                }
            } catch { /* best-effort restore */ }
        }
        next(err);
    } finally {
        if (tmpPath) { try { require("fs").rmSync(tmpPath, { force: true }); } catch { /* ignore */ } }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Process Control
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/bots/:id/start */
router.post("/:id/start", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        if (bot.expiresAt && bot.expiresAt <= Date.now()) {
            return res.status(403).json({ error: "Bot is expired. Please extend to start." });
        }

        // Static website: rebuild if needed, then start via http-server or nginx
        if (bot.projectType === "website" && bot.websiteConfig?.mode === "static") {
            const wc = bot.websiteConfig;
            await runBuildCommand(bot, wc.buildCommand);
            await applyWebsiteInfra(bot);
            await createNotification(`Website "${bot.name}" was started.`, "start");
            const output = wc.domain ? "nginx config applied" : "http-server started";
            return res.json({ message: "Website started", output });
        }

        // Discord bot or fullstack website: use PM2 (routed to the bot's node)
        const proxyConf = await getProxyConf(bot);
        const output = await executor.startBot(bot, proxyConf);
        await createNotification(`Bot "${bot.name}" was started.`, "start");
        res.json({ message: "Bot started", output });
    } catch (err) {
        next(err);
    }
});

/** POST /api/bots/:id/stop */
router.post("/:id/stop", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        if (bot.projectType === "website" && bot.websiteConfig?.mode === "static") {
            if (bot.websiteConfig.domain) {
                // Domain mode: remove nginx config
                await executor.nginxRemoveConfig(bot);
            } else {
                // http-server mode: stop PM2 process
                await executor.stopBot(bot);
            }
            await createNotification(`Website "${bot.name}" was stopped.`, "stop");
            return res.json({ message: "Website stopped" });
        }

        const output = await executor.stopBot(bot);
        await createNotification(`Bot "${bot.name}" was stopped.`, "stop");
        res.json({ message: "Bot stopped", output });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/bots/:id/website-config
 * Update website infrastructure settings (port, apiPort, distFolder, buildCommand).
 * Re-applies nginx config and adjusts UFW ports automatically.
 *
 * Body: { port?, apiPort?, distFolder?, buildCommand? }
 */
router.put("/:id/website-config", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });
        if (bot.projectType !== "website") return res.status(400).json({ error: "Only website projects support this" });

        const wc = bot.websiteConfig;
        const { port, apiPort, distFolder, buildCommand, extraNginxConfig } = req.body;

        const newPort = port ? parseInt(port, 10) : wc.port;
        if (isNaN(newPort) || newPort < 1 || newPort > 65535)
            return res.status(400).json({ error: "Invalid port" });

        const newApiPort = apiPort ? parseInt(apiPort, 10) : wc.apiPort;
        if (wc.mode === "fullstack" && (!newApiPort || isNaN(newApiPort)))
            return res.status(400).json({ error: "apiPort is required for fullstack" });

        const newDistFolder = distFolder?.trim() || wc.distFolder;
        const newBuildCommand = buildCommand !== undefined ? (buildCommand.trim() || null) : wc.buildCommand;
        const newExtraNginx = extraNginxConfig !== undefined ? (extraNginxConfig.trim() || null) : (wc.extraNginxConfig || null);
        const newWc = { ...wc, port: newPort, apiPort: newApiPort, distFolder: newDistFolder, buildCommand: newBuildCommand, extraNginxConfig: newExtraNginx };

        if (wc.mode === "static" && !wc.domain) {
            // http-server mode: adjust UFW port if changed, then restart http-server
            if (newPort !== wc.port) {
                await executor.ufwClosePort(bot, wc.port);
                await executor.ufwOpenPort(bot, newPort);
            }
            await executor.startHttpServer(bot, newDistFolder, newPort);
        } else {
            // nginx mode: adjust UFW port if changed, then rewrite config
            if (newPort !== wc.port) {
                await executor.ufwClosePort(bot, wc.port);
                await executor.ufwOpenPort(bot, newPort);
            }
            await executor.nginxWriteConfig(bot, {
                mode: wc.mode,
                port: newPort,
                apiPort: newApiPort || null,
                distFolder: newDistFolder,
                domain: wc.domain || null,
                extraConfig: newExtraNginx,
            });
            if (wc.domain && wc.sslEnabled) {
                await executor.nginxEnableSSL(bot, wc.domain, null);
                await executor.ufwOpenPort(bot, 443);
            }
        }

        const updated = await db.findOneAndUpdate("bots", { _id: req.params.id }, { websiteConfig: newWc });
        res.json({ message: "Website config updated", bot: updated });
    } catch (err) {
        next(err);
    }
});

/** POST /api/bots/:id/domain — set custom domain + issue SSL */
router.post("/:id/domain", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });
        if (bot.projectType !== "website") return res.status(400).json({ error: "Only website projects support custom domains" });

        const { domain, email } = req.body;
        if (!domain) return res.status(400).json({ error: "domain is required" });

        const wc = bot.websiteConfig;

        // If static site was running via http-server (no domain), stop it and close its port
        if (wc.mode === "static" && !wc.domain) {
            await executor.deleteBot(bot);
            await executor.ufwClosePort(bot, wc.port);
        }

        // Write nginx config with new domain (on the bot's node)
        await executor.nginxWriteConfig(bot, {
            mode: wc.mode,
            port: wc.port,
            apiPort: wc.apiPort || null,
            distFolder: wc.distFolder,
            domain,
        });

        // certbot's HTTP challenge needs 80 open; 443 serves the cert afterwards.
        // (Worker nodes start with only SSH + the agent port open.)
        await executor.ufwOpenPort(bot, 80);

        // Issue SSL via certbot
        await executor.nginxEnableSSL(bot, domain, email || null);
        await executor.ufwOpenPort(bot, 443);

        // Persist domain + sslEnabled to DB
        const updated = await db.findOneAndUpdate(
            "bots",
            { _id: req.params.id },
            { websiteConfig: { ...wc, domain, sslEnabled: true } },
        );

        await createNotification(`Domain "${domain}" with SSL was configured for "${bot.name}".`, "info");
        res.json({ message: `SSL configured for ${domain}`, bot: updated });
    } catch (err) {
        next(err);
    }
});

/** POST /api/bots/:id/restart */
router.post("/:id/restart", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        if (bot.expiresAt && bot.expiresAt <= Date.now()) {
            return res.status(403).json({ error: "Bot is expired. Please extend to start." });
        }

        // Auto-stop if the bot has been restarted too many times in a short window.
        if (shouldAutoStop(req.params.id)) {
            restartTimestamps.delete(req.params.id); // reset counter after stopping
            await executor.stopBot(bot);
            await createNotification(
                `Bot "${bot.name}" was auto-stopped after ${RESTART_MAX} restarts within ${RESTART_WINDOW_MS / 1000}s.`,
                "restart",
            );
            return res.status(429).json({
                error: `Bot auto-stopped: restarted ${RESTART_MAX}+ times within ${RESTART_WINDOW_MS / 1000}s to prevent a restart loop.`,
            });
        }

        if (bot.projectType === "website" && bot.websiteConfig?.mode === "static") {
            const wc = bot.websiteConfig;
            await runBuildCommand(bot, wc.buildCommand);
            await applyWebsiteInfra(bot);
            await createNotification(`Website "${bot.name}" was restarted.`, "restart");
            return res.json({ message: "Website restarted" });
        }

        // Use startBot (which deletes + re-registers) so the wrapper script
        // is always regenerated with the current proxy settings.
        const proxyConf = await getProxyConf(bot);
        const output = await executor.startBot(bot, proxyConf);
        await createNotification(`Bot "${bot.name}" was restarted.`, "restart");
        res.json({ message: "Bot restarted", output });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Git Update
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/bots/:id/update
 * Pull latest git changes, run install command, and restart the bot.
 * For local bots that are also git repos, git pull still works.
 * For local bots with no remote, only install + restart is performed.
 * Skips install entirely if bot has no installCommand.
 */
router.post("/:id/update", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        if (bot.expiresAt && bot.expiresAt <= Date.now()) {
            return res.status(403).json({ error: "Bot is expired. Please extend to start." });
        }

        let pullOutput = "(skipped — no git remote)";
        let pullFailed = false;

        // Attempt git pull (on the bot's node)
        try {
            pullOutput = await executor.pullRepo(bot);
            console.log(`[Bots] git pull for "${bot.name}": ${pullOutput.trim().split('\n')[0]}`);
        } catch (err) {
            pullFailed = true;
            pullOutput = err.message || "unknown error";
            console.warn(`[Bots] git pull failed for "${bot.name}": ${pullOutput}`);
        }

        // Static website: skip install, run build if configured, then apply serving infra
        if (bot.projectType === "website" && bot.websiteConfig?.mode === "static") {
            const wc = bot.websiteConfig;
            await runBuildCommand(bot, wc.buildCommand);
            await applyWebsiteInfra(bot);
            await createNotification(`Bot "${bot.name}" was updated / reinstalled.`, "reinstall");
            console.log(`[Bots] Updated static website "${bot.name}"`);
            return res.json({
                message: "Website updated and restarted",
                pullOutput,
                pullFailed,
                restartOutput: wc.domain ? "nginx config applied" : "http-server started",
            });
        }

        await executor.installDeps(bot, bot.installCommand);

        // Use startBot so wrapper script is refreshed with current proxy settings
        const proxyConf = await getProxyConf(bot);
        const restartOutput = await executor.startBot(bot, proxyConf);

        await createNotification(`Bot "${bot.name}" was updated / reinstalled.`, "reinstall");
        console.log(`[Bots] Updated bot "${bot.name}"`);
        res.json({
            message: "Bot updated and restarted",
            pullOutput,
            pullFailed,
            restartOutput,
        });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  .env Editor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/bots/:id/env
 * Read the .env file of the bot. Returns empty string if no .env exists.
 */
router.get("/:id/env", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        try {
            const data = await executor.fsRead(bot, ".env");
            res.json({ content: data.content });
        } catch (err) {
            if (err.status === 404) return res.json({ content: "" });
            throw err;
        }
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/bots/:id/env
 * Overwrite the .env file with new content.
 *
 * Body: { content: string }
 */
router.put("/:id/env", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { content } = req.body;
        if (content === undefined)
            return res.status(400).json({ error: "content is required" });

        await executor.fsWrite(bot, ".env", content);
        res.json({ message: ".env saved successfully" });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  File Manager
//
//  Every operation is relayed to the agent on the project's node, which runs
//  its own traversal check against its configured roots (agent/utils/paths.js).
//  The panel only guards what the agent cannot know: that the file manager must
//  never address the project directory itself.
// ─────────────────────────────────────────────────────────────────────────────

const multer = require("multer");

// Memory storage: the destination lives in another process (often another
// machine), so the file is buffered here and forwarded to the agent.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 },
});

/** True when a requested path is the project root rather than something inside it. */
const isProjectRoot = (reqPath) => {
    const p = String(reqPath || "").trim();
    return p === "" || p === "." || p === "/" || p === "./";
};

/**
 * GET /api/bots/:id/fs/download?path=...
 * Downloads a specific file.
 */
router.get("/:id/fs/download", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        let upstream;
        try {
            upstream = await executor.fsDownloadStream(bot, req.query.path);
        } catch (err) {
            const status = err.response?.status || 500;
            return res
                .status(status)
                .json({ error: status === 404 ? "File not found" : "Download failed on the node" });
        }

        if (upstream.headers["content-disposition"]) {
            res.setHeader("Content-Disposition", upstream.headers["content-disposition"]);
        }
        if (upstream.headers["content-type"]) {
            res.setHeader("Content-Type", upstream.headers["content-type"]);
        }
        upstream.data.pipe(res);
        upstream.data.on("error", () => res.end());
        req.on("close", () => upstream.data.destroy());
    } catch (err) {
        console.error(`[FS] Download error: ${err.message}`);
        next(err);
    }
});

/**
 * GET /api/bots/:id/fs/list?path=...
 * Lists directories and files for a given path relative to the project folder.
 */
router.get("/:id/fs/list", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        res.json(await executor.fsList(bot, req.query.path));
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/bots/:id/fs/read?path=...
 * Returns the contents of a specific file. Max 10MB (enforced by the agent).
 */
router.get("/:id/fs/read", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        res.json(await executor.fsRead(bot, req.query.path, req.query.binary === "true"));
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/bots/:id/fs/write
 * Writes updated content to a specific file.
 * Body: { path: string, content: string, binary?: boolean }
 */
router.put("/:id/fs/write", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { path: reqPath, content, binary } = req.body;
        if (content === undefined || !reqPath) {
            return res.status(400).json({ error: "path and content are required" });
        }

        // Binary by explicit flag or by a known non-text extension — the client
        // sends base64 in both cases.
        const isBinaryFile =
            binary === true || /\.(db|sqlite|sqlite3|wasm|bin|exe|dll|so|dylib)$/i.test(reqPath);

        await executor.fsWrite(bot, reqPath, content, isBinaryFile);
        res.json({ message: "File saved successfully" });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/bots/:id/fs/create
 * Creates a file or directory.
 * Body: { path: string, type: 'file' | 'dir' }
 */
router.post("/:id/fs/create", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { path: reqPath, type } = req.body;
        if (!reqPath || !type) {
            return res.status(400).json({ error: "path and type are required" });
        }

        await executor.fsCreate(bot, reqPath, type === "dir");
        res.json({ message: `${type === "dir" ? "Directory" : "File"} created successfully` });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/bots/:id/fs/delete
 * Deletes a file or directory inside the project.
 * Body: { path: string }
 */
router.delete("/:id/fs/delete", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { path: reqPath } = req.body;
        if (!reqPath) return res.status(400).json({ error: "path is required" });
        // executor.fsDelete(bot, "") wipes the whole project — that belongs to
        // DELETE /api/bots/:id, never to the file manager.
        if (isProjectRoot(reqPath)) {
            return res.status(400).json({ error: "Cannot delete the root directory" });
        }

        await executor.fsDelete(bot, reqPath);
        res.json({ message: "Deleted successfully" });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/bots/:id/fs/rename
 * Renames a file or directory.
 * Body: { oldPath: string, newPath: string }
 */
router.put("/:id/fs/rename", requireOwnership, async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { oldPath, newPath } = req.body;
        if (!oldPath || !newPath) {
            return res.status(400).json({ error: "oldPath and newPath are required" });
        }
        if (isProjectRoot(oldPath) || isProjectRoot(newPath)) {
            return res.status(400).json({ error: "Cannot rename the root directory" });
        }

        await executor.fsRename(bot, oldPath, newPath);
        res.json({ message: "Renamed successfully" });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/bots/:id/fs/upload
 * Uploads a file to the specified directory.
 * Form Data: path (string), file (File)
 */
router.post("/:id/fs/upload", requireOwnership, upload.single("file"), async (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        await executor.fsUpload(bot, req.body.path || "", req.file.buffer, req.file.originalname);
        res.json({ message: "File uploaded successfully", file: req.file.originalname });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
