const express = require("express");
const router = express.Router();
const path = require("path");
const db = require("../db");
const pm2Service = require("../services/pm2Service");

// ─────────────────────────────────────────────────────────────────────────────
//  Proxy Config
// ─────────────────────────────────────────────────────────────────────────────

const PROXY_KEY = "proxy_config";
const VALID_PROXY_TYPES = new Set(["socks5", "socks4", "http"]);
const BOTS_ROOT = () => process.env.BOTS_ROOT_DIR;

/**
 * Default proxy config shape.
 */
const defaultConfig = () => ({
    enabled: false,
    type: "socks5",
    host: "",
    port: 1080,
    username: null,
    password: null,
});

const normalizeConfig = (config) => ({
    enabled: Boolean(config.enabled),
    type: VALID_PROXY_TYPES.has(config.type) ? config.type : "socks5",
    host: String(config.host || "").trim(),
    port: Number(config.port) || 1080,
    username: config.username ? String(config.username) : null,
    password: config.password ? String(config.password) : null,
});

const validateConfig = (config) => {
    if (!VALID_PROXY_TYPES.has(config.type)) {
        return "type must be one of: socks5, socks4, http";
    }
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
        return "port must be a number between 1 and 65535";
    }
    if (config.enabled && !config.host) {
        return "host is required before enabling global proxy";
    }
    return null;
};

const botDir = (bot) => {
    if (bot.source === "local" && bot.localPath) return bot.localPath;
    return path.join(BOTS_ROOT(), bot.buyerID, bot.botID);
};

const getProxyConf = async (bot, config = null) => {
    if (!bot.proxyEnabled) return null;
    const globalConf = config || (await db.get(PROXY_KEY));
    if (!globalConf || !globalConf.enabled || !globalConf.host || !globalConf.port) return null;
    return normalizeConfig(globalConf);
};

const refreshRunningBot = async (bot, config = null) => {
    const live = await pm2Service.getBotStatus(bot.pm2Name);
    if (live.status !== "online") return false;

    const proxyConf = await getProxyConf(bot, config);
    await pm2Service.startBot(
        bot.pm2Name,
        botDir(bot),
        bot.startScript,
        bot.maxMemory || null,
        proxyConf,
    );
    return true;
};

const refreshRunningBots = async (bots, config = null) => {
    let refreshed = 0;
    const errors = [];

    for (const bot of bots) {
        try {
            if (await refreshRunningBot(bot, config)) refreshed += 1;
        } catch (err) {
            errors.push({ botId: bot._id, name: bot.name, error: err.message });
            console.warn(`[Proxy] Failed to refresh "${bot.name}" after proxy change: ${err.message}`);
        }
    }

    return { refreshed, errors };
};

/**
 * GET /api/proxy/config
 * Returns the global proxy configuration.
 */
router.get("/config", async (req, res, next) => {
    try {
        const config = normalizeConfig((await db.get(PROXY_KEY)) || defaultConfig());
        res.json(config);
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/proxy/config
 * Update the global proxy configuration.
 *
 * Body: { enabled?, type?, host?, port?, username?, password? }
 */
router.put("/config", async (req, res, next) => {
    try {
        const previousConfig = normalizeConfig((await db.get(PROXY_KEY)) || defaultConfig());
        const current = { ...previousConfig };

        const { enabled, type, host, port, username, password } = req.body;

        if (enabled !== undefined) current.enabled = Boolean(enabled);
        if (type !== undefined) current.type = type;
        if (host !== undefined) current.host = String(host).trim();
        if (port !== undefined) current.port = Number(port);
        if (username !== undefined) current.username = username || null;
        if (password !== undefined) current.password = password || null;

        const nextConfig = normalizeConfig(current);
        const validationError = validateConfig(nextConfig);
        if (validationError) return res.status(400).json({ error: validationError });

        await db.set(PROXY_KEY, nextConfig);

        const proxiedBots = previousConfig.enabled || nextConfig.enabled
            ? await db.find("bots", { proxyEnabled: true })
            : [];
        const apply = proxiedBots.length > 0
            ? await refreshRunningBots(proxiedBots, nextConfig)
            : { refreshed: 0, errors: [] };

        console.log(`[Proxy] Config updated — enabled=${nextConfig.enabled} host=${nextConfig.host}:${nextConfig.port}`);
        res.json({ ...nextConfig, apply });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Per-Bot Proxy Toggle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/proxy/bots
 * Returns all bots with their proxyEnabled flag.
 */
router.get("/bots", async (req, res, next) => {
    try {
        const bots = await db.find("bots");
        const groups = await db.find("groups");

        // Build a groupId → group map for enrichment
        const groupMap = Object.fromEntries(groups.map((g) => [g._id, g]));

        res.json(
            bots.map(({ _id, name, buyerID, botID, pm2Name, proxyEnabled, groupId }) => ({
                _id,
                name,
                buyerID,
                botID,
                pm2Name,
                proxyEnabled: Boolean(proxyEnabled),
                groupId: groupId || null,
                group: groupId ? (groupMap[groupId] || null) : null,
            }))
        );
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/proxy/bots/bulk
 * Bulk enable or disable proxy for multiple bots.
 * IMPORTANT: must be defined BEFORE /bots/:id to avoid Express matching "bulk" as an id.
 *
 * Body: { ids: string[], proxyEnabled: boolean }
 */
router.put("/bots/bulk", async (req, res, next) => {
    try {
        const { ids, proxyEnabled } = req.body;
        if (!Array.isArray(ids) || proxyEnabled === undefined)
            return res.status(400).json({ error: "ids (array) and proxyEnabled are required" });

        const uniqueIds = [...new Set(ids)];
        const result = await db.updateMany("bots", { _id: uniqueIds }, { proxyEnabled: Boolean(proxyEnabled) });
        const apply = await refreshRunningBots(result.records);

        console.log(`[Proxy] Bulk proxy=${proxyEnabled} for ${uniqueIds.length} bots`);
        res.json({ updated: result.count, apply });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/proxy/bots/:id
 * Enable or disable proxy for a specific bot.
 *
 * Body: { proxyEnabled: boolean }
 */
router.put("/bots/:id", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { proxyEnabled } = req.body;
        if (proxyEnabled === undefined)
            return res.status(400).json({ error: "proxyEnabled is required" });

        const updated = await db.findOneAndUpdate(
            "bots",
            { _id: req.params.id },
            { proxyEnabled: Boolean(proxyEnabled) }
        );
        const apply = await refreshRunningBots([updated]);

        console.log(`[Proxy] Bot "${bot.name}" proxy=${proxyEnabled}`);
        res.json({ _id: updated._id, name: updated.name, proxyEnabled: updated.proxyEnabled, apply });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
