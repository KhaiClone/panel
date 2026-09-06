const db = require("../db");
const nodeService = require("./nodeService");
const sampleStore = require("./sampleStore");

// ─────────────────────────────────────────────────────────────────────────────
//  Resource sampler — records two series every SAMPLE_INTERVAL, 24/7:
//
//    per NODE  CPU / RAM / disk / network, from the agent's /stats
//    per BOT   CPU / memory / up, from the agent's /pm2/list
//
//  Both come from the same tick and the same pair of requests per node, so the
//  two series share timestamps and can be charted against each other. An
//  offline node is skipped entirely, leaving a gap rather than a false zero.
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_INTERVAL_MS = 15_000;
const MAINTENANCE_EVERY_TICKS = Math.round((60 * 60 * 1000) / SAMPLE_INTERVAL_MS); // ~hourly

const nodeRow = (nodeId, ts, stats) => ({
    node_id: nodeId,
    ts,
    cpu: stats.cpu?.usagePercent ?? null,
    ram: stats.memory?.usedPercent ?? null,
    disk: stats.disk?.usedPercent ?? null,
    rx: stats.network?.rxBytesPerSec ?? null,
    tx: stats.network?.txBytesPerSec ?? null,
});

/**
 * Map one node's PM2 list onto the bots the panel knows about.
 * Keyed by pm2Name because that is what PM2 reports; a bot with no matching
 * process is recorded as down (up = 0) rather than skipped, so a stopped
 * stretch is visible in the chart instead of being an ambiguous gap.
 */
const botRows = (nodeId, ts, procs, botsOnNode) => {
    const byName = new Map(procs.map((p) => [p.name, p]));
    return botsOnNode.map((bot) => {
        const p = byName.get(bot.pm2Name);
        const online = p?.pm2_env?.status === "online";
        return {
            bot_id: bot._id,
            node_id: nodeId,
            ts,
            cpu: online ? (p.monit?.cpu ?? 0) : 0,
            mem: online ? (p.monit?.memory ?? 0) : 0,
            up: online ? 1 : 0,
        };
    });
};

const tick = async () => {
    const ts = Date.now();
    const nodeRows = [];
    const allBotRows = [];

    const [nodes, bots] = await Promise.all([nodeService.getNodes(), db.find("bots")]);

    // Group the panel's bots by the node they live on, once per tick.
    const botsByNode = new Map();
    for (const bot of bots) {
        let id;
        try {
            id = nodeService.resolveNodeId(bot.nodeId);
        } catch {
            continue; // PANEL_NODE_ID unset — nothing sensible to attribute it to
        }
        if (!botsByNode.has(id)) botsByNode.set(id, []);
        botsByNode.get(id).push(bot);
    }

    await Promise.all(
        nodes
            .filter((n) => n.enabled !== false)
            .map(async (n) => {
                const mine = botsByNode.get(n._id) || [];
                // Both requests in parallel; either may fail on its own without
                // costing us the other half of this node's sample.
                const [stats, pm2] = await Promise.allSettled([
                    nodeService.getNodeStats(n._id),
                    mine.length
                        ? nodeService.agentRequest(n, "get", "/pm2/list", { timeout: 10_000 })
                        : Promise.resolve(null),
                ]);
                if (stats.status === "fulfilled") nodeRows.push(nodeRow(n._id, ts, stats.value));
                if (pm2.status === "fulfilled" && pm2.value) {
                    allBotRows.push(...botRows(n._id, ts, pm2.value.processes || [], mine));
                }
            }),
    );

    sampleStore.insertNodeSamples(nodeRows);
    sampleStore.insertBotSamples(allBotRows);
};

let ticks = 0;
let timer = null;

/** Roll raw rows into 5-minute buckets, then drop what is past retention. */
const maintenance = () => {
    try {
        sampleStore.rollup();
    } catch (e) {
        console.error("[Sampler] rollup failed:", e.message);
        return; // never prune raw rows the rollup did not manage to consume
    }
    try {
        const removed = sampleStore.prune();
        if (removed) console.log(`[Sampler] pruned ${removed} expired samples`);
    } catch (e) {
        console.error("[Sampler] prune failed:", e.message);
    }
};

const start = () => {
    if (timer) return;
    tick().catch((e) => console.error("[Sampler]", e.message));
    timer = setInterval(() => {
        tick().catch((e) => console.error("[Sampler]", e.message));
        if (++ticks % MAINTENANCE_EVERY_TICKS === 0) maintenance();
    }, SAMPLE_INTERVAL_MS);

    // Catch up on anything missed while the panel was down.
    setTimeout(maintenance, 30_000);

    const d = (ms) => `${Math.round(ms / 86_400_000)}d`;
    console.log(
        `[Sampler] History started — every ${SAMPLE_INTERVAL_MS / 1000}s | ` +
            `raw ${d(sampleStore.RAW_RETENTION_MS)}, 5m rollup ${d(sampleStore.ROLLUP_RETENTION_MS)}`,
    );
};

module.exports = { start, maintenance, SAMPLE_INTERVAL_MS };
