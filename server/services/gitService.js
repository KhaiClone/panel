const { exec } = require("child_process");
const util = require("util");
const fs = require("fs");
const path = require("path");
const execAsync = util.promisify(exec);

// Timeout for git operations (ms) — large repos may need more
const GIT_TIMEOUT = 120_000;

// Fresh installs (after removing node_modules + lockfile) can take much longer
// than a git pull — especially with heavy native modules. 10 minutes.
const INSTALL_TIMEOUT = 600_000;

/**
 * Clone a git repository into the target directory.
 * Uses --depth 1 for a shallow clone (faster, saves disk space).
 *
 * @param {string} repoUrl    - Git URL (https or ssh)
 * @param {string} targetPath - Absolute path to clone into
 * @param {string} branch     - Branch to checkout (default: main)
 */
const cloneRepo = async (repoUrl, targetPath, branch = "main") => {
    const cmd = `git clone -b ${branch} --depth 1 "git@github.com:${repoUrl.replace("https://github.com/", "")}" "${targetPath}"`;
    const { stdout, stderr } = await execAsync(cmd, { timeout: GIT_TIMEOUT });
    return stdout || stderr;
};

/**
 * Pull the latest commits in an existing bot directory.
 *
 * @param {string} botPath - Absolute path to the bot's directory
 */
const pullRepo = async (botPath) => {
    try {
        const { stdout, stderr } = await execAsync(`git pull`, {
            cwd: botPath,
            timeout: GIT_TIMEOUT,
        });
        return stdout || stderr;
    } catch (err) {
        console.error(`[Git] Pull failed for ${botPath}:`, err.message);
        throw err;
    }
};

/**
 * Detect and remove the package folder AND lockfile for a given install command.
 * The lockfile has to go too — otherwise npm/yarn/pnpm resolve against the pinned
 * versions and never actually pick up updates in package.json.
 *
 * Supports npm      → node_modules + package-lock.json
 *          yarn     → node_modules + yarn.lock
 *          pnpm     → node_modules + pnpm-lock.yaml
 *          bun      → node_modules + bun.lockb / bun.lock
 *          composer → vendor       + composer.lock
 *          pip      → venv (best-effort; no lockfile)
 *
 * @param {string} botPath   - Absolute path to the bot's directory
 * @param {string} cmd       - The install command that will be run
 */
const cleanPackageFolder = (botPath, cmd) => {
    const cmdLower = cmd.toLowerCase().trim();

    let folderName = null;
    let lockFiles = [];

    if (cmdLower.startsWith("npm ") || cmdLower === "npm") {
        folderName = "node_modules";
        lockFiles = ["package-lock.json", "npm-shrinkwrap.json"];
    } else if (cmdLower.startsWith("yarn")) {
        folderName = "node_modules";
        lockFiles = ["yarn.lock"];
    } else if (cmdLower.startsWith("pnpm ") || cmdLower === "pnpm") {
        folderName = "node_modules";
        lockFiles = ["pnpm-lock.yaml"];
    } else if (cmdLower.startsWith("bun ") || cmdLower === "bun") {
        folderName = "node_modules";
        lockFiles = ["bun.lockb", "bun.lock"];
    } else if (cmdLower.startsWith("composer ")) {
        folderName = "vendor";
        lockFiles = ["composer.lock"];
    } else if (cmdLower.startsWith("pip ") || cmdLower.startsWith("pip3 ")) {
        folderName = "venv";
    }

    if (!folderName) return; // Unknown package manager — skip cleanup

    const targetPath = path.join(botPath, folderName);
    if (fs.existsSync(targetPath)) {
        console.log(`[Git] Removing old ${folderName} at ${targetPath}`);
        fs.rmSync(targetPath, { recursive: true, force: true });
    }

    for (const lockName of lockFiles) {
        const lockPath = path.join(botPath, lockName);
        if (fs.existsSync(lockPath)) {
            console.log(`[Git] Removing stale lockfile ${lockName}`);
            fs.rmSync(lockPath, { force: true });
        }
    }
};

/**
 * Run a dependency install command inside the bot directory.
 * Defaults to `npm install` if no custom command is provided.
 * If installCommand is explicitly null or empty, the step is skipped entirely
 * (useful for pre-built projects like Lavalink / Java JARs).
 *
 * Automatically removes the old package folder (e.g. node_modules) before
 * running the install so every reinstall starts from a clean state.
 *
 * @param {string} botPath        - Absolute path to the bot's directory
 * @param {string|null} installCommand - Custom install command, or null to skip
 */
const installDeps = async (botPath, installCommand = undefined) => {
    // Explicitly empty / null → skip
    if (installCommand === null || installCommand === "") return "(skipped — no install command)";

    // Use provided command or default to npm install
    const cmd = installCommand && installCommand.trim()
        ? installCommand.trim()
        : `npm install --omit=dev`;

    // Remove old package folder + lockfile so the reinstall actually picks up
    // updated versions from package.json (npm respects the lock otherwise).
    cleanPackageFolder(botPath, cmd);

    const { stdout, stderr } = await execAsync(
        cmd,
        { cwd: botPath, timeout: INSTALL_TIMEOUT, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout || stderr;
};

module.exports = { cloneRepo, pullRepo, installDeps, cleanPackageFolder };
