const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);
const fs = require("fs");
const path = require("path");
const os = require("os");

// Standalone copy of the panel's githubService, operating on THIS VPS's
// ~/.ssh. Keeps SSH keys and git config identical across nodes so a bot
// cloned from a private repo works on any node.

const SSH_DIR = path.join(os.homedir(), ".ssh");
const SSH_CONFIG = path.join(SSH_DIR, "config");
const SSH_TIMEOUT = 15_000;

const ensureSshDir = () => {
    if (!fs.existsSync(SSH_DIR)) fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
};

const readSshConfig = () => (fs.existsSync(SSH_CONFIG) ? fs.readFileSync(SSH_CONFIG, "utf8") : "");
const writeSshConfig = (content) => fs.writeFileSync(SSH_CONFIG, content, { encoding: "utf8", mode: 0o644 });

const parseSshConfig = (content) => {
    const blocks = [];
    let current = null;
    for (const line of content.split("\n")) {
        const hostMatch = line.match(/^\s*Host\s+(.+)/i);
        if (hostMatch) {
            if (current) blocks.push(current);
            current = { host: hostMatch[1].trim(), lines: [line] };
        } else if (current) {
            current.lines.push(line);
        } else {
            blocks._preamble = blocks._preamble || [];
            blocks._preamble.push(line);
        }
    }
    if (current) blocks.push(current);
    return blocks;
};

const getFingerprint = async (keyPath) => {
    try {
        const { stdout } = await execAsync(`ssh-keygen -lf "${keyPath}"`, { timeout: 5000 });
        return stdout.trim();
    } catch {
        return null;
    }
};

const listKeys = async () => {
    ensureSshDir();
    const files = fs.readdirSync(SSH_DIR);
    const pubFiles = files.filter((f) => f.endsWith(".pub"));
    const keys = [];

    for (const pubFile of pubFiles) {
        const name = pubFile.replace(/\.pub$/, "");
        if (["known_hosts", "authorized_keys", "config"].includes(name)) continue;

        const privatePath = path.join(SSH_DIR, name);
        const publicPath = path.join(SSH_DIR, pubFile);
        const hasPrivate = fs.existsSync(privatePath) && fs.statSync(privatePath).isFile();
        const publicKey = fs.readFileSync(publicPath, "utf8").trim();
        const fingerprint = await getFingerprint(publicPath);

        keys.push({ name, hasPrivate, hasPublic: true, publicKey, fingerprint });
    }
    return keys;
};

const addSshConfigEntry = (name) => {
    const config = readSshConfig();
    const alias = `github.com-${name}`;
    if (config.includes(`Host ${alias}`)) return;
    const entry = [
        "",
        `# GitHub key: ${name}`,
        `Host ${alias}`,
        `    HostName github.com`,
        `    User git`,
        `    IdentityFile ~/.ssh/${name}`,
        `    IdentitiesOnly yes`,
        "",
    ].join("\n");
    writeSshConfig(config.trimEnd() + "\n" + entry);
};

const removeSshConfigEntry = (name) => {
    const config = readSshConfig();
    if (!config) return;
    const alias = `github.com-${name}`;
    const blocks = parseSshConfig(config);
    const preamble = blocks._preamble || [];
    const remaining = blocks.filter((b) => b.host !== alias);

    let newConfig = preamble.join("\n");
    for (const block of remaining) newConfig += "\n" + block.lines.join("\n");
    newConfig = newConfig
        .split("\n")
        .filter((line) => !line.includes(`# GitHub key: ${name}`))
        .join("\n");
    writeSshConfig(newConfig.trim() + "\n");
};

const deleteKey = (name) => {
    const keyPath = path.join(SSH_DIR, name);
    if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    if (fs.existsSync(keyPath + ".pub")) fs.unlinkSync(keyPath + ".pub");
    removeSshConfigEntry(name);
};

/**
 * Write a key pair. With overwrite=true an existing key of the same name is
 * replaced (used by sync so re-pushing an updated key just works).
 */
const importKey = async (name, privateKey, publicKey, { overwrite = false } = {}) => {
    ensureSshDir();
    const keyPath = path.join(SSH_DIR, name);

    if (fs.existsSync(keyPath)) {
        if (!overwrite) throw new Error(`Key "${name}" already exists`);
        deleteKey(name);
    }

    fs.writeFileSync(keyPath, privateKey.trim() + "\n", { encoding: "utf8", mode: 0o600 });

    if (publicKey) {
        fs.writeFileSync(keyPath + ".pub", publicKey.trim() + "\n", { encoding: "utf8", mode: 0o644 });
    } else {
        try {
            await execAsync(`ssh-keygen -y -f "${keyPath}" > "${keyPath}.pub"`, { timeout: SSH_TIMEOUT });
        } catch {
            fs.unlinkSync(keyPath);
            throw new Error("Invalid private key — could not derive public key");
        }
    }

    addSshConfigEntry(name);
    const pubContent = fs.readFileSync(keyPath + ".pub", "utf8").trim();
    const fingerprint = await getFingerprint(keyPath + ".pub");
    return { name, publicKey: pubContent, fingerprint };
};

const testConnection = async (keyName = null) => {
    try {
        const identityArg = keyName ? `-i "${path.join(SSH_DIR, keyName)}"` : "";
        const { stdout, stderr } = await execAsync(
            `ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 ${identityArg} -T git@github.com 2>&1`,
            { timeout: SSH_TIMEOUT },
        ).catch((err) => ({ stdout: err.stdout || "", stderr: err.stderr || "" }));
        const output = (stdout || stderr || "").trim();
        const success = output.includes("successfully authenticated") || output.includes("Hi ");
        return { success, output };
    } catch (err) {
        return { success: false, output: err.message };
    }
};

const getGitConfig = async () => {
    let name = "", email = "";
    try { name = (await execAsync("git config --global user.name", { timeout: 5000 })).stdout.trim(); } catch { /* unset */ }
    try { email = (await execAsync("git config --global user.email", { timeout: 5000 })).stdout.trim(); } catch { /* unset */ }
    return { name, email };
};

const setGitConfig = async (name, email) => {
    if (name !== undefined && name !== "") await execAsync(`git config --global user.name "${name}"`, { timeout: 5000 });
    if (email !== undefined && email !== "") await execAsync(`git config --global user.email "${email}"`, { timeout: 5000 });
    return getGitConfig();
};

module.exports = { listKeys, importKey, deleteKey, testConnection, getGitConfig, setGitConfig };
