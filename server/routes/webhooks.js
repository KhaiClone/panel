const express = require("express");
const multer = require("multer");
const hooks = require("../services/webhookMessages");

// Mounted at /api/webhooks behind pageAuth("webhooks") — the Webhooks page
// (services/webhookMessages.js). The shop server's webhooks, listed by
// ArnTo-assistant; messages go straight to Discord's webhook API. Staff only
// reach the channels their own Discord account can see and post in.
//
//   GET    /status                  which bots list / make webhooks, Discord's limits
//   GET    /targets                 the server, its channels and their webhooks — from the list
//   POST   /targets/reload          load the list from the bot now (once every 10 minutes)
//   POST   /webhooks                { channelId, name, avatarUrl } — ArnTo-selfbot makes one (asked by ArnTo-assistant)
//   GET    /fetch?link=             a message by its link, and the webhook that sent it
//   GET    /message?webhookId=&messageId=&threadId=   a message read through its webhook
//   POST   /send                    multipart: payload (JSON) + files — one message
//   POST   /edit                    multipart: payload (JSON) + files
//   POST   /delete                  { webhookId, messageId, threadId } — on Discord
//   GET    /sent                    what was sent from here, newest first
//   DELETE /sent/:id                drop it from the list (the message stays on Discord)
//   GET    /drafts                  saved messages
//   POST   /drafts                  { name, messages, target, options }
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

// Files stay in memory: they go on to Discord in the same request.
const upload = multer({ storage: multer.memoryStorage(), limits: { files: hooks.FILES_MAX, fileSize: hooks.FILES_BYTES } }).array("files", hooks.FILES_MAX);
const withFiles = (req, res, next) =>
    upload(req, res, (err) => {
        if (!err) return next();
        const text = err.code === "LIMIT_FILE_SIZE" ? `A file is bigger than ${hooks.FILES_BYTES / 1048576} MB` : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE" ? `At most ${hooks.FILES_MAX} files per message` : err.message;
        next(Object.assign(new Error(text), { status: 400 }));
    });

/** The JSON part of a multipart request (or a plain JSON body). */
const payloadOf = (req) => {
    if (!req.is("multipart/form-data")) return req.body || {};
    try {
        return JSON.parse(req.body?.payload || "{}");
    } catch {
        throw Object.assign(new Error("The message could not be read"), { status: 400 });
    }
};

router.get("/status", handle((req) => hooks.status(req.auth)));
router.get("/targets", handle((req) => hooks.targets({ auth: req.auth })));
router.post("/targets/reload", handle((req) => hooks.reload(req.auth)));
router.post("/webhooks", handle((req) => hooks.create(req.body || {}, req.auth)));

router.get("/fetch", handle((req) => hooks.fetchByLink(req.query.link, req.auth)));
router.get("/message", handle((req) => hooks.readThroughWebhook(req.query, req.auth)));

router.post("/send", withFiles, handle((req) => hooks.send(payloadOf(req), req.files || [], req.auth)));
router.post("/edit", withFiles, handle((req) => hooks.edit(payloadOf(req), req.files || [], req.auth)));
router.post("/delete", handle((req) => hooks.remove(req.body || {}, req.auth)));

router.get("/sent", handle((req) => ({ sent: hooks.listSent({ limit: req.query.limit, auth: req.auth }) })));
router.delete("/sent/:id", handle((req) => hooks.forget(req.params.id, req.auth)));

router.get("/drafts", handle(() => ({ drafts: hooks.listDrafts() })));
router.post("/drafts", handle((req) => hooks.createDraft(req.body || {}, req.auth)));
router.put("/drafts/:id", handle((req) => hooks.updateDraft(req.params.id, req.body || {}, req.auth)));
router.delete("/drafts/:id", handle((req) => hooks.deleteDraft(req.params.id)));

module.exports = router;
