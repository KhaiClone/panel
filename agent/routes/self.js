const express = require("express");
const path = require("path");
const fs = require("fs");
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

// ─────────────────────────────────────────────────────────────────────────────
//  Panel self-management
//
//  The panel is a control plane and runs no shell of its own, so the machine it
//  lives on manages it through these endpoints. Only meaningful on the node that
//  actually hosts the panel: PANEL_DIR must point at the panel repo.
//
//  SECURITY: none of these takes a path from the request. They operate on the
//  fixed PANEL_DIR from this agent's env. Accepting a caller-supplied path here
//  would turn a leaked agent key into arbitrary file write on the host — the
//  root-jail in utils/paths.js exists for exactly that reason.
// ─────────────────────────────────────────────────────────────────────────────

const PANEL_DIR = process.env.PANEL_DIR || null;
const PANEL_PM2_NAME = process.env.PANEL_PM2_NAME || "bot-panel";

/** Guard every panel endpoint: unconfigured means "this node does not host it". */
const requirePanelDir = (req, res, next) => {
    if (!PANEL_DIR) {
        return res.status(503).json({
            error: "PANEL_DIR is not configured on this agent — it does not host the panel",
        });
    }
    if (!fs.existsSync(PANEL_DIR)) {
        return res.status(503).json({ error: `PANEL_DIR "${PANEL_DIR}" does not exist` });
    }
    next();
};

/**
 * GET /self/panel-status
 * PM2 status of the panel process.
 */
router.get("/panel-status", requirePanelDir, async (req, res, next) => {
    try {
        const live = await getBotStatus(PANEL_PM2_NAME);
        res.json({ pm2Name: PANEL_PM2_NAME, panelDir: PANEL_DIR, ...live });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /self/panel-logs?lines=100
 */
router.get("/panel-logs", requirePanelDir, async (req, res, next) => {
    try {
        const lines = Math.min(parseInt(req.query.lines) || 100, 500);
        res.json({ logs: await getBotLogs(PANEL_PM2_NAME, lines) });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /self/panel-restart
 * Restart the panel. Answered first, then restarted ~1.5s later so the response
 * reaches the browser before its server goes away.
 */
router.post("/panel-restart", requirePanelDir, (req, res) => {
    res.json({ message: `Panel "${PANEL_PM2_NAME}" will restart in ~1.5 seconds` });
    setTimeout(() => {
        exec(`pm2 restart "${PANEL_PM2_NAME}" --no-color`, (err) => {
            if (err) console.error("[Agent] Panel restart failed:", err.message);
        });
    }, 1500);
});

/**
 * GET /self/env
 * The panel's .env, verbatim. Reachable only with the agent key.
 */
router.get("/env", requirePanelDir, (req, res, next) => {
    try {
        const envPath = path.join(PANEL_DIR, ".env");
        const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
        res.json({ content });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /self/env   body: { content }
 * Overwrite the panel's .env. The previous file is always kept as
 * .env.bak-<timestamp> first — this is the panel's own credentials file and a
 * bad write would lock everyone out.
 */
router.put("/env", requirePanelDir, (req, res, next) => {
    try {
        const { content } = req.body;
        if (typeof content !== "string") {
            return res.status(400).json({ error: "content is required" });
        }
        const envPath = path.join(PANEL_DIR, ".env");
        let backup = null;
        if (fs.existsSync(envPath)) {
            backup = `${envPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
            fs.copyFileSync(envPath, backup);
        }
        fs.writeFileSync(envPath, content, "utf8");
        res.json({ message: ".env saved", backup });
    } catch (err) {
        next(err);
    }
});

// One rebuild at a time: two overlapping `npm install` runs in the same tree
// leave node_modules in a state neither of them expects.
let _rebuildInProgress = false;

/**
 * POST /self/rebuild-app
 * git pull → update deps → build client → verify every dependency resolves →
 * only then restart. A failed build must never restart the panel: it would come
 * back up against a half-installed tree.
 */
router.post("/rebuild-app", requirePanelDir, async (req, res) => {
    if (_rebuildInProgress) {
        return res.status(409).json({
            success: false,
            buildOutput: "",
            message: "A rebuild is already in progress — wait for it to finish.",
        });
    }
    _rebuildInProgress = true;

    const out = [];
    const run = async (cmd, timeout) => {
        const { stdout, stderr } = await execAsync(cmd, {
            cwd: PANEL_DIR,
            timeout,
            maxBuffer: 10 * 1024 * 1024,
        });
        out.push(stdout, stderr);
    };

    try {
        console.log("[Agent] Panel rebuild: git pull");
        await run("git pull", 60_000);

        // Deliberately NOT a clean reinstall: deleting node_modules first would
        // leave the running panel without deps if the install fails (e.g. the
        // registry is unreachable). An in-place install fails safe.
        console.log("[Agent] Panel rebuild: updating dependencies");
        await run("npm run update:deps", 300_000);

        console.log("[Agent] Panel rebuild: building client");
        await run("npm run build", 180_000);

        console.log("[Agent] Panel rebuild: verifying dependencies");
        await run(
            `node -e "Object.keys(require('./package.json').dependencies).forEach(d => require.resolve(d))"`,
            30_000,
        );

        const buildOutput = out.filter(Boolean).join("\n").trim();
        res.json({
            success: true,
            buildOutput,
            message: `Build successful. Panel "${PANEL_PM2_NAME}" will restart in ~1.5 seconds`,
        });

        setTimeout(() => {
            exec(`pm2 restart "${PANEL_PM2_NAME}" --no-color`, (err) => {
                if (err) console.error("[Agent] Post-build restart failed:", err.message);
            });
        }, 1500);
    } catch (err) {
        if (err.stdout) out.push(err.stdout);
        if (err.stderr) out.push(err.stderr);

        let reason = err.message;
        if (err.killed && err.signal === "SIGTERM") reason = "Process timed out.";
        else if (err.killed && err.signal === "SIGKILL")
            reason = "Process was killed by the OS (likely out of memory — the vite build is memory hungry).";
        else if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
            reason = "Process exceeded the max output buffer.";
        out.push(`\n[ERROR] ${reason}`);

        res.status(500).json({
            success: false,
            buildOutput: out.filter(Boolean).join("\n").trim(),
            message: "Build failed — the panel was NOT restarted",
        });
    } finally {
        _rebuildInProgress = false;
    }
});

module.exports = router;
