const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// ─────────────────────────────────────────────────────────────────────────────
//  Time-series store for 24/7 resource history.
//
//  A dedicated better-sqlite3 file (separate from the QuickDB panel.sqlite) —
//  key-value JSON would mean re-serializing the whole array every 15s, so we
//  use a proper indexed table with one row per (node, tick).
// ─────────────────────────────────────────────────────────────────────────────

const dataDir = path.join(__dirname, "../../data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "samples.sqlite"));
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
`);

const insertStmt = db.prepare(
    "INSERT INTO samples (node_id, ts, cpu, ram, disk, rx, tx) VALUES (@node_id, @ts, @cpu, @ram, @disk, @rx, @tx)",
);
const insertTx = db.transaction((rows) => {
    for (const r of rows) insertStmt.run(r);
});

/** Insert every node's sample for one tick in a single transaction. */
const insertMany = (rows) => {
    if (rows && rows.length) insertTx(rows);
};

const queryStmt = db.prepare(
    "SELECT ts, cpu, ram, disk, rx, tx FROM samples WHERE node_id = ? AND ts >= ? ORDER BY ts ASC",
);

/** All samples for a node since `sinceTs` (ascending). */
const query = (nodeId, sinceTs) => queryStmt.all(nodeId, sinceTs);

const pruneStmt = db.prepare("DELETE FROM samples WHERE ts < ?");

/** Drop samples older than `cutoffTs`. Returns the number removed. */
const prune = (cutoffTs) => pruneStmt.run(cutoffTs).changes;

module.exports = { insertMany, query, prune };
