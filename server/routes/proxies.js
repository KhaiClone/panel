const express = require("express");
const router = express.Router();
const proxyStore = require("../services/proxyStore");
const proxyPool = require("../services/proxyPool");

// Mounted behind authMiddleware (see index.js).
//
// The proxies YOU supply to the panel, plus the per-feature switches that decide
// whether a feature draws from them, from the agent VPSes, or both.
//
// NOTE the neighbouring /api/proxy (singular, routes/proxy.js) is a different
// thing: it pins a BOT's public IP to a VPS via proxychains. This one is the pool
// the panel itself egresses through — Auto Quest today, more features later.

// ── Settings (declared before /:id so "settings" is not read as an id) ───────────

/** GET /api/proxies/settings/:feature — switches + what the pool looks like now */
router.get("/settings/:feature", async (req, res, next) => {
    try {
        res.json(await proxyPool.describePool(req.params.feature));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** PATCH /api/proxies/settings/:feature { useNodes, useCustomProxies, priority } */
router.patch("/settings/:feature", async (req, res, next) => {
    try {
        await proxyPool.updateSettings(req.params.feature, req.body || {});
        res.json(await proxyPool.describePool(req.params.feature));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

// ── CRUD ─────────────────────────────────────────────────────────────────────────

/** GET /api/proxies — every registered proxy (credentials masked) */
router.get("/", async (req, res, next) => {
    try {
        res.json({
            proxies: await proxyStore.list(),
            protocols: proxyStore.PROTOCOLS,
            uses: proxyStore.KNOWN_USES,
        });
    } catch (err) {
        next(err);
    }
});

/** POST /api/proxies — add one proxy */
router.post("/", async (req, res, next) => {
    try {
        res.status(201).json(await proxyStore.create(req.body || {}));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/**
 * POST /api/proxies/bulk { text, defaults }
 * Paste a list; per-line failures come back in `errors` instead of failing the lot.
 */
router.post("/bulk", async (req, res, next) => {
    try {
        const { text, defaults } = req.body || {};
        if (!text) return res.status(400).json({ error: "Chưa có dòng proxy nào." });
        res.status(201).json(await proxyStore.bulkCreate(text, defaults || {}));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** PATCH /api/proxies/:id — omit `password` to keep the stored one */
router.patch("/:id", async (req, res, next) => {
    try {
        res.json(await proxyStore.update(req.params.id, req.body || {}));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** DELETE /api/proxies/:id */
router.delete("/:id", async (req, res, next) => {
    try {
        await proxyStore.remove(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** POST /api/proxies/:id/test — what IP does this proxy egress from? */
router.post("/:id/test", async (req, res, next) => {
    try {
        res.json(await proxyStore.test(req.params.id));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/**
 * POST /api/proxies/:id/rotate — fetch the provider's rotate link now.
 * Refused while a run holds the proxy: changing the IP mid-run is the one thing
 * that can break an in-flight quest (see proxyPool's header).
 */
router.post("/:id/rotate", async (req, res, next) => {
    try {
        if (proxyPool.isBusy(req.params.id))
            return res
                .status(409)
                .json({ error: "Proxy đang được một lượt chạy sử dụng — thử lại khi xong." });
        res.json(await proxyStore.rotate(req.params.id, { force: true, reason: "manual" }));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

module.exports = router;
