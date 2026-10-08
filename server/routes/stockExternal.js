const express = require("express");
const stock = require("../services/stockService");
const discordBus = require("../services/discordBus");

// Mounted at /api/external/stock behind apiKeyMiddleware — ArnTo-assistant's
// /giao and /kho (services/stockService.js). A project key only, like Deco Gift.
//
//   GET  /products     enabled product types: [{ code, name, available, days }]
//   POST /deliver      { product, buyerId, buyerTag, staffId, staffTag, days? } → the panel
//                      picks an item and has the assistant DM it (bus "stock.deliver");
//                      days: this delivery's own length (/giao songay)
//
// /manage is /kho: everything the Stock page does except creating a product
// type. It reads the stock in clear, so only the project that delivers it (the
// one that announced "stock.deliver") may use it; that project also gets the
// delivered item back from /deliver. :ref is a product's id or code.
//
//   GET    /manage/products                      every product type, with counts
//   GET    /manage/products/:ref
//   PUT    /manage/products/:ref                 edit (name, code, enabled, the DM's look, reminders)
//   DELETE /manage/products/:ref                 with its stock and history
//   GET    /manage/products/:ref/items           what is in stock
//   POST   /manage/products/:ref/items           { text, allowDuplicates }
//   DELETE /manage/products/:ref/items           empty the stock
//   DELETE /manage/products/:ref/items/:itemId   one item
//   GET    /manage/deliveries?product=&buyerId=&limit=   history, each with the item it sent
//   GET    /manage/deliveries/:id
//   POST   /manage/deliveries/:id/extend         { days }
//   POST   /manage/deliveries/:id/reminders      { enabled }

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

const isDeliverer = (req) => discordBus.canHandle(req.apiCaller.botId, stock.CMD);

router.get("/products", handle(() => ({ products: stock.catalog() })));
router.post(
    "/deliver",
    handle(async (req) => {
        const { product, buyerId, buyerTag, staffId, staffTag, days } = req.body || {};
        const res = await stock.deliver({ product, buyerId, buyerTag, staffId, staffTag, days, via: "discord" });
        if (!isDeliverer(req)) delete res.item;
        return res;
    }),
);

const manage = express.Router();
manage.use((req, res, next) => {
    if (!isDeliverer(req)) return res.status(403).json({ error: `Only the project that delivers stock (announced "${stock.CMD}") can manage it` });
    next();
});

manage.get("/products", handle(() => ({ products: stock.listProducts() })));
manage.get("/products/:ref", handle((req) => stock.getProduct(req.params.ref)));
manage.put("/products/:ref", handle((req) => stock.updateProduct(req.params.ref, req.body || {})));
manage.delete("/products/:ref", handle((req) => stock.deleteProduct(req.params.ref)));

manage.get("/products/:ref/items", handle((req) => ({ items: stock.listItems(req.params.ref) })));
manage.post("/products/:ref/items", handle((req) => stock.addItems(req.params.ref, req.body || {})));
manage.delete("/products/:ref/items", handle((req) => stock.clearItems(req.params.ref)));
manage.delete("/products/:ref/items/:itemId", handle((req) => stock.deleteItem(req.params.ref, req.params.itemId)));

manage.get(
    "/deliveries",
    handle((req) => ({
        deliveries: stock.listDeliveries({ productId: req.query.product || null, buyerId: req.query.buyerId || null, limit: req.query.limit }),
    })),
);
manage.get("/deliveries/:id", handle((req) => stock.getDelivery(req.params.id)));
manage.post("/deliveries/:id/extend", handle((req) => stock.extendDelivery(req.params.id, req.body?.days)));
manage.post("/deliveries/:id/reminders", handle((req) => stock.setDeliveryReminders(req.params.id, !!req.body?.enabled)));

router.use("/manage", manage);

module.exports = router;
