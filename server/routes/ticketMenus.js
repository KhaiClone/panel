const express = require("express");
const db = require("../db");
const menus = require("../services/ticketMenuService");

// Ticket menus (services/ticketMenuService.js), the same routes twice:
//   /api/ticket-menus           the Ticket Menus page (authMiddleware)
//   /api/external/ticket-menus  ArnTo-Shop's tickets and /menu (apiKeyMiddleware) —
//                               a project key, and once the menus are imported
//                               only the owner's
//
//   GET    /                     services, products, "Khác", sellers (+ ownerName on the page)
//   POST   /import               the shop's old menus, once (external only)
//   POST   /services             { key, label, emoji, description, ping, category, enabled }
//   PUT    /services/:key
//   DELETE /services/:key        its products stay, out of that menu
//   POST   /services/:key/move   { position }
//   POST   /products             { name, description, emoji, sellerId, suffix, services, enabled }
//   PUT    /products/:id
//   DELETE /products/:id
//   POST   /products/:id/move    { position }
//   PUT    /settings             { other, sellers }

const handle = (fn) => async (req, res) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
};

const build = ({ external }) => {
    const router = express.Router();
    // A change from the page tells the shop to re-read; one the shop made, not.
    const opts = { notify: !external };

    if (external) {
        router.use((req, res, next) => {
            const botId = req.apiCaller?.botId;
            if (!botId) return res.status(403).json({ error: "Ticket menus need a project API key (Panel Settings → API Keys)" });
            if (!menus.canAccess(botId)) return res.status(403).json({ error: "The ticket menus belong to another project" });
            next();
        });
        router.post("/import", handle((req) => menus.importFrom(req.apiCaller.botId, req.body || {})));
        router.get("/", handle(() => menus.get()));
    } else {
        router.get(
            "/",
            handle(async () => {
                const data = menus.get();
                const bot = data.owner ? await db.findOne("bots", { _id: data.owner }).catch(() => null) : null;
                return { ...data, ownerName: bot?.name || null };
            }),
        );
    }

    router.post("/services", handle((req) => menus.createService(req.body || {}, opts)));
    router.put("/services/:key", handle((req) => menus.updateService(req.params.key, req.body || {}, opts)));
    router.delete("/services/:key", handle((req) => menus.deleteService(req.params.key, opts)));
    router.post("/services/:key/move", handle((req) => menus.moveService(req.params.key, req.body?.position, opts)));

    router.post("/products", handle((req) => menus.createProduct(req.body || {}, opts)));
    router.put("/products/:id", handle((req) => menus.updateProduct(req.params.id, req.body || {}, opts)));
    router.delete("/products/:id", handle((req) => menus.deleteProduct(req.params.id, opts)));
    router.post("/products/:id/move", handle((req) => menus.moveProduct(req.params.id, req.body?.position, opts)));

    router.put("/settings", handle((req) => menus.updateSettings(req.body || {}, opts)));
    return router;
};

module.exports = { panel: build({ external: false }), external: build({ external: true }) };
