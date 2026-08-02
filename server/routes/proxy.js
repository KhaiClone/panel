const express = require("express");
const router = express.Router();
const db = require("../db");
const executor = require("../services/executor");
const nodeService = require("../services/nodeService");

// ─────────────────────────────────────────────────────────────────────────────
//  Egress proxy — pin a bot's public IP to a chosen VPS, independent of the node
//  that runs the process. Uses the agent CONNECT proxies (see agent/services/
//  proxy.js) applied via proxychains4 on the run host (see executor.startBot).
//  Replaces the old global socks/http proxy feature.
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL = nodeService.LOCAL_NODE_ID;

/** GET /api/proxy — bots + their egress setting, and the VPSes available as egress. */
router.get("/", async (req, res, next) => {
    try {
        const nodes = await nodeService.getNodes(); // agent nodes (proxy-capable)
        const bots = (await db.find("bots")) || [];
        res.json({
            nodes: nodes.map((n) => ({ _id: n._id, name: n.name, host: n.host })),
            bots: bots.map((b) => ({
                _id: b._id,
                name: b.name,
                pm2Name: b.pm2Name,
                projectType: b.projectType || "discord",
                nodeId: b.nodeId || LOCAL,
                egressNodeId: b.egressNodeId || "",
            })),
        });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/proxy/bots/:id  { egressNodeId }
 * Set which VPS the bot egresses through ("" = none / run-host IP). If the bot is
 * running, re-register it so the new proxy wrapper takes effect immediately.
 */
router.put("/bots/:id", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Không tìm thấy bot." });

        let egressNodeId = req.body?.egressNodeId ?? "";
        egressNodeId = egressNodeId ? String(egressNodeId).trim() : "";
        if (egressNodeId && egressNodeId !== LOCAL) {
            // Validate the target node exists (getNode throws if it doesn't).
            await nodeService.getNode(egressNodeId);
        }

        const updated = await db.findOneAndUpdate(
            "bots",
            { _id: req.params.id },
            { egressNodeId },
        );

        // Apply immediately when the bot is online (re-register with the new wrapper).
        let applied = false;
        try {
            const status = await executor.getBotStatus(updated);
            if (status?.status === "online") {
                await executor.startBot(updated);
                applied = true;
            }
        } catch (e) {
            console.warn(`[Egress] apply for ${updated.pm2Name}: ${e.message}`);
        }

        res.json({ ok: true, applied, egressNodeId });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

module.exports = router;
