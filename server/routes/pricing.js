const express = require("express");
const router = express.Router();
const pricingStore = require("../services/pricingStore");

// Mounted at /api/pricing behind authMiddleware (see index.js).
//
// Bảng giá của các hệ thống auto. Trang /pricing của panel là chỗ duy nhất bạn
// chỉnh giá; ArnTo-Auto đọc lại qua /api/external/pricing.

/** GET /api/pricing — toàn bộ bảng giá (catalog + giá đã merge) */
router.get("/", async (req, res, next) => {
    try {
        res.json(await pricingStore.getPricing());
    } catch (err) {
        next(err);
    }
});

/** PATCH /api/pricing/:feature { ...cài đặt } — autoBadge | autoQuest */
router.patch("/:feature", async (req, res, next) => {
    try {
        res.json(await pricingStore.updateFeature(req.params.feature, req.body || {}));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** PATCH /api/pricing/badge/:badgeKey/:tierKey { price?, enabled? } */
router.patch("/badge/:badgeKey/:tierKey", async (req, res, next) => {
    try {
        res.json(
            await pricingStore.setTier(req.params.badgeKey, req.params.tierKey, req.body || {}),
        );
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/**
 * POST /api/pricing/badge/:badgeKey/bulk { tiers: { [tierKey]: { price?, enabled? } } }
 * Đặt giá nhiều mốc một lượt — trang /pricing lưu cả bảng bằng đúng endpoint này
 * thay vì bắn 10 request rời.
 */
router.post("/badge/:badgeKey/bulk", async (req, res, next) => {
    try {
        const tiers = req.body?.tiers;
        if (!tiers || typeof tiers !== "object") {
            return res.status(400).json({ error: "tiers required" });
        }
        let latest = null;
        for (const [tierKey, patch] of Object.entries(tiers)) {
            latest = await pricingStore.setTier(req.params.badgeKey, tierKey, patch || {});
        }
        res.json(latest ?? (await pricingStore.getPricing()));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

module.exports = router;
