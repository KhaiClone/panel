const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);
const fs = require("fs");
const path = require("path");
const os = require("os");

const SSH_DIR = path.join(os.homedir(), ".ssh");
const SSH_CONFIG = path.join(SSH_DIR, "config");

// Timeout for SSH operations
const SSH_TIMEOUT = 15_000;

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Ensure ~/.ssh exists with correct permissions */
const ensureSshDir = () => {
    if (!fs.existsSync(SSH_DIR)) {
        fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
    }
};

/** Read SSH config file, return content or empty string */
const readSshConfig = () => {
    if (!fs.existsSync(SSH_CONFIG)) return "";
    return fs.readFileSync(SSH_CONFIG, "utf8");
};

/** Write SSH config file */
const writeSshConfig = (content) => {
    fs.writeFileSync(SSH_CONFIG, content, { encoding: "utf8", mode: 0o644 });
};

/**
 * Parse SSH config into blocks.
 * Each block = { host, lines[] } where lines includes the Host line.
 */
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
            // Lines before any Host block (comments, etc.)
            if (!blocks._preamble) blocks._preamble = [];
            blocks._preamble = blocks._preamble || [];
            blocks._preamble.push(line);
        }
    }
    if (current) blocks.push(current);
    return blocks;
};

/**
 * Get the SSH key fingerprint using ssh-keygen -lf
 */
const getFingerprint = async (keyPath) => {
    try {
        const { stdout } = await execAsync(`ssh-keygen -lf "${keyPath}"`, { timeout: 5000 });
        return stdout.trim();
    } catch {
        return null;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  List Keys
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all SSH key pairs in ~/.ssh.
 * Returns array of { name, hasPrivate, hasPublic, publicKey, fingerprint, hostAlias }
 */
const listKeys = async () => {
    ensureSshDir();

    const files = fs.readdirSync(SSH_DIR);

    // Find .pub files and match with private keys
    const pubFiles = files.filter((f) => f.endsWith(".pub"));
    const keys = [];

    for (const pubFile of pubFiles) {
        const name = pubFile.replace(/\.pub$/, "");
        // Skip known_hosts, authorized_keys, config etc.
        if (["known_hosts", "authorized_keys", "config"].includes(name)) continue;

        const privatePath = path.join(SSH_DIR, name);
        const publicPath = path.join(SSH_DIR, pubFile);

        const hasPrivate = fs.existsSync(privatePath) && fs.statSync(privatePath).isFile();
        const publicKey = fs.readFileSync(publicPath, "utf8").trim();
        const fingerprint = await getFingerprint(publicPath);

        // Check if there's a Host alias in SSH config for this key
        const config = readSshConfig();
        const blocks = parseSshConfig(config);
        const matchingBlock = blocks.find(
            (b) =>
                b.lines &&
                b.lines.some((l) => l.includes(path.join(SSH_DIR, name)) || l.includes(`~/.ssh/${name}`)),
        );

        keys.push({
            name,
            hasPrivate,
            hasPublic: true,
            publicKey,
            fingerprint,
            hostAlias: matchingBlock?.host || null,
        });
    }

    // Also find private keys without .pub (less common but possible)
    const privateOnly = files.filter((f) => {
        if (f.endsWith(".pub") || f.startsWith(".")) return false;
        if (["known_hosts", "authorized_keys", "config"].includes(f)) return false;
        if (pubFiles.includes(f + ".pub")) return false; // Already handled above
        const fp = path.join(SSH_DIR, f);
        return fs.existsSync(fp) && fs.statSync(fp).isFile();
    });

    for (const name of privateOnly) {
        // Check if it looks like a key file (starts with -----BEGIN)
        try {
            const content = fs.readFileSync(path.join(SSH_DIR, name), "utf8");
            if (!content.startsWith("-----BEGIN")) continue;
        } catch {
            continue;
        }

        keys.push({
            name,
            hasPrivate: true,
            hasPublic: false,
            publicKey: null,
            fingerprint: null,
            hostAlias: null,
        });
    }

    return keys;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Generate Key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a new ED25519 SSH key pair.
 * @param {string} name    — Key filename (e.g. "github_myaccount")
 * @param {string} comment — Email or comment for the key
 */
const generateKey = async (name, comment = "") => {
    ensureSshDir();

    const keyPath = path.join(SSH_DIR, name);
    if (fs.existsSync(keyPath)) {
        throw new Error(`Key "${name}" already exists`);
    }

    const commentArg = comment ? `-C "${comment}"` : `-C ""`;
    await execAsync(`ssh-keygen -t ed25519 ${commentArg} -f "${keyPath}" -N ""`, {
        timeout: SSH_TIMEOUT,
    });

    // Set correct permissions
    fs.chmodSync(keyPath, 0o600);

    // Add SSH config entry
    addSshConfigEntry(name);

    // Read back the public key
    const publicKey = fs.readFileSync(keyPath + ".pub", "utf8").trim();
    const fingerprint = await getFingerprint(keyPath + ".pub");

    return { name, publicKey, fingerprint };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Import Key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Import an existing SSH key pair by writing key content to files.
 * @param {string} name       — Key filename
 * @param {string} privateKey — Private key content
 * @param {string} publicKey  — Public key content (optional, will derive if missing)
 */
const importKey = async (name, privateKey, publicKey) => {
    ensureSshDir();

    const keyPath = path.join(SSH_DIR, name);
    if (fs.existsSync(keyPath)) {
        throw new Error(`Key "${name}" already exists`);
    }

    // Write private key
    fs.writeFileSync(keyPath, privateKey.trim() + "\n", { encoding: "utf8", mode: 0o600 });

    // Write or derive public key
    if (publicKey) {
        fs.writeFileSync(keyPath + ".pub", publicKey.trim() + "\n", { encoding: "utf8", mode: 0o644 });
    } else {
        // Derive public key from private key
        try {
            await execAsync(`ssh-keygen -y -f "${keyPath}" > "${keyPath}.pub"`, { timeout: SSH_TIMEOUT });
        } catch {
            // If derivation fails, clean up
            fs.unlinkSync(keyPath);
            throw new Error("Invalid private key — could not derive public key");
        }
    }

    // Add SSH config entry
    addSshConfigEntry(name);

    const pubContent = fs.readFileSync(keyPath + ".pub", "utf8").trim();
    const fingerprint = await getFingerprint(keyPath + ".pub");

    return { name, publicKey: pubContent, fingerprint };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Delete Key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete an SSH key pair and its SSH config entry.
 * @param {string} name — Key filename
 */
const deleteKey = (name) => {
    const keyPath = path.join(SSH_DIR, name);
    const pubPath = keyPath + ".pub";

    if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    if (fs.existsSync(pubPath)) fs.unlinkSync(pubPath);

    // Remove SSH config entry
    removeSshConfigEntry(name);
};

// ─────────────────────────────────────────────────────────────────────────────
//  Test Connection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Test SSH connection to GitHub.
 * @param {string|null} keyName — Specific key to test, or null for default
 * @returns {{ success: boolean, output: string }}
 */
const testConnection = async (keyName = null) => {
    try {
        const identityArg = keyName ? `-i "${path.join(SSH_DIR, keyName)}"` : "";
        // ssh -T git@github.com returns exit code 1 even on success (it's expected)
        const { stdout, stderr } = await execAsync(
            `ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 ${identityArg} -T git@github.com 2>&1`,
            { timeout: SSH_TIMEOUT },
        ).catch((err) => {
            // Exit code 1 is expected from GitHub SSH test
            return { stdout: err.stdout || "", stderr: err.stderr || "" };
        });

        const output = (stdout || stderr || "").trim();
        // GitHub responds with "Hi <username>!" on successful auth
        const success = output.includes("successfully authenticated") || output.includes("Hi ");

        return { success, output };
    } catch (err) {
        return { success: false, output: err.message };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  SSH Config Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a Host entry to ~/.ssh/config for a GitHub key.
 * Host alias pattern: github.com-<keyname>
 */
const addSshConfigEntry = (name) => {
    const config = readSshConfig();
    const alias = `github.com-${name}`;

    // Check if entry already exists
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

/**
 * Remove a Host entry from ~/.ssh/config.
 */
const removeSshConfigEntry = (name) => {
    const config = readSshConfig();
    if (!config) return;

    const alias = `github.com-${name}`;
    const blocks = parseSshConfig(config);

    // Filter out the matching block and its comment
    const remaining = [];
    const preamble = blocks._preamble || [];

    for (const block of blocks) {
        if (block.host === alias) continue; // Skip this block
        remaining.push(block);
    }

    // Rebuild config
    let newConfig = preamble.join("\n");
    for (const block of remaining) {
        newConfig += "\n" + block.lines.join("\n");
    }

    // Remove comment lines for this key
    newConfig = newConfig
        .split("\n")
        .filter((line) => !line.includes(`# GitHub key: ${name}`))
        .join("\n");

    writeSshConfig(newConfig.trim() + "\n");
};

// ─────────────────────────────────────────────────────────────────────────────
//  Git Global Config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get global git user.name and user.email.
 */
const getGitConfig = async () => {
    let name = "";
    let email = "";

    try {
        const { stdout } = await execAsync("git config --global user.name", { timeout: 5000 });
        name = stdout.trim();
    } catch { /* not set */ }

    try {
        const { stdout } = await execAsync("git config --global user.email", { timeout: 5000 });
        email = stdout.trim();
    } catch { /* not set */ }

    return { name, email };
};

/**
 * Set global git user.name and user.email.
 */
const setGitConfig = async (name, email) => {
    if (name !== undefined) {
        await execAsync(`git config --global user.name "${name}"`, { timeout: 5000 });
    }
    if (email !== undefined) {
        await execAsync(`git config --global user.email "${email}"`, { timeout: 5000 });
    }
    return getGitConfig();
};

module.exports = {
    listKeys,
    generateKey,
    importKey,
    deleteKey,
    testConnection,
    getGitConfig,
    setGitConfig,
};
