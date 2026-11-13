const express = require("express");
const router = express.Router();
const customers = require("../services/customerProjects");
const channels = require("../services/customerChannels");

// /api/customer-projects — owner only (mounted behind authMiddleware, like
// /api/bots: the Bots pages are owner-only for good). A project is touched
// here only after the owner turns it into a customer project.

// err.details: what the page needs to go on (e.g. ENV_TAKEN: where the .env's
// current webhooks post, so the owner can link those channels instead).
const fail = (res, next) => (err) => {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.details || {}) });
    next(err);
};

const pick = (body, keys) => Object.fromEntries(keys.filter((k) => body?.[k] !== undefined).map((k) => [k, body[k]]));

/** GET /status — is the panel's Discord bot up, when the daily sync runs, its last result. */
router.get("/status", (req, res) => res.json(customers.status()));

/** GET /channel-settings — the Kho categories per kind and what the panel's bot can do there. */
router.get("/channel-settings", async (req, res, next) => {
    try {
        res.json(await channels.describeSettings());
    } catch (err) {
        fail(res, next)(err);
    }
});

/** PUT /channel-settings  { log?: [categoryId], backup?: [categoryId] } */
router.put("/channel-settings", async (req, res, next) => {
    try {
        res.json(await channels.setSettings(pick(req.body, ["log", "backup"])));
    } catch (err) {
        fail(res, next)(err);
    }
});

/** POST /refresh — look every customer project up again now. */
router.post("/refresh", async (req, res, next) => {
    try {
        if (!customers.status().busReady) {
            return res.status(503).json({ error: "The panel's Discord bot is not connected — names cannot be looked up now" });
        }
        res.json(await customers.syncAll());
    } catch (err) {
        fail(res, next)(err);
    }
});

/** POST /:id/enable  { botUserId?, syncName?, tokenKey? } */
router.post("/:id/enable", async (req, res, next) => {
    try {
        res.json(await customers.enable(req.params.id, pick(req.body, ["botUserId", "syncName", "tokenKey"])));
    } catch (err) {
        fail(res, next)(err);
    }
});

/** POST /:id/disable — the project is left alone again; its bot id is kept. */
router.post("/:id/disable", async (req, res, next) => {
    try {
        res.json(await customers.disable(req.params.id));
    } catch (err) {
        fail(res, next)(err);
    }
});

/** PUT /:id  { botUserId?, syncName?, tokenKey?, logKey?, backupKey? } */
router.put("/:id", async (req, res, next) => {
    try {
        res.json(await customers.update(req.params.id, pick(req.body, ["botUserId", "syncName", "tokenKey", "logKey", "backupKey"])));
    } catch (err) {
        fail(res, next)(err);
    }
});

/** POST /:id/detect  { tokenKey? } — the bot id in the project's token; nothing is saved. */
router.post("/:id/detect", async (req, res, next) => {
    try {
        res.json(await customers.detect(req.params.id, req.body?.tokenKey));
    } catch (err) {
        fail(res, next)(err);
    }
});

/**
 * POST /:id/channels  { kinds?: ["log","backup"], replace? } — make the Kho
 * channels + webhooks and write the URLs to the project's .env (restart to use).
 * 409 code ENV_TAKEN: a key already has a value; `taken` says where it posts.
 */
router.post("/:id/channels", async (req, res, next) => {
    try {
        res.json(await customers.setUpChannels(req.params.id, pick(req.body, ["kinds", "replace"])));
    } catch (err) {
        fail(res, next)(err);
    }
});

/** POST /:id/channels/link  { kinds? } — adopt the channels the .env already posts to. */
router.post("/:id/channels/link", async (req, res, next) => {
    try {
        res.json(await customers.linkChannels(req.params.id, pick(req.body, ["kinds"])));
    } catch (err) {
        fail(res, next)(err);
    }
});

/** DELETE /:id/channels/:kind — stop managing it; the channel and the .env stay. */
router.delete("/:id/channels/:kind", async (req, res, next) => {
    try {
        res.json(await customers.unlinkChannel(req.params.id, req.params.kind));
    } catch (err) {
        fail(res, next)(err);
    }
});

/** POST /:id/refresh — look this project's bot and customer up again now. */
router.post("/:id/refresh", async (req, res, next) => {
    try {
        res.json(await customers.refresh(req.params.id));
    } catch (err) {
        fail(res, next)(err);
    }
});

module.exports = router;
