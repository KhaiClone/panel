const express = require("express");
const multer = require("multer");
const messages = require("../services/botMessages");

// Mounted at /api/messages behind pageAuth("messages") — the Messages page
// (services/botMessages.js). ArnTo-assistant does the posting, over the bus.
// Staff only reach the shop server's channels their own Discord account can
// see and post in — every route below that names a channel checks it (checkChannel).
//
//   GET    /status                  which bot posts, is the bus up, Discord's limits
//   GET    /targets                 servers, channels (with the bot's rights) and roles — from the map
//   POST   /targets/reload          load the map from the bot now (once every 10 minutes)
//   GET    /fetch?link=             a message by its link — to edit it or copy it
//   POST   /send                    { channelId, message, mentions, silent, publish } — or
//                                   multipart: payload (that JSON, + files: [names]) + files
//   POST   /edit                    { channelId, messageId, message, mentions, keepAttachments } — or multipart
//   POST   /delete                  { channelId, messageId } — on Discord
//   GET    /sent                    what was sent from here, newest first
//   DELETE /sent/:id                drop it from the list (the message stays on Discord)
//   GET    /drafts                  saved messages
//   POST   /drafts                  { name, message, options }
//   PUT    /drafts/:id              any of those
//   DELETE /drafts/:id
//
// Mounted at /api/external/messages behind apiKeyMiddleware (`external`):
//   GET    /files/:id               a file uploaded on the page, for the bot the
//                                   command went to (it fetches it over its gateway)

const router = express.Router();

const handle = (fn) => async (req, res, next) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        next(err);
    }
};

// Files stay in memory until the bot has fetched them (services/botMessages.js).
const upload = multer({ storage: multer.memoryStorage(), limits: { files: messages.FILES_MAX, fileSize: messages.FILES_BYTES } }).array("files", messages.FILES_MAX);
const withFiles = (req, res, next) =>
    upload(req, res, (err) => {
        if (!err) return next();
        const text = err.code === "LIMIT_FILE_SIZE" ? `A file is bigger than ${messages.FILES_BYTES / 1048576} MB` : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE" ? `At most ${messages.FILES_MAX} files per message` : err.message;
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

router.get("/status", handle((req) => messages.status(req.auth)));
router.get("/targets", handle((req) => messages.targets({ auth: req.auth })));
router.post("/targets/reload", handle((req) => messages.reload(req.auth)));
router.get("/fetch", handle((req) => messages.fetchByLink(req.query.link, req.auth)));

router.post("/send", withFiles, handle((req) => messages.send(payloadOf(req), req.auth, req.files || [])));
router.post("/edit", withFiles, handle((req) => messages.edit(payloadOf(req), req.auth, req.files || [])));
router.post("/delete", handle((req) => messages.remove(req.body || {}, req.auth)));

router.get("/sent", handle(async (req) => ({ sent: await messages.listSent({ limit: req.query.limit, auth: req.auth }) })));
router.delete("/sent/:id", handle((req) => messages.forget(req.params.id, req.auth)));

router.get("/drafts", handle(() => ({ drafts: messages.listDrafts() })));
router.post("/drafts", handle((req) => messages.createDraft(req.body || {}, req.auth)));
router.put("/drafts/:id", handle((req) => messages.updateDraft(req.params.id, req.body || {}, req.auth)));
router.delete("/drafts/:id", handle((req) => messages.deleteDraft(req.params.id)));

const external = express.Router();
external.get("/files/:id", (req, res) => {
    try {
        const f = messages.fileFor(req.params.id, req.apiCaller?.botId);
        res.set({ "content-type": f.type || "application/octet-stream", "content-length": String(f.buffer.length), "cache-control": "no-store" });
        res.end(f.buffer);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

module.exports = { panel: router, external };
