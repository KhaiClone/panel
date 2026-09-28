const express = require("express");
const router = express.Router();
const lease = require("../services/panelLease");

/** GET /lease — which panel this agent follows. */
router.get("/", (req, res) => {
    res.json(lease.read());
});

/**
 * POST /lease   body: { epoch, panelNodeId }
 * A panel claims this agent. Refused with 409 when a newer panel already has.
 */
router.post("/", (req, res, next) => {
    try {
        const { epoch, panelNodeId } = req.body || {};
        const result = lease.claim(Number(epoch), panelNodeId);
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
