const { exec } = require("child_process");
const util = require("util");
const fs = require("fs");
const path = require("path");
const execAsync = util.promisify(exec);

// Timeout for git operations (ms) — large repos may need more
const GIT_TIMEOUT = 120_000;

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
 * Detect and remove the package folder for a given install command.
 * Supports npm / yarn / pnpm / bun → node_modules
 *          composer                → vendor
 *          pip / pip3              → venv (best-effort)
 *
 * @param {string} botPath   - Absolute path to the bot's directory
 * @param {string} cmd       - The install command that will be run
 */
const cleanPackageFolder = (botPath, cmd) => {
    const cmdLower = cmd.toLowerCase().trim();

    let folderName = null;

    if (
        cmdLower.startsWith("npm ") ||
        cmdLower.startsWith("yarn") ||
        cmdLower.startsWith("pnpm ") ||
        cmdLower.startsWith("bun ")
    ) {
        folderName = "node_modules";
    } else if (cmdLower.startsWith("composer ")) {
        folderName = "vendor";
    } else if (cmdLower.startsWith("pip ") || cmdLower.startsWith("pip3 ")) {
        folderName = "venv";
    }

    if (!folderName) return; // Unknown package manager — skip cleanup

    const targetPath = path.join(botPath, folderName);
    if (fs.existsSync(targetPath)) {
        console.log(`[Git] Removing old ${folderName} at ${targetPath}`);
        fs.rmSync(targetPath, { recursive: true, force: true });
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

    // Remove old package folder before reinstalling
    cleanPackageFolder(botPath, cmd);

    const { stdout, stderr } = await execAsync(
        cmd,
        { cwd: botPath, timeout: GIT_TIMEOUT },
    );
    return stdout || stderr;
};

module.exports = { cloneRepo, pullRepo, installDeps, cleanPackageFolder };
