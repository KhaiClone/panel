const express = require("express");
const router = express.Router();
const customers = require("../services/customerProjects");

// /api/customer-projects — owner only (mounted behind authMiddleware, like
// /api/bots: the Bots pages are owner-only for good). A project is touched
// here only after the owner turns it into a customer project.

const fail = (res, next) => (err) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
};

const pick = (body, keys) => Object.fromEntries(keys.filter((k) => body?.[k] !== undefined).map((k) => [k, body[k]]));

/** GET /status — is the panel's Discord bot up, when the daily sync runs, its last result. */
router.get("/status", (req, res) => res.json(customers.status()));

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

/** PUT /:id  { botUserId?, syncName?, tokenKey? } */
router.put("/:id", async (req, res, next) => {
    try {
        res.json(await customers.update(req.params.id, pick(req.body, ["botUserId", "syncName", "tokenKey"])));
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

/** POST /:id/refresh — look this project's bot and customer up again now. */
router.post("/:id/refresh", async (req, res, next) => {
    try {
        res.json(await customers.refresh(req.params.id));
    } catch (err) {
        fail(res, next)(err);
    }
});

module.exports = router;
