const express = require("express");
const router = express.Router();
const badgeService = require("./../services/badgeService");

// Mounted at /api/badges behind authMiddleware (see index.js).
// Trang /badges của panel: xem đơn, duyệt những đơn treo ở manual_review.

/** GET /api/badges?status=&ref= — danh sách đơn */
router.get("/", async (req, res, next) => {
    try {
        res.json(
            await badgeService.listOrders({
                ref: req.query.ref ? String(req.query.ref) : null,
                status: req.query.status ? String(req.query.status) : null,
            }),
        );
    } catch (err) {
        next(err);
    }
});

/** GET /api/badges/:orderId */
router.get("/:orderId", async (req, res, next) => {
    try {
        const order = await badgeService.getOrder(req.params.orderId);
        if (!order) return res.status(404).json({ error: "Order not found" });
        res.json(order);
    } catch (err) {
        next(err);
    }
});

/** POST /api/badges/:orderId/resolve { action: "retry" | "forfeit" | "cancel" } */
router.post("/:orderId/resolve", async (req, res, next) => {
    try {
        res.json(await badgeService.resolveManual(req.params.orderId, req.body?.action));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

module.exports = router;
