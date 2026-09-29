const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);
const fs = require("fs");
const path = require("path");
const os = require("os");

// ─────────────────────────────────────────────────────────────────────────────
//  pm2-logrotate management, owned entirely by the agent.
//
//  Lets the panel install and configure the pm2-logrotate module on any node so
//  PM2 logs can never fill a disk — and every agent installs it into its own
//  PM2 on start when it is missing (ensureOnBoot). A 2.9G pm2.log once filled a disk here and
//  corrupted dump.pm2, losing every process on reboot — that is what this guards.
// ─────────────────────────────────────────────────────────────────────────────

// `pm2 install` picks up whatever package manager it finds in PATH. A
// snap-confined bun cannot write into the hidden ~/.pm2 directory and fails
// with "AccessDenied create package.json", so module commands run with a
// PATH that only contains the system locations of node/npm.
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";
const safeEnv = { ...process.env, PATH: SAFE_PATH };

const PM2_HOME = process.env.PM2_HOME || path.join(os.homedir(), ".pm2");
const MODULE_CONF_PATH = path.join(PM2_HOME, "module_conf.json");
const MODULE_NAME = "pm2-logrotate";
// Left when the module was absent and the agent installed it, so
// uninstall-agent.sh removes it again — and only then.
const MARKER_PATH = path.join(PM2_HOME, ".bot-panel-logrotate");

// Editable settings and their validation rules. Anything not listed here is
// rejected, which also keeps `pm2 set` arguments shell-safe — do not loosen
// these patterns, they are the injection guard as much as the validation.
const SETTING_RULES = {
    max_size: /^\d+[KMG]?$/,               // e.g. 50M, 1G, 10485760
    retain: /^(\d+|all|none)$/,            // rotated files to keep
    compress: /^(true|false)$/,
    rotateInterval: /^[\d*/, -]+$/,        // cron expression, e.g. 0 0 * * *
    workerInterval: /^\d+$/,               // seconds between size checks
    rotateModule: /^(true|false)$/,
};

/** Read the module's current settings from PM2's module_conf.json. */
const readModuleConf = () => {
    try {
        const conf = JSON.parse(fs.readFileSync(MODULE_CONF_PATH, "utf8"));
        return conf[MODULE_NAME] || null;
    } catch {
        return null;
    }
};

/**
 * Get install state, PM2 process status and current settings.
 * Returns { installed, status, config }.
 */
const getStatus = async () => {
    const config = readModuleConf();

    let status = "not_installed";
    try {
        const { stdout } = await execAsync("pm2 jlist --no-color", { env: safeEnv });
        const list = JSON.parse(stdout || "[]");
        const proc = list.find((p) => p.name === MODULE_NAME);
        if (proc) status = proc.pm2_env.status;
    } catch {
        status = "unknown";
    }

    return { installed: status !== "not_installed" || config !== null, status, config };
};

/**
 * Apply settings via `pm2 set pm2-logrotate:<key> <value>`.
 * Only whitelisted keys with valid values are accepted.
 */
const setConfig = async (settings) => {
    const entries = Object.entries(settings || {});
    if (entries.length === 0) throw new Error("No settings provided");

    // Validate everything first, so a bad key never leaves a half-applied config
    for (const [key, value] of entries) {
        const rule = SETTING_RULES[key];
        if (!rule) throw new Error(`Unknown setting: "${key}"`);
        if (!rule.test(String(value).trim())) {
            throw new Error(`Invalid value for "${key}": "${value}"`);
        }
    }

    for (const [key, value] of entries) {
        await execAsync(`pm2 set ${MODULE_NAME}:${key} "${String(value).trim()}"`, {
            env: safeEnv,
            timeout: 30_000,
        });
    }
    return getStatus();
};

/**
 * Install the pm2-logrotate module (idempotent — reinstalls if present)
 * and apply sensible defaults so it protects the disk out of the box.
 */
const install = async () => {
    const wasThere = (await getStatus()).status !== "not_installed";
    await execAsync(`pm2 install ${MODULE_NAME} --no-color`, {
        env: safeEnv,
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
    });
    if (!wasThere) {
        try { fs.writeFileSync(MARKER_PATH, `${new Date().toISOString()}\n`); } catch { /* only uninstall reads it */ }
    }
    await setConfig({ max_size: "50M", retain: "7", compress: "true", rotateModule: "true" });
    return getStatus();
};

// One install at a time: the boot-time check and the panel's setup step
// usually ask within seconds of each other, and two `pm2 install` runs in the
// same ~/.pm2/modules trip over each other.
let inFlight = null;

/**
 * Install with the defaults unless the module is already in this PM2 — an
 * existing install and its settings are left exactly as they are.
 * Resolves to getStatus() plus `changed` (true when this call installed it).
 */
const ensureInstalled = ({ status = getStatus, run = install } = {}) => {
    if (!inFlight) {
        inFlight = (async () => {
            const before = await status();
            if (before.status === "unknown") {
                throw new Error(`Could not read PM2's process list — is pm2 installed in ${SAFE_PATH.split(":").join(" or ")}?`);
            }
            if (before.status !== "not_installed") return { ...before, changed: false };
            return { ...(await run()), changed: true };
        })().finally(() => {
            inFlight = null;
        });
    }
    return inFlight;
};

/** PM2_LOGROTATE=off in the agent's .env: this node manages its logs itself. */
const optedOut = () => String(process.env.PM2_LOGROTATE || "").toLowerCase() === "off";

/**
 * Every agent keeps PM2's logs from filling its disk, from the moment it is
 * set up: shortly after start, ensure the module. PM2_LOGROTATE=off opts out.
 */
const ensureOnBoot = (delayMs = 5000) => {
    if (optedOut()) return;
    setTimeout(() => {
        ensureInstalled()
            .then((r) => {
                if (r.changed) console.log(`[Agent] ${MODULE_NAME} installed (max 50M per log, keep 7, gzip)`);
            })
            .catch((err) => console.warn(`[Agent] Could not install ${MODULE_NAME}:`, err.message.split("\n")[0]));
    }, delayMs).unref();
};

module.exports = { getStatus, install, setConfig, ensureInstalled, ensureOnBoot, optedOut, MARKER_PATH };
