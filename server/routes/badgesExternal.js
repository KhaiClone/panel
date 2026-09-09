const express = require("express");
const router = express.Router();
const badgeService = require("../services/badgeService");

// Mounted at /api/external/badges behind apiKeyMiddleware (x-api-key = PANEL_API_KEY).
// ArnTo-Auto giữ phần thanh toán; panel chạy phần còn lại và webhook kết quả về.

/**
 * POST /check { token }
 * Kiểm token + lấy tình trạng tài khoản trước khi dựng bảng giá. Khách có Nitro
 * thì trả luôn tiến độ hiện tại (đọc bằng token của chính họ). Không dùng reader.
 */
router.post("/check", async (req, res, next) => {
    try {
        const { token } = req.body || {};
        if (!token) return res.status(400).json({ error: "token là bắt buộc" });
        res.json(await badgeService.check({ token }));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/**
 * POST /quote { token, badgeKey, tierKey }
 * Kiểm token + báo giá. KHÔNG dùng reader — khách có Nitro thì đọc bằng token của
 * chính họ, khách không Nitro thì trả needsDeclaration=true để bot hỏi khách khai.
 * Gọi bao nhiêu lần cũng không tốn tài nguyên acc reader.
 */
router.post("/quote", async (req, res, next) => {
    try {
        const { token, badgeKey, tierKey } = req.body || {};
        if (!token || !badgeKey || !tierKey) {
            return res.status(400).json({ error: "token, badgeKey, tierKey là bắt buộc" });
        }
        res.json(await badgeService.quote({ token, badgeKey, tierKey }));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/**
 * POST /start { token, badgeKey, tierKey, declaredValue?, ref?, webhookUrl?, paymentId? }
 * CHỈ gọi sau khi tiền đã về. Panel đọc giá trị thật bằng reader, so với mốc đã
 * mua, rồi gửi /science. Trả về ngay, tiến độ đi qua webhook.
 */
router.post("/start", async (req, res, next) => {
    try {
        const { token, badgeKey, tierKey } = req.body || {};
        if (!token || !badgeKey || !tierKey) {
            return res.status(400).json({ error: "token, badgeKey, tierKey là bắt buộc" });
        }
        const declared = Number(req.body.declaredValue);
        res.status(201).json(
            await badgeService.createOrder({
                token,
                badgeKey,
                tierKey,
                declaredValue: Number.isFinite(declared) ? declared : null,
                ref: req.body.ref ?? null,
                webhookUrl: req.body.webhookUrl ?? null,
                paymentId: req.body.paymentId ?? null,
            }),
        );
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** GET /?ref=<userId> — đơn của một người mua */
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

/** GET /:orderId */
router.get("/:orderId", async (req, res, next) => {
    try {
        const order = await badgeService.getOrder(req.params.orderId);
        if (!order) return res.status(404).json({ error: "Không tìm thấy đơn" });
        res.json(order);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
