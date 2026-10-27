const express = require("express");
const db = require("../db");
const forms = require("../services/formService");

// Forms (services/formService.js):
//   /api/forms           the Forms page (pageAuth("forms"))
//   /api/external/forms  ArnTo-assistant's /form (apiKeyMiddleware) — a project
//                        key, and once the forms are imported only the owner's
//
//   GET    /                  forms + settings (+ ownerName on the page)
//   POST   /import            the bot's old built-in forms, once (external only)
//   POST   /items             { key, name, enabled, message, note, buttonLabel, buttonEmoji, modalTitle, fields, selfbotText }
//   PUT    /items/:key
//   DELETE /items/:key
//   POST   /items/:key/move   { position }
//   PUT    /settings          { defaultKey, viewerRoles, retentionDays, savedText, viewLabel, viewEmoji, doneText } — owner only:
//                             the viewer roles decide who reads what customers typed (passwords, tokens)

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
    if (!botId) return res.status(403).json({ error: "Forms need a project API key (Panel Settings → API Keys)" });
    if (!forms.canAccess(botId)) return res.status(403).json({ error: "The forms belong to another project" });
    next();
});
external.get("/", handle(() => forms.get()));
external.post("/import", handle((req) => forms.importFrom(req.apiCaller.botId, req.body || {})));

const panel = express.Router();
panel.get(
    "/",
    handle(async () => {
        const data = forms.get();
        const bot = data.owner ? await db.findOne("bots", { _id: data.owner }).catch(() => null) : null;
        return { ...data, ownerName: bot?.name || null };
    }),
);
panel.post("/items", handle((req) => forms.createForm(req.body || {})));
panel.put("/items/:key", handle((req) => forms.updateForm(req.params.key, req.body || {})));
panel.delete("/items/:key", handle((req) => forms.deleteForm(req.params.key)));
panel.post("/items/:key/move", handle((req) => forms.moveForm(req.params.key, req.body?.position)));
panel.put("/settings", (req, res, next) => {
    if (req.auth?.kind !== "owner") return res.status(403).json({ error: "Only the owner can change the form settings" });
    next();
});
panel.put("/settings", handle((req) => forms.updateSettings(req.body || {})));

module.exports = { panel, external };
