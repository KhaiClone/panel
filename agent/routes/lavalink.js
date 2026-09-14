const express = require("express");
const router = express.Router();
const lavalink = require("../services/lavalink");

// Lavalink lives at this agent's fixed LAVALINK_DIR. No endpoint here takes a
// path — see the SECURITY note in services/lavalink.js.

/** GET /lavalink/status — everything the panel's Lavalink page shows for this node. */
router.get("/status", async (req, res, next) => {
    try {
        res.json(await lavalink.status());
    } catch (err) {
        next(err);
    }
});

/** GET /lavalink/logs?lines=100 */
router.get("/logs", async (req, res, next) => {
    try {
        const lines = Math.min(parseInt(req.query.lines) || 100, 500);
        res.json({ logs: await lavalink.logs(lines) });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /lavalink/config   body: { content, restart?, port?, password?, heap? }
 * Writes the panel's application.yml. Restarting is the caller's choice: the
 * panel only restarts nodes whose config actually changed.
 */
router.put("/config", async (req, res, next) => {
    try {
        const { content, restart, port, password, address, heap } = req.body;
        const result = lavalink.writeConfig(content);

        if (!restart || !result.changed) return res.json({ ...result, restarted: false });

        const live = await require("../services/pm2").getBotStatus(lavalink.PM2_NAME);
        if (live.status !== "online") return res.json({ ...result, restarted: false });

        await lavalink.restart();
        const health = await lavalink.health({ port, password, address });
        res.json({ ...result, restarted: true, health });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /lavalink/install
 * body: { content, jarUrl, expectedSize, version, port, password, heap, start? }
 *
 * One call does the whole first-time setup — java check, config, jar, start,
 * health — so the panel does not have to orchestrate five round trips and
 * decide what a half-finished install means.
 *
 * `start: false` stops after the jar is in place: the node is prepared but
 * nothing is running, for an operator who wants to look before it goes live.
 */
router.post("/install", async (req, res, next) => {
    try {
        const { content, jarUrl, expectedSize, version, port, password, address, heap, start = true } = req.body;
        if (!jarUrl) return res.status(400).json({ error: "jarUrl is required" });

        const java = await lavalink.javaInfo();
        if (!java.present) {
            return res.status(412).json({
                error: "Java is not installed on this node — Lavalink v4 needs Java 17 or newer",
                code: "java-missing",
                java,
            });
        }
        if (java.major !== null && java.major < 17) {
            return res.status(412).json({
                error: `Java ${java.major} is too old for Lavalink v4 — install Java 17 or newer`,
                code: "java-too-old",
                java,
            });
        }

        if (content) lavalink.writeConfig(content);
        const jar = await lavalink.installJar({ url: jarUrl, expectedSize, version });

        if (!start) {
            return res.json({ installed: true, started: false, jar, java, status: await lavalink.status() });
        }

        await lavalink.start(heap);
        const health = await lavalink.health({ port, password, address });

        res.json({ installed: true, started: true, jar, health, java, status: await lavalink.status() });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /lavalink/update
 * body: { jarUrl, expectedSize, version, port, password, heap }
 *
 * Swap the jar and prove the new one works. A failed health check puts the old
 * jar back and restarts it — a node must never be left down by an auto-update
 * that ran at 2am with nobody watching.
 */
router.post("/update", async (req, res, next) => {
    try {
        const { jarUrl, expectedSize, version, port, password, address, heap } = req.body;
        if (!jarUrl) return res.status(400).json({ error: "jarUrl is required" });

        const jar = await lavalink.installJar({ url: jarUrl, expectedSize, version });
        await lavalink.start(heap); // re-registers the process against the new jar
        const health = await lavalink.health({ port, password, address });

        if (health.ok) return res.json({ updated: true, rolledBack: false, jar, health });

        let rolledBack = false;
        let rollbackHealth = null;
        try {
            lavalink.rollback();
            await lavalink.start(heap);
            rollbackHealth = await lavalink.health({ port, password, address });
            rolledBack = true;
        } catch (rbErr) {
            return res.status(500).json({
                updated: false,
                rolledBack: false,
                error: `New jar failed its health check (${health.error}) and the rollback also failed: ${rbErr.message}`,
                health,
                logs: await lavalink.logs(40),
            });
        }

        res.status(500).json({
            updated: false,
            rolledBack,
            error: `New jar failed its health check: ${health.error} — rolled back to the previous jar`,
            health,
            rollbackHealth,
            logs: await lavalink.logs(40),
        });
    } catch (err) {
        next(err);
    }
});

/** POST /lavalink/start   body: { heap, port, password } */
router.post("/start", async (req, res, next) => {
    try {
        const { heap, port, password, address } = req.body || {};
        const output = await lavalink.start(heap);
        res.json({ output, health: await lavalink.health({ port, password, address }) });
    } catch (err) {
        next(err);
    }
});

/** POST /lavalink/restart   body: { port, password } */
router.post("/restart", async (req, res, next) => {
    try {
        const { port, password, address } = req.body || {};
        const output = await lavalink.restart();
        res.json({ output, health: await lavalink.health({ port, password, address }) });
    } catch (err) {
        next(err);
    }
});

/** POST /lavalink/stop */
router.post("/stop", async (req, res, next) => {
    try {
        res.json({ output: await lavalink.stop() });
    } catch (err) {
        next(err);
    }
});

/** POST /lavalink/rollback   body: { heap, port, password } — manual undo of an update. */
router.post("/rollback", async (req, res, next) => {
    try {
        const { heap, port, password, address } = req.body || {};
        lavalink.rollback();
        await lavalink.start(heap);
        res.json({ rolledBack: true, health: await lavalink.health({ port, password, address }) });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
