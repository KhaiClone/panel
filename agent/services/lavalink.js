const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);

const pm2 = require("./pm2");

// ─────────────────────────────────────────────────────────────────────────────
//  Lavalink — one instance per node, owned by the panel.
//
//  Every bot that plays audio talks to 127.0.0.1 on its OWN node, so the panel
//  keeps a single shared config and pushes the same application.yml everywhere.
//
//  SECURITY: like /self/*, nothing here takes a path from the request. The
//  instance lives at the fixed LAVALINK_DIR from this agent's env. Accepting a
//  caller-supplied directory would turn a leaked agent key into arbitrary file
//  write — which is exactly what the root-jail in utils/paths.js prevents for
//  the project endpoints.
// ─────────────────────────────────────────────────────────────────────────────

const LAVALINK_DIR = process.env.LAVALINK_DIR || path.join(os.homedir(), "lavalink");
const PM2_NAME = process.env.LAVALINK_PM2_NAME || "lavalink";

const JAR = () => path.join(LAVALINK_DIR, "Lavalink.jar");
const JAR_TMP = () => path.join(LAVALINK_DIR, "Lavalink.jar.tmp");
const JAR_PREV = () => path.join(LAVALINK_DIR, "Lavalink.jar.prev");
const CONFIG = () => path.join(LAVALINK_DIR, "application.yml");
const VERSION_FILE = () => path.join(LAVALINK_DIR, "version.txt");
const VERSION_PREV = () => path.join(LAVALINK_DIR, "version.prev.txt");

// A jar plus the rollback copy is ~200MB. Refuse below this and say so, rather
// than filling the disk — a full disk also corrupts pm2's dump.pm2 (see pm2.js).
const MIN_FREE_BYTES = 1024 * 1024 * 1024;

const ensureDir = () => {
    if (!fs.existsSync(LAVALINK_DIR)) fs.mkdirSync(LAVALINK_DIR, { recursive: true });
    return LAVALINK_DIR;
};

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const readIf = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : null);

// ─────────────────────────────────────────────────────────────────────────────
//  Host facts the panel needs before it can install anything
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Java runtime on this node. Lavalink v4 needs 17+.
 * The agent never installs it: that would mean running package management as
 * root from an HTTP call. Missing java is reported, and the panel shows the
 * command to run by hand.
 */
const javaInfo = async () => {
    try {
        // `java -version` writes to stderr, which is not an error.
        const { stdout, stderr } = await execAsync("java -version 2>&1", { timeout: 15_000 });
        const out = (stdout || stderr || "").trim();
        const m = out.match(/version "?(\d+)(?:\.(\d+))?[^"]*"?/);
        // 1.8.0_x → major 8; 17.0.9 → major 17
        let major = null;
        if (m) major = m[1] === "1" ? parseInt(m[2], 10) : parseInt(m[1], 10);
        return { present: true, version: out.split("\n")[0].trim(), major };
    } catch {
        return { present: false, version: null, major: null };
    }
};

/** Alpine ships musl, and Lavalink publishes a separate jar for it. */
const libc = async () => {
    try {
        const { stdout, stderr } = await execAsync("ldd --version 2>&1 || true", { timeout: 10_000 });
        return /musl/i.test(stdout || stderr || "") ? "musl" : "glibc";
    } catch {
        return "glibc";
    }
};

/** Free bytes on the filesystem holding LAVALINK_DIR. */
const freeBytes = async () => {
    const dir = fs.existsSync(LAVALINK_DIR) ? LAVALINK_DIR : path.dirname(LAVALINK_DIR);
    try {
        // fs.statfs landed in Node 18.15 — fall back to df on anything older.
        if (typeof fs.statfsSync === "function") {
            const st = fs.statfsSync(dir);
            return st.bavail * st.bsize;
        }
    } catch { /* fall through to df */ }
    try {
        const { stdout } = await execAsync(`df -Pk "${dir}"`, { timeout: 10_000 });
        const line = stdout.trim().split("\n").pop().split(/\s+/);
        return parseInt(line[3], 10) * 1024;
    } catch {
        return null;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Status
// ─────────────────────────────────────────────────────────────────────────────

const status = async () => {
    const jar = JAR();
    const config = CONFIG();
    const jarStat = fs.existsSync(jar) ? fs.statSync(jar) : null;
    const configBuf = readIf(config);

    const [java, live, free, lib] = await Promise.all([
        javaInfo(),
        pm2.getBotStatus(PM2_NAME),
        freeBytes(),
        libc(),
    ]);

    return {
        dir: LAVALINK_DIR,
        pm2Name: PM2_NAME,
        installed: Boolean(jarStat),
        jarSize: jarStat ? jarStat.size : null,
        jarMtime: jarStat ? jarStat.mtimeMs : null,
        version: fs.existsSync(VERSION_FILE())
            ? fs.readFileSync(VERSION_FILE(), "utf8").trim() || null
            : null,
        configSha: configBuf ? sha256(configBuf) : null,
        hasRollback: fs.existsSync(JAR_PREV()),
        java,
        libc: lib,
        freeBytes: free,
        live, // pm2 status/cpu/memory/restarts
    };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Overwrite application.yml with the panel's rendered copy.
 * The previous file is always kept — it holds the password the running bots
 * are already using, and a bad write should stay recoverable by hand.
 * Returns the new sha so the panel can tell which nodes are in sync.
 */
const writeConfig = (content) => {
    if (typeof content !== "string" || !content.trim()) {
        throw new Error("config content is required");
    }
    ensureDir();
    const file = CONFIG();
    const before = readIf(file);
    const after = Buffer.from(content, "utf8");
    if (before && before.equals(after)) {
        return { sha: sha256(after), changed: false, backup: null };
    }
    let backup = null;
    if (before) {
        backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        fs.copyFileSync(file, backup);
    }
    fs.writeFileSync(file, after);
    return { sha: sha256(after), changed: true, backup };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Jar download
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET a URL to a file, following redirects (a GitHub release asset redirects to
 * objects.githubusercontent.com). Rejects anything that is not https.
 */
const downloadTo = (url, dest, depth = 0) =>
    new Promise((resolve, reject) => {
        if (depth > 5) return reject(new Error("Too many redirects"));
        if (!/^https:\/\//i.test(url)) return reject(new Error("Only https downloads are allowed"));

        const req = https.get(
            url,
            { headers: { "User-Agent": "bot-panel-agent", Accept: "application/octet-stream" }, timeout: 60_000 },
            (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return resolve(downloadTo(res.headers.location, dest, depth + 1));
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                }
                const out = fs.createWriteStream(dest);
                let bytes = 0;
                res.on("data", (c) => (bytes += c.length));
                res.pipe(out);
                out.on("finish", () => out.close(() => resolve(bytes)));
                out.on("error", (err) => reject(err));
                res.on("error", (err) => reject(err));
            },
        );
        req.on("timeout", () => req.destroy(new Error("Download timed out")));
        req.on("error", reject);
    });

/**
 * Fetch a new Lavalink.jar and swap it in.
 *
 * Nothing touches the live jar until the download is complete and verified:
 * download → size check → ZIP magic check → current jar becomes .prev →
 * tmp moves into place. A failure at any point leaves the running jar alone.
 */
const installJar = async ({ url, expectedSize = null, version = null }) => {
    if (!url) throw new Error("url is required");
    ensureDir();

    const free = await freeBytes();
    if (free !== null && free < MIN_FREE_BYTES) {
        throw new Error(
            `Only ${(free / 1024 / 1024).toFixed(0)}MB free on ${LAVALINK_DIR} — ` +
                `need at least ${MIN_FREE_BYTES / 1024 / 1024}MB for the jar plus its rollback copy`,
        );
    }

    const tmp = JAR_TMP();
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

    let bytes;
    try {
        bytes = await downloadTo(url, tmp);
    } catch (err) {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        throw err;
    }

    const fail = (msg) => {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        throw new Error(msg);
    };

    if (expectedSize && bytes !== expectedSize) {
        fail(`Downloaded ${bytes} bytes but the release says ${expectedSize} — refusing to install a truncated jar`);
    }
    // A jar is a zip. An HTML error page or a proxy interstitial is not.
    const head = Buffer.alloc(4);
    const fd = fs.openSync(tmp, "r");
    try {
        fs.readSync(fd, head, 0, 4, 0);
    } finally {
        fs.closeSync(fd);
    }
    if (!head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        fail("Downloaded file is not a jar (missing ZIP header) — the URL probably served an error page");
    }

    const jar = JAR();
    if (fs.existsSync(jar)) {
        if (fs.existsSync(JAR_PREV())) fs.unlinkSync(JAR_PREV());
        fs.renameSync(jar, JAR_PREV());
        // Remember which version that jar was, so a rollback can restore the
        // label too — otherwise the node reports an unknown version and the
        // next daily run tries the same broken release all over again.
        if (fs.existsSync(VERSION_FILE())) fs.copyFileSync(VERSION_FILE(), VERSION_PREV());
        else if (fs.existsSync(VERSION_PREV())) fs.unlinkSync(VERSION_PREV());
    }
    fs.renameSync(tmp, jar);
    if (version) fs.writeFileSync(VERSION_FILE(), `${version}\n`, "utf8");

    return { bytes, version, previous: fs.existsSync(JAR_PREV()) };
};

/** Put the previous jar back. Used when a fresh one fails its health check. */
const rollback = () => {
    const prev = JAR_PREV();
    if (!fs.existsSync(prev)) throw new Error("No previous jar to roll back to");
    const jar = JAR();
    if (fs.existsSync(jar)) fs.unlinkSync(jar);
    fs.renameSync(prev, jar);

    if (fs.existsSync(VERSION_PREV())) {
        fs.renameSync(VERSION_PREV(), VERSION_FILE());
    } else if (fs.existsSync(VERSION_FILE())) {
        // The version file described the jar we just threw away.
        fs.unlinkSync(VERSION_FILE());
    }
    return { restored: true, version: fs.existsSync(VERSION_FILE()) ? fs.readFileSync(VERSION_FILE(), "utf8").trim() : null };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Process control
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RSS ceiling to hand pm2, derived from the heap.
 *
 * -Xmx bounds the Java heap only; the process also needs metaspace, the code
 * cache, thread stacks and — for an audio server — a lot of direct byte
 * buffers. Twice the heap, never below 1G, leaves room for all of it while
 * still catching a genuine runaway.
 */
const pm2MemoryCeiling = (xmx) => {
    const m = /^(\d+)([MG])$/i.exec(String(xmx || ""));
    if (!m) return "2048M";
    const mb = m[2].toUpperCase() === "G" ? Number(m[1]) * 1024 : Number(m[1]);
    return `${Math.max(mb * 2, 1024)}M`;
};

/**
 * Start under PM2 using the agent's normal wrapper-script path, so Lavalink
 * behaves like every other managed process (same dump.pm2 guard, same logs).
 *
 * The memory ceiling is ALWAYS passed explicitly. "No flag" does not mean "no
 * limit" any more: pm2 7 applies a 200MB max_memory_restart of its own when
 * none is given, and a JVM crosses 200MB before it has finished booting — the
 * node then boots, reports ready, gets SIGKILLed and restarts, every 30
 * seconds, with nothing in the log to explain it. Node bots never noticed
 * because they sit under 100MB. (pm2 6 had no such default, which is why the
 * same code behaved on one node and not on another.)
 */
const start = async (heap = "512M") => {
    if (!fs.existsSync(JAR())) throw new Error("Lavalink.jar is not installed on this node");
    if (!fs.existsSync(CONFIG())) throw new Error("application.yml is missing — sync the config first");
    const java = await javaInfo();
    if (!java.present) {
        throw new Error("Java is not installed on this node — Lavalink v4 needs Java 17 or newer");
    }
    const xmx = /^\d+[MG]$/i.test(String(heap)) ? String(heap).toUpperCase() : "512M";
    return pm2.startBot(PM2_NAME, LAVALINK_DIR, `java -Xmx${xmx} -jar Lavalink.jar`, pm2MemoryCeiling(xmx), null);
};

const stop = () => pm2.stopBot(PM2_NAME);
const restart = () => pm2.restartBot(PM2_NAME);
const logs = (lines = 100) => pm2.getBotLogs(PM2_NAME, lines);

/**
 * Poll Lavalink's own /version endpoint until it answers.
 *
 * This is the only proof that an update actually worked: pm2 reports "online"
 * the moment the JVM starts, which is several seconds before Lavalink has
 * loaded its config — and a bad jar or a taken port stays "online" right up
 * until it exits.
 */
const health = ({ port = 2333, password = "", address = "0.0.0.0", timeoutMs = 60_000 } = {}) =>
    new Promise((resolve) => {
        // 0.0.0.0 means "every interface", which is not an address you can call.
        // A specific bind address has to be used as-is, or the probe knocks on
        // a port nothing is listening on and reports a healthy node as broken.
        const host = !address || address === "0.0.0.0" || address === "::" ? "127.0.0.1" : address;
        const deadline = Date.now() + timeoutMs;
        const attempt = () => {
            const req = http.get(
                { host, port, path: "/version", headers: { Authorization: password }, timeout: 5000 },
                (res) => {
                    let body = "";
                    res.on("data", (c) => (body += c));
                    res.on("end", () => {
                        if (res.statusCode === 200) return resolve({ ok: true, version: body.trim().slice(0, 120) });
                        retry(`HTTP ${res.statusCode}`);
                    });
                },
            );
            req.on("timeout", () => req.destroy(new Error("timeout")));
            req.on("error", (err) => retry(err.code || err.message));
        };
        const retry = (reason) => {
            if (Date.now() >= deadline) return resolve({ ok: false, error: reason });
            setTimeout(attempt, 2000);
        };
        attempt();
    });

module.exports = {
    LAVALINK_DIR,
    PM2_NAME,
    MIN_FREE_BYTES,
    javaInfo,
    libc,
    pm2MemoryCeiling,
    freeBytes,
    status,
    writeConfig,
    installJar,
    rollback,
    start,
    stop,
    restart,
    logs,
    health,
    sha256,
};
