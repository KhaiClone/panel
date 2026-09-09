const express = require("express");
const router = express.Router();
const badgeService = require("./../services/badgeService");
const badgeReader = require("./../services/badgeReader");
const readerStore = require("./../services/badgeReaderStore");

// Mounted at /api/badges behind authMiddleware (see index.js).
// Trang /badges của panel: xem đơn, duyệt những đơn treo ở manual_review.

// ── Pool reader ──────────────────────────────────────────────────────────────────
// Khai báo trước /:orderId để "readers" không bị đọc thành một orderId.

/** GET /api/badges/readers — pool + tóm tắt sức khoẻ */
router.get("/readers", async (req, res, next) => {
    try {
        res.json(await badgeReader.readerStatus());
    } catch (err) {
        next(err);
    }
});

/** POST /api/badges/readers { token, label } — thêm reader (token được xác thực trước) */
router.post("/readers", async (req, res, next) => {
    try {
        const { token, label } = req.body || {};
        if (!token) return res.status(400).json({ error: "token là bắt buộc" });
        res.status(201).json(await badgeReader.addReader(String(token).trim(), label));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** PATCH /api/badges/readers/:id { label?, enabled?, token? } */
router.patch("/readers/:id", async (req, res, next) => {
    try {
        if (req.body?.token) {
            return res.json(
                await badgeReader.replaceReaderToken(req.params.id, String(req.body.token).trim()),
            );
        }
        res.json(await readerStore.update(req.params.id, req.body || {}));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** POST /api/badges/readers/:id/verify — hỏi lại Discord xem còn dùng được không */
router.post("/readers/:id/verify", async (req, res, next) => {
    try {
        res.json(await badgeReader.verifyReader(req.params.id));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** POST /api/badges/readers/verify-all */
router.post("/readers/verify-all", async (req, res, next) => {
    try {
        res.json(await badgeReader.verifyAllReaders());
    } catch (err) {
        next(err);
    }
});

/** DELETE /api/badges/readers/:id */
router.delete("/readers/:id", async (req, res, next) => {
    try {
        await readerStore.remove(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** GET /api/badges/reader — giữ lại cho tương thích, trả cùng dữ liệu với /readers */
router.get("/reader", async (req, res, next) => {
    try {
        res.json(await badgeReader.readerStatus());
    } catch (err) {
        next(err);
    }
});

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
        if (!order) return res.status(404).json({ error: "Không tìm thấy đơn" });
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

/** POST /api/badges/:orderId/verify — ép xác minh ngay, không chờ tới hạn */
router.post("/:orderId/verify", async (req, res, next) => {
    try {
        res.json(await badgeService.verifyOrder(req.params.orderId));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

module.exports = router;
