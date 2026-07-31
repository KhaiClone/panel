const express = require("express");
const router = express.Router();
const questService = require("../services/questService");
const questMonthly = require("../services/questMonthly");

// Mounted at /api/external/quests behind apiKeyMiddleware (x-api-key = PANEL_API_KEY).
// This is how ArnTo-Auto delegates quest execution to the panel: it keeps payment,
// the panel runs the quests and webhooks events back.

/** POST /preview { token } — resolve + list available quests */
router.post("/preview", async (req, res, next) => {
    try {
        const { token } = req.body || {};
        if (!token) return res.status(400).json({ error: "token required" });
        res.json(await questService.previewToken(token));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/**
 * POST /start { token, mode, selectedQuestIds, webhookUrl, ref }
 * Start (or update) running quests for an account. `webhookUrl` receives quest
 * events (quest_start/quest_done/status/removed) with the opaque `ref` echoed back.
 */
router.post("/start", async (req, res, next) => {
    try {
        const { token, mode, selectedQuestIds, webhookUrl, ref } = req.body || {};
        if (!token) return res.status(400).json({ error: "token required" });
        res.status(201).json(
            await questService.startAccount({ token, mode, selectedQuestIds, webhookUrl, ref }),
        );
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** GET / — accounts (per-quest + monthly), optional ?ref=<userId> filter. Used by
 *  arnto-auto's /status. */
router.get("/", async (req, res, next) => {
    try {
        const ref = req.query.ref ? String(req.query.ref) : null;
        let single = await questService.listAccounts();
        let monthly = await questMonthly.list();
        if (ref) {
            single = single.filter((a) => String(a.ref) === ref);
            monthly = monthly.filter((a) => String(a.ref) === ref);
        }
        res.json({ single, monthly });
    } catch (err) {
        next(err);
    }
});

/** POST /monthly { token, months, ref, webhookUrl } — activate/extend a monthly plan */
router.post("/monthly", async (req, res, next) => {
    try {
        const { token, months, ref, webhookUrl } = req.body || {};
        if (!token) return res.status(400).json({ error: "token required" });
        res.status(201).json(await questMonthly.activate({ token, months, ref, webhookUrl }));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** GET /:accountId — status + live quests */
router.get("/:accountId", async (req, res, next) => {
    try {
        const acc = await questService.getAccount(req.params.accountId);
        if (!acc) return res.status(404).json({ error: "not found" });
        res.json(acc);
    } catch (err) {
        next(err);
    }
});

/** POST /:accountId/stop */
router.post("/:accountId/stop", async (req, res, next) => {
    try {
        await questService.stopAccount(req.params.accountId);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

/** DELETE /:accountId */
router.delete("/:accountId", async (req, res, next) => {
    try {
        await questService.removeAccount(req.params.accountId);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
