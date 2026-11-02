const express = require("express");
const ownerAccess = require("../services/ownerAccess");
const { clientIp } = require("../middleware/auth");
const router = express.Router();

// Panel Settings → Security: the IPs the owner account works from
// (services/ownerAccess.js). Owner only (mounted behind authMiddleware).
// IPs travel in the body, never the URL: an IPv6 one carries "/64".

const fail = (res, next, err) => (err.status ? res.status(err.status).json({ error: err.message }) : next(err));

/** GET /api/owner-ips — the list, the env ones, blocked, waiting, and whether Discord can take approvals. */
router.get("/", async (req, res, next) => {
    try {
        res.json({ ...ownerAccess.list(clientIp(req)), discord: await ownerAccess.approvals() });
    } catch (err) {
        fail(res, next, err);
    }
});

/** POST /api/owner-ips/remove { ip } — the owner account no longer works from it. */
router.post("/remove", (req, res, next) => {
    try {
        ownerAccess.remove(req.body?.ip);
        res.json({ ok: true });
    } catch (err) {
        fail(res, next, err);
    }
});

/** POST /api/owner-ips/unblock { ip } — a denied IP may ask again. */
router.post("/unblock", (req, res, next) => {
    try {
        ownerAccess.unblock(req.body?.ip);
        res.json({ ok: true });
    } catch (err) {
        fail(res, next, err);
    }
});

module.exports = router;
