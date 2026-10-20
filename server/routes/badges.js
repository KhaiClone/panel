const express = require("express");
const router = express.Router();
const badgeService = require("./../services/badgeService");

// Mounted at /api/badges behind authMiddleware (see index.js).
// Trang /badges của panel: xem đơn, duyệt những đơn treo ở manual_review, và
// (owner) thêm tay một tài khoản không qua thanh toán.

/** Đơn thêm tay là đơn miễn phí — không phải thứ một quyền staff được trao. */
const ownerOnly = (req, res, next) =>
    req.auth?.kind === "owner"
        ? next()
        : res.status(403).json({ error: "Only the owner can add accounts by hand" });

const fail = (res, err) =>
    res.status(err.status).json({
        error: err.invalidToken ? "The token is invalid or dead" : err.message,
        ...(err.needsValue ? { needsValue: true } : {}),
    });

/** GET /api/badges?status=&ref=&source=manual|auto — danh sách đơn */
router.get("/", async (req, res, next) => {
    try {
        res.json(
            await badgeService.listOrders({
                ref: req.query.ref ? String(req.query.ref) : null,
                status: req.query.status ? String(req.query.status) : null,
                source: req.query.source ? String(req.query.source) : null,
            }),
        );
    } catch (err) {
        next(err);
    }
});

/** POST /api/badges/manual/check { token } — tình trạng tài khoản + catalog cho form thêm tay */
router.post("/manual/check", ownerOnly, async (req, res, next) => {
    try {
        if (!String(req.body?.token ?? "").trim()) {
            return res.status(400).json({ error: "Paste the account's token" });
        }
        res.json(await badgeService.checkManual({ token: req.body.token }));
    } catch (err) {
        if (err.status) return fail(res, err);
        next(err);
    }
});

/** POST /api/badges/manual { token, badgeKey, tierKey, currentValue?, note? } — đơn miễn phí */
router.post("/manual", ownerOnly, async (req, res, next) => {
    try {
        const { token, badgeKey, tierKey, currentValue, note } = req.body || {};
        if (!badgeKey || !tierKey) return res.status(400).json({ error: "Pick a badge and a tier" });
        res.status(201).json(
            await badgeService.createManualOrder(
                { token, badgeKey, tierKey, currentValue: currentValue ?? null, note },
                req.auth.username ?? "owner",
            ),
        );
    } catch (err) {
        if (err.status) return fail(res, err);
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
