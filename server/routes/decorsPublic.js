const express = require("express");
const router = express.Router();
const decorService = require("../services/decorService");

// Public, read-only: what the decor site (decor.thunderbolt.io.vn) shows. Its
// Vercel function (decor-site/api/_panel.js) finds the active panel and asks
// here on every visit, cached about a minute at Vercel's edge. These are the
// same lists the site's data/*.json snapshot holds, so nothing here is private.

/** GET /api/public/decors — all decors (loaded + imported) with computed prices */
router.get("/", async (req, res, next) => {
    try {
        res.json(await decorService.listDecors());
    } catch (err) {
        next(err);
    }
});

/** GET /api/public/decors/categories — theme list (with banners) */
router.get("/categories", async (req, res, next) => {
    try {
        res.json(await decorService.listCategories());
    } catch (err) {
        next(err);
    }
});

module.exports = router;
