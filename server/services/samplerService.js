const nodeService = require("./nodeService");
const sampleStore = require("./sampleStore");

// ─────────────────────────────────────────────────────────────────────────────
//  Resource sampler — records CPU/RAM/Disk/network for the panel VPS and every
//  enabled node every SAMPLE_INTERVAL, 24/7, keeping RETENTION_MS of history.
//  Central collection: the panel reads each node's existing /stats; offline
//  nodes are skipped (leaving a gap in that node's series).
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_INTERVAL_MS = 15_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const PRUNE_EVERY_TICKS = Math.round((60 * 60 * 1000) / SAMPLE_INTERVAL_MS); // ~hourly

const toRow = (nodeId, ts, stats) => ({
    node_id: nodeId,
    ts,
    cpu: stats.cpu?.usagePercent ?? null,
    ram: stats.memory?.usedPercent ?? null,
    disk: stats.disk?.usedPercent ?? null,
    rx: stats.network?.rxBytesPerSec ?? null,
    tx: stats.network?.txBytesPerSec ?? null,
});

const tick = async () => {
    const ts = Date.now();
    const rows = [];

    // Panel VPS
    try {
        rows.push(toRow(nodeService.LOCAL_NODE_ID, ts, await nodeService.getLocalStats()));
    } catch (err) {
        console.error("[Sampler] local stats failed:", err.message);
    }

    // Each enabled remote node (skip unreachable — leaves a gap)
    const nodes = await nodeService.getNodes();
    await Promise.all(
        nodes
            .filter((n) => n.enabled !== false)
            .map(async (n) => {
                try {
                    rows.push(toRow(n._id, ts, await nodeService.getNodeStats(n._id)));
                } catch { /* offline — skip this tick */ }
            }),
    );

    sampleStore.insertMany(rows);
};

let ticks = 0;
let timer = null;

const start = () => {
    if (timer) return;
    tick().catch((e) => console.error("[Sampler]", e.message));
    timer = setInterval(() => {
        tick().catch((e) => console.error("[Sampler]", e.message));
        if (++ticks % PRUNE_EVERY_TICKS === 0) {
            try {
                const removed = sampleStore.prune(Date.now() - RETENTION_MS);
                if (removed) console.log(`[Sampler] pruned ${removed} old samples`);
            } catch (e) { console.error("[Sampler] prune failed:", e.message); }
        }
    }, SAMPLE_INTERVAL_MS);
    console.log(`[Sampler] Resource history started — every ${SAMPLE_INTERVAL_MS / 1000}s, kept ${RETENTION_MS / 86_400_000}d`);
};

module.exports = { start, RETENTION_MS };
