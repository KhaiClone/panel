const express = require("express");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const router = express.Router();

const db = require("../db");
const pm2Service = require("../services/pm2Service");
const gitService = require("../services/gitService");
const nginxService = require("../services/nginxService");
const ufwService = require("../services/ufwService");
const { createNotification } = require("./notifications");

// Root directory where all buyer bot folders live (e.g. /root/bots)
const BOTS_ROOT = () => process.env.BOTS_ROOT_DIR;

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
 * Resolve the distFolder (relative or absolute) to an absolute path.
 * If already absolute, returns as-is. Otherwise resolves relative to botDir.
 */
const resolveDistFolder = (bot, distFolder) => {
    if (path.isAbsolute(distFolder)) return distFolder;
    return path.join(botDir(bot), distFolder);
};

/**
 * Assign a port for a website project.
 * Uses the user-supplied port or auto-assigns a free one.
 * @returns {Promise<number>}
 */
const assignPort = async (requestedPort) => {
    if (requestedPort) {
        const port = parseInt(requestedPort, 10);
        if (isNaN(port) || port < 1 || port > 65535)
            throw new Error("Invalid port number");
        return port;
    }
    return ufwService.findFreePort(3000, 9000);
};

/**
 * Apply nginx config + UFW for a website project.
 * @param {Object} bot  - Full bot record (must have pm2Name, websiteConfig)
 * @param {string} dir  - Absolute botDir
 */
const applyWebsiteInfra = async (bot, dir) => {
    const wc = bot.websiteConfig;
    const distAbs = resolveDistFolder({ ...bot, source: bot.source, localPath: bot.localPath }, wc.distFolder);
    await nginxService.writeConfig(bot.pm2Name, {
        mode: wc.mode,
        port: wc.port,
        apiPort: wc.apiPort || null,
        distFolder: distAbs,
        domain: wc.domain || null,
    });
    await ufwService.openPort(wc.port);
};

/**
 * Get live status for any project type.
 * - discord / fullstack website → PM2 status
 * - static website → nginx config existence
 */
const getLiveStatus = async (bot, pm2List) => {
    if (bot.projectType === "website" && bot.websiteConfig?.mode === "static") {
        const online = nginxService.configExists(bot.pm2Name);
        return { status: online ? "online" : "stopped", cpu: 0, memory: 0, restarts: 0, uptime: null };
    }
    return pm2Service.getBotStatus(bot.pm2Name, pm2List);
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

/**
 * Resolve the working directory of a bot.
 * - source === "local"  → use the stored localPath directly
 * - source === "git"    → construct from BOTS_ROOT/buyerID/botID (default)
 */
const botDir = (bot) => {
    if (bot.source === "local" && bot.localPath) return bot.localPath;
    return path.join(BOTS_ROOT(), bot.buyerID, bot.botID);
};

// ─────────────────────────────────────────────────────────────────────────────
//  List & Read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/bots/domains
 * Returns all website projects that have a custom domain configured.
 */
router.get("/domains", async (req, res, next) => {
    try {
        const bots = await db.find("bots");
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
        const bots = await db.find("bots");
        const pm2List = await pm2Service.getProcessList();

        const enriched = await Promise.all(
            bots.map(async (bot) => {
                const live = await getLiveStatus(bot, pm2List);
                return { ...bot, live };
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
router.get("/:id", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const pm2List = await pm2Service.getProcessList();
        const live = await getLiveStatus(bot, pm2List);
        res.json({ ...bot, live });
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
router.post("/", async (req, res, next) => {
    try {
        const {
            buyerID,
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

        // Validate required fields
        if (!buyerID || !botID || !name || !repoUrl) {
            return res.status(400).json({
                error: "buyerID, botID, name, and repoUrl are required",
            });
        }
        if (projectType === "website") {
            if (!rawWebsiteConfig?.distFolder)
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

        const dir = path.join(BOTS_ROOT(), buyerID, botID);

        // Ensure buyer directory exists
        fs.mkdirSync(path.join(BOTS_ROOT(), buyerID), { recursive: true });

        // 1. Clone repository
        console.log(`[Bots] Cloning ${repoUrl} → ${dir}`);
        await gitService.cloneRepo(repoUrl, dir, branch);

        // 2. Install dependencies
        console.log(`[Bots] Installing deps for ${botID}`);
        await gitService.installDeps(dir, installCommand);

        // 3. Build step (website only)
        let websiteConfig = null;
        let serviceConfig = null;
        if (projectType === "website") {
            if (rawWebsiteConfig.buildCommand) {
                console.log(`[Bots] Running build command for ${botID}`);
                await execAsync(rawWebsiteConfig.buildCommand, { cwd: dir, timeout: 300_000 });
            }
            const port = await assignPort(rawWebsiteConfig.port);
            websiteConfig = {
                mode: rawWebsiteConfig.mode || "static",
                port,
                apiPort: rawWebsiteConfig.apiPort ? parseInt(rawWebsiteConfig.apiPort, 10) : null,
                buildCommand: rawWebsiteConfig.buildCommand || null,
                distFolder: rawWebsiteConfig.distFolder,
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
            groupId,
            maxMemory,
            currentPrice,
            tags: Array.isArray(tags) ? tags : [],
            expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
            projectType,
            websiteConfig,
            serviceConfig,
            createdAt: Date.now(),
        });

        // 5. Post-creation infra
        if (projectType === "website") {
            await applyWebsiteInfra(botRecord, dir);
            console.log(`[Bots] Website infra applied for "${name}" on port ${websiteConfig.port}`);
        } else if (projectType === "service" && serviceConfig?.port) {
            await ufwService.openPort(serviceConfig.port);
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
router.post("/import-local", async (req, res, next) => {
    try {
        const {
            buyerID,
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

        if (!buyerID || !botID || !name || !localPath) {
            return res.status(400).json({
                error: "buyerID, botID, name, and localPath are required",
            });
        }
        if (projectType === "website") {
            if (!rawWebsiteConfig?.distFolder)
                return res.status(400).json({ error: "websiteConfig.distFolder is required for websites" });
            if (rawWebsiteConfig.mode === "fullstack" && !rawWebsiteConfig.apiPort)
                return res.status(400).json({ error: "websiteConfig.apiPort is required for fullstack websites" });
        }
        if (projectType === "service" && rawServiceConfig?.port) {
            const p = parseInt(rawServiceConfig.port, 10);
            if (isNaN(p) || p < 1 || p > 65535)
                return res.status(400).json({ error: "Invalid serviceConfig.port" });
        }

        // Validate the path exists on disk
        if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) {
            return res.status(400).json({
                error: `Path "${localPath}" does not exist or is not a directory`,
            });
        }

        // Prevent duplicate botID under same buyer
        const existing = await db.findOne("bots", { buyerID, botID });
        if (existing) {
            return res.status(409).json({
                error: `Bot "${botID}" already exists for buyer "${buyerID}"`,
            });
        }

        // Run install command if provided (skip if explicitly empty/null)
        if (installCommand !== null && installCommand !== "") {
            console.log(`[Bots] Installing deps for local bot ${botID}`);
            await gitService.installDeps(localPath, installCommand);
        }

        // Build step (website only)
        let websiteConfig = null;
        if (projectType === "website") {
            if (rawWebsiteConfig.buildCommand) {
                await execAsync(rawWebsiteConfig.buildCommand, { cwd: localPath, timeout: 300_000 });
            }
            const port = await assignPort(rawWebsiteConfig.port);
            websiteConfig = {
                mode: rawWebsiteConfig.mode || "static",
                port,
                apiPort: rawWebsiteConfig.apiPort ? parseInt(rawWebsiteConfig.apiPort, 10) : null,
                buildCommand: rawWebsiteConfig.buildCommand || null,
                distFolder: rawWebsiteConfig.distFolder,
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
        let repoUrl = null;
        let branch = null;
        try {
            const { stdout: remoteOut } = await execAsync(`git -C "${localPath}" remote get-url origin`);
            repoUrl = remoteOut.trim();
            const { stdout: branchOut } = await execAsync(`git -C "${localPath}" rev-parse --abbrev-ref HEAD`);
            branch = branchOut.trim();
        } catch {
            // Not a git repo — that's fine
        }

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
            groupId,
            maxMemory,
            currentPrice,
            tags: Array.isArray(tags) ? tags : [],
            expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
            projectType,
            websiteConfig,
            serviceConfig,
            createdAt: Date.now(),
        });

        if (projectType === "website") {
            await applyWebsiteInfra(botRecord, localPath);
        }
        if (projectType === "service" && serviceConfig?.port) {
            await ufwService.openPort(serviceConfig.port);
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
router.put("/:id", async (req, res, next) => {
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
            updates.expiresAt = expiresAt
                ? new Date(expiresAt).getTime()
                : null;
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
            const live = await pm2Service.getBotStatus(bot.pm2Name);
            if (live.status === "online") {
                await pm2Service.setMemoryLimit(bot.pm2Name, maxMemory || null);
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
router.delete("/:id", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        // Stop & unregister from PM2
        await pm2Service.deleteBot(bot.pm2Name);

        // Project-type cleanup
        if (bot.projectType === "website" && bot.websiteConfig) {
            await nginxService.removeConfig(bot.pm2Name);
            await ufwService.closePort(bot.websiteConfig.port);
        } else if (bot.projectType === "service" && bot.serviceConfig?.port) {
            await ufwService.closePort(bot.serviceConfig.port);
        }

        // Only delete source files for git-managed bots
        if (bot.source !== "local") {
            const dir = botDir(bot);
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
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
//  Process Control
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/bots/:id/start */
router.post("/:id/start", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        if (bot.expiresAt && bot.expiresAt <= Date.now()) {
            return res.status(403).json({ error: "Bot is expired. Please extend to start." });
        }

        const dir = botDir(bot);

        // Static website: rebuild + re-apply nginx config (no PM2)
        if (bot.projectType === "website" && bot.websiteConfig?.mode === "static") {
            const wc = bot.websiteConfig;
            if (wc.buildCommand) {
                await execAsync(wc.buildCommand, { cwd: dir, timeout: 300_000 });
            }
            await applyWebsiteInfra(bot, dir);
            await createNotification(`Website "${bot.name}" was started.`, "start");
            return res.json({ message: "Website started", output: "nginx config applied" });
        }

        // Discord bot or fullstack website: use PM2
        const proxyConf = await getProxyConf(bot);
        const output = await pm2Service.startBot(
            bot.pm2Name,
            dir,
            bot.startScript,
            bot.maxMemory || null,
            proxyConf,
        );
        await createNotification(`Bot "${bot.name}" was started.`, "start");
        res.json({ message: "Bot started", output });
    } catch (err) {
        next(err);
    }
});

/** POST /api/bots/:id/stop */
router.post("/:id/stop", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        // Static website: remove nginx config (no PM2 to stop)
        if (bot.projectType === "website" && bot.websiteConfig?.mode === "static") {
            await nginxService.removeConfig(bot.pm2Name);
            await createNotification(`Website "${bot.name}" was stopped.`, "stop");
            return res.json({ message: "Website stopped", output: "nginx config removed" });
        }

        const output = await pm2Service.stopBot(bot.pm2Name);
        await createNotification(`Bot "${bot.name}" was stopped.`, "stop");
        res.json({ message: "Bot stopped", output });
    } catch (err) {
        next(err);
    }
});

/** POST /api/bots/:id/domain — set custom domain + issue SSL */
router.post("/:id/domain", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });
        if (bot.projectType !== "website") return res.status(400).json({ error: "Only website projects support custom domains" });

        const { domain, email } = req.body;
        if (!domain) return res.status(400).json({ error: "domain is required" });

        const dir = botDir(bot);
        const wc = bot.websiteConfig;

        // Regenerate nginx config with new domain
        const distAbs = resolveDistFolder(bot, wc.distFolder);
        await nginxService.writeConfig(bot.pm2Name, {
            mode: wc.mode,
            port: wc.port,
            apiPort: wc.apiPort || null,
            distFolder: distAbs,
            domain,
        });

        // Issue SSL via certbot
        await nginxService.enableSSL(domain, email || null);

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
router.post("/:id/restart", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        if (bot.expiresAt && bot.expiresAt <= Date.now()) {
            return res.status(403).json({ error: "Bot is expired. Please extend to start." });
        }

        // Auto-stop if the bot has been restarted too many times in a short window.
        if (shouldAutoStop(req.params.id)) {
            restartTimestamps.delete(req.params.id); // reset counter after stopping
            await pm2Service.stopBot(bot.pm2Name);
            await createNotification(
                `Bot "${bot.name}" was auto-stopped after ${RESTART_MAX} restarts within ${RESTART_WINDOW_MS / 1000}s.`,
                "restart",
            );
            return res.status(429).json({
                error: `Bot auto-stopped: restarted ${RESTART_MAX}+ times within ${RESTART_WINDOW_MS / 1000}s to prevent a restart loop.`,
            });
        }

        const dir = botDir(bot);

        // Static website: rebuild + re-apply nginx (no PM2 restart)
        if (bot.projectType === "website" && bot.websiteConfig?.mode === "static") {
            const wc = bot.websiteConfig;
            if (wc.buildCommand) {
                await execAsync(wc.buildCommand, { cwd: dir, timeout: 300_000 });
            }
            await applyWebsiteInfra(bot, dir);
            await createNotification(`Website "${bot.name}" was restarted (rebuilt).`, "restart");
            return res.json({ message: "Website rebuilt and restarted" });
        }

        // Use startBot (which deletes + re-registers) so the wrapper script
        // is always regenerated with the current proxy settings.
        const proxyConf = await getProxyConf(bot);
        const output = await pm2Service.startBot(
            bot.pm2Name,
            dir,
            bot.startScript,
            bot.maxMemory || null,
            proxyConf,
        );
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
router.post("/:id/update", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        if (bot.expiresAt && bot.expiresAt <= Date.now()) {
            return res.status(403).json({ error: "Bot is expired. Please extend to start." });
        }

        const dir = botDir(bot);
        let pullOutput = "(skipped — no git remote)";

        // Attempt git pull
        try {
            pullOutput = await gitService.pullRepo(dir);
        } catch (err) {
            pullOutput = `(pull failed or skipped: ${err.message || 'unknown error'})`;
        }

        await gitService.installDeps(dir, bot.installCommand);

        // Use startBot so wrapper script is refreshed with current proxy settings
        const proxyConf = await getProxyConf(bot);
        const restartOutput = await pm2Service.startBot(
            bot.pm2Name,
            dir,
            bot.startScript,
            bot.maxMemory || null,
            proxyConf,
        );

        await createNotification(`Bot "${bot.name}" was updated / reinstalled.`, "reinstall");
        console.log(`[Bots] Updated bot "${bot.name}"`);
        res.json({
            message: "Bot updated and restarted",
            pullOutput,
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
router.get("/:id/env", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const envPath = path.join(botDir(bot), ".env");
        const content = fs.existsSync(envPath)
            ? fs.readFileSync(envPath, "utf8")
            : "";
        res.json({ content });
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
router.put("/:id/env", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { content } = req.body;
        if (content === undefined)
            return res.status(400).json({ error: "content is required" });

        const envPath = path.join(botDir(bot), ".env");
        fs.writeFileSync(envPath, content, "utf8");

        res.json({ message: ".env saved successfully" });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  File Manager
// ─────────────────────────────────────────────────────────────────────────────

const resolveSafePath = (baseDir, reqPath) => {
    // Normalize requested path to remove ../ etc.
    const target = path.normalize(path.join(baseDir, reqPath || ""));
    // Ensure the target is still inside baseDir
    if (!target.startsWith(path.normalize(baseDir))) {
        throw new Error("Invalid path");
    }
    return target;
};

/**
 * GET /api/bots/:id/fs/download?path=...
 * Downloads a specific file.
 */
router.get("/:id/fs/download", async (req, res, next) => {
    try {
        console.log(`[FS] Incoming download: id=${req.params.id} path=${req.query.path}`);
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) {
            console.error(`[FS] Bot not found: ${req.params.id}`);
            return res.status(404).json({ error: "Bot not found" });
        }

        const baseDir = botDir(bot);
        let targetFile;
        try {
            targetFile = resolveSafePath(baseDir, req.query.path);
        } catch (e) {
            console.error(`[FS] Path resolution failed: ${e.message}`);
            return res.status(400).json({ error: "Invalid path" });
        }

        console.log(`[FS] Verified download: bot=${bot.name} target=${targetFile}`);

        if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
            console.error(`[FS] File on disk not found: ${targetFile}`);
            return res.status(404).json({ error: "File not found" });
        }

        const fileName = path.basename(targetFile);
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.sendFile(path.resolve(targetFile), { dotfiles: 'allow' }, (err) => {
            if (err) {
                console.error(`[FS] sendFile error: ${err.message}`);
                if (!res.headersSent) {
                    next(err);
                }
            }
        });
    } catch (err) {
        console.error(`[FS] Download error: ${err.message}`);
        next(err);
    }
});

/**
 * GET /api/bots/:id/fs/list?path=...
 * Lists directories and files for a given path relative to the bot's root folder.
 */
router.get("/:id/fs/list", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const baseDir = botDir(bot);
        if (!fs.existsSync(baseDir)) return res.json({ files: [] });

        let targetDir;
        try {
            targetDir = resolveSafePath(baseDir, req.query.path);
        } catch (e) {
            return res.status(400).json({ error: "Invalid path" });
        }

        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
            return res.status(400).json({ error: "Directory not found" });
        }

        const items = fs.readdirSync(targetDir).map(name => {
            const fullPath = path.join(targetDir, name);
            const stat = fs.statSync(fullPath);
            return {
                name,
                isDir: stat.isDirectory(),
                size: stat.size,
                mtime: stat.mtimeMs
            };
        });

        // Sort directories first, then alphabetically
        items.sort((a, b) => {
            if (a.isDir && !b.isDir) return -1;
            if (!a.isDir && b.isDir) return 1;
            return a.name.localeCompare(b.name);
        });

        res.json({ files: items });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/bots/:id/fs/read?path=...
 * Returns the contents of a specific file. Max 1MB.
 */
router.get("/:id/fs/read", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const baseDir = botDir(bot);
        let targetFile;
        try {
            targetFile = resolveSafePath(baseDir, req.query.path);
        } catch (e) {
            return res.status(400).json({ error: "Invalid path" });
        }

        if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
            return res.status(404).json({ error: "File not found" });
        }

        const stat = fs.statSync(targetFile);
        if (stat.size > 1024 * 1024 * 10) {
            return res.status(400).json({ error: "File too large to edit (max 10MB)" });
        }

        const isBinary = req.query.binary === 'true';
        let content;

        if (isBinary) {
            // Read as buffer and convert to base64 for binary files
            const buffer = fs.readFileSync(targetFile);
            content = buffer.toString('base64');
        } else {
            // Read as UTF-8 for text files
            content = fs.readFileSync(targetFile, "utf8");
        }

        res.json({ content });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/bots/:id/fs/download?path=...
 * Downloads a specific file.
 */


/**
 * PUT /api/bots/:id/fs/write
 * Writes updated content to a specific file.
 * Body: { path: string, content: string }
 */
router.put("/:id/fs/write", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { path: reqPath, content, binary } = req.body;
        if (content === undefined || !reqPath) {
            return res.status(400).json({ error: "path and content are required" });
        }

        const baseDir = botDir(bot);
        let targetFile;
        try {
            targetFile = resolveSafePath(baseDir, reqPath);
        } catch (e) {
            return res.status(400).json({ error: "Invalid path" });
        }

        // Check if this is a binary file based on extension or explicit binary flag
        const isBinaryFile = binary === true || /\.(db|sqlite|sqlite3|wasm|bin|exe|dll|so|dylib)$/i.test(reqPath);

        if (isBinaryFile && typeof content === 'string') {
            // Convert base64 back to buffer for binary files
            const buffer = Buffer.from(content, 'base64');
            fs.writeFileSync(targetFile, buffer);
        } else {
            // Write as UTF-8 for text files
            fs.writeFileSync(targetFile, content, "utf8");
        }

        res.json({ message: "File saved successfully" });
    } catch (err) {
        next(err);
    }
});

const multer = require("multer");

const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        try {
            const bot = await db.findOne("bots", { _id: req.params.id });
            if (!bot) return cb(new Error("Bot not found"));
            
            const baseDir = botDir(bot);
            const targetDir = resolveSafePath(baseDir, req.body.path || "");
            
            if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
                return cb(new Error("Directory not found"));
            }
            cb(null, targetDir);
        } catch (e) {
            cb(e);
        }
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage });

/**
 * POST /api/bots/:id/fs/create
 * Creates a file or directory.
 * Body: { path: string, type: 'file' | 'dir' }
 */
router.post("/:id/fs/create", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { path: reqPath, type } = req.body;
        if (!reqPath || !type) {
            return res.status(400).json({ error: "path and type are required" });
        }

        const baseDir = botDir(bot);
        let targetPath;
        try {
            targetPath = resolveSafePath(baseDir, reqPath);
        } catch (e) {
            return res.status(400).json({ error: "Invalid path" });
        }

        if (fs.existsSync(targetPath)) {
            return res.status(400).json({ error: "Path already exists" });
        }

        if (type === "dir") {
            fs.mkdirSync(targetPath, { recursive: true });
        } else {
            fs.writeFileSync(targetPath, "", "utf8");
        }

        res.json({ message: `${type === 'dir' ? 'Directory' : 'File'} created successfully` });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/bots/:id/fs/delete
 * Deletes a file or directory.
 * Body: { path: string }
 */
router.delete("/:id/fs/delete", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { path: reqPath } = req.body;
        if (!reqPath) {
            return res.status(400).json({ error: "path is required" });
        }

        const baseDir = botDir(bot);
        let targetPath;
        try {
            targetPath = resolveSafePath(baseDir, reqPath);
        } catch (e) {
            return res.status(400).json({ error: "Invalid path" });
        }

        if (!fs.existsSync(targetPath)) {
            return res.status(404).json({ error: "Path not found" });
        }

        if (targetPath === baseDir || targetPath === path.normalize(baseDir)) {
            return res.status(400).json({ error: "Cannot delete the root directory" });
        }

        fs.rmSync(targetPath, { recursive: true, force: true });
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
router.put("/:id/fs/rename", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { oldPath, newPath } = req.body;
        if (!oldPath || !newPath) {
            return res.status(400).json({ error: "oldPath and newPath are required" });
        }

        const baseDir = botDir(bot);
        let targetOldPath, targetNewPath;
        try {
            targetOldPath = resolveSafePath(baseDir, oldPath);
            targetNewPath = resolveSafePath(baseDir, newPath);
        } catch (e) {
            return res.status(400).json({ error: "Invalid path" });
        }

        if (!fs.existsSync(targetOldPath)) {
            return res.status(404).json({ error: "Original path not found" });
        }

        if (fs.existsSync(targetNewPath)) {
            return res.status(400).json({ error: "Destination path already exists" });
        }

        if (targetOldPath === baseDir || targetOldPath === path.normalize(baseDir)) {
            return res.status(400).json({ error: "Cannot rename the root directory" });
        }

        fs.renameSync(targetOldPath, targetNewPath);
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
router.post("/:id/fs/upload", upload.single("file"), async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded" });
        }
        res.json({ message: "File uploaded successfully", file: req.file.originalname });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
