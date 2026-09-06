const express = require("express");
const nodeService = require("../services/nodeService");
const history = require("../services/historyService");
const router = express.Router();


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
 * GET /api/system/history?node=<id>&range=1h|6h|24h|7d|30d
 * One node's resource history, columnar and capped so a 30-day range costs the
 * browser no more than an hour. Defaults to the X-Panel-Node context.
 */
router.get("/history", (req, res, next) => {
    try {
        const nodeId = nodeService.resolveNodeId(req.query.node || req.nodeId || undefined);
        res.json(history.nodeHistory(nodeId, req.query.range));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
