const { exec } = require("child_process");
const util = require("util");
const fs = require("fs");
const path = require("path");
const execAsync = util.promisify(exec);

// Standalone copy of server/services/gitService.js — identical behavior so
// clone/pull/install work the same on every node.

const GIT_TIMEOUT = 120_000;
const INSTALL_TIMEOUT = 600_000;

const cloneRepo = async (repoUrl, targetPath, branch = "main") => {
    const cmd = `git clone -b ${branch} --depth 1 "git@github.com:${repoUrl.replace("https://github.com/", "")}" "${targetPath}"`;
    const { stdout, stderr } = await execAsync(cmd, { timeout: GIT_TIMEOUT });
    return stdout || stderr;
};

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

    if (!folderName) return;

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

const installDeps = async (botPath, installCommand = undefined) => {
    if (installCommand === null || installCommand === "") return "(skipped — no install command)";

    const cmd = installCommand && installCommand.trim()
        ? installCommand.trim()
        : `npm install --omit=dev`;

    cleanPackageFolder(botPath, cmd);

    const { stdout, stderr } = await execAsync(
        cmd,
        { cwd: botPath, timeout: INSTALL_TIMEOUT, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout || stderr;
};

module.exports = { cloneRepo, pullRepo, installDeps, cleanPackageFolder };
