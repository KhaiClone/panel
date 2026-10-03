const express = require("express");
const router = express.Router();
const decorService = require("../services/decorService");

// Mounted behind authMiddleware (see index.js). The data is shared data owned by
// ArnTo-assistant and kept on the panel (services/decorService.js).

/**
 * GET /api/decors — all decors (loaded + imported) with computed prices, plus
 * `tierPrices` (each way's price ignoring the sale switches) for this page.
 */
router.get("/", async (req, res, next) => {
    try {
        res.json(await decorService.listDecors({ tierPrices: true }));
    } catch (err) {
        next(err);
    }
});

/** GET /api/decors/categories — theme list (with banners) for the theme picker */
router.get("/categories", async (req, res, next) => {
    try {
        res.json(await decorService.listCategories());
    } catch (err) {
        next(err);
    }
});

/** GET /api/decors/prices — price tiers + how many decors use each tier */
router.get("/prices", async (req, res, next) => {
    try {
        res.json(await decorService.listPrices());
    } catch (err) {
        next(err);
    }
});

/** PUT /api/decors/prices — add or update one tier { type, original, price } */
router.put("/prices", async (req, res, next) => {
    try {
        res.json(await decorService.upsertPrice(req.body));
    } catch (err) {
        next(err);
    }
});

/** DELETE /api/decors/prices/:type/:original — remove one tier */
router.delete("/prices/:type/:original", async (req, res, next) => {
    try {
        res.json(await decorService.deletePrice(req.params.type, req.params.original));
    } catch (err) {
        next(err);
    }
});

/** POST /api/decors/preview — normalize form fields without saving */
router.post("/preview", async (req, res, next) => {
    try {
        res.json(await decorService.previewDecor(req.body));
    } catch (err) {
        next(err);
    }
});

/** POST /api/decors/import — normalize + store into importedDecors */
router.post("/import", async (req, res, next) => {
    try {
        res.status(201).json(await decorService.importDecor(req.body));
    } catch (err) {
        next(err);
    }
});

/**
 * PATCH /api/decors — the sale switches of many decors at once.
 * Body: { sku_ids: [...], noLoginWithNitro?, noLoginWithoutNitro?, noGift? }
 */
router.patch("/", async (req, res, next) => {
    try {
        const { sku_ids, ...flags } = req.body || {};
        res.json(await decorService.updateDecors(sku_ids, flags));
    } catch (err) {
        next(err);
    }
});

/**
 * PATCH /api/decors/:sku_id — one decor or bundle, loaded or imported.
 * Body: { noLoginWithNitro?, noLoginWithoutNitro?, noGift?, category_sku_id? (imported only) }
 * /import/:sku_id is the same, kept for older callers.
 */
router.patch(["/:sku_id", "/import/:sku_id"], async (req, res, next) => {
    try {
        res.json(await decorService.updateDecor(req.params.sku_id, req.body));
    } catch (err) {
        next(err);
    }
});

/** DELETE /api/decors/import/:sku_id — remove an imported decor */
router.delete("/import/:sku_id", async (req, res, next) => {
    try {
        res.json(await decorService.deleteDecor(req.params.sku_id));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
