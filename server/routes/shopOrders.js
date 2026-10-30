const express = require("express");
const router = express.Router();
const orderService = require("../services/orderService");
const decorGift = require("../services/decorGiftService");
const { hasGrant } = require("../middleware/auth");

// Mounted behind pageAuth("orders") (see index.js). Thin proxy to the
// ArnTo-Shop Orders API; the shop enforces its own logic and Discord side-effects.
// The revenue totals go only to the owner and staff holding the
// "orders.revenue" grant (Panel Settings → Staff); the page has the rest.

/** GET /api/shop/orders?status=&sellerId= */
router.get("/orders", async (req, res, next) => {
    try {
        const { status, sellerId } = req.query;
        res.json(await orderService.listOrders({ status, sellerId }));
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/shop/orders/stats?period=2026-10 | 2026 | all — the orders placed in
 * that month / year (Vietnam time) or ever; without `revenue` (overall, per
 * seller and per breakdown row) unless allowed.
 */
router.get("/orders/stats", async (req, res, next) => {
    try {
        const stats = await orderService.getStats({ period: req.query.period });
        res.json(hasGrant(req.auth, "orders.revenue") ? stats : orderService.withoutRevenue(stats));
    } catch (err) {
        next(err);
    }
});

/** POST /api/shop/orders/:orderId/done */
router.post("/orders/:orderId/done", async (req, res, next) => {
    try {
        res.json(await orderService.completeOrder(req.params.orderId));
    } catch (err) {
        next(err);
    }
});

/** POST /api/shop/orders/:orderId/cancel */
router.post("/orders/:orderId/cancel", async (req, res, next) => {
    try {
        res.json(await orderService.cancelOrder(req.params.orderId));
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/shop/orders/:orderId — any status, owner only: it rewrites the
 * shop's revenue and history and cannot be undone (Discord: /order-remove,
 * Administrator only).
 */
router.delete("/orders/:orderId", async (req, res, next) => {
    if (req.auth?.kind !== "owner") return res.status(403).json({ error: "Only the owner can delete orders" });
    try {
        res.json(await orderService.deleteOrder(req.params.orderId));
    } catch (err) {
        next(err);
    }
});

// ── Deco Gift orders made here, for buyers who paid in a ticket ──────────────
// ArnTo-Auto records them as paid (services/decorGiftService.js createByHand).

/** GET /api/shop/deco-gift/catalog — decors sold as Gift, with their prices */
router.get("/deco-gift/catalog", async (req, res, next) => {
    try {
        res.json(await decorGift.catalog());
    } catch (err) {
        next(err);
    }
});

/** GET /api/shop/deco-gift/buyer/:id → { known, tag, reseller } */
router.get("/deco-gift/buyer/:id", async (req, res, next) => {
    try {
        res.json(await decorGift.buyerInfo(req.params.id));
    } catch (err) {
        next(err);
    }
});

/** POST /api/shop/deco-gift/orders { ref, buyerId, skus, note } */
router.post("/deco-gift/orders", async (req, res, next) => {
    try {
        res.json(await decorGift.createByHand(req.body || {}, req.auth));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
