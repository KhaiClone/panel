const express = require("express");
const router = express.Router();

const nodeJoin = require("../services/nodeJoin");

// Public — no JWT: a new VPS has nothing but the token in the URL, and every
// route here is useless without a live one (single use, 30 minutes, stored
// hashed, bound to one IP — see services/nodeJoin.js). Mounted after the
// lifecycle gate, so a panel that is starting or moving refuses the join itself.

/**
 * GET /api/join/:token/install.sh — agent/setup-agent.sh with this invite's
 * settings. An unusable token gets a script that prints why and exits 1, so
 * `bash join-node.sh` shows the reason rather than curl's bare status code.
 */
router.get("/:token/install.sh", async (req, res) => {
    res.set("Cache-Control", "no-store").type("text/x-shellscript");
    try {
        res.send(await nodeJoin.script(req.params.token));
    } catch (err) {
        res.status(err.status || 500).send(nodeJoin.errorScript(err.message));
    }
});

/** POST /api/join/:token — the script's callback: { apiKey (encrypted with the token), agentPort } */
router.post("/:token", async (req, res, next) => {
    try {
        const { node } = await nodeJoin.join(req.params.token, req.body || {});
        res.status(201).json({ node });
    } catch (err) {
        next(err);
    }
});

/** GET /api/join/:token — provisioning progress, for the script to print. */
router.get("/:token", async (req, res, next) => {
    try {
        res.set("Cache-Control", "no-store").json(await nodeJoin.status(req.params.token));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
