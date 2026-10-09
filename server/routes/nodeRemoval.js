const express = require("express");
const router = express.Router();

const nodeRemoval = require("../services/nodeRemoval");

// Public — no JWT: the caller is uninstall-agent.sh on a VPS that is leaving
// the panel, with nothing but the token in the URL (random, stored hashed,
// accepted only while that removal runs — see services/nodeRemoval.js).

/**
 * POST /api/node-removal/:token?status=running|done|failed
 * Body (text/plain): the script's output so far.
 */
router.post("/:token", express.text({ type: "text/plain", limit: "256kb" }), async (req, res, next) => {
    try {
        await nodeRemoval.report(req.params.token, {
            status: req.query.status,
            log: typeof req.body === "string" ? req.body : "",
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
