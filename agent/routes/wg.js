const express = require("express");
const router = express.Router();
const wg = require("../services/wg");

// WireGuard control, driven by the panel coordinator. Auth = the shared agent key
// (applied by the global middleware in agent/index.js).

/** GET /wg/pubkey — this node's WireGuard public key + listen port (keygen if needed). */
router.get("/pubkey", async (req, res, next) => {
    try {
        res.json(await wg.getIdentity());
    } catch (err) {
        next(err);
    }
});

/**
 * POST /wg/config
 * body: { address: "10.88.0.X/24", listenPort, peers: [{ pubKey, allowedIps, endpoint, keepalive }] }
 * Writes the conf and brings up / live-reloads the tunnel.
 */
router.post("/config", async (req, res, next) => {
    try {
        const { address, listenPort, peers } = req.body || {};
        res.json(await wg.applyConfig({ address, listenPort }, peers || []));
    } catch (err) {
        next(err);
    }
});

/** GET /wg/status — interface + peer handshakes. */
router.get("/status", async (req, res, next) => {
    try {
        res.json(await wg.status());
    } catch (err) {
        next(err);
    }
});

module.exports = router;
