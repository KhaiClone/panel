#!/usr/bin/env node
/**
 * Checks for sampleStore + historyService — no test framework needed.
 * Run:  node scripts/sampleStore.test.js
 *
 * Uses its own throwaway database (data/samples.test.sqlite) so it never
 * touches recorded history. The riskiest logic here is the rollup/prune pair:
 * pruning raw rows the rollup has not consumed yet would silently lose data,
 * so that interaction gets the most attention.
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const DB = path.join(__dirname, "..", "data", "samples.test.sqlite");
for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(DB + suffix, { force: true }); } catch { /* fresh anyway */ }
}
// sampleStore derives its path from the data dir; point it at the test file.
process.env.SAMPLES_DB_PATH = DB;

const store = require("../server/services/sampleStore");
const history = require("../server/services/historyService");

let passed = 0;
const ok = (label, fn) => {
    try {
        fn();
        passed++;
        console.log(`  ok   ${label}`);
    } catch (err) {
        console.error(`  FAIL ${label}\n       ${err.message}`);
        process.exitCode = 1;
    }
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.now();

// ── Seed: 4 days of 15s node samples and bot samples for two subjects ───────
const nodeRows = [];
const botRows = [];
for (let t = now - 4 * DAY; t <= now; t += 15_000) {
    nodeRows.push({ node_id: "n1", ts: t, cpu: 50, ram: 60, disk: 70, rx: 100, tx: 200 });
    botRows.push({ bot_id: "b1", node_id: "n1", ts: t, cpu: 10, mem: 1000, up: 1 });
}
// A second node with a shorter, differently-valued series
for (let t = now - 2 * HOUR; t <= now; t += 15_000) {
    nodeRows.push({ node_id: "n2", ts: t, cpu: 20, ram: 30, disk: 40, rx: 1, tx: 2 });
}
store.insertNodeSamples(nodeRows);
store.insertBotSamples(botRows);

console.log(`\nSeeded ${nodeRows.length} node rows, ${botRows.length} bot rows`);

console.log("\nqueryNode — resolution follows the requested span");
ok("a 1h span reads raw and returns ~240 rows", () => {
    const rows = store.queryNode("n1", now - HOUR);
    assert.ok(rows.length > 200 && rows.length < 280, `got ${rows.length}`);
});
ok("a 1h span carries every column", () => {
    const r = store.queryNode("n1", now - HOUR)[0];
    for (const k of ["ts", "cpu", "ram", "disk", "rx", "tx"]) assert.ok(k in r, `missing ${k}`);
});
ok("an out-of-raw-range span reads the (still empty) rollup", () => {
    assert.strictEqual(store.queryNode("n1", now - 10 * DAY).length, 0);
});

console.log("\nrollup");
ok("rollup writes 5-minute buckets", () => {
    store.rollup();
    const s = store.stats();
    assert.ok(s.samples_5m > 0, "no node buckets written");
    assert.ok(s.bot_samples_5m > 0, "no bot buckets written");
});
ok("buckets average to the seeded value", () => {
    const rows = store.queryNode("n1", now - 10 * DAY);
    assert.ok(rows.length > 0, "rollup returned nothing");
    assert.ok(Math.abs(rows[0].cpu - 50) < 0.001, `cpu=${rows[0].cpu}`);
});
ok("bucket timestamps land on 5-minute boundaries", () => {
    const rows = store.queryNode("n1", now - 10 * DAY);
    for (const r of rows.slice(0, 20)) {
        assert.strictEqual(r.ts % store.ROLLUP_BUCKET_MS, 0, `ts=${r.ts}`);
    }
});
ok("rerunning rollup does not duplicate buckets", () => {
    const before = store.stats().samples_5m;
    store.rollup();
    assert.strictEqual(store.stats().samples_5m, before);
});
ok("the still-open bucket is left out", () => {
    const rows = store.queryNode("n1", now - 10 * DAY);
    const open = Math.floor(now / store.ROLLUP_BUCKET_MS) * store.ROLLUP_BUCKET_MS;
    assert.ok(rows[rows.length - 1].ts < open, "open bucket was aggregated");
});

console.log("\nprune — must never drop raw rows the rollup has not consumed");
ok("prune removes raw rows older than raw retention", () => {
    const before = store.stats().samples;
    store.prune();
    const after = store.stats().samples;
    assert.ok(after < before, `nothing pruned (${before} → ${after})`);
});
ok("raw rows inside retention survive", () => {
    assert.ok(store.queryNode("n1", now - HOUR).length > 200);
});
ok("history older than raw retention still resolves from the rollup", () => {
    const rows = store.queryNode("n1", now - 4 * DAY);
    assert.ok(rows.length > 500, `got ${rows.length}`);
    assert.ok(Math.abs(rows[0].cpu - 50) < 0.001);
});
ok("REGRESSION: the first rollup starts at the OLDEST raw row, not one retention back", () => {
    // The original implementation began at now - RAW_RETENTION, so anything older
    // was never aggregated — and prune then deleted it. Four days of real history
    // were lost that way. The rollup must reach back to the very first sample.
    const rows = store.queryNode("n1", now - 5 * DAY);
    const oldest = rows[0].ts;
    const seededFrom = now - 4 * DAY;
    assert.ok(
        oldest - seededFrom < 2 * store.ROLLUP_BUCKET_MS,
        `rollup only reaches back to ${new Date(oldest).toISOString()}, ` +
            `but data was seeded from ${new Date(seededFrom).toISOString()}`,
    );
});

console.log("\nhistoryService — columnar output, capped point count");
ok("nodeHistory returns parallel arrays", () => {
    const h = history.nodeHistory("n1", "24h");
    assert.ok(Array.isArray(h.ts) && Array.isArray(h.cpu));
    assert.strictEqual(h.ts.length, h.cpu.length);
    assert.strictEqual(h.ts.length, h.ram.length);
});
ok("a long range is capped at MAX_POINTS", () => {
    const h = history.nodeHistory("n1", "30d");
    assert.ok(h.ts.length <= history.MAX_POINTS, `got ${h.ts.length}`);
});
ok("bucket-averaging preserves the value", () => {
    const h = history.nodeHistory("n1", "30d");
    assert.ok(Math.abs(h.cpu[0] - 50) < 0.001, `cpu[0]=${h.cpu[0]}`);
});
ok("an unknown range falls back to the default", () => {
    assert.strictEqual(history.nodeHistory("n1", "banana").range, history.DEFAULT_RANGE);
});
ok("allNodesHistory covers both nodes in one call", () => {
    const h = history.allNodesHistory("1h");
    assert.ok(h.nodes.n1 && h.nodes.n2, `got ${Object.keys(h.nodes)}`);
    assert.ok(h.nodes.n1.ts.length <= history.SPARK_POINTS);
});
ok("botHistory returns cpu/mem/up", () => {
    const h = history.botHistory("b1", "24h");
    assert.ok(h.ts.length > 0);
    assert.ok(Math.abs(h.cpu[0] - 10) < 0.001);
    assert.ok(Math.abs(h.mem[0] - 1000) < 0.001);
});
ok("nodeBotsHistory groups by bot", () => {
    const h = history.nodeBotsHistory("n1", "1h");
    assert.ok(h.bots.b1, `got ${Object.keys(h.bots)}`);
});
ok("an unknown subject yields empty arrays, not an error", () => {
    const h = history.botHistory("does-not-exist", "1h");
    assert.deepStrictEqual(h.ts, []);
    assert.deepStrictEqual(h.cpu, []);
});

for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
}
console.log(`\n${passed} checks passed${process.exitCode ? " — but some FAILED above" : ""}\n`);
