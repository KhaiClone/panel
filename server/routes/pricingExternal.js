const express = require("express");
const router = express.Router();
const pricingStore = require("../services/pricingStore");

// Mounted at /api/external/pricing behind apiKeyMiddleware (x-api-key = PANEL_API_KEY).
//
// Chỉ đọc. ArnTo-Auto gọi cái này rồi cache, nên sửa giá trên panel là bot áp dụng
// ngay mà không cần restart. Không có endpoint ghi ở đây: giá chỉ đổi từ trang
// /pricing sau khi đăng nhập panel.

/** GET / — toàn bộ bảng giá */
router.get("/", async (req, res, next) => {
    try {
        res.json(await pricingStore.getPricing());
    } catch (err) {
        next(err);
    }
});

/** GET /:feature — một hệ thống (autoBadge | autoQuest) */
router.get("/:feature", async (req, res, next) => {
    try {
        const pricing = await pricingStore.getPricing();
        const feature = pricing[req.params.feature];
        if (!feature) {
            return res.status(404).json({ error: `Hệ thống không hợp lệ: ${req.params.feature}` });
        }
        res.json(feature);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /quote { badgeKey, tierKey, hasNitro }
 * Giá cuối cùng của một mốc. Giá phẳng — không phụ thuộc mốc khách đang có; chỉ
 * hệ số non-Nitro làm thay đổi con số.
 */
router.post("/quote", async (req, res, next) => {
    try {
        const { badgeKey, tierKey, hasNitro = true } = req.body || {};
        if (!badgeKey || !tierKey) {
            return res.status(400).json({ error: "badgeKey và tierKey là bắt buộc" });
        }
        res.json(await pricingStore.quote(badgeKey, tierKey, { hasNitro: Boolean(hasNitro) }));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

module.exports = router;
