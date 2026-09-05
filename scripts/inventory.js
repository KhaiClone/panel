#!/usr/bin/env node
/**
 * inventory.js — snapshot the panel's data, READ ONLY.
 *
 *   node scripts/inventory.js                  print a summary
 *   node scripts/inventory.js --save           also write scripts/snapshots/<ts>.json
 *   node scripts/inventory.js --save=baseline  write scripts/snapshots/baseline.json
 *
 * Both databases are opened readonly, so this can never modify anything. It is
 * the reference point scripts/verify.js compares against — take a baseline
 * before changing anything, then re-run verify after every step.
 *
 * Secrets are never printed: API keys and quest tokens are reduced to a length.
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const PANEL_DB = path.join(ROOT, "data", "panel.sqlite");
const SAMPLES_DB = path.join(ROOT, "data", "samples.sqlite");

const openRO = (file) => {
    if (!fs.existsSync(file)) return null;
    return new Database(file, { readonly: true, fileMustExist: true });
};

/** quick.db stores each collection as one JSON array in the `json` table. */
const readCollections = (db) => {
    const out = {};
    for (const row of db.prepare("SELECT ID, json FROM json").all()) {
        try {
            out[row.ID] = JSON.parse(row.json);
        } catch {
            out[row.ID] = null; // unparseable — recorded so verify can flag it
        }
    }
    return out;
};

const countBy = (arr, keyFn) => {
    const m = {};
    for (const item of arr) {
        const k = keyFn(item) ?? "(missing)";
        m[k] = (m[k] || 0) + 1;
    }
    return m;
};

const sha256 = (file) =>
    fs.existsSync(file)
        ? require("crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex")
        : null;

function build() {
    const panel = openRO(PANEL_DB);
    if (!panel) throw new Error(`Not found: ${PANEL_DB}`);
    const col = readCollections(panel);

    const bots = Array.isArray(col.bots) ? col.bots : [];
    const nodes = Array.isArray(col.nodes) ? col.nodes : [];

    const snapshot = {
        takenAt: new Date().toISOString(),
        panelDbSha256: sha256(PANEL_DB),

        // Every collection and how many records it holds — the primary
        // "did anything vanish" signal.
        collections: Object.fromEntries(
            Object.entries(col).map(([k, v]) => [k, Array.isArray(v) ? v.length : v === null ? "UNPARSEABLE" : 1]),
        ),

        bots: {
            total: bots.length,
            byNodeId: countBy(bots, (b) => b.nodeId),
            byProjectType: countBy(bots, (b) => b.projectType || "discord"),
            bySource: countBy(bots, (b) => b.source),
            byOwnerId: countBy(bots, (b) => b.ownerId),
            // Full per-bot detail so verify can name exactly what changed
            records: bots
                .map((b) => ({
                    _id: b._id,
                    name: b.name,
                    pm2Name: b.pm2Name,
                    buyerID: b.buyerID,
                    botID: b.botID,
                    nodeId: b.nodeId ?? null,
                    egressNodeId: b.egressNodeId ?? null,
                    source: b.source ?? null,
                    localPath: b.localPath ?? null,
                    projectType: b.projectType || "discord",
                    expiresAt: b.expiresAt ?? null,
                    domain: b.websiteConfig?.domain ?? null,
                    port: b.websiteConfig?.port ?? b.serviceConfig?.port ?? null,
                }))
                .sort((a, b) => String(a._id).localeCompare(String(b._id))),
        },

        // apiKey is reduced to its length — never write a key into a snapshot
        // file that will be copied around and pasted into chats.
        nodes: nodes
            .map((n) => ({
                _id: n._id,
                name: n.name,
                host: n.host,
                controlHost: n.controlHost ?? null,
                port: n.port,
                enabled: n.enabled !== false,
                questProxy: n.questProxy !== false,
                wgOverlayIp: n.wgOverlayIp ?? null,
                hasWgPubKey: !!n.wgPubKey,
                apiKeyLength: n.apiKey ? String(n.apiKey).length : 0,
            }))
            .sort((a, b) => String(a._id).localeCompare(String(b._id))),

        samples: {},
    };

    panel.close();

    const samples = openRO(SAMPLES_DB);
    if (samples) {
        for (const r of samples
            .prepare("SELECT node_id, COUNT(*) c, MIN(ts) mn, MAX(ts) mx FROM samples GROUP BY node_id")
            .all()) {
            snapshot.samples[r.node_id] = { rows: r.c, firstTs: r.mn, lastTs: r.mx };
        }
        samples.close();
    }

    return snapshot;
}

function printSummary(s) {
    const line = (l, v) => console.log(`  ${String(l).padEnd(26)} ${v}`);
    console.log(`\nSnapshot ${s.takenAt}`);
    console.log(`panel.sqlite sha256 ${s.panelDbSha256?.slice(0, 16)}…\n`);

    console.log("Collections");
    for (const [k, v] of Object.entries(s.collections)) line(k, v);

    console.log("\nBots");
    line("total", s.bots.total);
    for (const [k, v] of Object.entries(s.bots.byNodeId)) line(`  nodeId ${k}`, v);
    for (const [k, v] of Object.entries(s.bots.byProjectType)) line(`  type ${k}`, v);
    for (const [k, v] of Object.entries(s.bots.bySource)) line(`  source ${k}`, v);

    console.log("\nNodes");
    for (const n of s.nodes) {
        line(n.name, `${n._id}  ${n.host}:${n.port}${n.controlHost ? ` (control ${n.controlHost})` : ""}${n.enabled ? "" : "  DISABLED"}`);
    }

    console.log("\nSamples by node");
    for (const [k, v] of Object.entries(s.samples)) line(k, `${v.rows} rows`);
    console.log("");
}

if (require.main === module) {
    const snapshot = build();
    printSummary(snapshot);

    const saveArg = process.argv.find((a) => a === "--save" || a.startsWith("--save="));
    if (saveArg) {
        const name = saveArg.includes("=") ? saveArg.split("=")[1] : String(Date.now());
        const dir = path.join(__dirname, "snapshots");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${name}.json`);
        fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
        console.log(`Saved → ${file}\n`);
    }
}

module.exports = { build };
