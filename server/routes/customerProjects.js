const express = require("express");
const router = express.Router();
const customers = require("../services/customerProjects");
const channels = require("../services/customerChannels");
const retired = require("../services/customerRetire");
const repos = require("../services/customerRepos");

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

// ── Retired customer projects (phase 3, services/customerRetire.js) ──────────

const retiredAction = (fn) => async (req, res, next) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        fail(res, next)(err);
    }
};

/** GET /retired — what deleted / expired customer projects left behind, newest first. */
router.get("/retired", retiredAction(() => retired.list()));
/** POST /retired/:rid/channels/:kind/delete — delete that Kho channel (the owner confirmed). */
router.post("/retired/:rid/channels/:kind/delete", retiredAction((req) => retired.deleteChannel(req.params.rid, req.params.kind)));
/** POST /retired/:rid/webhooks — try deleting the webhooks again. */
router.post("/retired/:rid/webhooks", retiredAction((req) => retired.retryWebhooks(req.params.rid)));
/** POST /retired/:rid/keys — try revoking the API keys again. */
router.post("/retired/:rid/keys", retiredAction((req) => retired.retryKeys(req.params.rid)));
/** POST /retired/:rid/repo — the owner dealt with the repo. */
router.post("/retired/:rid/repo", retiredAction((req) => retired.markRepoHandled(req.params.rid)));
/** DELETE /retired/:rid — forget the entry; nothing on Discord / GitHub changes. */
router.delete("/retired/:rid", retiredAction((req) => retired.dismiss(req.params.rid)));

// ── The customers' GitHub org (phase 4, services/customerRepos.js) ───────────

/** GET /github-settings — { org, hasToken, configured } (the token never comes back). */
router.get("/github-settings", retiredAction(() => repos.getSettings()));
/** PUT /github-settings  { org?, token? } — checked against GitHub before it is saved. */
router.put("/github-settings", retiredAction((req) => repos.setSettings(pick(req.body, ["org", "token"]))));
/** GET /repos — the org's repos with who uses each, and customer projects whose repo is not there. */
router.get("/repos", retiredAction(() => repos.overview()));
/** POST /repos/:name/archive  { archived: true|false } */
router.post("/repos/:name/archive", retiredAction((req) => repos.archive(req.params.name, req.body?.archived !== false)));
/** DELETE /repos/:name  { confirm: "<the repo's name>" } — refused while a project uses it. */
router.delete("/repos/:name", retiredAction((req) => repos.remove(req.params.name, req.body?.confirm)));
/** POST /retired/:rid/repo/archive — archive a retired project's repo; its line is done. */
router.post("/retired/:rid/repo/archive", retiredAction((req) => repos.archiveRetired(req.params.rid)));
/** POST /retired/:rid/repo/delete  { confirm } — delete it instead. */
router.post("/retired/:rid/repo/delete", retiredAction((req) => repos.deleteRetired(req.params.rid, req.body?.confirm)));

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

/** POST /:id/repo/update-url — the project's repo moved into the org: point its record there. */
router.post("/:id/repo/update-url", retiredAction((req) => repos.updateProjectUrl(req.params.id)));

/** GET /:id/reusable — old channels of this bot from when it was retired (a customer back). */
router.get("/:id/reusable", retiredAction((req) => customers.reusable(req.params.id)));

/** POST /:id/channels/reuse  { retiredId, replace? } — put those old channels back to use. */
router.post("/:id/channels/reuse", retiredAction((req) => customers.reuseChannels(req.params.id, pick(req.body, ["retiredId", "replace"]))));

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
