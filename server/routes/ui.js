const express = require("express");
const ui = require("../services/uiTemplateService");

// The Embeds page (services/uiTemplateService.js).
//
//   GET    /                     catalogs of every bot, overrides, custom variables, posted panels
//   POST   /check                { key, value } → { errors, warnings } without saving
//   PUT    /templates/:key       { value } → save the admin's version
//   DELETE /templates/:key       back to the bot's default
//   PUT    /custom               { vars } → the {custom.*} variables
//   POST   /posted/refresh       { botId?, keys? } → bots re-render their posted panels
//   POST   /posted/adopt         { key, link } → track a panel posted earlier

const router = express.Router();

const handle = (fn) => async (req, res) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message, ...(err.errors ? { errors: err.errors } : {}) });
    }
};

router.get("/", handle(() => ui.overview()));
router.post("/check", handle((req) => ui.check(String(req.body?.key || ""), req.body?.value)));
router.put("/templates/:key", handle((req) => ui.setOverride(req.params.key, req.body?.value)));
router.delete("/templates/:key", handle((req) => ui.resetOverride(req.params.key)));
router.put("/custom", handle((req) => ui.setCustom(req.body?.vars)));
router.post("/posted/refresh", handle((req) => ui.refreshPosted(req.body || {})));
router.post("/posted/adopt", handle((req) => ui.adopt(req.body || {})));

module.exports = router;
