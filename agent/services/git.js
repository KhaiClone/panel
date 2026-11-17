const { exec, execFile } = require("child_process");
const util = require("util");
const fs = require("fs");
const path = require("path");
const nodeVersions = require("./nodeVersions");
const { projectEnv } = require("../utils/projectEnv");
const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

// The agent owns every git operation — the panel runs no git of its own, so
// clone/pull/install work the same on every node.

const GIT_TIMEOUT = 120_000;
const INSTALL_TIMEOUT = 600_000;

// ─────────────────────────────────────────────────────────────────────────────
//  GitHub's host keys travel with the agent.
//
//  Clones go over SSH (git@github.com:…) and the agent runs them with no TTY,
//  so ssh cannot ask "continue connecting (yes/no)?" — a node whose
//  ~/.ssh/known_hosts lacks github.com fails with "Host key verification
//  failed". That hit VPS dio 2 on 2026-11-11: its panel checkout came over
//  HTTPS, nothing had ever SSHed to GitHub there, so it had no known_hosts at
//  all. The Git keys page's Test (accept-new) only ever runs on the node that
//  hosts the panel, so a fresh node had no way out from the panel.
//
//  Instead of trusting whatever answers on first contact, ssh also reads
//  ../github_known_hosts (GitHub's published keys) as a global known-hosts
//  file. StrictHostKeyChecking is left alone: an unknown or changed key is
//  still refused, ~/.ssh/known_hosts and /etc/ssh/ssh_known_hosts* are still
//  read, and other hosts behave exactly as before.
//
//  GIT_SSH_COMMAND outranks core.sshCommand — no node sets one (checked
//  2026-11-11); one already in the agent's environment is kept as is.
// ─────────────────────────────────────────────────────────────────────────────

const GITHUB_KNOWN_HOSTS = path.join(__dirname, "..", "github_known_hosts");

/** Single-quote for sh, which git runs GIT_SSH_COMMAND through. */
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const GIT_SSH_COMMAND = `ssh -o ${shQuote(
    `GlobalKnownHostsFile="${GITHUB_KNOWN_HOSTS}" /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2`,
)}`;

/** `base` plus the ssh command above, for git commands that reach a remote. */
const sshEnv = (base = process.env) =>
    base.GIT_SSH_COMMAND ? { ...base } : { ...base, GIT_SSH_COMMAND };

const cloneRepo = async (repoUrl, targetPath, branch = "main") => {
    const cmd = `git clone -b ${branch} --depth 1 "git@github.com:${repoUrl.replace("https://github.com/", "")}" "${targetPath}"`;
    const { stdout, stderr } = await execAsync(cmd, { env: sshEnv(), timeout: GIT_TIMEOUT });
    return stdout || stderr;
};

/**
 * Read a checkout's origin URL and current branch. Both are informational, so
 * a folder that is not a git repo yields nulls instead of an error.
 */
const repoInfo = async (botPath) => {
    const one = async (cmd) => {
        try {
            const { stdout } = await execAsync(cmd, { cwd: botPath, timeout: 15_000 });
            return stdout.trim() || null;
        } catch {
            return null;
        }
    };
    return {
        repoUrl: await one("git remote get-url origin"),
        branch: await one("git rev-parse --abbrev-ref HEAD"),
    };
};

const pullRepo = async (botPath) => {
    try {
        // Hooks in the project's .git run here — without the agent's key.
        const { stdout, stderr } = await execAsync(`git pull`, {
            cwd: botPath,
            env: sshEnv(projectEnv()),
            timeout: GIT_TIMEOUT,
        });
        return stdout || stderr;
    } catch (err) {
        console.error(`[Git] Pull failed for ${botPath}:`, err.message);
        throw err;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  A renamed repo (2026-11-17): the panel names the customers' repos after
//  the customer and the bot and renames them when those change. GitHub
//  redirects the old name, but only until a new repo takes it — and with
//  names made of usernames, the next customer to pick that username would
//  take it, and this checkout would pull THEIR code. So the panel points
//  origin at the new name right after a rename.
//
//  Only the owner/name part changes: the URL keeps its form and host (an SSH
//  host alias stays), and the panel names the old owner/name it expects —
//  anything else in origin is refused rather than overwritten. execFile, no
//  shell; the project's own env (utils/projectEnv.js) like every git command
//  run inside a project.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_NAME = /^[\w.-]+\/[\w.-]+$/;
const ORIGIN = /^(.*[:/])([\w.-]+\/[\w.-]+?)(\.git)?(\/?)$/;

const gitIn = async (botPath, args) => {
    const { stdout } = await execFileAsync("git", args, { cwd: botPath, env: projectEnv(), timeout: 15_000 });
    return stdout.trim();
};

/** origin owner/name `from` → `to`. → { changed, url } */
const setOrigin = async (botPath, from, to) => {
    if (!OWNER_NAME.test(String(from || "")) || !OWNER_NAME.test(String(to || ""))) {
        throw Object.assign(new Error("from and to must be owner/name"), { status: 400 });
    }
    let url;
    try {
        url = await gitIn(botPath, ["remote", "get-url", "origin"]);
    } catch {
        throw Object.assign(new Error("This checkout has no origin remote"), { status: 409 });
    }
    const m = ORIGIN.exec(url);
    const now = m ? m[2].toLowerCase() : null;
    if (now === to.toLowerCase()) return { changed: false, url };
    if (now !== from.toLowerCase()) {
        throw Object.assign(new Error(`origin is ${url}, not ${from} — left as it is`), { status: 409 });
    }
    const next = `${m[1]}${to}${m[3] || ""}${m[4]}`;
    await gitIn(botPath, ["remote", "set-url", "origin", next]);
    return { changed: true, url: next };
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

const installDeps = async (botPath, installCommand = undefined, nodeVersion = null) => {
    if (installCommand === null || installCommand === "") return "(skipped — no install command)";

    const cmd = installCommand && installCommand.trim()
        ? installCommand.trim()
        : `npm install --omit=dev`;

    // Resolve the Node version before cleaning: a failed download must not
    // cost the project its node_modules. Install scripts are the project's
    // code: they run without the agent's key (utils/projectEnv.js).
    const env = projectEnv(await nodeVersions.envFor(nodeVersion));

    cleanPackageFolder(botPath, cmd);

    const { stdout, stderr } = await execAsync(
        cmd,
        { cwd: botPath, env, timeout: INSTALL_TIMEOUT, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout || stderr;
};

module.exports = { cloneRepo, pullRepo, setOrigin, installDeps, cleanPackageFolder, repoInfo, sshEnv, GITHUB_KNOWN_HOSTS };
