const express = require("express");
const nodeService = require("../services/nodeService");
const sampleStore = require("../services/sampleStore");
const router = express.Router();

const RANGE_MS = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
};

// Own short cache: nodeService.getNodeStats caches for 10s, too coarse for the
// System page's ~4s poll — the live chart would step instead of move.
const CACHE_TTL = 2000;
const statsCache = new Map(); // nodeId → { at, stats }

/**
 * GET /api/system/stats
 * CPU, RAM, disk and network of one node, read from its agent.
 * Honors the X-Panel-Node context; with no node selected it reports the node
 * the panel itself runs on.
 */
router.get("/stats", async (req, res, next) => {
    try {
        const nodeId = req.nodeId || nodeService.panelNodeId();
        const now = Date.now();
        const cached = statsCache.get(nodeId);
        if (cached && now - cached.at < CACHE_TTL) return res.json(cached.stats);

        const node = await nodeService.getNode(nodeId);
        const stats = await nodeService.agentRequest(node, "get", "/stats", { timeout: 8000 });
        statsCache.set(nodeId, { at: Date.now(), stats });
        res.json(stats);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/system/history?node=<id>&range=1h|6h|24h|7d
 * Persistent resource history recorded by samplerService, down-sampled to
 * ~720 points so charts stay light. node defaults to the remote-view context.
 */
router.get("/history", (req, res, next) => {
    try {
        const nodeId = nodeService.resolveNodeId(req.query.node || req.nodeId || undefined);
        const rangeMs = RANGE_MS[req.query.range] || RANGE_MS["6h"];
        const rows = sampleStore.query(nodeId, Date.now() - rangeMs);

        const TARGET = 720;
        if (rows.length <= TARGET) return res.json(rows);

        // Bucket-average down to ~TARGET points
        const bucket = Math.ceil(rows.length / TARGET);
        const out = [];
        for (let i = 0; i < rows.length; i += bucket) {
            const slice = rows.slice(i, i + bucket);
            const avg = (k) => {
                const vals = slice.map((r) => r[k]).filter((v) => v != null);
                return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
            };
            out.push({
                ts: slice[slice.length - 1].ts,
                cpu: avg("cpu"), ram: avg("ram"), disk: avg("disk"), rx: avg("rx"), tx: avg("tx"),
            });
        }
        res.json(out);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
