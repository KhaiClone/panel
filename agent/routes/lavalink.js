const express = require("express");
const router = express.Router();
const lavalink = require("../services/lavalink");
const tokener = require("../services/spotifyTokener");

// Lavalink lives at this agent's fixed LAVALINK_DIR. No endpoint here takes a
// path — see the SECURITY note in services/lavalink.js.

// ── spotify-tokener rides along ──────────────────────────────────────────────
// It follows Lavalink (services/spotifyTokener.js), so every call that starts
// Lavalink brings it in line first — LavaSrc may want a token the moment
// Lavalink is up — and proves it with a real token after Lavalink answered,
// when Chrome has had the JVM's boot time to warm up. Neither step ever fails
// the Lavalink call: without the tokener only Spotify links are affected, and
// the outcome goes back to the panel as `tokener`.

/** `tokenerPort` undefined → a panel from before the tokener: leave it alone. */
const tokenerUp = async (tokenerPort, opts) => {
    if (tokenerPort === undefined) return null;
    try {
        return await tokener.ensure(tokenerPort || null, opts);
    } catch (err) {
        return { wanted: Boolean(tokenerPort), port: tokenerPort || null, running: false, error: err.message };
    }
};

const tokenerProof = async (result) => {
    if (result?.running) result.health = await tokener.verify(result.port);
    return result;
};

/**
 * GET /lavalink/status?tokenerPort=8081 — everything the panel's Lavalink page
 * shows for this node. The port lets a tokener the panel did not start be
 * recognised there.
 */
router.get("/status", async (req, res, next) => {
    try {
        const wanted = parseInt(req.query.tokenerPort, 10) || null;
        const [status, tokenerStatus] = await Promise.all([lavalink.status(), tokener.status(wanted)]);
        res.json({ ...status, tokener: tokenerStatus });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /lavalink/tokener   body: { tokenerPort }
 * The panel's per-node switch, applied now without touching Lavalink. Same
 * rule as a sync: started only where Lavalink runs, removed anywhere.
 */
router.post("/tokener", async (req, res, next) => {
    try {
        const { tokenerPort } = req.body || {};
        const live = await require("../services/pm2").getBotStatus(lavalink.PM2_NAME);
        const result =
            live.status === "online" || !tokenerPort
                ? await tokenerUp(tokenerPort)
                : { wanted: true, port: tokenerPort, running: false, note: "Lavalink is not running here — the tokener starts with it" };
        res.json({ tokener: await tokenerProof(result) });
    } catch (err) {
        next(err);
    }
});

/** GET /lavalink/logs?lines=100 — Lavalink's, then spotify-tokener's when it exists. */
router.get("/logs", async (req, res, next) => {
    try {
        const lines = Math.min(parseInt(req.query.lines) || 100, 500);
        const [main, extra] = await Promise.all([lavalink.logs(lines), tokener.logs(lines)]);
        res.json({ logs: extra ? `${main}\n\n──── ${tokener.PM2_NAME} ────\n${extra}` : main });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /lavalink/stats   body: { port, password, address }
 * Lavalink's own /v4/stats. Sent as a body rather than a query string so the
 * password never lands in a URL.
 */
router.post("/stats", async (req, res, next) => {
    try {
        const { port, password, address } = req.body || {};
        res.json({ stats: await lavalink.stats({ port, password, address }) });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /lavalink/config   body: { content, restart?, port?, password?, heap?, tokenerPort? }
 * Writes the panel's application.yml. Restarting is the caller's choice: the
 * panel only restarts nodes whose config actually changed.
 *
 * The tokener is brought in line even when the file did not change — a sync is
 * how a node that predates it (or just got Chrome) gets one. Only where
 * Lavalink runs, though: syncing a stopped node must not start anything.
 */
router.put("/config", async (req, res, next) => {
    try {
        const { content, restart, port, password, address, tokenerPort } = req.body;
        const result = lavalink.writeConfig(content);

        const live = await require("../services/pm2").getBotStatus(lavalink.PM2_NAME);
        const running = live.status === "online";
        const tokenerResult = running || !tokenerPort ? await tokenerUp(tokenerPort) : null;

        if (!restart || !result.changed || !running) {
            return res.json({ ...result, restarted: false, tokener: await tokenerProof(tokenerResult) });
        }

        await lavalink.restart();
        const health = await lavalink.health({ port, password, address });
        res.json({ ...result, restarted: true, health, tokener: await tokenerProof(tokenerResult) });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /lavalink/install
 * body: { content, jarUrl, expectedSize, version, port, password, heap, tokenerPort?, start? }
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
        const { content, jarUrl, expectedSize, version, port, password, address, heap, tokenerPort, start = true } = req.body;
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

        const tokenerResult = await tokenerUp(tokenerPort);
        await lavalink.start(heap);
        const health = await lavalink.health({ port, password, address });

        res.json({
            installed: true,
            started: true,
            jar,
            health,
            java,
            tokener: await tokenerProof(tokenerResult),
            status: await lavalink.status(),
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /lavalink/update
 * body: { jarUrl, expectedSize, version, port, password, heap, tokenerPort? }
 *
 * Swap the jar and prove the new one works. A failed health check puts the old
 * jar back and restarts it — a node must never be left down by an auto-update
 * that ran at 2am with nobody watching.
 *
 * A node that was NOT running only gets the new jar. Starting it would be the
 * 02:00 job deciding, unattended, to put an audio server live that somebody
 * deliberately left stopped. Nothing is running, so there is also nothing to
 * health-check and nothing that could need a rollback.
 */
router.post("/update", async (req, res, next) => {
    try {
        const { jarUrl, expectedSize, version, port, password, address, heap, tokenerPort } = req.body;
        if (!jarUrl) return res.status(400).json({ error: "jarUrl is required" });

        const before = await require("../services/pm2").getBotStatus(lavalink.PM2_NAME);
        const wasRunning = before.status === "online";

        const jar = await lavalink.installJar({ url: jarUrl, expectedSize, version });

        if (!wasRunning) {
            return res.json({
                updated: true,
                rolledBack: false,
                started: false,
                jar,
                note: "Node was not running — the jar was replaced and left stopped",
            });
        }
        const tokenerResult = await tokenerUp(tokenerPort);
        await lavalink.start(heap); // re-registers the process against the new jar
        const health = await lavalink.health({ port, password, address });

        if (health.ok) {
            return res.json({
                updated: true,
                rolledBack: false,
                started: true,
                jar,
                health,
                tokener: await tokenerProof(tokenerResult),
            });
        }

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

/** POST /lavalink/start   body: { heap, port, password, tokenerPort } */
router.post("/start", async (req, res, next) => {
    try {
        const { heap, port, password, address, tokenerPort } = req.body || {};
        const tokenerResult = await tokenerUp(tokenerPort);
        const output = await lavalink.start(heap);
        const health = await lavalink.health({ port, password, address });
        res.json({ output, health, tokener: await tokenerProof(tokenerResult) });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /lavalink/restart   body: { port, password, tokenerPort }
 * Restarts a running tokener too: a wedged Chrome is exactly what someone
 * pressing Restart on a node whose Spotify links fail is trying to clear.
 */
router.post("/restart", async (req, res, next) => {
    try {
        const { port, password, address, tokenerPort } = req.body || {};
        const tokenerResult = await tokenerUp(tokenerPort, { force: true });
        const output = await lavalink.restart();
        const health = await lavalink.health({ port, password, address });
        res.json({ output, health, tokener: await tokenerProof(tokenerResult) });
    } catch (err) {
        next(err);
    }
});

/** POST /lavalink/stop — the tokener goes with it. */
router.post("/stop", async (req, res, next) => {
    try {
        const output = await lavalink.stop();
        await tokener.stop().catch(() => {});
        res.json({ output });
    } catch (err) {
        next(err);
    }
});

/** POST /lavalink/rollback   body: { heap, port, password, tokenerPort } — manual undo of an update. */
router.post("/rollback", async (req, res, next) => {
    try {
        const { heap, port, password, address, tokenerPort } = req.body || {};
        lavalink.rollback();
        const tokenerResult = await tokenerUp(tokenerPort);
        await lavalink.start(heap);
        const health = await lavalink.health({ port, password, address });
        res.json({ rolledBack: true, health, tokener: await tokenerProof(tokenerResult) });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
