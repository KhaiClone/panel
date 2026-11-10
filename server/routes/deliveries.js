const express = require("express");
const db = require("../db");
const deliveries = require("../services/deliveryService");

// Deliveries (services/deliveryService.js):
//   /api/deliveries           the Deliveries page (pageAuth("deliveries"))
//   /api/external/deliveries  ArnTo-assistant's /giaotay (apiKeyMiddleware) — a
//                             project key; the first project to read owns them
//
//   GET    /                  delivery types + rules (+ ownerName on the page)
//   POST   /types             { key, name, enabled, confirm, keepDays, fields, separator, codeBlock, rules, …the texts }
//   PUT    /types/:key
//   DELETE /types/:key
//   POST   /types/:key/move   { position }
//   POST   /rules             { name, text }
//   PUT    /rules/:id
//   DELETE /rules/:id
//   POST   /rules/:id/move    { position }

const handle = (fn) => async (req, res) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
};

const external = express.Router();
external.use((req, res, next) => {
    const botId = req.apiCaller?.botId;
    if (!botId) return res.status(403).json({ error: "Deliveries need a project API key (Panel Settings → API Keys)" });
    if (!deliveries.canAccess(botId)) return res.status(403).json({ error: "The delivery types belong to another project" });
    next();
});
external.get("/", handle((req) => deliveries.readFor(req.apiCaller.botId)));

const panel = express.Router();
panel.get(
    "/",
    handle(async () => {
        const data = deliveries.get();
        const bot = data.owner ? await db.findOne("bots", { _id: data.owner }).catch(() => null) : null;
        return { ...data, ownerName: bot?.name || null };
    }),
);
panel.post("/types", handle((req) => deliveries.createType(req.body || {})));
panel.put("/types/:key", handle((req) => deliveries.updateType(req.params.key, req.body || {})));
panel.delete("/types/:key", handle((req) => deliveries.deleteType(req.params.key)));
panel.post("/types/:key/move", handle((req) => deliveries.moveType(req.params.key, req.body?.position)));
panel.post("/rules", handle((req) => deliveries.createRule(req.body || {})));
panel.put("/rules/:id", handle((req) => deliveries.updateRule(req.params.id, req.body || {})));
panel.delete("/rules/:id", handle((req) => deliveries.deleteRule(req.params.id)));
panel.post("/rules/:id/move", handle((req) => deliveries.moveRule(req.params.id, req.body?.position)));

module.exports = { panel, external };
