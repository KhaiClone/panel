const { exec, execSync } = require("child_process");
const util = require("util");
const path = require("path");
const fs = require("fs");
const execAsync = util.promisify(exec);

const pkg = (() => { try { return require("../../package.json"); } catch { return {}; } })();

// ─────────────────────────────────────────────────────────────────────────────
//  Panel PM2 Identity
// ─────────────────────────────────────────────────────────────────────────────

/** Cached panel PM2 name — resolved once on first call */
let _panelName = null;

/**
 * Auto-detect the panel's PM2 process name.
 *
 * Strategy:
 *  1. PM2 injects `pm_id` into every managed process — use it to look up our name
 *  2. Fall back to PANEL_PM2_NAME env var
 *  3. Last resort: "bot-panel" (matches ecosystem.config.js default)
 */
const getPanelPM2Name = async () => {
    if (_panelName) return _panelName;

    // Strategy 1: auto-detect via pm_id
    const pmId = process.env.pm_id;
    if (pmId !== undefined) {
        try {
            const { stdout } = await execAsync("pm2 jlist --no-color");
            const list = JSON.parse(stdout || "[]");
            const self = list.find((p) => String(p.pm_id) === String(pmId));
            if (self) {
                _panelName = self.name;
                console.log(`[Panel] Auto-detected PM2 name: "${_panelName}" (pm_id=${pmId})`);
                return _panelName;
            }
        } catch (err) {
            console.warn("[Panel] Auto-detection failed, falling back to env var:", err.message);
        }
    }

    // Strategy 2: env var
    _panelName = process.env.PANEL_PM2_NAME || "bot-panel";
    console.log(`[Panel] Using configured PM2 name: "${_panelName}"`);
    return _panelName;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Status
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve the latest git commit hash (short). Returns null if not a git repo. */
const getGitCommitHash = () => {
    try {
        return execSync("git rev-parse HEAD", { cwd: path.resolve(__dirname, "../.."), timeout: 3000 })
            .toString()
            .trim();
    } catch {
        return null;
    }
};

/**
 * Get live status info for the panel's PM2 process.
 * Returns { env, git, pm2 } matching the shape the frontend expects.
 */
const getPanelStatus = async () => {
    const name = await getPanelPM2Name();

    const env = {
        version: pkg.version || "?",
        isDev: process.env.NODE_ENV === "development",
    };

    const git = {
        commitHash: getGitCommitHash(),
    };

    try {
        const { stdout } = await execAsync("pm2 jlist --no-color");
        const list = JSON.parse(stdout || "[]");
        const proc = list.find((p) => p.name === name);

        if (!proc) {
            return {
                env,
                git,
                pm2: {
                    name,
                    status: "not_found",
                    monit: { cpu: 0, memory: 0 },
                    pm_uptime: null,
                    restarts: 0,
                    pm_id: null,
                },
            };
        }

        return {
            env,
            git,
            pm2: {
                name: proc.name,
                status: proc.pm2_env.status,
                monit: {
                    cpu: proc.monit?.cpu ?? 0,
                    memory: proc.monit?.memory ?? 0,
                },
                pm_uptime: proc.pm2_env.pm_uptime ?? null,
                restarts: proc.pm2_env.restart_time ?? 0,
                pm_id: proc.pm_id,
            },
        };
    } catch {
        return {
            env,
            git,
            pm2: {
                name,
                status: "unknown",
                monit: { cpu: 0, memory: 0 },
                pm_uptime: null,
                restarts: 0,
                pm_id: null,
            },
        };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Actions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Restart the panel via PM2.
 * Uses a small delay so the HTTP response can be sent before the process dies.
 */
const restartPanel = async () => {
    const name = await getPanelPM2Name();
    // Fire-and-forget with 1.5s delay so the API response reaches the client
    setTimeout(() => {
        exec(`pm2 restart "${name}" --no-color`, (err) => {
            if (err) console.error("[Panel] Restart failed:", err.message);
        });
    }, 1500);
    return { message: `Panel "${name}" will restart in ~1.5 seconds` };
};

const rebuildPanel = async () => {
    const name = await getPanelPM2Name();
    const panelRoot = path.resolve(__dirname, "../..");

    let accumulatedOutput = [];

    try {
        // ── 1. Git Pull ──────────────────────────────────────────────────────
        console.log("[Panel] Pulling latest changes from git…");
        const { stdout: pullOut, stderr: pullErr } = await execAsync(
            "git pull",
            { cwd: panelRoot, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
        );
        accumulatedOutput.push(pullOut, pullErr);

        // ── 2. Reinstall all deps ────────────────────────────────────────────
        console.log("[Panel] Reinstalling all dependencies…");
        const { stdout: installOut, stderr: installErr } = await execAsync(
            "npm run reinstall:all",
            { cwd: panelRoot, timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
        );
        accumulatedOutput.push(installOut, installErr);

        // ── 3. Build client ──────────────────────────────────────────────────
        console.log("[Panel] Building client…");
        const { stdout: buildOut, stderr: buildErr } = await execAsync(
            "npm run build",
            { cwd: panelRoot, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
        );
        accumulatedOutput.push(buildOut, buildErr);

        const buildOutput = accumulatedOutput.filter(Boolean).join("\n").trim();

        // ── 4. Restart panel ─────────────────────────────────────────────────
        setTimeout(() => {
            exec(`pm2 restart "${name}" --no-color`, (err) => {
                if (err) console.error("[Panel] Post-build restart failed:", err.message);
            });
        }, 1500);

        return {
            success: true,
            buildOutput,
            message: `Build successful. Panel "${name}" will restart in ~1.5 seconds`,
        };
    } catch (err) {
        // If an execAsync call throws, it usually populates err.stdout and err.stderr with what it captured before crashing
        if (err.stdout) accumulatedOutput.push(err.stdout);
        if (err.stderr) accumulatedOutput.push(err.stderr);
        
        let failReason = err.message;
        if (err.killed) {
            if (err.signal === 'SIGTERM') failReason = "Process timed out (reached timeout limit).";
            else if (err.signal === 'SIGKILL') failReason = "Process was killed by the OS (likely Out of Memory). Vite build requires significant RAM.";
        }
        else if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') failReason = "Process exceeded max output buffer.";

        accumulatedOutput.push(`\n[ERROR DETAILS] ${failReason}`);

        return {
            success: false,
            buildOutput: accumulatedOutput.filter(Boolean).join("\n").trim(),
            message: "Build failed — panel was NOT restarted",
        };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Logs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the last N lines of panel logs.
 */
const getPanelLogs = async (lines = 100) => {
    const name = await getPanelPM2Name();
    try {
        const { stdout } = await execAsync(
            `pm2 logs "${name}" --lines ${lines} --nostream --no-color`,
        );
        return stdout;
    } catch (err) {
        return err.message;
    }
};

module.exports = {
    getPanelPM2Name,
    getPanelStatus,
    restartPanel,
    rebuildPanel,
    getPanelLogs,
};
