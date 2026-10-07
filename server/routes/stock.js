const express = require("express");
const stock = require("../services/stockService");

// Mounted at /api/stock behind authMiddleware — the Stock page (services/stockService.js).
//
//   GET    /status                              who delivers / reminds right now
//   GET    /products                            product types with stock counts
//   POST   /products                            create
//   PUT    /products/:id                        edit
//   DELETE /products/:id                        delete with its stock and history
//   GET    /products/:id/items                  what is in stock
//   POST   /products/:id/items                  { text, allowDuplicates } paste items
//   DELETE /products/:id/items                  empty the stock
//   DELETE /products/:id/items/:itemId          one item
//   POST   /deliver                             { productId, buyerId } → the assistant DMs one
//   GET    /deliveries?productId=               history
//   POST   /deliveries/:id/extend               { days }
//   POST   /deliveries/:id/reminders            { enabled }

const router = express.Router();

const handle = (fn) => async (req, res, next) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        next(err);
    }
};

router.get("/status", handle(() => stock.status()));

router.get("/products", handle(() => ({ products: stock.listProducts(), defaultMessage: stock.DEFAULT_MESSAGE })));
router.post("/products", handle((req) => stock.createProduct(req.body || {})));
router.put("/products/:id", handle((req) => stock.updateProduct(req.params.id, req.body || {})));
router.delete("/products/:id", handle((req) => stock.deleteProduct(req.params.id)));

router.get("/products/:id/items", handle((req) => ({ items: stock.listItems(req.params.id) })));
router.post("/products/:id/items", handle((req) => stock.addItems(req.params.id, req.body || {})));
router.delete("/products/:id/items", handle((req) => stock.clearItems(req.params.id)));
router.delete("/products/:id/items/:itemId", handle((req) => stock.deleteItem(req.params.id, req.params.itemId)));

router.post(
    "/deliver",
    handle((req) => stock.deliver({ product: req.body?.productId, buyerId: req.body?.buyerId, staffTag: "Panel", via: "panel" })),
);

router.get("/deliveries", handle((req) => ({ deliveries: stock.listDeliveries({ productId: req.query.productId || null }) })));
router.post("/deliveries/:id/extend", handle((req) => stock.extendDelivery(req.params.id, req.body?.days)));
router.post("/deliveries/:id/reminders", handle((req) => stock.setDeliveryReminders(req.params.id, !!req.body?.enabled)));

module.exports = router;
