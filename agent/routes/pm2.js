const express = require("express");
const router = express.Router();
const pm2 = require("../services/pm2");
const { resolveSafe } = require("../utils/paths");

/**
 * GET /pm2/list
 * Full PM2 process list (raw jlist output).
 */
router.get("/list", async (req, res, next) => {
    try {
        res.json({ processes: await pm2.getProcessList() });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /pm2/status/:pm2Name
 */
router.get("/status/:pm2Name", async (req, res, next) => {
    try {
        res.json(await pm2.getBotStatus(req.params.pm2Name));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /pm2/start
 * body: { pm2Name, root, dir, startCommand, maxMemory, proxyConf }
 * dir is relative to the node's BOTS_ROOT_DIR / SITES_ROOT_DIR.
 */
router.post("/start", async (req, res, next) => {
    try {
        const { pm2Name, root, dir, startCommand, maxMemory, proxyConf } = req.body;
        if (!pm2Name || !dir) return res.status(400).json({ error: "pm2Name and dir are required" });

        const botPath = resolveSafe(root, dir);
        const output = await pm2.startBot(pm2Name, botPath, startCommand || "npm start", maxMemory || null, proxyConf || null);
        res.json({ output });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /pm2/start-static
 * body: { pm2Name, root, dir, distFolder, port }
 * Serves a static site with http-server under PM2.
 */
router.post("/start-static", async (req, res, next) => {
    try {
        const { pm2Name, root, dir, distFolder, port } = req.body;
        if (!pm2Name || !dir || !port) {
            return res.status(400).json({ error: "pm2Name, dir and port are required" });
        }

        const distPath = resolveSafe(root, dir, distFolder || "");
        const output = await pm2.startHttpServer(pm2Name, distPath, parseInt(port));
        res.json({ output });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /pm2/stop   body: { pm2Name }
 */
router.post("/stop", async (req, res, next) => {
    try {
        if (!req.body.pm2Name) return res.status(400).json({ error: "pm2Name is required" });
        res.json({ output: await pm2.stopBot(req.body.pm2Name) });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /pm2/restart   body: { pm2Name }
 */
router.post("/restart", async (req, res, next) => {
    try {
        if (!req.body.pm2Name) return res.status(400).json({ error: "pm2Name is required" });
        res.json({ output: await pm2.restartBot(req.body.pm2Name) });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /pm2/delete   body: { pm2Name }
 * Never fails if the process doesn't exist.
 */
router.post("/delete", async (req, res, next) => {
    try {
        if (!req.body.pm2Name) return res.status(400).json({ error: "pm2Name is required" });
        res.json({ output: (await pm2.deleteBot(req.body.pm2Name)) || "" });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /pm2/memory-limit   body: { pm2Name, maxMemory }
 * maxMemory null/empty removes the limit.
 */
router.post("/memory-limit", async (req, res, next) => {
    try {
        const { pm2Name, maxMemory } = req.body;
        if (!pm2Name) return res.status(400).json({ error: "pm2Name is required" });
        res.json({ output: await pm2.setMemoryLimit(pm2Name, maxMemory || null) });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
