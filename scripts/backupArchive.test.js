#!/usr/bin/env node
/**
 * Checks for services/backupArchive.js — no test framework needed.
 * Run:  node scripts/backupArchive.test.js
 *
 * Everything happens in a throwaway directory under the OS temp dir: the real
 * data/, restore/ and .env are never touched. The scenarios are the template's
 * (round trip, empty restore/, many pieces, missing piece, damaged piece) plus
 * what is the panel's own: two databases, the fencing epoch and the node
 * identity that must survive a rollback.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert");
const Database = require("better-sqlite3");
const archive = require("../server/services/backupArchive");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "panel-backup-test-"));
const opts = {
    dataDir: path.join(SANDBOX, "data"),
    restoreDir: path.join(SANDBOX, "restore"),
    envFile: path.join(SANDBOX, ".env"),
    sharedDb: path.join(SANDBOX, "data", "shared.sqlite"),
};
const PANEL = path.join(opts.dataDir, "panel.sqlite");
const SHARED = opts.sharedDb;
const HERE = "nodeHERE";
const ELSEWHERE = "nodeELSE";

let passed = 0;
const ok = (label, fn) => {
    try {
        fn();
        passed++;
        console.log(`  ok   ${label}`);
    } catch (err) {
        console.error(`  FAIL ${label}\n       ${err.stack.split("\n").slice(0, 3).join("\n       ")}`);
        process.exitCode = 1;
    }
};

// Restore logs on purpose; keep the test output readable.
const quiet = (fn) => {
    const [log, warn] = [console.log, console.warn];
    console.log = console.warn = () => {};
    try {
        return fn();
    } finally {
        console.log = log;
        console.warn = warn;
    }
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

const setKey = (file, key, value) => {
    const c = new Database(file);
    c.exec("CREATE TABLE IF NOT EXISTS json (ID TEXT PRIMARY KEY, json TEXT)");
    c.prepare("INSERT INTO json (ID, json) VALUES (?, ?) ON CONFLICT(ID) DO UPDATE SET json = excluded.json").run(key, JSON.stringify(value));
    c.close();
};
const getKey = (file, key) => {
    const c = new Database(file, { readonly: true });
    const row = c.prepare("SELECT json FROM json WHERE ID = ?").get(key);
    c.close();
    return row ? JSON.parse(row.json) : null;
};

let sharedConn = null; // kept open like the panel's, so its WAL is never checkpointed
const sharedOpen = () => {
    if (!sharedConn) {
        sharedConn = new Database(SHARED);
        sharedConn.pragma("journal_mode = WAL");
        sharedConn.pragma("wal_autocheckpoint = 0");
        sharedConn.exec("CREATE TABLE IF NOT EXISTS docs (seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, doc TEXT NOT NULL)");
    }
    return sharedConn;
};
const sharedClose = () => {
    if (sharedConn) sharedConn.close();
    sharedConn = null;
};
const addOrders = (n, tag) => {
    const ins = sharedOpen().prepare("INSERT INTO docs (name, doc) VALUES ('orders', ?)");
    for (let i = 0; i < n; i++) ins.run(JSON.stringify({ tag, i }));
};
const countOrders = (file = SHARED) => {
    const c = new Database(file, { readonly: true });
    const n = c.prepare("SELECT COUNT(*) n FROM docs WHERE name = 'orders'").get().n;
    c.close();
    return n;
};

/** A fresh sandbox: panel.sqlite, shared.sqlite (WAL, open), .env. */
const reset = () => {
    sharedClose();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    fs.mkdirSync(opts.dataDir, { recursive: true });
    setKey(PANEL, "bots", [{ _id: "b1", name: "one" }]);
    setKey(PANEL, "nodes", [
        { _id: HERE, name: "here", controlHost: "127.0.0.1" },
        { _id: ELSEWHERE, name: "else", controlHost: null },
    ]);
    setKey(PANEL, "panel_lease", { epoch: 2, nodeId: HERE, since: 1 });
    fs.writeFileSync(opts.envFile, `PORT=1975\nPANEL_NODE_ID=${HERE}\nJWT_SECRET=one\n`);
    addOrders(5, "before");
};

/** Back up the sandbox now; returns the files. */
const backup = () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panel-backup-build-"));
    try {
        return archive.build({
            dbs: [
                { kind: "panel", file: PANEL },
                { kind: "shared", file: SHARED },
            ],
            envFile: opts.envFile,
            tmpDir: tmp,
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
};

const stage = (files) => {
    fs.mkdirSync(opts.restoreDir, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(opts.restoreDir, f.name), f.data);
};

/** Restore as at boot: the panel process is gone, so is its connection. */
const boot = () => {
    sharedClose();
    return quiet(() => archive.restore(opts));
};

const baks = () => fs.readdirSync(opts.dataDir).filter((n) => n.includes(".bak-"));

// ── Scenarios ────────────────────────────────────────────────────────────────

console.log("backupArchive");

ok("names: the template's scheme with the database in it", () => {
    assert.deepStrictEqual(archive.parseName("20261002-1430__b7f3a1c9__panel-001-of-004.gz"), {
        ts: "20261002-1430", hash8: "b7f3a1c9", kind: "panel", index: 1, total: 4,
    });
    assert.deepStrictEqual(archive.parseName("20261002-1430__b7f3a1c9__env.txt"), { ts: "20261002-1430", hash8: "b7f3a1c9", kind: "env" });
    assert.strictEqual(archive.parseName("20261002-1430__b7f3a1c9__000-of-001.gz"), null); // a bot's backup, not the panel's
    assert.strictEqual(archive.parseName("panel.sqlite"), null);
});

ok("round trip: a rollback returns both databases and .env to the backup moment", () => {
    reset();
    const built = backup();
    assert.deepStrictEqual(built.files.map((f) => f.name.split("__")[2]), ["env.txt", "panel-000-of-001.gz", "shared-000-of-001.gz"]);
    assert.strictEqual(built.files[0].name.split("__")[1], built.summary.dbs.panel.hash8, "env.txt carries the panel's hash");

    // Life goes on after the backup…
    addOrders(7, "after");
    setKey(PANEL, "bots", []);
    fs.writeFileSync(opts.envFile, `PORT=1975\nPANEL_NODE_ID=${HERE}\nJWT_SECRET=two\n`);

    stage(built.files);
    assert.strictEqual(boot(), true);
    assert.strictEqual(countOrders(), 5);
    assert.deepStrictEqual(getKey(PANEL, "bots"), [{ _id: "b1", name: "one" }]);
    assert.match(fs.readFileSync(opts.envFile, "utf8"), /JWT_SECRET=one/);
    assert.deepStrictEqual(fs.readdirSync(opts.restoreDir), [], "sources deleted — disarmed");
    const result = archive.lastResult(opts);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.restored.sort(), [".env", "panel.sqlite", "shared.sqlite"]);
});

ok("the replaced files are kept, WAL and all", () => {
    // From the previous scenario: the "after" state was set aside.
    const bakShared = baks().find((n) => n.startsWith("shared.sqlite.bak-") && !/-(wal|shm)$/.test(n));
    assert.ok(bakShared, `no shared .bak in ${baks()}`);
    assert.strictEqual(countOrders(path.join(opts.dataDir, bakShared)), 12, "the .bak still sees the rows that sat in its WAL");
    assert.ok(baks().some((n) => n.startsWith("panel.sqlite.bak-")));
    assert.ok(fs.readdirSync(SANDBOX).some((n) => n.startsWith(".env.bak-")));
});

ok("after a crash, the WAL left on disk goes with the .bak, not with the restored file", () => {
    reset();
    const built = backup();
    addOrders(6, "only-in-wal"); // 11 rows, 6 of them only in the WAL
    // Freeze the files as a killed process leaves them (closing would checkpoint).
    const frozen = {};
    for (const s of ["", "-wal", "-shm"]) frozen[s] = fs.readFileSync(SHARED + s);
    sharedClose();
    for (const s of ["", "-wal", "-shm"]) fs.writeFileSync(SHARED + s, frozen[s]);
    assert.ok(fs.statSync(`${SHARED}-wal`).size > 0, "the crash state has a WAL");

    stage(built.files);
    quiet(() => archive.restore(opts));
    assert.strictEqual(countOrders(), 5, "the restored file did not pick up the old WAL");
    const bak = baks().find((n) => n.startsWith("shared.sqlite.bak-") && !/-(wal|shm)$/.test(n));
    assert.ok(baks().includes(`${bak}-wal`), "the WAL was renamed with the .bak");
    assert.strictEqual(countOrders(path.join(opts.dataDir, bak)), 11, "the .bak still has the rows that were only in its WAL");
});

ok("the snapshot includes rows still in the WAL", () => {
    reset();
    addOrders(3, "wal-only"); // never checkpointed: the connection stays open
    assert.ok(fs.statSync(`${SHARED}-wal`).size > 0);
    const built = backup();
    addOrders(1, "after");
    stage(built.files);
    boot();
    assert.strictEqual(countOrders(), 8);
});

ok("a restart with an empty restore/ does nothing", () => {
    const before = fs.readFileSync(PANEL);
    fs.rmSync(path.join(opts.dataDir, "restore-last.json"), { force: true });
    assert.strictEqual(boot(), false);
    assert.ok(fs.readFileSync(PANEL).equals(before));
    assert.strictEqual(archive.lastResult(opts), null);
});

ok("many pieces: ~20 MB that does not compress is cut and joined back exactly", () => {
    reset();
    const blob = crypto.randomBytes(20 * 1024 * 1024).toString("base64");
    sharedOpen().prepare("INSERT INTO docs (name, doc) VALUES ('blob', ?)").run(blob);
    const built = backup();
    const pieces = built.files.filter((f) => f.name.includes("__shared-"));
    assert.ok(pieces.length >= 2, `expected several pieces, got ${pieces.length}`);
    assert.ok(pieces.every((f) => f.data.length <= 9 * 1024 * 1024));
    sharedOpen().prepare("DELETE FROM docs WHERE name = 'blob'").run();
    stage(built.files);
    assert.strictEqual(boot(), true);
    const c = new Database(SHARED, { readonly: true });
    assert.strictEqual(c.prepare("SELECT doc FROM docs WHERE name = 'blob'").get().doc, blob);
    c.close();
});

ok("a missing piece: nothing written, nothing deleted", () => {
    reset();
    const blob = crypto.randomBytes(12 * 1024 * 1024).toString("base64");
    sharedOpen().prepare("INSERT INTO docs (name, doc) VALUES ('blob', ?)").run(blob);
    const built = backup();
    addOrders(2, "after");
    const files = built.files.filter((f) => !f.name.endsWith("shared-001-of-002.gz"));
    assert.strictEqual(files.length, built.files.length - 1);
    stage(files);
    const panelBefore = fs.readFileSync(PANEL);
    assert.strictEqual(boot(), false);
    assert.strictEqual(countOrders(), 7, "shared untouched");
    assert.ok(fs.readFileSync(PANEL).equals(panelBefore), "panel untouched although its own pieces were complete");
    assert.strictEqual(fs.readdirSync(opts.restoreDir).length, files.length, "sources kept for the missing piece to join them");
    assert.deepStrictEqual(baks(), []);
    const result = archive.lastResult(opts);
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /missing piece 001/);
});

ok("a damaged piece (checksum): nothing written, nothing deleted", () => {
    reset();
    const built = backup();
    const files = built.files.map((f) => {
        if (!f.name.includes("__panel-")) return f;
        // A valid gzip of different content: only the checksum can tell.
        return { name: f.name, data: require("zlib").gzipSync(Buffer.concat([Buffer.from("SQLite format 3\0"), crypto.randomBytes(64)])) };
    });
    stage(files);
    const before = fs.readFileSync(PANEL);
    assert.strictEqual(boot(), false);
    assert.ok(fs.readFileSync(PANEL).equals(before));
    assert.match(archive.lastResult(opts).error, /checksum mismatch/);
    assert.deepStrictEqual(baks(), []);
});

ok("the fencing epoch never goes back", () => {
    reset();
    const built = backup(); // epoch 2
    setKey(PANEL, "panel_lease", { epoch: 3, nodeId: HERE, since: 2 }); // a move happened since
    stage(built.files);
    boot();
    assert.strictEqual(getKey(PANEL, "panel_lease").epoch, 3);
    assert.ok(archive.lastResult(opts).notes.some((n) => /Epoch kept at 3/.test(n)));
});

ok("a backup from when the panel ran elsewhere: node addresses fixed, PANEL_NODE_ID kept", () => {
    reset();
    // The backup moment: the panel lived on ELSEWHERE.
    setKey(PANEL, "panel_lease", { epoch: 1, nodeId: ELSEWHERE, since: 1 });
    setKey(PANEL, "nodes", [
        { _id: HERE, name: "here", controlHost: null },
        { _id: ELSEWHERE, name: "else", controlHost: "127.0.0.1" },
    ]);
    fs.writeFileSync(opts.envFile, `PANEL_NODE_ID=${ELSEWHERE}\nJWT_SECRET=one\n`);
    const built = backup();
    // Now: it lives HERE, at epoch 2.
    setKey(PANEL, "panel_lease", { epoch: 2, nodeId: HERE, since: 2 });
    fs.writeFileSync(opts.envFile, `PANEL_NODE_ID=${HERE}\nJWT_SECRET=one\n`);

    stage(built.files);
    boot();
    const nodes = getKey(PANEL, "nodes");
    assert.strictEqual(nodes.find((n) => n._id === HERE).controlHost, "127.0.0.1");
    assert.strictEqual(nodes.find((n) => n._id === ELSEWHERE).controlHost, null);
    assert.deepStrictEqual(getKey(PANEL, "panel_lease"), { epoch: 2, nodeId: HERE, since: 1 });
    assert.match(fs.readFileSync(opts.envFile, "utf8"), new RegExp(`PANEL_NODE_ID=${HERE}`));
});

ok("only the pieces given are restored (shared alone keeps panel.sqlite and .env)", () => {
    reset();
    const built = backup();
    addOrders(4, "after");
    setKey(PANEL, "bots", []);
    fs.appendFileSync(opts.envFile, "NEW_KEY=1\n");
    stage(built.files.filter((f) => f.name.includes("__shared-")));
    assert.strictEqual(boot(), true);
    assert.strictEqual(countOrders(), 5);
    assert.deepStrictEqual(getKey(PANEL, "bots"), []);
    assert.match(fs.readFileSync(opts.envFile, "utf8"), /NEW_KEY=1/);
    assert.deepStrictEqual(archive.lastResult(opts).restored, ["shared.sqlite"]);
});

ok("several backups in restore/: the newest is used", () => {
    reset();
    const older = backup();
    const files = older.files.map((f) => ({ name: f.name.replace(/^\d{8}-\d{4}/, "20000101-0000"), data: f.data }));
    addOrders(1, "newer");
    const newer = backup();
    const planned = archive.plan([...files, ...newer.files]);
    assert.strictEqual(planned.ts, newer.ts);
    assert.strictEqual(planned.warnings.length, 1);
});

ok("two different backups from the same minute are refused, not mixed", () => {
    reset();
    const a = backup();
    addOrders(1, "x");
    const b = backup();
    assert.notStrictEqual(a.summary.dbs.shared.hash8, b.summary.dbs.shared.hash8);
    const mixed = [...a.files.filter((f) => f.name.includes("__shared-")), ...b.files.filter((f) => f.name.includes("__shared-"))]
        .map((f, i) => ({ name: f.name.replace(/^\d{8}-\d{4}/, "20261002-1430"), data: f.data, i }));
    assert.throws(() => archive.plan(mixed), /Two different shared backups/);
});

ok("files that are not backups are ignored, and none at all is an error", () => {
    assert.throws(() => archive.plan([{ name: "notes.txt", data: Buffer.from("x") }]), /No backup files/);
    reset();
    const built = backup();
    const planned = archive.plan([...built.files, { name: "notes.txt", data: Buffer.from("x") }]);
    assert.deepStrictEqual(Object.keys(planned.dbs).sort(), ["panel", "shared"]);
});

sharedClose();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
