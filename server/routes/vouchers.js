const express = require("express");
const vouchers = require("../services/voucherService");

// Mounted at /api/vouchers behind authMiddleware — the Vouchers page (services/voucherService.js).
//
//   GET    /status                              who DMs / updates cards, the settings
//   PUT    /settings                            { channelId, pingRoleId, staffRoleIds }
//   GET    /                                    vouchers with their use counts
//   POST   /                                    create
//   PUT    /:id                                 edit
//   DELETE /:id                                 delete with its members and history
//   GET    /redemptions?voucherId=&status=      uses, newest first
//   POST   /redemptions/:id/claim               the admin claims a pending use
//   POST   /redemptions/:id/reject              { reason } — the use goes back to the member
//   GET    /:id/grants                          members it was given to
//   POST   /:id/grants                          { userIds, uses, notify } give it (and DM them)
//   PUT    /:id/grants/:userId                  { uses } this member's own limit ("" = the voucher's)
//   DELETE /:id/grants/:userId                  take it back
//   POST   /:id/grants/:userId/dm               DM the code again

const router = express.Router();

const handle = (fn) => async (req, res, next) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        next(err);
    }
};

router.get("/status", handle(() => vouchers.status()));
router.put("/settings", handle((req) => vouchers.setSettings(req.body || {})));

router.get("/redemptions", handle((req) => ({ redemptions: vouchers.listRedemptions({ voucherId: req.query.voucherId || null, status: req.query.status || null }) })));
router.post("/redemptions/:id/claim", handle((req) => vouchers.claim(req.params.id, { staffTag: "Panel", via: "panel" })));
router.post("/redemptions/:id/reject", handle((req) => vouchers.reject(req.params.id, { staffTag: "Panel", via: "panel", reason: req.body?.reason })));

router.get("/", handle(() => ({ vouchers: vouchers.listVouchers() })));
router.post("/", handle((req) => vouchers.createVoucher(req.body || {})));
router.put("/:id", handle((req) => vouchers.updateVoucher(req.params.id, req.body || {})));
router.delete("/:id", handle((req) => vouchers.deleteVoucher(req.params.id)));

router.get("/:id/grants", handle((req) => ({ grants: vouchers.listGrants(req.params.id) })));
router.post("/:id/grants", handle((req) => vouchers.grant(req.params.id, req.body || {})));
router.put("/:id/grants/:userId", handle((req) => vouchers.updateGrant(req.params.id, req.params.userId, req.body || {})));
router.delete("/:id/grants/:userId", handle((req) => vouchers.revoke(req.params.id, req.params.userId)));
router.post("/:id/grants/:userId/dm", handle((req) => vouchers.resendDm(req.params.id, req.params.userId)));

module.exports = router;
