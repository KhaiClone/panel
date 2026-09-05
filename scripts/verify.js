#!/usr/bin/env node
/**
 * verify.js — compare the live data against a snapshot, READ ONLY.
 *
 *   node scripts/verify.js                              vs scripts/snapshots/baseline.json
 *   node scripts/verify.js scripts/snapshots/x.json     vs a specific snapshot
 *
 * Run this after every step of the refactor. Exit code 1 means something was
 * LOST — stop and investigate before going further.
 *
 * Three outcome classes, deliberately kept apart:
 *   LOST     a record that existed is gone            → always a problem
 *   CHANGED  a record still exists but a field moved  → expected during migration
 *   ADDED    a new record                             → normal
 */

const fs = require("fs");
const path = require("path");
const { build } = require("./inventory");

const RED = "\x1b[31m", YEL = "\x1b[33m", GRN = "\x1b[32m", DIM = "\x1b[90m", OFF = "\x1b[0m";

const argPath = process.argv[2] || path.join(__dirname, "snapshots", "baseline.json");
if (!fs.existsSync(argPath)) {
    console.error(`${RED}Snapshot not found: ${argPath}${OFF}`);
    console.error(`Create one first:  node scripts/inventory.js --save=baseline`);
    process.exit(2);
}

const before = JSON.parse(fs.readFileSync(argPath, "utf8"));
const after = build();

const lost = [];
const changed = [];
const added = [];

// ── Collection sizes ────────────────────────────────────────────────────────
console.log(`\n${DIM}Comparing against ${argPath}`);
console.log(`baseline taken ${before.takenAt}${OFF}\n`);

console.log("Collection sizes");
const allCollections = [...new Set([...Object.keys(before.collections), ...Object.keys(after.collections)])].sort();
for (const name of allCollections) {
    const b = before.collections[name];
    const a = after.collections[name];
    const same = b === a;
    const shrank = typeof b === "number" && typeof a === "number" && a < b;
    const mark = same ? `${GRN}=${OFF}` : shrank ? `${RED}▼${OFF}` : `${YEL}▲${OFF}`;
    if (shrank) lost.push(`collection "${name}" shrank: ${b} → ${a}`);
    if (a === undefined) lost.push(`collection "${name}" no longer exists (was ${b})`);
    if (a === "UNPARSEABLE") lost.push(`collection "${name}" is CORRUPT — cannot be parsed`);
    console.log(`  ${mark} ${String(name).padEnd(28)} ${b ?? "—"} → ${a ?? "—"}`);
}

// ── Bots, record by record ──────────────────────────────────────────────────
const beforeBots = new Map(before.bots.records.map((b) => [b._id, b]));
const afterBots = new Map(after.bots.records.map((b) => [b._id, b]));

const WATCHED = ["nodeId", "egressNodeId", "source", "localPath", "pm2Name", "buyerID", "botID", "projectType", "expiresAt", "domain"];

for (const [id, b] of beforeBots) {
    const a = afterBots.get(id);
    if (!a) {
        lost.push(`bot "${b.name}" (${b.pm2Name}, ${id}) is GONE`);
        continue;
    }
    for (const f of WATCHED) {
        if (JSON.stringify(b[f]) !== JSON.stringify(a[f])) {
            changed.push(`bot "${b.name}" ${f}: ${JSON.stringify(b[f])} → ${JSON.stringify(a[f])}`);
        }
    }
}
for (const [id, a] of afterBots) {
    if (!beforeBots.has(id)) added.push(`bot "${a.name}" (${a.pm2Name}, ${id})`);
}

// ── Nodes ───────────────────────────────────────────────────────────────────
const beforeNodes = new Map(before.nodes.map((n) => [n._id, n]));
const afterNodes = new Map(after.nodes.map((n) => [n._id, n]));
for (const [id, n] of beforeNodes) {
    const a = afterNodes.get(id);
    if (!a) { lost.push(`node "${n.name}" (${id}) is GONE`); continue; }
    for (const f of ["name", "host", "controlHost", "port", "enabled", "questProxy", "wgOverlayIp"]) {
        if (JSON.stringify(n[f]) !== JSON.stringify(a[f])) {
            changed.push(`node "${n.name}" ${f}: ${JSON.stringify(n[f])} → ${JSON.stringify(a[f])}`);
        }
    }
    if (n.apiKeyLength && !a.apiKeyLength) lost.push(`node "${n.name}" lost its API key`);
}
for (const [id, a] of afterNodes) {
    if (!beforeNodes.has(id)) added.push(`node "${a.name}" (${id})`);
}

// ── Samples ─────────────────────────────────────────────────────────────────
// A node_id disappearing here is expected exactly once: when the legacy "local"
// series is folded away by the migration. Anything else losing rows is not.
for (const [nodeId, b] of Object.entries(before.samples)) {
    const a = after.samples[nodeId];
    if (!a) {
        const msg = `samples for node_id "${nodeId}" removed (${b.rows} rows)`;
        if (nodeId === "local") changed.push(`${msg} — expected if the migration ran`);
        else lost.push(msg);
        continue;
    }
    if (a.rows < b.rows) changed.push(`samples "${nodeId}" row count fell: ${b.rows} → ${a.rows}`);
}

// ── Report ──────────────────────────────────────────────────────────────────
const section = (title, items, color) => {
    console.log(`\n${color}${title} (${items.length})${OFF}`);
    if (!items.length) console.log(`  ${DIM}none${OFF}`);
    for (const i of items) console.log(`  ${color}•${OFF} ${i}`);
};

section("LOST — data that existed and no longer does", lost, RED);
section("CHANGED — still present, a field moved", changed, YEL);
section("ADDED — new since the baseline", added, GRN);

if (lost.length) {
    console.log(`\n${RED}FAILED: ${lost.length} item(s) lost. Stop here — restore the backup before continuing.${OFF}\n`);
    process.exit(1);
}
console.log(`\n${GRN}OK: nothing was lost.${OFF}${changed.length ? ` ${changed.length} expected change(s) above — confirm they were intended.` : ""}\n`);
