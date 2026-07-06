const express = require("express");
const router = express.Router();
const assistantService = require("../services/assistantService");

// Mounted behind authMiddleware + adminOnly (see index.js). Thin proxy to the
// ArnTo-assistant decor API.

/** GET /api/decors — all decors (loaded + imported) with computed prices */
router.get("/", async (req, res, next) => {
    try {
        res.json(await assistantService.listDecors());
    } catch (err) {
        next(err);
    }
});

/** POST /api/decors/preview — normalize form fields without saving */
router.post("/preview", async (req, res, next) => {
    try {
        res.json(await assistantService.previewDecor(req.body));
    } catch (err) {
        next(err);
    }
});

/** POST /api/decors/import — normalize + store into importedDecors */
router.post("/import", async (req, res, next) => {
    try {
        res.status(201).json(await assistantService.importDecor(req.body));
    } catch (err) {
        next(err);
    }
});

/** DELETE /api/decors/import/:sku_id — remove an imported decor */
router.delete("/import/:sku_id", async (req, res, next) => {
    try {
        res.json(await assistantService.deleteDecor(req.params.sku_id));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
