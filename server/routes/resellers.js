const express = require("express");
const resellers = require("../services/resellerService");

// Resellers / CTV (services/resellerService.js), two routers:
//
//   /api/resellers                     the CTV page (authMiddleware)
//     GET    /status                   who answers on Discord, how many
//     GET    /settings                 the welcome / farewell DM texts
//     PUT    /settings                 { welcome, farewell } ("" = the default)
//     GET    /?all=1&month=2026-10     CTVs with their orders that month and in total
//     GET    /orders?userId=&month=    CTV orders, newest first (month=all: every month)
//     POST   /sync                     the shop checks the CTV role
//     POST   /                         { userId, shop, note }
//     GET    /:userId
//     PUT    /:userId                  { shop, note, joinedAt }
//     DELETE /:userId                  no longer a CTV
//
//   /api/external/resellers            ArnTo-Shop (apiKeyMiddleware) — a project key,
//                                      and once imported only the owner's. Each change
//                                      answers with `event`, which the shop applies on
//                                      Discord itself (role, DM).
//     POST   /import                   { resellers: [{ userId, userTag, joinedAt }] } once
//     GET    /                         { imported, resellers }
//     GET    /:userId
//     POST   /                         { userId, userTag, shop, note, byId, byTag }
//     DELETE /:userId                  { byId, byTag }

const handle = (fn) => async (req, res) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
};

// ── The page ─────────────────────────────────────────────────────────────────

const panel = express.Router();
const fromPanel = { via: "panel" };

panel.get("/status", handle(() => resellers.status()));
panel.get("/settings", handle(() => resellers.getSettings()));
panel.put("/settings", handle((req) => resellers.setSettings(req.body || {})));
panel.get("/", handle((req) => resellers.list({ all: !!req.query.all, month: req.query.month })));
panel.get("/orders", handle((req) => resellers.orders({ userId: req.query.userId || null, month: req.query.month })));
panel.post("/sync", handle(() => resellers.syncRoles()));
panel.post("/", handle((req) => resellers.add(req.body || {}, fromPanel)));
panel.get("/:userId", handle((req) => resellers.get(req.params.userId)));
panel.put("/:userId", handle((req) => resellers.update(req.params.userId, req.body || {})));
panel.delete("/:userId", handle((req) => resellers.remove(req.params.userId, fromPanel)));

// ── ArnTo-Shop ───────────────────────────────────────────────────────────────

const external = express.Router();

external.use((req, res, next) => {
    const botId = req.apiCaller?.botId;
    if (!botId) return res.status(403).json({ error: "CTVs need a project API key (Panel Settings → API Keys)" });
    if (!resellers.canAccess(botId)) return res.status(403).json({ error: "The CTVs belong to another project" });
    next();
});

const fromDiscord = (req) => ({ via: "discord", byId: req.body?.byId, byTag: req.body?.byTag });

external.post("/import", handle((req) => resellers.importFrom(req.apiCaller.botId, req.body || {})));
external.get("/", handle(() => ({ imported: resellers.status().imported, resellers: resellers.listPlain() })));
external.get("/:userId", handle((req) => resellers.get(req.params.userId)));
external.post("/", handle((req) => resellers.add(req.body || {}, fromDiscord(req))));
external.delete("/:userId", handle((req) => resellers.remove(req.params.userId, fromDiscord(req))));

module.exports = { panel, external };
