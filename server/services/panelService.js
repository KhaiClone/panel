const { exec, execSync } = require("child_process");
const util = require("util");
const path = require("path");
const fs = require("fs");
const execAsync = util.promisify(exec);

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

/**
 * Get live status info for the panel's PM2 process.
 * @returns {{ name, status, cpu, memory, restarts, uptime, pm_id }}
 */
const getPanelStatus = async () => {
    const name = await getPanelPM2Name();

    try {
        const { stdout } = await execAsync("pm2 jlist --no-color");
        const list = JSON.parse(stdout || "[]");
        const proc = list.find((p) => p.name === name);

        if (!proc) {
            return {
                name,
                status: "not_found",
                cpu: 0,
                memory: 0,
                restarts: 0,
                uptime: null,
                pm_id: null,
            };
        }

        return {
            name: proc.name,
            status: proc.pm2_env.status,
            cpu: proc.monit?.cpu ?? 0,
            memory: proc.monit?.memory ?? 0,
            restarts: proc.pm2_env.restart_time ?? 0,
            uptime: proc.pm2_env.pm_uptime ?? null,
            pm_id: proc.pm_id,
        };
    } catch {
        return {
            name,
            status: "unknown",
            cpu: 0,
            memory: 0,
            restarts: 0,
            uptime: null,
            pm_id: null,
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

/**
 * Rebuild the client (npm run build) then restart the panel.
 * The build runs synchronously relative to the caller — the panel stays
 * online during the build and only restarts once it succeeds.
 *
 * Before installing and building, clears node_modules from both the root
 * and the client directory so stale packages are never left behind.
 *
 * @returns {{ success, buildOutput, message }}
 */
const rebuildPanel = async () => {
    const name = await getPanelPM2Name();
    const panelRoot = path.resolve(__dirname, "../..");
    const clientRoot = path.join(panelRoot, "client");

    try {
        // ── 1. Clean old node_modules ────────────────────────────────────────
        for (const [label, dir] of [
            ["root", path.join(panelRoot, "node_modules")],
            ["client", path.join(clientRoot, "node_modules")],
        ]) {
            if (fs.existsSync(dir)) {
                console.log(`[Panel] Removing old ${label} node_modules…`);
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }

        // ── 2. Reinstall root deps ───────────────────────────────────────────
        console.log("[Panel] Installing root dependencies…");
        const { stdout: installRootOut, stderr: installRootErr } = await execAsync(
            "npm install",
            { cwd: panelRoot, timeout: 120_000 },
        );

        // ── 3. Reinstall client deps ─────────────────────────────────────────
        console.log("[Panel] Installing client dependencies…");
        const { stdout: installClientOut, stderr: installClientErr } = await execAsync(
            "npm install",
            { cwd: clientRoot, timeout: 120_000 },
        );

        // ── 4. Build client ──────────────────────────────────────────────────
        console.log("[Panel] Building client…");
        const { stdout: buildOut, stderr: buildErr } = await execAsync(
            "npm run build",
            { cwd: panelRoot, timeout: 120_000 },
        );

        const buildOutput = [
            installRootOut, installRootErr,
            installClientOut, installClientErr,
            buildOut, buildErr,
        ].filter(Boolean).join("\n").trim();

        // ── 5. Restart panel ─────────────────────────────────────────────────
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
        return {
            success: false,
            buildOutput: err.stdout || err.stderr || err.message,
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
