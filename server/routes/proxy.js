const express = require("express");
const router = express.Router();
const db = require("../db");

// ─────────────────────────────────────────────────────────────────────────────
//  Proxy Config
// ─────────────────────────────────────────────────────────────────────────────

const PROXY_KEY = "proxy_config";

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

/**
 * GET /api/proxy/config
 * Returns the global proxy configuration.
 */
router.get("/config", async (req, res, next) => {
    try {
        const config = (await db.get(PROXY_KEY)) || defaultConfig();
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
        const current = (await db.get(PROXY_KEY)) || defaultConfig();

        const { enabled, type, host, port, username, password } = req.body;

        if (enabled !== undefined) current.enabled = Boolean(enabled);
        if (type !== undefined) current.type = type;
        if (host !== undefined) current.host = host;
        if (port !== undefined) current.port = Number(port);
        if (username !== undefined) current.username = username || null;
        if (password !== undefined) current.password = password || null;

        await db.set(PROXY_KEY, current);
        console.log(`[Proxy] Config updated — enabled=${current.enabled} host=${current.host}:${current.port}`);
        res.json(current);
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
        res.json(
            bots.map(({ _id, name, buyerID, botID, pm2Name, proxyEnabled }) => ({
                _id,
                name,
                buyerID,
                botID,
                pm2Name,
                proxyEnabled: Boolean(proxyEnabled),
            }))
        );
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

        console.log(`[Proxy] Bot "${bot.name}" proxy=${proxyEnabled}`);
        res.json({ _id: updated._id, name: updated.name, proxyEnabled: updated.proxyEnabled });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/proxy/bots/bulk
 * Bulk enable or disable proxy for multiple bots.
 *
 * Body: { ids: string[], proxyEnabled: boolean }
 */
router.put("/bots/bulk", async (req, res, next) => {
    try {
        const { ids, proxyEnabled } = req.body;
        if (!Array.isArray(ids) || proxyEnabled === undefined)
            return res.status(400).json({ error: "ids (array) and proxyEnabled are required" });

        const results = await Promise.all(
            ids.map((id) =>
                db.findOneAndUpdate("bots", { _id: id }, { proxyEnabled: Boolean(proxyEnabled) })
            )
        );

        console.log(`[Proxy] Bulk proxy=${proxyEnabled} for ${ids.length} bots`);
        res.json({ updated: results.filter(Boolean).length });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
