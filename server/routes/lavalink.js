const express = require("express");
const router = express.Router();

const db = require("../db");
const store = require("../services/lavalinkStore");
const lavalink = require("../services/lavalinkService");
const updater = require("../services/lavalinkUpdater");
const { renderYaml, sha256 } = require("../services/lavalinkConfig");

// Mounted behind authMiddleware (see index.js). The panel has one account, so a
// valid token is full access — same as every other route here.

const withNode = (handler) => async (req, res, next) => {
    try {
        const node = await db.findOne("nodes", { _id: req.params.id });
        if (!node) return res.status(404).json({ error: "Node not found" });
        await handler(node, req, res);
    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/lavalink
 * Settings + what we know about the latest release. The release lookup is
 * best-effort: GitHub being unreachable must not blank out the page.
 */
router.get("/", async (req, res, next) => {
    try {
        const settings = await store.get();
        let release = null;
        try {
            release = await lavalink.latestRelease();
        } catch (err) {
            release = { error: err.message };
        }
        res.json({ settings, release, schedule: updater.SCHEDULE });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/lavalink/settings   body: { ...patch, sync?: boolean }
 * `sync: true` pushes the new application.yml to every node right away,
 * restarting the ones that are running.
 */
router.put("/settings", async (req, res, next) => {
    try {
        const { sync, ...patch } = req.body || {};
        const before = await store.get();
        const settings = await store.update(patch);

        // The daily job is armed with a timezone; changing it has to re-arm.
        if (patch.timezone && patch.timezone !== before.timezone) await updater.start();

        const result = sync ? await lavalink.syncAll({ restart: true }) : null;
        res.json({ settings, sync: result });
    } catch (err) {
        next(err);
    }
});

/** GET /api/lavalink/yaml — the exact application.yml the nodes should hold. */
router.get("/yaml", async (req, res, next) => {
    try {
        const yaml = renderYaml(await store.get());
        res.json({ yaml, sha: sha256(yaml) });
    } catch (err) {
        next(err);
    }
});

/** GET /api/lavalink/status — per-node state, plus the config sha they should match. */
router.get("/status", async (req, res, next) => {
    try {
        res.json(await lavalink.statusAll());
    } catch (err) {
        next(err);
    }
});

/** POST /api/lavalink/sync   body: { restart } */
router.post("/sync", async (req, res, next) => {
    try {
        res.json(await lavalink.syncAll({ restart: req.body?.restart !== false }));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/lavalink/check-update
 * Runs exactly what the 02:00 job runs, now.
 */
router.post("/check-update", async (req, res, next) => {
    try {
        res.json(await updater.run({ manual: true }));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/lavalink/nodes/:id/install   body: { start?: boolean }
 * First-time setup (or a clean reinstall). `start: false` prepares the node
 * without launching Lavalink.
 */
router.post("/nodes/:id/install", withNode(async (node, req, res) => {
    res.json(await lavalink.installOnNode(node, { start: req.body?.start !== false }));
}));

/** POST /api/lavalink/nodes/:id/update — bring one node to the latest release. */
router.post("/nodes/:id/update", withNode(async (node, req, res) => {
    const release = await lavalink.latestRelease({ force: true });
    res.json(await lavalink.updateNode(node, release));
}));

/** POST /api/lavalink/nodes/:id/sync — push the config to one node. */
router.post("/nodes/:id/sync", withNode(async (node, req, res) => {
    res.json(await lavalink.syncNode(node, { restart: req.body?.restart !== false }));
}));

/** POST /api/lavalink/nodes/:id/:action — start | stop | restart | rollback */
router.post("/nodes/:id/:action", withNode(async (node, req, res) => {
    const { action } = req.params;
    if (!["start", "stop", "restart", "rollback"].includes(action)) {
        return res.status(400).json({ error: `Unknown action "${action}"` });
    }
    res.json(await lavalink.control(node, action));
}));

/** GET /api/lavalink/nodes/:id/logs?lines=100 */
router.get("/nodes/:id/logs", withNode(async (node, req, res) => {
    const lines = Math.min(parseInt(req.query.lines) || 100, 500);
    res.json(await lavalink.logs(node, lines));
}));

module.exports = router;
