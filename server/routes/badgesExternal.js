const express = require("express");
const router = express.Router();
const badgeService = require("../services/badgeService");

// Mounted at /api/external/badges behind apiKeyMiddleware (PANEL_API_KEY or a project key).
// ArnTo-Auto giữ phần thanh toán; panel chạy phần còn lại và webhook kết quả về.

/**
 * POST /check { token }
 * Kiểm token + lấy tình trạng tài khoản trước khi dựng bảng giá. Trả tiến độ
 * hiện tại (đọc bằng token của chính khách), và `tieredAvailable: false` kèm
 * `tieredReason` khi tài khoản không mua được game badge (không Nitro…).
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
 * Kiểm token + báo giá. Game badge: 400 nếu tài khoản không có Nitro hoặc Discord
 * không cho đọc tiến độ — bot không được hiện QR khi quote lỗi.
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
 * POST /start { token, badgeKey, tierKey, ref?, webhookUrl?, paymentId? }
 * CHỈ gọi sau khi tiền đã về. Panel đọc giá trị thật bằng token của khách, so
 * với mốc đã mua, rồi gửi /science. Trả về ngay, tiến độ đi qua webhook.
 */
router.post("/start", async (req, res, next) => {
    try {
        const { token, badgeKey, tierKey } = req.body || {};
        if (!token || !badgeKey || !tierKey) {
            return res.status(400).json({ error: "token, badgeKey, tierKey là bắt buộc" });
        }
        res.status(201).json(
            await badgeService.createOrder({
                token,
                badgeKey,
                tierKey,
                ref: req.body.ref ?? null,
                webhookUrl: req.body.webhookUrl ?? null,
                // Key riêng của project → webhook đi theo project đó (callbackService).
                webhookBotId: req.apiCaller?.botId ?? null,
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
