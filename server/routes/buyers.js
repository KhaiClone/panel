const express = require("express");
const router = express.Router();
const buyerService = require("../services/buyerService");
const { hasGrant } = require("../middleware/auth");

// Mounted at /api/buyers behind pageAuth("buyers") (see index.js). Read-only.
// Amounts go only to the owner and staff holding "orders.revenue" (the Orders
// page's "See revenue"): the buyers' spend is the shop's income again.

/**
 * GET /api/buyers?period=2026-10 | 2026 | all | 2026-10-05_2026-10-20
 *   &sort=spent|completed|orders|average|recent &seller=<id>|all
 *   &source=ticket|autoQuest|autoQuestMonthly|autoBadge|decoGift|all &resellers=1
 * — buyers in that period, ranked.
 */
router.get("/", async (req, res, next) => {
    try {
        const { period, sort, seller, source, resellers } = req.query;
        res.json(await buyerService.list({ period, sort, seller, source, resellers, money: hasGrant(req.auth, "orders.revenue") }));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** GET /api/buyers/:buyerId — one buyer, all time, with every order they placed */
router.get("/:buyerId", async (req, res, next) => {
    try {
        res.json(await buyerService.profile(req.params.buyerId, { money: hasGrant(req.auth, "orders.revenue") }));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

module.exports = router;
