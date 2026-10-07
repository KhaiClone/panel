const express = require("express");
const stock = require("../services/stockService");

// Mounted at /api/external/stock behind apiKeyMiddleware — ArnTo-assistant's
// /giao (services/stockService.js). A project key only, like Deco Gift.
//
//   GET  /products     enabled product types: [{ code, name, available }]
//   POST /deliver      { product, buyerId, buyerTag, staffId, staffTag } → the panel
//                      picks an item and has the assistant DM it (bus "stock.deliver")

const router = express.Router();

router.use((req, res, next) => {
    if (!req.apiCaller?.botId) return res.status(403).json({ error: "Stock needs a project API key (Panel Settings → API Keys)" });
    next();
});

const handle = (fn) => async (req, res) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
};

router.get("/products", handle(() => ({ products: stock.catalog() })));
router.post(
    "/deliver",
    handle((req) => {
        const { product, buyerId, buyerTag, staffId, staffTag } = req.body || {};
        return stock.deliver({ product, buyerId, buyerTag, staffId, staffTag, via: "discord" });
    }),
);

module.exports = router;
