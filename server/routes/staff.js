const express = require("express");
const staffService = require("../services/staffService");

// Staff access (services/staffService.js) — the owner's page, Panel Settings →
// Staff. Mounted with authMiddleware: staff never reach these.
//
//   GET    /                      { staff, pages, grants, settings }
//   PUT    /settings              { clientId, clientSecret, redirectUri, guildId, roleId }
//   POST   /                      { userId, perms, grants?, note }
//   PUT    /:userId               { perms?, grants?, note? }
//   DELETE /:userId               removes them and ends their session
//   GET    /sessions?userId=      newest first
//   DELETE /sessions/:id          signs that session out
//   GET    /audit?userId=&before= what they did, newest first

const router = express.Router();

const handle = (fn) => async (req, res) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        if (!err.status || err.status >= 500) console.error(`[Staff] ${req.method} ${req.originalUrl}: ${err.message}`);
        res.status(err.status || 500).json({ error: err.message });
    }
};

router.get("/", handle(() => ({ staff: staffService.list(), pages: staffService.PAGES, grants: staffService.GRANTS, settings: staffService.getSettings() })));
router.put("/settings", handle((req) => staffService.setSettings(req.body || {})));
router.get("/sessions", handle((req) => staffService.sessions({ userId: req.query.userId, limit: req.query.limit })));
router.delete("/sessions/:id", handle((req) => staffService.kick(req.params.id)));
router.get("/audit", handle((req) => staffService.auditLog({ userId: req.query.userId, limit: req.query.limit, before: req.query.before })));
router.post("/", handle((req) => staffService.add(req.body || {})));
router.put("/:userId", handle((req) => staffService.update(req.params.userId, req.body || {})));
router.delete("/:userId", handle((req) => staffService.remove(req.params.userId)));

module.exports = router;
