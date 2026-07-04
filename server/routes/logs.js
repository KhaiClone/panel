const express = require("express");
const router = express.Router();
const db = require("../db");
const { streamBotLogs } = require("../services/pm2Service");
const executor = require("../services/executor");

const checkLogOwnership = async (req, decoded) => {
    const bot = await db.findOne("bots", { _id: req.params.botId });
    if (!bot) return { bot: null, allowed: false };
    if (decoded.role === "admin") return { bot, allowed: true };
    return { bot, allowed: bot.ownerId === decoded.userId };
};

/**
 * GET /api/logs/:botId?lines=100
 * Snapshot of the last N lines of PM2 logs.
 */
router.get("/:botId", async (req, res, next) => {
    try {
        const jwt = require("jsonwebtoken");
        const authHeader = req.headers["authorization"];
        let token = authHeader && authHeader.split(" ")[1];
        if (!token && req.query.token) token = req.query.token;
        if (!token) return res.status(401).json({ error: "No token" });

        let decoded;
        try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
        catch { return res.status(401).json({ error: "Invalid token" }); }

        const { bot, allowed } = await checkLogOwnership(req, decoded);
        if (!bot) return res.status(404).json({ error: "Bot not found" });
        if (!allowed) return res.status(403).json({ error: "Access denied" });

        const lines = Math.min(parseInt(req.query.lines) || 100, 500);
        const logs = await executor.getBotLogs(bot, lines);

        res.json({ logs });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/logs/:botId/stream
 * Server-Sent Events (SSE) live log stream.
 * Token passed as query param because EventSource cannot set Authorization header.
 */
router.get("/:botId/stream", async (req, res, next) => {
    try {
        const jwt = require("jsonwebtoken");
        const token = req.query.token;
        if (!token) return res.status(401).end();

        let decoded;
        try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
        catch { return res.status(401).end(); }

        const { bot, allowed } = await checkLogOwnership(req, decoded);
        if (!bot || !allowed) return res.status(403).end();

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);

        if (executor.isRemote(bot)) {
            // Remote bot: the agent already emits SSE — pipe its bytes through
            let upstream;
            try {
                upstream = await executor.streamRemoteLogs(bot, 50);
            } catch (err) {
                clearInterval(keepAlive);
                res.write(`data: [panel] Cannot reach node: ${err.message}\n\n`);
                return res.end();
            }

            upstream.data.pipe(res);
            upstream.data.on("error", () => res.end());

            req.on("close", () => {
                clearInterval(keepAlive);
                upstream.data.destroy();
            });
            return;
        }

        const proc = streamBotLogs(bot.pm2Name, 50);

        const sendData = (chunk) => {
            const lines = chunk.toString().split("\n");
            for (const line of lines) {
                if (line.trim()) res.write(`data: ${line}\n\n`);
            }
        };

        proc.stdout.on("data", sendData);
        proc.stderr.on("data", sendData);

        req.on("close", () => {
            clearInterval(keepAlive);
            proc.kill("SIGTERM");
        });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/logs/:botId
 * Clear PM2 logs for a bot.
 */
router.delete("/:botId", async (req, res, next) => {
    try {
        const jwt = require("jsonwebtoken");
        const authHeader = req.headers["authorization"];
        let token = authHeader && authHeader.split(" ")[1];
        if (!token && req.query.token) token = req.query.token;
        if (!token) return res.status(401).json({ error: "No token" });

        let decoded;
        try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
        catch { return res.status(401).json({ error: "Invalid token" }); }

        const { bot, allowed } = await checkLogOwnership(req, decoded);
        if (!bot) return res.status(404).json({ error: "Bot not found" });
        if (!allowed) return res.status(403).json({ error: "Access denied" });

        await executor.flushBotLogs(bot);
        res.json({ message: "Logs cleared" });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
