const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);
const fs = require("fs");
const path = require("path");
const os = require("os");

// ─────────────────────────────────────────────────────────────────────────────
//  pm2-logrotate management
//
//  Lets the panel install and configure the pm2-logrotate module so PM2 logs
//  can never fill the disk again (a 2.9G pm2.log once contributed to a full
//  disk that corrupted dump.pm2 and lost every process on reboot).
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

// Editable settings and their validation rules. Anything not listed here is
// rejected, which also keeps `pm2 set` arguments shell-safe.
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

    return {
        installed: status !== "not_installed" || config !== null,
        status,
        config,
    };
};

/**
 * Install the pm2-logrotate module (idempotent — reinstalls if present)
 * and apply sensible defaults so it protects the disk out of the box.
 */
const install = async () => {
    await execAsync(`pm2 install ${MODULE_NAME} --no-color`, {
        env: safeEnv,
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
    });
    await setConfig({
        max_size: "50M",
        retain: "7",
        compress: "true",
        rotateModule: "true",
    });
    return getStatus();
};

/**
 * Apply settings via `pm2 set pm2-logrotate:<key> <value>`.
 * Only whitelisted keys with valid values are accepted.
 *
 * @param {Object} settings - e.g. { max_size: "50M", retain: "7" }
 */
const setConfig = async (settings) => {
    const entries = Object.entries(settings || {});
    if (entries.length === 0) throw new Error("No settings provided");

    for (const [key, value] of entries) {
        const rule = SETTING_RULES[key];
        if (!rule) throw new Error(`Unknown setting: "${key}"`);
        if (!rule.test(String(value).trim())) {
            throw new Error(`Invalid value for "${key}": "${value}"`);
        }
    }

    for (const [key, value] of entries) {
        await execAsync(
            `pm2 set ${MODULE_NAME}:${key} "${String(value).trim()}"`,
            { env: safeEnv, timeout: 30_000 },
        );
    }
    return getStatus();
};

module.exports = {
    getStatus,
    install,
    setConfig,
};
