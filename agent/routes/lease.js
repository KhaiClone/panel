const express = require("express");
const router = express.Router();
const lease = require("../services/panelLease");
const gateway = require("../services/panelGateway");

/** GET /lease — which panel this agent follows. */
router.get("/", (req, res) => {
    res.json(lease.read());
});

/**
 * GET /lease/gateway — the local panel gateway: is it listening, where does it
 * forward, and can this machine reach that address.
 */
router.get("/gateway", async (req, res, next) => {
    try {
        res.json(await gateway.status());
    } catch (err) {
        next(err);
    }
});

/**
 * POST /lease   body: { epoch, panelNodeId, panelUrl? }
 * A panel claims this agent. Refused with 409 when a newer panel already has.
 * panelUrl is where this node's panel gateway forwards to (services/panelGateway.js).
 */
router.post("/", (req, res, next) => {
    try {
        const { epoch, panelNodeId, panelUrl } = req.body || {};
        const result = lease.claim(Number(epoch), panelNodeId, panelUrl ?? null);
        if (!result.ok) {
            return res.status(409).json({
                error: `A newer panel (epoch ${result.lease.epoch}) already controls this node`,
                code: lease.SUPERSEDED,
                lease: result.lease,
            });
        }
        res.json(result.lease);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
