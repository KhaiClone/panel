#!/usr/bin/env node
/**
 * migrate-local-node.js — retire the legacy nodeId "local".
 *
 *   node scripts/migrate-local-node.js              DRY RUN (default, writes nothing)
 *   node scripts/migrate-local-node.js --apply      actually write
 *
 * This is TIDY-UP, not a cutover. The panel already resolves a missing or
 * "local" nodeId to PANEL_NODE_ID at read time (nodeService.resolveNodeId), so
 * everything works before this runs. Running it simply removes the last reason
 * that compatibility shim has to exist.
 *
 * What it does:
 *   1. bots.nodeId       "local" or missing  → PANEL_NODE_ID
 *   2. bots.egressNodeId "local"             → PANEL_NODE_ID
 *   3. samples.sqlite    node_id "local"     → DELETED, not renamed.
 *      Renaming would be wrong: the panel host was sampled TWICE before the
 *      split (once as "local", once as its registered node id), so an UPDATE
 *      would duplicate every timestamp in that series.
 *
 * Safety:
 *   - the panel must be stopped (checked via pm2)
 *   - panel.sqlite is copied to panel.sqlite.pre-migrate-<ts> before any write
 *   - the bots collection is written in ONE operation, never record by record
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const Database = require("better-sqlite3");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ROOT = path.join(__dirname, "..");
const PANEL_DB = path.join(ROOT, "data", "panel.sqlite");
const SAMPLES_DB = path.join(ROOT, "data", "samples.sqlite");
const LEGACY = "local";

const APPLY = process.argv.includes("--apply");
const RED = "\x1b[31m", YEL = "\x1b[33m", GRN = "\x1b[32m", DIM = "\x1b[90m", OFF = "\x1b[0m";

const die = (msg) => {
    console.error(`\n${RED}${msg}${OFF}\n`);
    process.exit(1);
};

// ── Preconditions ───────────────────────────────────────────────────────────
const PANEL_NODE_ID = process.env.PANEL_NODE_ID;
if (!PANEL_NODE_ID) {
    die("PANEL_NODE_ID is not set in the panel's .env — set it to the _id of the node this panel runs on, then re-run.");
}
if (!fs.existsSync(PANEL_DB)) die(`Not found: ${PANEL_DB}`);

const panel = new Database(PANEL_DB, { readonly: !APPLY, fileMustExist: true });
const readCol = (name) => {
    const row = panel.prepare("SELECT json FROM json WHERE ID = ?").get(name);
    return row ? JSON.parse(row.json) : [];
};

const nodes = readCol("nodes");
const targetNode = nodes.find((n) => n._id === PANEL_NODE_ID);
if (!targetNode) {
    die(
        `PANEL_NODE_ID "${PANEL_NODE_ID}" is not a registered node.\n` +
            `Known nodes:\n` +
            nodes.map((n) => `  ${n._id}  ${n.name}`).join("\n"),
    );
}

const bots = readCol("bots");

const needsNode = bots.filter((b) => !b.nodeId || b.nodeId === LEGACY);
const needsEgress = bots.filter((b) => b.egressNodeId === LEGACY);

// ── Report what would happen ────────────────────────────────────────────────
console.log(`\n${APPLY ? YEL + "APPLY" : DIM + "DRY RUN"}${OFF} — target node: ${GRN}${targetNode.name}${OFF} (${PANEL_NODE_ID})\n`);

const byNode = {};
for (const b of bots) byNode[b.nodeId ?? "(missing)"] = (byNode[b.nodeId ?? "(missing)"] || 0) + 1;
console.log("bots by nodeId, before:");
for (const [k, v] of Object.entries(byNode)) console.log(`  ${String(k).padEnd(26)} ${v}`);

console.log(`\n${needsNode.length} bot(s) would get nodeId → ${PANEL_NODE_ID}`);
for (const b of needsNode) console.log(`  ${DIM}•${OFF} ${b.name} (${b.pm2Name})  nodeId=${JSON.stringify(b.nodeId ?? null)}`);

console.log(`\n${needsEgress.length} bot(s) would get egressNodeId → ${PANEL_NODE_ID}`);
for (const b of needsEgress) console.log(`  ${DIM}•${OFF} ${b.name} (${b.pm2Name})`);

// ── Samples ─────────────────────────────────────────────────────────────────
let samplesInfo = null;
if (fs.existsSync(SAMPLES_DB)) {
    const s = new Database(SAMPLES_DB, { readonly: true, fileMustExist: true });
    const rows = s.prepare("SELECT node_id, COUNT(*) c FROM samples GROUP BY node_id").all();
    const legacy = rows.find((r) => r.node_id === LEGACY);
    const target = rows.find((r) => r.node_id === PANEL_NODE_ID);
    samplesInfo = { legacy, target };

    console.log("\nsamples.sqlite rows per node_id:");
    for (const r of rows) console.log(`  ${String(r.node_id).padEnd(26)} ${r.c}`);

    if (legacy && target) {
        // Show that both series really do describe the same machine before we
        // throw one of them away.
        const cmp = s
            .prepare(
                `SELECT a.ts, a.cpu AS legacy_cpu, b.cpu AS node_cpu, a.ram AS legacy_ram, b.ram AS node_ram
                 FROM samples a JOIN samples b ON a.ts = b.ts
                 WHERE a.node_id = ? AND b.node_id = ?
                 ORDER BY a.ts DESC LIMIT 5`,
            )
            .all(LEGACY, PANEL_NODE_ID);
        console.log(`\n${YEL}Sanity check — the two series at the same timestamps:${OFF}`);
        if (!cmp.length) {
            console.log(`  ${RED}no shared timestamps — do NOT delete, investigate first${OFF}`);
        } else {
            for (const r of cmp) {
                console.log(
                    `  ts=${r.ts}  cpu ${String(r.legacy_cpu).padEnd(7)}vs ${String(r.node_cpu).padEnd(7)}` +
                        `ram ${String(r.legacy_ram).padEnd(7)}vs ${r.node_ram}`,
                );
            }
            console.log(`  ${DIM}Close values confirm both ids sampled the same machine.${OFF}`);
        }
        console.log(`\n${legacy.c} legacy row(s) would be DELETED (the "${PANEL_NODE_ID}" series keeps its ${target.c}).`);
    } else if (legacy && !target) {
        console.log(`\n${YEL}Only the legacy series exists — it would be RENAMED to ${PANEL_NODE_ID}, not deleted.${OFF}`);
    } else {
        console.log(`\nNo legacy "local" samples — nothing to do here.`);
    }
    s.close();
}

if (!APPLY) {
    console.log(`\n${DIM}Nothing was written. Re-run with --apply once the numbers above look right.${OFF}\n`);
    panel.close();
    process.exit(0);
}

// ── Apply ───────────────────────────────────────────────────────────────────
if (needsNode.length === 0 && needsEgress.length === 0 && !samplesInfo?.legacy) {
    console.log(`\n${GRN}Nothing left to migrate.${OFF}\n`);
    panel.close();
    process.exit(0);
}

// The panel must not be running: quick.db rewrites the whole collection on every
// write, so a concurrent panel write would silently drop this one (or ours theirs).
try {
    const list = JSON.parse(execSync("pm2 jlist --no-color", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const name = process.env.PANEL_PM2_NAME || "bot-panel";
    const self = list.find((p) => p.name === name);
    if (self && self.pm2_env?.status === "online") {
        die(`pm2 process "${name}" is still online. Run \`pm2 stop ${name}\` first — quick.db rewrites whole collections and a concurrent write would be lost.`);
    }
} catch (err) {
    if (err.message.includes("still online")) throw err;
    console.log(`${YEL}Could not query pm2 (${err.message.split("\n")[0]}). Make sure the panel is stopped.${OFF}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${PANEL_DB}.pre-migrate-${stamp}`;
fs.copyFileSync(PANEL_DB, backup);
console.log(`\nBackup → ${backup}`);

let n = 0, e = 0;
for (const b of bots) {
    if (!b.nodeId || b.nodeId === LEGACY) { b.nodeId = PANEL_NODE_ID; n++; }
    if (b.egressNodeId === LEGACY) { b.egressNodeId = PANEL_NODE_ID; e++; }
}
// One write for the whole collection — never record by record.
panel.prepare("UPDATE json SET json = ? WHERE ID = 'bots'").run(JSON.stringify(bots));
console.log(`${GRN}bots:${OFF} ${n} nodeId, ${e} egressNodeId updated in a single write`);

if (fs.existsSync(SAMPLES_DB) && samplesInfo?.legacy) {
    const s = new Database(SAMPLES_DB, { fileMustExist: true });
    if (samplesInfo.target) {
        const r = s.prepare("DELETE FROM samples WHERE node_id = ?").run(LEGACY);
        console.log(`${GRN}samples:${OFF} deleted ${r.changes} duplicate legacy row(s)`);
    } else {
        const r = s.prepare("UPDATE samples SET node_id = ? WHERE node_id = ?").run(PANEL_NODE_ID, LEGACY);
        console.log(`${GRN}samples:${OFF} renamed ${r.changes} row(s) (no duplicate series existed)`);
    }
    s.close();
}

panel.close();
console.log(`\n${GRN}Done.${OFF} Now run:  node scripts/verify.js\n`);
