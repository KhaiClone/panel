const { exec, spawn } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a PM2 CLI command and return stdout.
 * --no-color strips ANSI codes from output.
 */
const runPM2 = async (args) => {
    const { stdout, stderr } = await execAsync(`pm2 ${args} --no-color`);
    return stdout || stderr;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Process Control
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start a bot with PM2.
 * If the process already exists in PM2, it will be restarted instead.
 *
 * @param {string} pm2Name    - Unique PM2 name, e.g. "buyer123-mybot"
 * @param {string} botPath    - Absolute path to the bot's directory
 * @param {string} startScript - Entry file relative to botPath (default: index.js)
 */
const startBot = async (pm2Name, botPath, startScript = "index.js") => {
    // Check if process already exists in PM2 list
    const list = await getProcessList();
    const existing = list.find((p) => p.name === pm2Name);

    if (existing) {
        // Already registered — just restart it
        return runPM2(`restart "${pm2Name}"`);
    }

    // New process: register and start
    const scriptPath = `${botPath}/${startScript}`;
    return runPM2(
        `start "${scriptPath}" --name "${pm2Name}" --cwd "${botPath}"`,
    );
};

/** Stop a running bot (keeps it in PM2 list) */
const stopBot = async (pm2Name) => {
    return runPM2(`stop "${pm2Name}"`);
};

/** Restart a bot */
const restartBot = async (pm2Name) => {
    return runPM2(`restart "${pm2Name}"`);
};

/**
 * Remove a bot from PM2 entirely.
 * Called on expiry or manual deletion. Errors are silenced (process may not exist).
 */
const deleteBot = async (pm2Name) => {
    try {
        return await runPM2(`delete "${pm2Name}"`);
    } catch {
        // Process doesn't exist in PM2 — that's fine
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Status & Info
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the full PM2 process list as parsed JSON.
 * Returns an empty array if PM2 is not available or has no processes.
 */
const getProcessList = async () => {
    try {
        const { stdout } = await execAsync("pm2 jlist --no-color");
        return JSON.parse(stdout || "[]");
    } catch {
        return [];
    }
};

/**
 * Get live status info for a specific PM2 process.
 *
 * @returns {Object} { status, cpu, memory, restarts, uptime }
 */
const getBotStatus = async (pm2Name) => {
    const list = await getProcessList();
    const proc = list.find((p) => p.name === pm2Name);

    if (!proc)
        return {
            status: "stopped",
            cpu: 0,
            memory: 0,
            restarts: 0,
            uptime: null,
        };

    return {
        status: proc.pm2_env.status, // 'online' | 'stopped' | 'errored' | 'launching'
        cpu: proc.monit?.cpu ?? 0,
        memory: proc.monit?.memory ?? 0,
        restarts: proc.pm2_env.restart_time ?? 0,
        uptime: proc.pm2_env.pm_uptime ?? null,
    };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Logs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the last N lines of logs for a bot (snapshot, not streaming).
 *
 * @param {string} pm2Name
 * @param {number} lines - How many lines to return
 */
const getBotLogs = async (pm2Name, lines = 100) => {
    try {
        const { stdout } = await execAsync(
            `pm2 logs "${pm2Name}" --lines ${lines} --nostream --no-color`,
        );
        return stdout;
    } catch (err) {
        return err.message;
    }
};

/**
 * Spawn a `pm2 logs` process for live streaming.
 * Returns the ChildProcess — caller is responsible for killing it.
 *
 * @param {string} pm2Name
 * @param {number} lines - Initial history lines to show
 */
const streamBotLogs = (pm2Name, lines = 50) => {
    return spawn(
        "pm2",
        ["logs", pm2Name, "--lines", String(lines), "--raw", "--no-color"],
        {
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
};

module.exports = {
    startBot,
    stopBot,
    restartBot,
    deleteBot,
    getBotStatus,
    getBotLogs,
    streamBotLogs,
    getProcessList,
};
