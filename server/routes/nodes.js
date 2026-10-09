const express = require("express");
const router = express.Router();

const db = require("../db");
const nodeService = require("../services/nodeService");
const nodeSetup = require("../services/nodeSetup");
const nodeJoin = require("../services/nodeJoin");
const nodeRemoval = require("../services/nodeRemoval");
const history = require("../services/historyService");

// Mounted behind authMiddleware (see index.js).

/**
 * GET /api/nodes
 * All registered nodes with live status, stats, and bot counts.
 * The panel's own node is flagged isPanelNode and sorted first.
 */
router.get("/", async (req, res, next) => {
    try {
        const nodes = await nodeService.getAllNodesWithStats();
        const bots = await db.find("bots");

        const withCounts = nodes.map((n) => ({
            ...n,
            // Legacy rows still carrying nodeId "local" belong to the panel's node.
            botCount: bots.filter((b) => {
                try { return nodeService.resolveNodeId(b.nodeId) === n._id; } catch { return false; }
            }).length,
        }));

        res.json(withCounts);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/nodes/history?range=1h|6h|24h|7d|30d
 * Every node's series in one request, shaped for the sparklines in the systems
 * list. Declared before "/:id/..." so "history" is not read as a node id.
 */
router.get("/history", (req, res, next) => {
    try {
        res.json(history.allNodesHistory(req.query.range));
    } catch (err) {
        next(err);
    }
});

// ── One-command join (services/nodeJoin.js) ──────────────────────────────────
// The admin side: create / watch / revoke invites. The new VPS talks to the
// public routes/join.js with the token.

/** GET /api/nodes/invites — recent invites (last 24h), newest first. */
router.get("/invites", async (req, res, next) => {
    try {
        res.json(await nodeJoin.list());
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/nodes/invites   body: { name, ip, port?, origin? }
 * → { invite, token, command, secure }. The token is shown this once.
 * origin is the address the admin's browser uses for the panel — the command
 * uses it when the panel has no HTTPS address of its own.
 */
router.post("/invites", async (req, res, next) => {
    try {
        res.status(201).json(await nodeJoin.create(req.body || {}));
    } catch (err) {
        next(err);
    }
});

/** GET /api/nodes/invites/:inviteId — status and provisioning steps. */
router.get("/invites/:inviteId", async (req, res, next) => {
    try {
        res.json(await nodeJoin.get(req.params.inviteId));
    } catch (err) {
        next(err);
    }
});

/** DELETE /api/nodes/invites/:inviteId — revoke a pending invite. */
router.delete("/invites/:inviteId", async (req, res, next) => {
    try {
        res.json(await nodeJoin.revoke(req.params.inviteId));
    } catch (err) {
        next(err);
    }
});

// ── Removing a node (services/nodeRemoval.js) ────────────────────────────────

/** GET /api/nodes/removals — removals of the last 24h, newest first. */
router.get("/removals", async (req, res, next) => {
    try {
        res.json(await nodeRemoval.list());
    } catch (err) {
        next(err);
    }
});

/** GET /api/nodes/removals/:removalId — the panel's steps and the VPS's output. */
router.get("/removals/:removalId", async (req, res, next) => {
    try {
        res.json(await nodeRemoval.get(req.params.removalId));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/nodes
 * Register a worker node. Connection is tested before saving.
 * Body: { name, host, port, apiKey, controlHost? }
 */
router.post("/", async (req, res, next) => {
    try {
        const { name, host, port, apiKey, controlHost } = req.body;
        const node = await nodeSetup.register({ name, host, port, apiKey, controlHost });

        // SSH keys, WireGuard, lease, panel gateway, Lavalink — best-effort and in
        // the background: registration must not fail because Java is missing or
        // GitHub is briefly unreachable. Each page shows its own outcome.
        nodeSetup
            .provision(node)
            .then((steps) => {
                for (const s of steps.filter((x) => x.status !== "ok")) {
                    console.warn(`[Nodes] "${node.name}" — ${s.label}: ${s.status}${s.detail ? ` (${s.detail})` : ""}`);
                }
            })
            .catch((err) => console.error(`[Nodes] Setting up "${node.name}" failed:`, err.message));

        const { apiKey: _hidden, ...safe } = node;
        res.status(201).json(safe);
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/nodes/:id
 * Body: { name?, host?, port?, apiKey?, enabled?, controlHost?, questProxy? }
 *
 * questProxy: false keeps the node out of the egress proxy pool (Auto Quest,
 * Auto Badge — see proxyPool) while it still serves everything else.
 *
 * controlHost is the address the panel uses to reach this node's agent, and
 * nothing else. Sending "" clears it, falling back to host. Never confuse it
 * with host: wgService._peersFor() publishes host as the WireGuard endpoint to
 * every other node, and executor.buildEgressProxyConf() uses host as the proxy
 * address — pointing either of those at a loopback address breaks them.
 */
router.put("/:id", async (req, res, next) => {
    try {
        const node = await db.findOne("nodes", { _id: req.params.id });
        if (!node) return res.status(404).json({ error: "Node not found" });

        const { name, host, port, apiKey, enabled, controlHost, questProxy } = req.body;
        const updates = {};
        if (name !== undefined) updates.name = name;
        if (host !== undefined) updates.host = host;
        if (controlHost !== undefined) updates.controlHost = controlHost || null;
        if (port !== undefined) {
            const p = parseInt(port, 10);
            if (isNaN(p) || p < 1 || p > 65535) return res.status(400).json({ error: "Invalid port" });
            updates.port = p;
        }
        if (apiKey !== undefined && apiKey !== "") updates.apiKey = apiKey;
        if (enabled !== undefined) updates.enabled = !!enabled;
        if (questProxy !== undefined) updates.questProxy = !!questProxy;

        const updated = await db.findOneAndUpdate("nodes", { _id: req.params.id }, updates);

        // Enable/disable or endpoint (host/port) changes affect the mesh — re-push.
        if (enabled !== undefined || host !== undefined || port !== undefined) {
            require("../services/wgService")
                .syncMesh()
                .catch((err) => console.error(`[Nodes] WG mesh sync after updating "${updated.name}" failed:`, err.message));
        }

        const { apiKey: _hidden, ...safe } = updated;
        res.json(safe);
    } catch (err) {
        next(err);
    }
});

/** GET /api/nodes/:id/impact — what removing the node touches; the Remove dialog shows it first (nodeRemoval.impact). */
router.get("/:id/impact", async (req, res, next) => {
    try {
        const node = await db.findOne("nodes", { _id: req.params.id });
        if (!node) return res.status(404).json({ error: "Node not found" });
        res.json(await nodeRemoval.impact(node));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/nodes/:id/remove   body: { mode: "panel" | "vps", parts?: ["ssh", "firewall", "packages"], origin? }
 * → the removal record (follow it at /removals/:removalId).
 * "panel" only forgets the node; "vps" has the agent uninstall itself first,
 * removing `parts` too (all three = everything the setup did). Refused for the
 * panel's own node and while projects live on the node. Egress pins through
 * the node are cleared and its stale copies forgotten — the record lists them.
 */
router.post("/:id/remove", async (req, res, next) => {
    try {
        const { mode, parts, origin } = req.body || {};
        res.json(await nodeRemoval.remove(req.params.id, { mode, parts, origin }));
    } catch (err) {
        next(err);
    }
});

/** DELETE /api/nodes/:id — remove from the panel only (POST /:id/remove with mode "panel"). */
router.delete("/:id", async (req, res, next) => {
    try {
        const removal = await nodeRemoval.remove(req.params.id, { mode: "panel" });
        res.json({ message: `Node "${removal.name}" deleted`, removal, staleCopies: removal.staleCopies, egressBots: removal.egressBots });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/nodes/wg/sync — (re)build the WireGuard overlay: assign identities/IPs to
 * any node missing them and push the full mesh to every reachable node.
 */
router.post("/wg/sync", async (req, res, next) => {
    try {
        res.json({ results: await require("../services/wgService").syncMesh() });
    } catch (err) {
        next(err);
    }
});

// ── Agent detail proxies ─────────────────────────────────────────────────────
// These forward to the node's agent — used by the NodeDetail page and the
// per-node System Monitor view.

const withNode = (handler) => async (req, res, next) => {
    try {
        const node = await db.findOne("nodes", { _id: req.params.id });
        if (!node) return res.status(404).json({ error: "Node not found" });
        await handler(node, req, res);
    } catch (err) {
        next(err);
    }
};

/** GET /api/nodes/:id/stats — live stats of one node (cached ~10s) */
router.get("/:id/stats", withNode(async (node, req, res) => {
    res.json(await nodeService.getNodeStats(node._id));
}));

/** GET /api/nodes/:id/info — agent self-description */
router.get("/:id/info", withNode(async (node, req, res) => {
    res.json(await nodeService.agentRequest(node, "get", "/self/info", { timeout: 15_000 }));
}));

/** GET /api/nodes/:id/logs?lines= — the agent's own PM2 logs */
router.get("/:id/logs", withNode(async (node, req, res) => {
    const lines = Math.min(parseInt(req.query.lines) || 100, 500);
    res.json(await nodeService.agentRequest(node, "get", "/self/logs", { params: { lines }, timeout: 30_000 }));
}));

/** GET /api/nodes/:id/processes — full PM2 list on the node */
router.get("/:id/processes", withNode(async (node, req, res) => {
    res.json(await nodeService.agentRequest(node, "get", "/pm2/list", { timeout: 15_000 }));
}));

/** POST /api/nodes/:id/restart-agent */
router.post("/:id/restart-agent", withNode(async (node, req, res) => {
    res.json(await nodeService.agentRequest(node, "post", "/self/restart", { timeout: 15_000 }));
}));

/** POST /api/nodes/:id/update-agent — git pull + npm install + restart on the node */
router.post("/:id/update-agent", withNode(async (node, req, res) => {
    res.json(await nodeService.agentRequest(node, "post", "/self/update", { timeout: 400_000 }));
}));

/**
 * POST /api/nodes/:id/test
 * Live connection + stats check.
 */
/**
 * GET /api/nodes/:id/bots-history?range=...
 * CPU/memory history of every bot running on this node — the breakdown of who
 * is actually consuming the machine.
 */
router.get("/:id/bots-history", async (req, res, next) => {
    try {
        res.json(history.nodeBotsHistory(nodeService.resolveNodeId(req.params.id), req.query.range));
    } catch (err) {
        next(err);
    }
});

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
