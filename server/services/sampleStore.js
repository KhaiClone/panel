const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// ─────────────────────────────────────────────────────────────────────────────
//  Time-series store for resource history.
//
//  Two subjects, deliberately kept in separate tables because they answer
//  different questions and have very different row counts:
//
//    samples      one row per NODE per tick   — "is this VPS healthy?"
//    bot_samples  one row per BOT  per tick   — "which bot leaked memory?"
//
//  Two resolutions, so a month of history costs less than a week used to:
//
//    raw   every SAMPLE_INTERVAL (15s), kept RAW_RETENTION (3 days)
//    5m    5-minute averages, kept ROLLUP_RETENTION (30 days)
//
//  Callers never choose a table: queryNode/queryBot pick the resolution from
//  the requested time span. A dedicated better-sqlite3 file (not the QuickDB
//  panel.sqlite) — key-value JSON would mean rewriting the whole array every
//  15s, so this uses proper indexed tables.
// ─────────────────────────────────────────────────────────────────────────────

const RAW_RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days of 15s samples
const ROLLUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days of 5m averages
const ROLLUP_BUCKET_MS = 5 * 60 * 1000;

const dataDir = path.join(__dirname, "../../data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// SAMPLES_DB_PATH lets the test suite point at a throwaway file so it never
// touches recorded history; production always uses the default.
const dbPath = process.env.SAMPLES_DB_PATH || path.join(dataDir, "samples.sqlite");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
    CREATE TABLE IF NOT EXISTS samples (
        node_id TEXT NOT NULL,
        ts      INTEGER NOT NULL,
        cpu     REAL,
        ram     REAL,
        disk    REAL,
        rx      REAL,
        tx      REAL
    );
    CREATE INDEX IF NOT EXISTS idx_samples_node_ts ON samples (node_id, ts);

    CREATE TABLE IF NOT EXISTS samples_5m (
        node_id TEXT NOT NULL,
        ts      INTEGER NOT NULL,
        cpu     REAL,
        ram     REAL,
        disk    REAL,
        rx      REAL,
        tx      REAL,
        PRIMARY KEY (node_id, ts)
    );

    CREATE TABLE IF NOT EXISTS bot_samples (
        bot_id  TEXT NOT NULL,
        node_id TEXT,
        ts      INTEGER NOT NULL,
        cpu     REAL,
        mem     REAL,
        up      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_bot_samples_bot_ts ON bot_samples (bot_id, ts);
    CREATE INDEX IF NOT EXISTS idx_bot_samples_node_ts ON bot_samples (node_id, ts);

    CREATE TABLE IF NOT EXISTS bot_samples_5m (
        bot_id  TEXT NOT NULL,
        node_id TEXT,
        ts      INTEGER NOT NULL,
        cpu     REAL,
        mem     REAL,
        up      REAL,
        PRIMARY KEY (bot_id, ts)
    );

    CREATE TABLE IF NOT EXISTS rollup_state (
        name    TEXT PRIMARY KEY,
        last_ts INTEGER NOT NULL
    );
`);

// ─────────────────────────────────────────────────────────────────────────────
//  Writes
// ─────────────────────────────────────────────────────────────────────────────

const insNode = db.prepare(
    "INSERT INTO samples (node_id, ts, cpu, ram, disk, rx, tx) VALUES (@node_id, @ts, @cpu, @ram, @disk, @rx, @tx)",
);
const insNodeTx = db.transaction((rows) => {
    for (const r of rows) insNode.run(r);
});

const insBot = db.prepare(
    "INSERT INTO bot_samples (bot_id, node_id, ts, cpu, mem, up) VALUES (@bot_id, @node_id, @ts, @cpu, @mem, @up)",
);
const insBotTx = db.transaction((rows) => {
    for (const r of rows) insBot.run(r);
});

/** Insert every node's sample for one tick in a single transaction. */
const insertNodeSamples = (rows) => {
    if (rows && rows.length) insNodeTx(rows);
};

/** Insert every bot's sample for one tick in a single transaction. */
const insertBotSamples = (rows) => {
    if (rows && rows.length) insBotTx(rows);
};

// ─────────────────────────────────────────────────────────────────────────────
//  Reads — resolution is chosen from the requested span, never by the caller
// ─────────────────────────────────────────────────────────────────────────────

/** Raw data only goes back RAW_RETENTION_MS; older spans must read the rollup. */
const useRaw = (sinceTs) => sinceTs >= Date.now() - RAW_RETENTION_MS;

const qNodeRaw = db.prepare(
    "SELECT ts, cpu, ram, disk, rx, tx FROM samples WHERE node_id = ? AND ts >= ? ORDER BY ts ASC",
);
const qNode5m = db.prepare(
    "SELECT ts, cpu, ram, disk, rx, tx FROM samples_5m WHERE node_id = ? AND ts >= ? ORDER BY ts ASC",
);

/** One node's series since `sinceTs`, ascending. */
const queryNode = (nodeId, sinceTs) =>
    (useRaw(sinceTs) ? qNodeRaw : qNode5m).all(nodeId, sinceTs);

const qNodesRaw = db.prepare(
    "SELECT node_id, ts, cpu, ram, disk, rx, tx FROM samples WHERE ts >= ? ORDER BY ts ASC",
);
const qNodes5m = db.prepare(
    "SELECT node_id, ts, cpu, ram, disk, rx, tx FROM samples_5m WHERE ts >= ? ORDER BY ts ASC",
);

/**
 * Every node's series in one pass, as { nodeId: rows[] }.
 * One query instead of N — the systems list draws a sparkline per node.
 */
const queryAllNodes = (sinceTs) => {
    const out = {};
    for (const r of (useRaw(sinceTs) ? qNodesRaw : qNodes5m).all(sinceTs)) {
        (out[r.node_id] ||= []).push({ ts: r.ts, cpu: r.cpu, ram: r.ram, disk: r.disk, rx: r.rx, tx: r.tx });
    }
    return out;
};

const qBotRaw = db.prepare(
    "SELECT ts, cpu, mem, up FROM bot_samples WHERE bot_id = ? AND ts >= ? ORDER BY ts ASC",
);
const qBot5m = db.prepare(
    "SELECT ts, cpu, mem, up FROM bot_samples_5m WHERE bot_id = ? AND ts >= ? ORDER BY ts ASC",
);

/** One bot's series since `sinceTs`, ascending. */
const queryBot = (botId, sinceTs) =>
    (useRaw(sinceTs) ? qBotRaw : qBot5m).all(botId, sinceTs);

const qBotsOnNodeRaw = db.prepare(
    "SELECT bot_id, ts, cpu, mem, up FROM bot_samples WHERE node_id = ? AND ts >= ? ORDER BY ts ASC",
);
const qBotsOnNode5m = db.prepare(
    "SELECT bot_id, ts, cpu, mem, up FROM bot_samples_5m WHERE node_id = ? AND ts >= ? ORDER BY ts ASC",
);

/** Every bot on one node, as { botId: rows[] } — powers the node's bot breakdown. */
const queryBotsOnNode = (nodeId, sinceTs) => {
    const out = {};
    for (const r of (useRaw(sinceTs) ? qBotsOnNodeRaw : qBotsOnNode5m).all(nodeId, sinceTs)) {
        (out[r.bot_id] ||= []).push({ ts: r.ts, cpu: r.cpu, mem: r.mem, up: r.up });
    }
    return out;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Rollup — average raw rows into 5-minute buckets
//
//  Only buckets that are fully in the past are written, so a bucket is never
//  half-aggregated and then left that way. `rollup_state` remembers where each
//  table got to, making the job cheap and safe to run repeatedly.
// ─────────────────────────────────────────────────────────────────────────────

const getState = db.prepare("SELECT last_ts FROM rollup_state WHERE name = ?");
const setState = db.prepare(
    "INSERT INTO rollup_state (name, last_ts) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_ts = excluded.last_ts",
);

const rollNode = db.prepare(`
    INSERT INTO samples_5m (node_id, ts, cpu, ram, disk, rx, tx)
    SELECT node_id, (ts / ${ROLLUP_BUCKET_MS}) * ${ROLLUP_BUCKET_MS} AS bucket,
           AVG(cpu), AVG(ram), AVG(disk), AVG(rx), AVG(tx)
    FROM samples WHERE ts >= ? AND ts < ?
    GROUP BY node_id, bucket
    ON CONFLICT(node_id, ts) DO UPDATE SET
        cpu = excluded.cpu, ram = excluded.ram, disk = excluded.disk,
        rx = excluded.rx, tx = excluded.tx
`);

const rollBot = db.prepare(`
    INSERT INTO bot_samples_5m (bot_id, node_id, ts, cpu, mem, up)
    SELECT bot_id, MAX(node_id), (ts / ${ROLLUP_BUCKET_MS}) * ${ROLLUP_BUCKET_MS} AS bucket,
           AVG(cpu), AVG(mem), AVG(up)
    FROM bot_samples WHERE ts >= ? AND ts < ?
    GROUP BY bot_id, bucket
    ON CONFLICT(bot_id, ts) DO UPDATE SET
        node_id = excluded.node_id, cpu = excluded.cpu, mem = excluded.mem, up = excluded.up
`);

const rollupOne = db.transaction((name, stmt, from, to) => {
    stmt.run(from, to);
    setState.run(name, to);
});

const oldestRaw = {
    samples_5m: db.prepare("SELECT MIN(ts) m FROM samples"),
    bot_samples_5m: db.prepare("SELECT MIN(ts) m FROM bot_samples"),
};

/** Aggregate everything up to the last completed bucket. Safe to run often. */
const rollup = () => {
    const now = Date.now();
    const upTo = Math.floor(now / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS; // exclude the open bucket
    const jobs = [
        ["samples_5m", rollNode],
        ["bot_samples_5m", rollBot],
    ];
    let done = 0;
    for (const [name, stmt] of jobs) {
        // First run has no state, so it must start at the OLDEST raw row rather
        // than one retention window back. Starting later would leave everything
        // before that point unaggregated, and prune would then be free to delete
        // it — which is exactly how four days of history were lost once.
        const from = getState.get(name)?.last_ts ?? (oldestRaw[name].get().m ?? upTo);
        if (from >= upTo) continue;
        rollupOne(name, stmt, from, upTo);
        done++;
    }
    return done;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Prune
// ─────────────────────────────────────────────────────────────────────────────

const pruneStmts = {
    samples: db.prepare("DELETE FROM samples WHERE ts < ?"),
    bot_samples: db.prepare("DELETE FROM bot_samples WHERE ts < ?"),
    samples_5m: db.prepare("DELETE FROM samples_5m WHERE ts < ?"),
    bot_samples_5m: db.prepare("DELETE FROM bot_samples_5m WHERE ts < ?"),
};

/**
 * Drop rows past their retention. Raw is pruned only after the rollup has
 * consumed it, so a slow rollup can never lose data it had not aggregated yet.
 */
const prune = () => {
    const now = Date.now();
    const rawCutoff = now - RAW_RETENTION_MS;
    const rollupCutoff = now - ROLLUP_RETENTION_MS;

    const safeRaw = (name, tableState) => {
        const rolledTo = getState.get(tableState)?.last_ts ?? 0;
        return pruneStmts[name].run(Math.min(rawCutoff, rolledTo)).changes;
    };

    return (
        safeRaw("samples", "samples_5m") +
        safeRaw("bot_samples", "bot_samples_5m") +
        pruneStmts.samples_5m.run(rollupCutoff).changes +
        pruneStmts.bot_samples_5m.run(rollupCutoff).changes
    );
};

/** Row counts per table — surfaced on the panel's own maintenance view. */
const stats = () => {
    const out = {};
    for (const t of ["samples", "samples_5m", "bot_samples", "bot_samples_5m"]) {
        out[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    }
    return out;
};

module.exports = {
    insertNodeSamples,
    insertBotSamples,
    queryNode,
    queryAllNodes,
    queryBot,
    queryBotsOnNode,
    rollup,
    prune,
    stats,
    RAW_RETENTION_MS,
    ROLLUP_RETENTION_MS,
    ROLLUP_BUCKET_MS,
};
