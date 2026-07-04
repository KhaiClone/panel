const express = require("express");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);
const si = require("systeminformation");
const router = express.Router();
const { getBotLogs, getBotStatus } = require("../services/pm2");

// The agent's own PM2 process name (set by ecosystem.config.js / setup script)
const PM2_NAME = process.env.AGENT_PM2_NAME || "panel-agent";
// The agent lives inside the panel repo — repo root is one level up
const REPO_ROOT = path.resolve(__dirname, "../..");
const AGENT_DIR = path.resolve(__dirname, "..");

const AGENT_VERSION = require("../package.json").version;

/**
 * GET /self/info
 * Everything the panel's node-detail page shows about this agent.
 */
router.get("/info", async (req, res, next) => {
    try {
        let commit = null, branch = null;
        try {
            const { stdout: c } = await execAsync(`git -C "${REPO_ROOT}" rev-parse --short HEAD`);
            const { stdout: b } = await execAsync(`git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD`);
            commit = c.trim();
            branch = b.trim();
        } catch { /* not a git checkout */ }

        const [time, osInfo] = await Promise.all([
            si.time(),
            si.osInfo().catch(() => ({})),
        ]);

        const live = await getBotStatus(PM2_NAME);

        res.json({
            agentVersion: AGENT_VERSION,
            nodeVersion: process.version,
            pm2Name: PM2_NAME,
            pid: process.pid,
            agentUptime: process.uptime(),
            systemUptime: time.uptime ?? null,
            hostname: os.hostname(),
            platform: `${osInfo.distro || os.platform()} ${osInfo.release || ""}`.trim(),
            commit,
            branch,
            repoRoot: REPO_ROOT,
            config: {
                port: parseInt(process.env.AGENT_PORT) || 4200,
                botsRootDir: process.env.BOTS_ROOT_DIR || null,
                sitesRootDir: process.env.SITES_ROOT_DIR || null,
            },
            live, // PM2 status/cpu/memory/restarts of the agent process itself
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /self/logs?lines=100
 * The agent's own PM2 logs.
 */
router.get("/logs", async (req, res, next) => {
    try {
        const lines = Math.min(parseInt(req.query.lines) || 100, 500);
        const logs = await getBotLogs(PM2_NAME, lines);
        res.json({ logs });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /self/restart
 * Respond first, then restart — the HTTP response must leave before PM2
 * kills this process.
 */
router.post("/restart", (req, res) => {
    res.json({ message: "Agent restarting…" });
    setTimeout(() => {
        exec(`pm2 restart "${PM2_NAME}"`, (err) => {
            if (err) console.error("[Agent] Self-restart failed:", err.message);
        });
    }, 500);
});

/**
 * POST /self/update
 * git pull the repo, reinstall agent deps, then restart (after responding).
 */
router.post("/update", async (req, res, next) => {
    try {
        let pullOutput;
        try {
            const { stdout, stderr } = await execAsync(`git -C "${REPO_ROOT}" pull`, { timeout: 120_000 });
            pullOutput = (stdout || stderr).trim();
        } catch (err) {
            return res.status(500).json({ error: `git pull failed: ${err.message.split("\n")[0]}` });
        }

        let installOutput = "(skipped — already up to date)";
        const upToDate = /Already up.to.date/i.test(pullOutput);
        if (!upToDate) {
            try {
                const { stdout, stderr } = await execAsync("npm install --omit=dev", {
                    cwd: AGENT_DIR,
                    timeout: 300_000,
                    maxBuffer: 10 * 1024 * 1024,
                });
                installOutput = (stdout || stderr).trim().split("\n").slice(-2).join("\n");
            } catch (err) {
                return res.status(500).json({ error: `npm install failed: ${err.message.split("\n")[0]}`, pullOutput });
            }
        }

        res.json({
            message: upToDate ? "Already up to date — no restart needed" : "Updated — agent restarting…",
            pullOutput,
            installOutput,
            restarting: !upToDate,
        });

        if (!upToDate) {
            setTimeout(() => {
                exec(`pm2 restart "${PM2_NAME}"`, (err) => {
                    if (err) console.error("[Agent] Post-update restart failed:", err.message);
                });
            }, 500);
        }
    } catch (err) {
        next(err);
    }
});

module.exports = router;
