const express = require("express");
const decorGift = require("../services/decorGiftService");

// Mounted at /api/external/decor-gift behind apiKeyMiddleware — ArnTo-Auto's
// Deco Gift panel (services/decorGiftService.js). A project key only: the
// shared PANEL_API_KEY does not say who is selling.
//
//   GET  /catalog                      decors sold as Gift, with prices + images
//   POST /orders                       { paymentId, buyerId, sellerId, items, total } → the shop's order
//   POST /orders/:orderId/deliver      { buyerId, items: [{ name, type, link }] } → assistant DMs, shop completes
//   POST /orders/:orderId/complete     the shop completes (a retry after a delivered-but-not-completed)
//   POST /orders/:orderId/cancel       the shop cancels

const router = express.Router();

router.use((req, res, next) => {
    if (!req.apiCaller?.botId) return res.status(403).json({ error: "Deco Gift needs a project API key (Panel Settings → API Keys)" });
    next();
});

const handle = (fn) => async (req, res) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
};

router.get("/catalog", handle(() => decorGift.catalog()));
router.post("/orders", handle((req) => decorGift.createOrder(req.body || {})));
router.post("/orders/:orderId/deliver", handle((req) => decorGift.deliver(req.params.orderId, req.body || {})));
router.post("/orders/:orderId/complete", handle((req) => decorGift.completeOrder(req.params.orderId)));
router.post("/orders/:orderId/cancel", handle((req) => decorGift.cancelOrder(req.params.orderId)));

module.exports = router;
