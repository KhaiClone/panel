const express = require("express");
const ui = require("../services/uiTemplateService");

// Mounted at /api/external/ui behind apiKeyMiddleware — a bot's message
// templates (bot-lib/MessageTemplates.js). A project key only.
//
//   POST /catalog   { types, templates, hash }   every template the bot has
//   GET  /?version=&hash=                        its overrides + custom variables (or "unchanged")
//   POST /posted    { posted: [{ key, channelId, messageId }] }   panels it posted

const router = express.Router();

router.use((req, res, next) => {
    if (!req.apiCaller?.botId) return res.status(403).json({ error: "Message templates need a project API key (Panel Settings → API Keys)" });
    next();
});

const handle = (fn) => (req, res) => {
    try {
        res.json(fn(req));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
};

router.post("/catalog", handle((req) => ui.saveCatalog(req.apiCaller.botId, req.body || {})));
router.get("/", handle((req) => ui.forBot(req.apiCaller.botId, req.query)));
router.post("/posted", handle((req) => ui.savePosted(req.apiCaller.botId, req.body?.posted)));

module.exports = router;
