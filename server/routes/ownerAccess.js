const express = require("express");
const ownerAccess = require("../services/ownerAccess");
const { clientIp } = require("../middleware/auth");
const router = express.Router();

// Panel Settings → Security: the devices the owner account works on
// (services/ownerAccess.js). Owner only (mounted behind authMiddleware).
// IPs travel in the body, never the URL: an IPv6 one carries "/64".

const fail = (res, next, err) => (err.status ? res.status(err.status).json({ error: err.message }) : next(err));

/** GET /api/owner-access — devices, ADMIN_ALLOWED_IPS, waiting sign-ins, denied IPs, and whether Discord can take approvals. */
router.get("/", async (req, res, next) => {
    try {
        res.json({ ...ownerAccess.list({ ip: clientIp(req), device: ownerAccess.deviceOf(req) }), discord: await ownerAccess.approvals() });
    } catch (err) {
        fail(res, next, err);
    }
});

/** POST /api/owner-access/remove { id } — the owner account stops working on that device. */
router.post("/remove", (req, res, next) => {
    try {
        ownerAccess.remove(req.body?.id);
        res.json({ ok: true });
    } catch (err) {
        fail(res, next, err);
    }
});

/** POST /api/owner-access/unblock { ip } — a denied IP may ask again. */
router.post("/unblock", (req, res, next) => {
    try {
        ownerAccess.unblock(req.body?.ip);
        res.json({ ok: true });
    } catch (err) {
        fail(res, next, err);
    }
});

module.exports = router;
