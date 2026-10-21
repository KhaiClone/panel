const express = require("express");
const router = express.Router();
const badgeService = require("../services/badgeService");

// Mounted at /api/external/badges behind apiKeyMiddleware (PANEL_API_KEY or a project key).
// ArnTo-Auto giữ phần thanh toán; panel chạy phần còn lại và webhook kết quả về.
//
// Lỗi trả về `err.vi` (câu tiếng Việt) khi có: bot đưa nguyên văn tới khách và
// coi lỗi 400 có chữ "token" là token chết. `err.message` là bản tiếng Anh cho panel.

/**
 * POST /check { token }
 * Kiểm token + lấy tình trạng tài khoản trước khi dựng bảng giá. Trả tiến độ
 * hiện tại (đọc bằng token của chính khách), và `tieredAvailable: false` kèm
 * `tieredReason` khi Discord không trả lời được tiến độ (lỗi HTTP…).
 */
router.post("/check", async (req, res, next) => {
    try {
        const { token } = req.body || {};
        if (!token) return res.status(400).json({ error: "token là bắt buộc" });
        res.json(await badgeService.check({ token }));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.vi ?? err.message });
        next(err);
    }
});

/**
 * POST /quote { token, badgeKey, tierKey, buyerId? }
 * Kiểm token + báo giá. Game badge: 400 nếu Discord không trả lời được tiến độ —
 * bot không được hiện QR khi quote lỗi. Có Nitro hay không không còn quan trọng.
 * buyerId (người trả tiền) là CTV → `price` là giá CTV khi mốc có, `reseller: true`.
 */
router.post("/quote", async (req, res, next) => {
    try {
        const { token, badgeKey, tierKey, buyerId } = req.body || {};
        if (!token || !badgeKey || !tierKey) {
            return res.status(400).json({ error: "token, badgeKey, tierKey là bắt buộc" });
        }
        res.json(await badgeService.quote({ token, badgeKey, tierKey, buyerId: buyerId ?? null }));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.vi ?? err.message });
        next(err);
    }
});

/**
 * POST /start { token, badgeKey, tierKey, ref?, webhookUrl?, paymentId?, buyerId? }
 * CHỈ gọi sau khi tiền đã về. Panel đọc giá trị thật bằng token của khách, so
 * với mốc đã mua, rồi gửi /science. Trả về ngay, tiến độ đi qua webhook.
 * buyerId như /quote: đơn ghi giá CTV khi người mua là CTV.
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
                buyerId: req.body.buyerId ?? null,
            }),
        );
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.vi ?? err.message });
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
