const express = require("express");
const vouchers = require("../services/voucherService");

// Mounted at /api/external/vouchers behind apiKeyMiddleware — ArnTo-assistant's
// /voucher and its claim cards (services/voucherService.js). A project key only.
//
//   GET  /mine?userId=                 the member's vouchers with their uses left
//   POST /redeem                       { code, userId, userTag, note } → a pending use
//                                      { ok, view, card } or { ok: false, reason }
//   POST /redemptions/:id/card         { channelId, messageId } where the card was posted
//   POST /redemptions/:id/claim        { staffId, staffTag, isAdmin, roleIds } → view
//   POST /redemptions/:id/reject       { staffId, staffTag, isAdmin, roleIds, reason } → view
//
// A use already claimed / rejected answers 409 with its current `view`.

const router = express.Router();

router.use((req, res, next) => {
    if (!req.apiCaller?.botId) return res.status(403).json({ error: "Vouchers need a project API key (Panel Settings → API Keys)" });
    next();
});

const handle = (fn) => async (req, res) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message, ...(err.view ? { view: err.view } : {}) });
    }
};

const staff = (req) => {
    const { staffId, staffTag, isAdmin, roleIds, reason } = req.body || {};
    if (!vouchers.canClaim({ isAdmin, roleIds })) throw Object.assign(new Error("Only admins can claim vouchers"), { status: 403 });
    return { staffId, staffTag, reason, via: "discord" };
};

router.get("/mine", handle((req) => ({ vouchers: vouchers.mine(req.query.userId) })));
router.post(
    "/redeem",
    handle((req) => {
        const { code, userId, userTag, note } = req.body || {};
        return vouchers.redeem({ code, userId, userTag, note });
    }),
);
router.post("/redemptions/:id/card", handle((req) => vouchers.attachCard(req.params.id, req.body || {})));
router.post("/redemptions/:id/claim", handle((req) => vouchers.claim(req.params.id, staff(req))));
router.post("/redemptions/:id/reject", handle((req) => vouchers.reject(req.params.id, staff(req))));

module.exports = router;
