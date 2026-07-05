const express = require("express");
const router = express.Router();
const shopService = require("../services/shopService");

// Mounted behind authMiddleware + adminOnly (see index.js). Thin proxy to the
// ArnTo-Shop Orders API; the shop enforces its own logic and Discord side-effects.

/** GET /api/shop/orders?status=&sellerId= */
router.get("/orders", async (req, res, next) => {
    try {
        const { status, sellerId } = req.query;
        res.json(await shopService.listOrders({ status, sellerId }));
    } catch (err) {
        next(err);
    }
});

/** GET /api/shop/orders/stats */
router.get("/orders/stats", async (req, res, next) => {
    try {
        res.json(await shopService.getStats());
    } catch (err) {
        next(err);
    }
});

/** POST /api/shop/orders/:orderId/done */
router.post("/orders/:orderId/done", async (req, res, next) => {
    try {
        res.json(await shopService.completeOrder(req.params.orderId));
    } catch (err) {
        next(err);
    }
});

/** POST /api/shop/orders/:orderId/cancel */
router.post("/orders/:orderId/cancel", async (req, res, next) => {
    try {
        res.json(await shopService.cancelOrder(req.params.orderId));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
