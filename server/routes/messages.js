const express = require("express");
const messages = require("../services/botMessages");

// Mounted at /api/messages behind pageAuth("messages") — the Messages page
// (services/botMessages.js). ArnTo-assistant does the posting, over the bus.
//
//   GET    /status                  which bot posts, is the bus up, Discord's limits
//   GET    /targets?refresh=1       servers, channels (with the bot's rights) and roles
//   GET    /fetch?link=             a message by its link — to edit it or copy it
//   POST   /send                    { channelId, message, mentions, silent, publish }
//   POST   /edit                    { channelId, messageId, message, mentions }
//   POST   /delete                  { channelId, messageId } — on Discord
//   GET    /sent                    what was sent from here, newest first
//   DELETE /sent/:id                drop it from the list (the message stays on Discord)
//   GET    /drafts                  saved messages
//   POST   /drafts                  { name, message, options }
//   PUT    /drafts/:id              any of those
//   DELETE /drafts/:id

const router = express.Router();

const handle = (fn) => async (req, res, next) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        next(err);
    }
};

router.get("/status", handle(() => messages.status()));
router.get("/targets", handle((req) => messages.targets({ refresh: req.query.refresh === "1" })));
router.get("/fetch", handle((req) => messages.fetchByLink(req.query.link)));

router.post("/send", handle((req) => messages.send(req.body || {}, req.auth)));
router.post("/edit", handle((req) => messages.edit(req.body || {}, req.auth)));
router.post("/delete", handle((req) => messages.remove(req.body || {}, req.auth)));

router.get("/sent", handle((req) => ({ sent: messages.listSent({ limit: req.query.limit }) })));
router.delete("/sent/:id", handle((req) => messages.forget(req.params.id)));

router.get("/drafts", handle(() => ({ drafts: messages.listDrafts() })));
router.post("/drafts", handle((req) => messages.createDraft(req.body || {}, req.auth)));
router.put("/drafts/:id", handle((req) => messages.updateDraft(req.params.id, req.body || {}, req.auth)));
router.delete("/drafts/:id", handle((req) => messages.deleteDraft(req.params.id)));

module.exports = router;
