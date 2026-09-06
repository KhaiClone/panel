const sampleStore = require("./sampleStore");

// ─────────────────────────────────────────────────────────────────────────────
//  History shaping — one place that turns stored rows into chart-ready data.
//
//  Everything is returned COLUMNAR ({ ts: [], cpu: [], … }) rather than as an
//  array of objects: that is exactly the layout uPlot consumes, it avoids
//  repeating key names thousands of times over the wire, and it keeps the
//  client from having to transpose anything.
//
//  Series are capped at MAX_POINTS by bucket-averaging, so a 30-day range costs
//  the browser the same as a 1-hour one.
// ─────────────────────────────────────────────────────────────────────────────

const RANGE_MS = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
};
const DEFAULT_RANGE = "6h";

// Enough for a smooth line on a wide screen, few enough to stay light.
const MAX_POINTS = 720;
// A sparkline in a table row is ~120px wide; more points would be invisible.
const SPARK_POINTS = 60;

const rangeMs = (key) => RANGE_MS[key] || RANGE_MS[DEFAULT_RANGE];
const rangeKeys = () => Object.keys(RANGE_MS);

const avg = (vals) => {
    let sum = 0;
    let n = 0;
    for (const v of vals) {
        if (v !== null && v !== undefined && Number.isFinite(v)) {
            sum += v;
            n++;
        }
    }
    return n ? sum / n : null;
};

/**
 * Rows → columnar series, bucket-averaged down to at most `target` points.
 * `keys` names the numeric columns to carry through; ts is always included.
 */
const toColumns = (rows, keys, target = MAX_POINTS) => {
    const out = { ts: [] };
    for (const k of keys) out[k] = [];
    if (!rows || rows.length === 0) return out;

    if (rows.length <= target) {
        for (const r of rows) {
            out.ts.push(r.ts);
            for (const k of keys) out[k].push(r[k] ?? null);
        }
        return out;
    }

    const bucket = Math.ceil(rows.length / target);
    for (let i = 0; i < rows.length; i += bucket) {
        const slice = rows.slice(i, i + bucket);
        out.ts.push(slice[slice.length - 1].ts);
        for (const k of keys) out[k].push(avg(slice.map((r) => r[k])));
    }
    return out;
};

const NODE_KEYS = ["cpu", "ram", "disk", "rx", "tx"];
const BOT_KEYS = ["cpu", "mem", "up"];

/** One node's CPU/RAM/disk/network history. */
const nodeHistory = (nodeId, range) => {
    const ms = rangeMs(range);
    return {
        range: RANGE_MS[range] ? range : DEFAULT_RANGE,
        from: Date.now() - ms,
        ...toColumns(sampleStore.queryNode(nodeId, Date.now() - ms), NODE_KEYS),
    };
};

/**
 * Every node at once, shaped for sparklines in the systems list.
 * One SQL query for all nodes rather than one per row.
 */
const allNodesHistory = (range, points = SPARK_POINTS) => {
    const ms = rangeMs(range);
    const grouped = sampleStore.queryAllNodes(Date.now() - ms);
    const nodes = {};
    for (const [nodeId, rows] of Object.entries(grouped)) {
        nodes[nodeId] = toColumns(rows, NODE_KEYS, points);
    }
    return { range: RANGE_MS[range] ? range : DEFAULT_RANGE, from: Date.now() - ms, nodes };
};

/** One bot's CPU/memory history. `up` is 1 while the process was online. */
const botHistory = (botId, range) => {
    const ms = rangeMs(range);
    return {
        range: RANGE_MS[range] ? range : DEFAULT_RANGE,
        from: Date.now() - ms,
        ...toColumns(sampleStore.queryBot(botId, Date.now() - ms), BOT_KEYS),
    };
};

/** Every bot on one node — the per-node breakdown of who is using what. */
const nodeBotsHistory = (nodeId, range, points = SPARK_POINTS) => {
    const ms = rangeMs(range);
    const grouped = sampleStore.queryBotsOnNode(nodeId, Date.now() - ms);
    const bots = {};
    for (const [botId, rows] of Object.entries(grouped)) {
        bots[botId] = toColumns(rows, BOT_KEYS, points);
    }
    return { range: RANGE_MS[range] ? range : DEFAULT_RANGE, from: Date.now() - ms, bots };
};

module.exports = {
    RANGE_MS,
    DEFAULT_RANGE,
    MAX_POINTS,
    SPARK_POINTS,
    rangeKeys,
    nodeHistory,
    allNodesHistory,
    botHistory,
    nodeBotsHistory,
};
