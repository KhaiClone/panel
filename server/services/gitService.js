const { exec } = require("child_process");
const util = require("util");
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
    const { stdout, stderr } = await execAsync(`git -C "${botPath}" pull`, {
        timeout: GIT_TIMEOUT,
    });
    return stdout || stderr;
};

/**
 * Run a dependency install command inside the bot directory.
 * Defaults to `npm install` if no custom command is provided.
 * If installCommand is explicitly null or empty, the step is skipped entirely
 * (useful for pre-built projects like Lavalink / Java JARs).
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

    const { stdout, stderr } = await execAsync(
        cmd,
        { cwd: botPath, timeout: GIT_TIMEOUT },
    );
    return stdout || stderr;
};

module.exports = { cloneRepo, pullRepo, installDeps };
