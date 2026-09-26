const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
//  Per-project Node.js versions.
//
//  A project may pin an exact Node version. Everything the agent runs for it —
//  install, build, start, its terminal — then finds that version's node, npm
//  and npx first on PATH. A project without a pin keeps the node on the system
//  PATH, exactly as before this existed.
//
//  Versions are the official nodejs.org Linux builds, checked against the
//  release's SHASUMS256.txt and unpacked under NODE_VERSIONS_DIR (default
//  ~/.panel-node/v20.18.1/…). No nvm and no root: each agent user owns its own
//  copies. A version is downloaded once per node, the first time something
//  needs it, and reused from then on without touching the network.
// ─────────────────────────────────────────────────────────────────────────────

const DIST = "https://nodejs.org/dist";
const VERSIONS_DIR = process.env.NODE_VERSIONS_DIR || path.join(os.homedir(), ".panel-node");
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

// nodejs.org's name for this CPU; undefined = no official Linux build for it.
const ARCH = { x64: "x64", arm64: "arm64", arm: "armv7l", ppc64: "ppc64le", s390x: "s390x" }[process.arch];
const SUPPORTED = process.platform === "linux" && !!ARCH;

/** Exact versions only — the value ends up in a directory name and a URL. */
const assertVersion = (version) => {
    if (typeof version !== "string" || !VERSION_RE.test(version)) {
        const err = new Error(`Invalid Node version "${version}" — expected an exact version such as 20.18.1`);
        err.status = 400;
        throw err;
    }
};

const versionDir = (version) => path.join(VERSIONS_DIR, `v${version}`);
const binDir = (version) => path.join(versionDir(version), "bin");
const isInstalled = (version) => VERSION_RE.test(version) && fs.existsSync(path.join(binDir(version), "node"));

const compareDesc = (a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
    return 0;
};

/** Exact versions unpacked on this node, newest first. */
const listInstalled = () => {
    let entries = [];
    try { entries = fs.readdirSync(VERSIONS_DIR); } catch { return []; }
    return entries
        .filter((d) => d.startsWith("v") && isInstalled(d.slice(1)))
        .map((d) => d.slice(1))
        .sort(compareDesc);
};

/** What `node` resolves to on this agent's PATH — the default for unpinned projects. */
const systemVersion = async () => {
    try {
        const { stdout } = await execAsync("node -v", { timeout: 10_000 });
        return stdout.trim().replace(/^v/, "") || null;
    } catch {
        return null;
    }
};

const fetchOk = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (res.status === 404) {
        const err = new Error(`nodejs.org has no ${url.slice(DIST.length + 1)}`);
        err.status = 400;
        throw err;
    }
    if (!res.ok) throw new Error(`nodejs.org answered HTTP ${res.status} for ${url}`);
    return res;
};

const download = async (version) => {
    if (!SUPPORTED) {
        throw new Error(`Pinned Node versions need Linux on a CPU nodejs.org builds for (this node is ${process.platform}/${process.arch})`);
    }
    const file = `node-v${version}-linux-${ARCH}.tar.gz`;
    const base = `${DIST}/v${version}`;

    // The checksum list first: it also tells a nonexistent version apart from
    // a download that failed halfway.
    const sums = await (await fetchOk(`${base}/SHASUMS256.txt`)).text();
    const line = sums.split("\n").find((l) => l.trim().endsWith(`  ${file}`));
    if (!line) throw new Error(`Node v${version} has no build named ${file}`);
    const expected = line.trim().split(/\s+/)[0];

    fs.mkdirSync(VERSIONS_DIR, { recursive: true });
    // Unpack beside the target and move it in whole, so a crash or a full disk
    // never leaves a half-extracted version that isInstalled() would accept.
    const staging = fs.mkdtempSync(path.join(VERSIONS_DIR, `.staging-v${version}-`));
    try {
        console.log(`[Node] Downloading ${file}`);
        const tarball = path.join(staging, file);
        const hash = crypto.createHash("sha256");
        const res = await fetchOk(`${base}/${file}`);
        await pipeline(
            Readable.fromWeb(res.body),
            async function* (source) {
                for await (const chunk of source) {
                    hash.update(chunk);
                    yield chunk;
                }
            },
            fs.createWriteStream(tarball),
        );
        if (hash.digest("hex") !== expected) {
            throw new Error(`Checksum mismatch for ${file} — refusing to install it`);
        }

        await execAsync(`tar -xzf "${tarball}" -C "${staging}"`, { timeout: 180_000 });
        const unpacked = path.join(staging, `node-v${version}-linux-${ARCH}`);
        const { stdout } = await execAsync(`"${path.join(unpacked, "bin", "node")}" -v`, { timeout: 15_000 });
        if (stdout.trim() !== `v${version}`) {
            throw new Error(`The unpacked node reports ${stdout.trim()}, expected v${version}`);
        }

        try {
            fs.renameSync(unpacked, versionDir(version));
        } catch (err) {
            if (!isInstalled(version)) throw err; // someone else finished first — theirs is fine
        }
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
    console.log(`[Node] Installed v${version} → ${versionDir(version)}`);
};

// One download per version at a time: two starts needing the same version
// share the first one's download instead of racing into the same directory.
const inFlight = new Map();

/**
 * Make `version` available on this node and return its bin directory.
 * Already installed → no network at all.
 */
const ensureVersion = async (version) => {
    assertVersion(version);
    if (isInstalled(version)) return binDir(version);
    if (!inFlight.has(version)) {
        inFlight.set(version, download(version).finally(() => inFlight.delete(version)));
    }
    await inFlight.get(version);
    return binDir(version);
};

/**
 * Environment for running something under `version`: the agent's own env with
 * that version's bin first on PATH. null/empty = the agent's env untouched.
 */
const envFor = async (version) => {
    if (!version) return process.env;
    const bin = await ensureVersion(version);
    return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}` };
};

module.exports = {
    VERSIONS_DIR,
    SUPPORTED,
    assertVersion,
    binDir,
    isInstalled,
    listInstalled,
    systemVersion,
    ensureVersion,
    envFor,
};
