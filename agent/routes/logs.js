const express = require("express");
const router = express.Router();
const { getBotLogs, streamBotLogs, flushBotLogs } = require("../services/pm2");

// The panel authenticates the browser (JWT) and relays these — the agent only
// trusts the shared x-agent-key applied globally in index.js.

/**
 * GET /logs/:pm2Name?lines=100
 * Snapshot of the last N lines.
 */
router.get("/:pm2Name", async (req, res, next) => {
    try {
        const lines = Math.min(parseInt(req.query.lines) || 100, 500);
        const logs = await getBotLogs(req.params.pm2Name, lines);
        res.json({ logs });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /logs/:pm2Name/stream
 * SSE live stream — the panel pipes this through to the browser.
 */
router.get("/:pm2Name/stream", (req, res, next) => {
    try {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
        const proc = streamBotLogs(req.params.pm2Name, parseInt(req.query.lines) || 50);

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
 * DELETE /logs/:pm2Name
 * Flush logs for one process.
 */
router.delete("/:pm2Name", async (req, res, next) => {
    try {
        await flushBotLogs(req.params.pm2Name);
        res.json({ message: "Logs cleared" });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
