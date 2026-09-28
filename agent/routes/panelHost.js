const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const { pipeline, Transform } = require("stream");
const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);
const si = require("systeminformation");
const { decrypt } = require("../utils/crypto");
const envFile = require("../utils/envFile");
const pm2 = require("../services/pm2");
const { isPortFree } = require("../services/ufw");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
//  Hosting the panel on this node — the receiving end of a panel move.
//
//  The panel orchestrates the move from the node it currently runs on:
//    status → prepare (pull, deps, client build) → import (.env + panel.sqlite)
//    → samples (history, streamed) → start → health
//  and, afterwards, the NEW panel calls retire on the node it came from.
//
//  SECURITY: like /self/panel-*, nothing here takes a path from the request.
//  The panel lives in this agent's own checkout (or PANEL_DIR once set), and
//  every file written has one of a fixed set of names. Secrets arrive
//  AES-GCM-encrypted with this agent's key (utils/crypto.js).
// ─────────────────────────────────────────────────────────────────────────────

// The agent lives inside the panel repo — its checkout is where a panel moved
// here runs from.
const REPO_ROOT = path.resolve(__dirname, "../..");
const AGENT_ENV = path.resolve(__dirname, "../.env");

const panelDir = () => process.env.PANEL_DIR || REPO_ROOT;
const pm2Name = () => process.env.PANEL_PM2_NAME || "bot-panel";

const IMPORTS = {
    env: ".env",
    db: path.join("data", "panel.sqlite"),
    marker: path.join("data", "migration-in.json"),
};

const stampNow = () => new Date().toISOString().replace(/[:.]/g, "-");
const git = async (dir, args) => (await execAsync(`git -C "${dir}" ${args}`, { timeout: 15_000 })).stdout.trim();

/** Keep whatever was there as <file>.pre-import-<stamp> rather than deleting it. */
const setAside = (file, stamp) => {
    if (!fs.existsSync(file)) return null;
    const dest = `${file}.pre-import-${stamp}`;
    fs.renameSync(file, dest);
    return dest;
};

/** A running panel's files are never overwritten underneath it. */
const refuseWhileOnline = async (req, res, next) => {
    try {
        if ((await pm2.getBotStatus(pm2Name())).status === "online") {
            return res.status(409).json({
                error: `A panel ("${pm2Name()}") is running on this node — refusing to overwrite its files`,
            });
        }
        next();
    } catch (err) {
        next(err);
    }
};

const tail = (parts, max = 8000) => {
    const text = parts.filter(Boolean).join("\n").trim();
    return text.length > max ? `…${text.slice(-max)}` : text;
};

/**
 * GET /panel-host/status?port=1975
 * Can this node run the panel, and how far along is it?
 */
router.get("/status", async (req, res, next) => {
    try {
        const dir = panelDir();
        const has = (rel) => fs.existsSync(path.join(dir, rel));
        const port = parseInt(req.query.port, 10) || null;

        let commit = null;
        let branch = null;
        try {
            commit = await git(dir, "rev-parse HEAD");
            branch = await git(dir, "rev-parse --abbrev-ref HEAD");
        } catch { /* not a git checkout */ }

        const [mem, disks, live] = await Promise.all([
            si.mem(),
            si.fsSize().catch(() => []),
            pm2.getBotStatus(pm2Name()),
        ]);
        // The filesystem holding the panel dir: the longest mount point prefixing it.
        const disk = disks
            .filter((d) => dir === d.mount || dir.startsWith(d.mount.endsWith("/") ? d.mount : `${d.mount}/`))
            .sort((a, b) => b.mount.length - a.mount.length)[0];

        res.json({
            dir,
            hosting: !!process.env.PANEL_DIR,
            user: os.userInfo().username,
            pm2Name: pm2Name(),
            commit,
            branch,
            hasEnv: has(".env"),
            hasDb: has(IMPORTS.db),
            depsInstalled: has("node_modules/express") && has("node_modules/better-sqlite3"),
            clientBuilt: has("client/dist/index.html"),
            panelProcess: live.status,
            portFree: port ? await isPortFree(port) : null,
            nginx: fs.existsSync("/etc/nginx/sites-enabled"),
            memAvailableBytes: mem.available,
            diskFreeBytes: disk ? disk.size - disk.used : null,
        });
    } catch (err) {
        next(err);
    }
});

// One long operation at a time: two overlapping `npm install` runs in the same
// tree leave node_modules in a state neither expects.
let busy = null;

/**
 * POST /panel-host/prepare   body: { commit }
 * git pull → deps → client build → dependency check. Nothing is started and
 * nothing the panel owns is touched, so this runs long before the move itself.
 * The checkout must end up on exactly the panel's commit: the new panel opens
 * the old one's database, and a code/schema mismatch there is not recoverable
 * mid-move.
 */
router.post("/prepare", async (req, res) => {
    const { commit } = req.body || {};
    if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/.test(commit)) {
        return res.status(400).json({ error: "commit (the panel's git commit) is required" });
    }
    if (busy) return res.status(409).json({ error: `Another operation is running: ${busy}` });
    busy = "prepare";

    const dir = panelDir();
    const out = [];
    const run = async (cmd, timeout) => {
        out.push(`$ ${cmd}`);
        const { stdout, stderr } = await execAsync(cmd, { cwd: dir, timeout, maxBuffer: 10 * 1024 * 1024 });
        out.push(stdout, stderr);
    };

    try {
        await run("git pull --ff-only", 120_000);
        const head = await git(dir, "rev-parse HEAD");
        if (!head.startsWith(commit)) {
            throw new Error(
                `This node's checkout is at ${head.slice(0, 7)} but the panel runs ${commit.slice(0, 7)}. ` +
                    `Run "Rebuild & Restart" on the panel first so both sit on the same commit.`,
            );
        }
        await run("npm run update:deps", 600_000);
        await run("npm run build", 300_000);
        await run(
            `node -e "Object.keys(require('./package.json').dependencies).forEach(d => require.resolve(d))"`,
            30_000,
        );
        res.json({ ok: true, commit: head, output: tail(out) });
    } catch (err) {
        if (err.stdout) out.push(err.stdout);
        if (err.stderr) out.push(err.stderr);
        let reason = err.message.split("\n")[0];
        if (err.killed && err.signal === "SIGKILL") {
            reason = "Killed by the OS — most likely out of memory during the client build.";
        } else if (err.killed) {
            reason = "Timed out.";
        }
        res.status(500).json({ error: reason, output: tail(out) });
    } finally {
        busy = null;
    }
});

/**
 * POST /panel-host/import
 * body: { files: { env, db, marker }, sha256: { env, db, marker } }
 * Each file is encrypted with this agent's key; db is the base64 of panel.sqlite.
 * Whatever already sits at those paths is set aside, never deleted.
 */
router.post("/import", refuseWhileOnline, (req, res, next) => {
    try {
        const { files, sha256 } = req.body || {};
        if (!files || typeof files !== "object") return res.status(400).json({ error: "files is required" });

        const plain = {};
        for (const key of Object.keys(IMPORTS)) {
            if (!files[key]) return res.status(400).json({ error: `files.${key} is missing` });
            let text;
            try {
                text = decrypt(files[key], process.env.AGENT_API_KEY);
            } catch {
                return res.status(400).json({ error: `files.${key} could not be decrypted with this node's key` });
            }
            const buf = key === "db" ? Buffer.from(text, "base64") : Buffer.from(text, "utf8");
            const want = sha256?.[key];
            if (want && crypto.createHash("sha256").update(buf).digest("hex") !== want) {
                return res.status(400).json({ error: `files.${key} failed its checksum` });
            }
            plain[key] = buf;
        }
        if (plain.db.subarray(0, 16).toString("latin1") !== "SQLite format 3\u0000") {
            return res.status(400).json({ error: "files.db is not an SQLite database" });
        }

        const dir = panelDir();
        fs.mkdirSync(path.join(dir, "data"), { recursive: true });
        const stamp = stampNow();
        const setAsideFiles = [];
        for (const [key, rel] of Object.entries(IMPORTS)) {
            const dest = path.join(dir, rel);
            // A leftover WAL/journal next to a replaced database would be replayed
            // into it on open — move those aside with the file they belong to.
            const companions = key === "db" ? ["", "-wal", "-shm", "-journal"] : [""];
            for (const suffix of companions) {
                const moved = setAside(dest + suffix, stamp);
                if (moved) setAsideFiles.push(moved);
            }
            fs.writeFileSync(dest, plain[key], { mode: key === "env" ? 0o600 : 0o644 });
        }

        res.json({ ok: true, dir, setAside: setAsideFiles });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /panel-host/samples   raw body, header x-sha256
 * Resource history (samples.sqlite) — tens of MB, so it is streamed rather than
 * sent as JSON. Not secret, but checksummed: a truncated copy would be a
 * corrupt database.
 */
router.put("/samples", refuseWhileOnline, (req, res, next) => {
    const want = String(req.headers["x-sha256"] || "");
    if (!/^[0-9a-f]{64}$/.test(want)) return res.status(400).json({ error: "x-sha256 header is required" });

    const dataDir = path.join(panelDir(), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = path.join(dataDir, `samples.sqlite.incoming-${Date.now()}`);
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const hasher = new Transform({
        transform(chunk, enc, cb) {
            hash.update(chunk);
            bytes += chunk.length;
            cb(null, chunk);
        },
    });

    pipeline(req, hasher, fs.createWriteStream(tmp, { mode: 0o644 }), (err) => {
        if (err) {
            fs.rmSync(tmp, { force: true });
            return next(err);
        }
        if (hash.digest("hex") !== want) {
            fs.rmSync(tmp, { force: true });
            return res.status(400).json({ error: "samples.sqlite failed its checksum" });
        }
        try {
            const dest = path.join(dataDir, "samples.sqlite");
            const stamp = stampNow();
            for (const suffix of ["", "-wal", "-shm"]) setAside(dest + suffix, stamp);
            fs.renameSync(tmp, dest);
            res.json({ ok: true, bytes });
        } catch (e) {
            next(e);
        }
    });
});

/**
 * POST /panel-host/start
 * Mark this node as the panel's host (PANEL_DIR, persisted to agent/.env so the
 * /self/panel-* endpoints and later restarts see it) and start the panel.
 */
router.post("/start", async (req, res, next) => {
    try {
        const dir = panelDir();
        if (!fs.existsSync(path.join(dir, ".env"))) {
            return res.status(400).json({ error: `No .env in ${dir} — import the panel's data first` });
        }
        if (!fs.existsSync(path.join(dir, "client/dist/index.html"))) {
            return res.status(400).json({ error: "The client is not built here — run prepare first" });
        }
        process.env.PANEL_DIR = dir;
        envFile.setKey(AGENT_ENV, "PANEL_DIR", dir);
        const output = await pm2.startEcosystem(dir);
        res.json({ ok: true, dir, pm2Name: pm2Name(), output: output.slice(-2000) });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /panel-host/health?port=1975
 * The local panel's own /api/health, as seen from this machine.
 */
router.get("/health", (req, res) => {
    const port = parseInt(req.query.port, 10);
    if (!port || port < 1 || port > 65535) return res.status(400).json({ error: "port is required" });

    const request = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 5000 }, (resp) => {
        let body = "";
        resp.setEncoding("utf8");
        resp.on("data", (c) => {
            if (body.length < 10_000) body += c;
        });
        resp.on("end", () => {
            let json = null;
            try { json = JSON.parse(body); } catch { /* not JSON */ }
            res.json({ ok: resp.statusCode === 200, status: resp.statusCode, body: json });
        });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (e) => {
        if (!res.headersSent) res.json({ ok: false, error: e.code || e.message });
    });
});

/**
 * POST /panel-host/retire
 * This node no longer hosts the panel: remove it from PM2 (and the saved dump,
 * so a reboot cannot resurrect it), rename its .env so nothing can start it by
 * accident, and drop PANEL_DIR. data/ is kept — it is the rollback copy.
 * Also how an aborted move cleans up the target, where the imported .env may
 * sit in the checkout before PANEL_DIR was ever set.
 */
router.post("/retire", async (req, res, next) => {
    try {
        const name = pm2Name();
        const wasRunning = (await pm2.getBotStatus(name)).status;
        await pm2.deleteBot(name); // pm2 delete + pm2 save; a no-op when absent

        let retiredEnv = null;
        const envPath = path.join(panelDir(), ".env");
        if (fs.existsSync(envPath)) {
            retiredEnv = `${envPath}.retired-${stampNow()}`;
            fs.renameSync(envPath, retiredEnv);
        }
        if (process.env.PANEL_DIR) {
            delete process.env.PANEL_DIR;
            envFile.setKey(AGENT_ENV, "PANEL_DIR", null);
        }
        res.json({ ok: true, wasRunning, retiredEnv });
    } catch (err) {
        next(err);
    }
});

// ── Reachability as seen from THIS machine ─────────────────────────────────────

const HOST_RE = /^[a-zA-Z0-9.:-]{1,255}$/;

const tcpCheck = (host, port, timeout = 4000) =>
    new Promise((resolve) => {
        let settled = false;
        const sock = net.connect({ host, port });
        const done = (ok, error = null) => {
            if (settled) return;
            settled = true;
            sock.destroy();
            resolve({ host, port, ok, error });
        };
        sock.setTimeout(timeout, () => done(false, "timeout"));
        sock.once("connect", () => done(true));
        sock.once("error", (e) => done(false, e.code || e.message));
    });

/**
 * POST /panel-host/probe   body: { targets: [{ host, port }] }  (max 32)
 * TCP connect test — can a panel running here reach these agents/services?
 */
router.post("/probe", async (req, res) => {
    const targets = Array.isArray(req.body?.targets) ? req.body.targets.slice(0, 32) : [];
    const valid = targets.filter(
        (t) => t && HOST_RE.test(String(t.host)) && Number.isInteger(Number(t.port)) && t.port > 0 && t.port < 65536,
    );
    res.json({ results: await Promise.all(valid.map((t) => tcpCheck(String(t.host), Number(t.port)))) });
});

module.exports = router;
