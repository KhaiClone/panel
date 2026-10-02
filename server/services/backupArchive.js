const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { setEnvKey, envValue } = require("../utils/envText");

// ─────────────────────────────────────────────────────────────────────────────
//  Backup files + the boot-time restore — the mechanism of template-discord-bot
//  (handlers/backup.js, BACKUP.md there), extended to the panel's two databases.
//
//  One backup = ONE Discord message:
//
//    20261002-1430__b7f3a1c9__env.txt
//    20261002-1430__b7f3a1c9__panel-000-of-001.gz
//    20261002-1430__3c9e0d12__shared-000-of-001.gz
//
//  <ts> is the UTC minute (sorting by name = sorting by time); <hash8> the first
//  8 hex of the SHA-256 of the UNCOMPRESSED database, so a restore verifies the
//  whole snapshot → gzip → cut → send → download → join → gunzip chain;
//  env.txt carries the panel database's hash. Each database is a VACUUM INTO
//  snapshot (consistent while the panel writes, WAL folded in), gzipped and cut
//  in 9 MB pieces. The names carry everything — there is no manifest, and
//  `cat …panel-*.gz | gunzip > panel.sqlite` works by hand.
//
//  Restore: the files go in restore/ (by hand, or staged by the Panel page) and
//  the panel restarts. restore() runs on the FIRST line of server/index.js,
//  before dotenv — .env may be one of the files — and synchronously. Nothing is
//  touched unless every piece is there and every checksum matches; the replaced
//  files are kept as *.bak-<ts>; the sources are deleted only once the result is
//  written, which also disarms it for the next restart.
//
//  Unlike a bot, the panel's data says who it is: the restored panel.sqlite
//  keeps the CURRENT fencing epoch (an older one would get this panel fenced by
//  its own agents) and the restored .env keeps this machine's PANEL_NODE_ID.
//
//  Loads nothing of the panel (no dotenv, no quick.db, no services): it runs
//  before any of them.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, "../..");

const CHUNK_SIZE = 9 * 1024 * 1024;
const MAX_CHUNKS = 9; // 10 attachments per message, one kept for env.txt
const KINDS = ["panel", "shared"];
const RESULT_FILE = "restore-last.json";

// <ts>__<hash8>__env.txt  |  <ts>__<hash8>__<db>-000-of-004.gz
const NAME_RE = /^(\d{8}-\d{4})__([0-9a-f]{8})__(?:env\.txt|(panel|shared)-(\d{3})-of-(\d{3})\.gz)$/;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const LEASE_KEY = "panel_lease"; // services/panelLease.js

const log = (msg) => console.log(`[Restore] ${msg}`);
const warn = (msg) => console.warn(`[Restore] ${msg}`);

const pad = (n) => String(n).padStart(3, "0");
const sha8 = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const fmtSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const badInput = (message) => Object.assign(new Error(message), { status: 400 });

const stamp = (date = new Date()) => {
    const p = (n) => String(n).padStart(2, "0");
    return (
        `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
        `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}`
    );
};

/** "20261002-1430" → "2026-10-02 14:30 UTC" */
const readableTs = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)} UTC`;

/** Where everything lives. Every path can be overridden (the test does). */
const targets = (opts = {}) => {
    const dataDir = opts.dataDir || path.join(ROOT, "data");
    return {
        dataDir,
        restoreDir: opts.restoreDir || path.join(ROOT, "restore"),
        panel: path.join(dataDir, "panel.sqlite"),
        shared: opts.sharedDb || process.env.SHARED_DB_PATH || path.join(dataDir, "shared.sqlite"),
        // dotenv reads .env from the working directory; pm2 starts the panel in ROOT.
        env: opts.envFile || path.join(ROOT, ".env"),
    };
};

/** { ts, hash8, kind: "env"|"panel"|"shared", index, total } or null. */
const parseName = (name) => {
    const m = NAME_RE.exec(String(name));
    if (!m) return null;
    const [, ts, hash8, kind, index, total] = m;
    return kind ? { ts, hash8, kind, index: Number(index), total: Number(total) } : { ts, hash8, kind: "env" };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Backup — B2..B6 of the template
// ─────────────────────────────────────────────────────────────────────────────

/** Consistent snapshot of a live database, WAL included, free pages dropped. */
const snapshot = (file, dest) => {
    const conn = new (require("better-sqlite3"))(file, { fileMustExist: true });
    try {
        conn.exec(`VACUUM INTO '${dest.replace(/\\/g, "/").replace(/'/g, "''")}'`);
    } finally {
        conn.close();
    }
};

/** The summary line people read in the channel. */
const describe = ({ ts, dbs, env }) =>
    [
        `Backup • ${readableTs(ts)}`,
        ...Object.entries(dbs).map(
            ([kind, d]) => `${kind}.sqlite ${fmtSize(d.size)} → ${fmtSize(d.gz)} (${d.chunks} mảnh) · SHA-256 ${d.hash8}…`,
        ),
        env ? "+ .env" : "(không có .env)",
        "Rollback: Copy Message Link → Panel Settings → Backup & Rollback",
    ].join("\n");

/**
 * Snapshot, hash, gzip and cut every database that exists, plus .env.
 * Returns { ts, files: [{ name, data }], summary, content } ready to send.
 */
const build = ({ dbs, envFile, tmpDir, date = new Date() }) => {
    const ts = stamp(date);
    const files = [];
    const summary = { ts, dbs: {}, env: false };

    for (const { kind, file } of dbs) {
        if (!fs.existsSync(file)) continue;
        const snap = path.join(tmpDir, `${kind}.sqlite`);
        snapshot(file, snap);
        const raw = fs.readFileSync(snap);
        const hash8 = sha8(raw);
        const gz = zlib.gzipSync(raw, { level: 6 });
        const chunks = [];
        for (let at = 0; at < gz.length; at += CHUNK_SIZE) chunks.push(gz.subarray(at, at + CHUNK_SIZE));
        chunks.forEach((data, i) => files.push({ name: `${ts}__${hash8}__${kind}-${pad(i)}-of-${pad(chunks.length)}.gz`, data }));
        summary.dbs[kind] = { size: raw.length, gz: gz.length, hash8, chunks: chunks.length };
    }

    const kinds = Object.keys(summary.dbs);
    if (!kinds.length) throw new Error("No database to back up");
    if (files.length > MAX_CHUNKS) {
        const sizes = kinds.map((k) => `${k} ${fmtSize(summary.dbs[k].size)}`).join(", ");
        throw new Error(
            `The databases are too large (${sizes}): ${files.length} pieces, more than the ${MAX_CHUNKS} one Discord message can carry. ` +
                "Time to move backups somewhere else.",
        );
    }

    if (envFile && fs.existsSync(envFile)) {
        const hash8 = (summary.dbs.panel || summary.dbs[kinds[0]]).hash8;
        files.unshift({ name: `${ts}__${hash8}__env.txt`, data: fs.readFileSync(envFile) });
        summary.env = true;
    }
    return { ts, files, summary, content: describe(summary) };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Restore — R2..R7: pick, join, verify. Touches nothing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn a set of backup files ({ name, data }) into a verified restore plan:
 * { ts, dbs: { panel?, shared?: { hash8, data, chunks } }, env: { name, data } | null,
 *   warnings, names }. Throws (status 400) on anything incomplete or damaged.
 */
const plan = (files) => {
    const warnings = [];
    const parsed = [];
    for (const f of files) {
        const p = parseName(f.name);
        if (p) parsed.push({ ...p, name: f.name, data: f.data });
    }
    if (!parsed.length) throw badInput("No backup files here (names look like 20261002-1430__b7f3a1c9__panel-000-of-001.gz)");

    // R3 — several backups: the newest one.
    const stamps = [...new Set(parsed.map((p) => p.ts))].sort();
    const ts = stamps[stamps.length - 1];
    if (stamps.length > 1) warnings.push(`${stamps.length} backups present, using the newest: ${ts}`);
    const mine = parsed.filter((p) => p.ts === ts);

    const dbs = {};
    for (const kind of KINDS) {
        const parts = mine.filter((p) => p.kind === kind);
        if (!parts.length) continue;

        const hashes = [...new Set(parts.map((p) => p.hash8))];
        if (hashes.length > 1) {
            throw badInput(`Two different ${kind} backups from ${ts} (${hashes.join(", ")}) — keep the files of one message only`);
        }
        const totals = new Set(parts.map((p) => p.total));
        if (totals.size > 1) throw badInput(`${kind}: the pieces disagree on how many there are`);

        // R4 — a missing piece and nothing is touched.
        const total = parts[0].total;
        const byIndex = new Map(parts.map((p) => [p.index, p]));
        const missing = [];
        for (let i = 0; i < total; i++) if (!byIndex.has(i)) missing.push(pad(i));
        if (missing.length) throw badInput(`${kind}: missing piece ${missing.join(", ")} (needs all ${total})`);

        // R5, R6
        const pieces = [];
        for (let i = 0; i < total; i++) pieces.push(byIndex.get(i).data);
        const gz = Buffer.concat(pieces);
        let data;
        try {
            data = zlib.gunzipSync(gz);
        } catch (err) {
            throw badInput(`${kind}: gunzip failed (${err.message})`);
        }

        // R7 — the last line of defence for the whole chain.
        const actual = sha8(data);
        if (actual !== hashes[0]) {
            throw badInput(`${kind}: checksum mismatch (the names say ${hashes[0]}, the data is ${actual}) — a piece is damaged or incomplete`);
        }
        if (!data.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) throw badInput(`${kind}: not an SQLite database`);
        dbs[kind] = { hash8: hashes[0], data, chunks: total, gz: gz.length };
    }
    if (!Object.keys(dbs).length) throw badInput(`Backup ${ts} has no database pieces — nothing to restore`);

    const envs = mine.filter((p) => p.kind === "env");
    let env = envs.length === 1 ? envs[0] : null;
    if (envs.length > 1) {
        env = envs.find((e) => e.hash8 === dbs.panel?.hash8);
        if (!env) throw badInput(`Several env.txt for ${ts} — keep the one of the message you want`);
    }

    return {
        ts,
        dbs,
        env: env ? { name: env.name, data: env.data } : null,
        warnings,
        names: parsed.map((p) => p.name),
    };
};

/** The backup files in a directory (others are reported, never read). */
const readDir = (dir) => {
    const files = [];
    const unrecognized = [];
    if (!fs.existsSync(dir)) return { files, unrecognized };
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isFile()) continue;
        if (parseName(e.name)) files.push({ name: e.name, data: fs.readFileSync(path.join(dir, e.name)) });
        else unrecognized.push(e.name);
    }
    return { files, unrecognized };
};

/** Names of the backup files waiting in restore/. */
const pending = (opts) => {
    const dir = targets(opts).restoreDir;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => parseName(n)).sort();
};

// ─────────────────────────────────────────────────────────────────────────────
//  Restore — R8..R10: write the result, keeping what it replaces
// ─────────────────────────────────────────────────────────────────────────────

const readKey = (conn, key) => {
    const row = conn.prepare("SELECT json FROM json WHERE ID = ?").get(key);
    return row ? JSON.parse(row.json) : null;
};
const writeKey = (conn, key, value) =>
    conn
        .prepare("INSERT INTO json (ID, json) VALUES (?, ?) ON CONFLICT(ID) DO UPDATE SET json = excluded.json")
        .run(key, JSON.stringify(value));

/**
 * Make the restored panel.sqlite (a file not yet in place) safe to boot here:
 *   - the fencing epoch never goes back: every agent follows the highest epoch
 *     it has seen and would fence a panel that comes back with a lower one
 *   - a backup taken while the panel ran on another node gets the same node
 *     fix-up as a move (panelMigration.finalizeIncoming): the old node loses
 *     its loopback controlHost, this one gets it
 */
const carryPanelState = (restoredFile, currentFile, here) => {
    const Database = require("better-sqlite3");
    const notes = [];

    let current = null;
    if (fs.existsSync(currentFile)) {
        try {
            const conn = new Database(currentFile, { readonly: true, fileMustExist: true });
            try {
                current = readKey(conn, LEASE_KEY);
            } finally {
                conn.close();
            }
        } catch (err) {
            notes.push(`The current panel.sqlite could not be read (${err.message}) — the epoch is the backup's`);
        }
    }

    const conn = new Database(restoredFile);
    try {
        const lease = readKey(conn, LEASE_KEY) || {};
        const was = { ...lease };

        if (Number.isInteger(current?.epoch) && current.epoch > (lease.epoch || 0)) {
            lease.epoch = current.epoch;
            notes.push(`Epoch kept at ${current.epoch} (the backup had ${was.epoch ?? "none"}) so the agents keep following this panel`);
        }

        if (here && lease.nodeId && lease.nodeId !== here) {
            const nodes = readKey(conn, "nodes");
            if (Array.isArray(nodes)) {
                for (const n of nodes) {
                    if (n._id === lease.nodeId && LOOPBACK.has(n.controlHost)) n.controlHost = null;
                    if (n._id === here) n.controlHost = "127.0.0.1";
                }
                writeKey(conn, "nodes", nodes);
            }
            const from = Array.isArray(nodes) ? nodes.find((n) => n._id === lease.nodeId)?.name : null;
            notes.push(`The backup was taken while the panel ran on ${from || lease.nodeId} — node addresses fixed as after a move`);
            lease.nodeId = here;
        }

        if (lease.epoch !== was.epoch || lease.nodeId !== was.nodeId) {
            lease.since = lease.since || Date.now();
            writeKey(conn, LEASE_KEY, lease);
        }
    } finally {
        conn.close();
    }
    return notes;
};

/** `${file}.bak-<now>`, never one that already exists. */
const freeBakName = (file, now) => {
    let bak = `${file}.bak-${now}`;
    for (let i = 2; fs.existsSync(bak); i++) bak = `${file}.bak-${now}-${i}`;
    return bak;
};

/** Write a verified plan in place. Returns { restored, kept, notes }. */
const apply = (planned, opts = {}) => {
    const t = targets(opts);
    const notes = [];
    const currentEnv = fs.existsSync(t.env) ? fs.readFileSync(t.env, "utf8") : null;
    const restoredEnv = planned.env ? planned.env.data.toString("utf8") : null;
    // This machine's node: the current .env says it; on a bare machine, the backup.
    const here = envValue(currentEnv, "PANEL_NODE_ID") || envValue(restoredEnv, "PANEL_NODE_ID");

    // Everything is written next to its target first; only then is anything replaced.
    const staged = [];
    fs.mkdirSync(t.dataDir, { recursive: true });
    try {
        for (const kind of KINDS) {
            const db = planned.dbs[kind];
            if (!db) continue;
            const tmp = `${t[kind]}.restore-tmp`;
            rmrf(tmp);
            fs.writeFileSync(tmp, db.data);
            staged.push({ target: t[kind], tmp, label: path.basename(t[kind]) });
            if (kind === "panel") notes.push(...carryPanelState(tmp, t.panel, here));
        }
        if (restoredEnv !== null) {
            let text = restoredEnv;
            const said = envValue(text, "PANEL_NODE_ID");
            if (currentEnv && here && said !== here) {
                text = setEnvKey(text, "PANEL_NODE_ID", here);
                notes.push(`.env: PANEL_NODE_ID kept as ${here} (the backup said ${said || "nothing"})`);
            }
            const tmp = `${t.env}.restore-tmp`;
            fs.writeFileSync(tmp, text);
            staged.push({ target: t.env, tmp, label: ".env" });
        }
    } catch (err) {
        for (const s of staged) rmrf(s.tmp);
        throw err;
    }

    // R8 — keep what is replaced. R9 — its WAL / journal belong to it, not to
    // the new file: they move along (an SQLite file finds them by name), so the
    // .bak stays complete and openable.
    const now = stamp();
    const kept = [];
    const done = [];
    try {
        for (const { target, tmp, label } of staged) {
            if (fs.existsSync(target)) {
                const bak = freeBakName(target, now);
                fs.renameSync(target, bak);
                for (const suffix of ["-wal", "-shm", "-journal"]) {
                    if (fs.existsSync(target + suffix)) fs.renameSync(target + suffix, bak + suffix);
                }
                kept.push(path.basename(bak));
            }
            // R10
            fs.renameSync(tmp, target);
            done.push(label);
        }
    } catch (err) {
        for (const s of staged) rmrf(s.tmp);
        // The sources stay in restore/: the next start replays the whole backup.
        throw new Error(`${err.message}${done.length ? ` (already replaced: ${done.join(", ")}; kept: ${kept.join(", ")})` : ""}`);
    }
    return { restored: done, kept, notes };
};

const writeResult = (t, result) => {
    try {
        fs.mkdirSync(t.dataDir, { recursive: true });
        fs.writeFileSync(path.join(t.dataDir, RESULT_FILE), JSON.stringify(result, null, 2));
    } catch (err) {
        warn(`Could not record the result: ${err.message}`);
    }
};

/** What the last restore attempt did (for the Panel page), or null. */
const lastResult = (opts) => {
    try {
        return JSON.parse(fs.readFileSync(path.join(targets(opts).dataDir, RESULT_FILE), "utf8"));
    } catch {
        return null;
    }
};

/**
 * R1..R12. Runs before dotenv: synchronous, and never throws — a broken
 * restore must not keep the panel from starting with the data it has.
 * Returns true when something was restored.
 */
const restore = (opts = {}) => {
    const t = targets(opts);
    try {
        // R1
        if (!fs.existsSync(t.restoreDir)) {
            fs.mkdirSync(t.restoreDir, { recursive: true });
            return false;
        }
        // R2
        const { files, unrecognized } = readDir(t.restoreDir);
        for (const name of unrecognized) warn(`Ignoring ${name} — not a backup file name`);
        if (!files.length) return false;

        // R3..R7
        let planned;
        try {
            planned = plan(files);
        } catch (err) {
            warn(`NOT restoring: ${err.message}. The panel starts with its current data; fix restore/ and restart.`);
            writeResult(t, { ok: false, at: Date.now(), error: err.message, files: files.map((f) => f.name) });
            return false;
        }
        for (const w of planned.warnings) warn(w);

        // R8..R10
        const report = apply(planned, opts);
        for (const n of report.notes) log(n);

        // R11 — only now that the result is in place; this also disarms it.
        for (const name of planned.names) rmrf(path.join(t.restoreDir, name));

        log(
            `Restored backup ${planned.ts}: ${report.restored.join(", ")}` +
                (report.kept.length ? ` — previous files kept as ${report.kept.join(", ")}` : ""),
        );
        writeResult(t, { ok: true, at: Date.now(), backup: planned.ts, ...report, warnings: planned.warnings });
        return true;
    } catch (err) {
        warn(`Restore failed, skipped: ${err.message}`);
        writeResult(t, { ok: false, at: Date.now(), error: err.message });
        return false;
    }
};

module.exports = {
    NAME_RE,
    MAX_CHUNKS,
    fmtSize,
    stamp,
    readableTs,
    targets,
    parseName,
    build,
    plan,
    readDir,
    pending,
    apply,
    restore,
    lastResult,
};
