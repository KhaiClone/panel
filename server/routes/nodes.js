const express = require("express");
const router = express.Router();

const db = require("../db");
const nodeService = require("../services/nodeService");

// Mounted behind authMiddleware + adminOnly (see index.js).

/**
 * GET /api/nodes
 * All nodes (virtual "local" first) with live status, stats, and bot counts.
 */
router.get("/", async (req, res, next) => {
    try {
        const nodes = await nodeService.getAllNodesWithStats();
        const bots = await db.find("bots");

        const withCounts = nodes.map((n) => ({
            ...n,
            botCount: bots.filter((b) => (b.nodeId || nodeService.LOCAL_NODE_ID) === n._id).length,
        }));

        res.json(withCounts);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/nodes
 * Register a worker node. Connection is tested before saving.
 * Body: { name, host, port, apiKey }
 */
router.post("/", async (req, res, next) => {
    try {
        const { name, host, port, apiKey } = req.body;
        if (!name || !host || !port || !apiKey) {
            return res.status(400).json({ error: "name, host, port, and apiKey are required" });
        }

        const parsedPort = parseInt(port, 10);
        if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
            return res.status(400).json({ error: "Invalid port" });
        }

        const existing = await db.findOne("nodes", { host, port: parsedPort });
        if (existing) {
            return res.status(409).json({ error: `A node at ${host}:${parsedPort} already exists ("${existing.name}")` });
        }

        // Verify the agent is reachable with this key before saving
        const candidate = { name, host, port: parsedPort, apiKey };
        const healthy = await nodeService.checkNodeHealth(candidate);
        if (!healthy) {
            return res.status(400).json({
                error: `Cannot reach the agent at ${host}:${parsedPort} — check that the agent is running, the API key matches, and the firewall allows this panel's IP`,
            });
        }

        const node = await db.create("nodes", {
            name,
            host,
            port: parsedPort,
            apiKey,
            enabled: true,
            createdAt: Date.now(),
        });

        const { apiKey: _hidden, ...safe } = node;
        res.status(201).json(safe);
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/nodes/:id
 * Body: { name?, host?, port?, apiKey?, enabled? }
 */
router.put("/:id", async (req, res, next) => {
    try {
        const node = await db.findOne("nodes", { _id: req.params.id });
        if (!node) return res.status(404).json({ error: "Node not found" });

        const { name, host, port, apiKey, enabled } = req.body;
        const updates = {};
        if (name !== undefined) updates.name = name;
        if (host !== undefined) updates.host = host;
        if (port !== undefined) {
            const p = parseInt(port, 10);
            if (isNaN(p) || p < 1 || p > 65535) return res.status(400).json({ error: "Invalid port" });
            updates.port = p;
        }
        if (apiKey !== undefined && apiKey !== "") updates.apiKey = apiKey;
        if (enabled !== undefined) updates.enabled = !!enabled;

        const updated = await db.findOneAndUpdate("nodes", { _id: req.params.id }, updates);
        const { apiKey: _hidden, ...safe } = updated;
        res.json(safe);
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/nodes/:id
 * Refused while any bot still lives on the node.
 */
router.delete("/:id", async (req, res, next) => {
    try {
        const node = await db.findOne("nodes", { _id: req.params.id });
        if (!node) return res.status(404).json({ error: "Node not found" });

        const botsOnNode = await db.find("bots", { nodeId: req.params.id });
        if (botsOnNode.length > 0) {
            return res.status(400).json({
                error: `Cannot delete node "${node.name}" — ${botsOnNode.length} bot(s) still run on it. Remove or migrate them first.`,
            });
        }

        await db.findOneAndDelete("nodes", { _id: req.params.id });
        res.json({ message: `Node "${node.name}" deleted` });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/nodes/:id/test
 * Live connection + stats check.
 */
router.post("/:id/test", async (req, res, next) => {
    try {
        const node = await db.findOne("nodes", { _id: req.params.id });
        if (!node) return res.status(404).json({ error: "Node not found" });

        const healthy = await nodeService.checkNodeHealth(node);
        if (!healthy) {
            return res.json({ ok: false, message: "Agent is not responding (check agent process, API key, firewall)" });
        }

        let stats = null;
        try { stats = await nodeService.agentRequest(node, "get", "/stats", { timeout: 8000 }); } catch { /* health ok is enough */ }
        res.json({ ok: true, message: "Connection OK", stats });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
