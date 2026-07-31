const express = require("express");
const router = express.Router();
const questService = require("../services/questService");

// Mounted behind authMiddleware + adminOnly (see index.js). Admin-only Discord
// Quest runner — standalone (does NOT talk to the ArnTo-Auto bot).

/** GET /api/quests — list stored accounts + live status */
router.get("/", async (req, res, next) => {
    try {
        res.json(await questService.listAccounts());
    } catch (err) {
        next(err);
    }
});

/** POST /api/quests/preview { token } — resolve token + list its available quests */
router.post("/preview", async (req, res, next) => {
    try {
        const { token } = req.body || {};
        if (!token) return res.status(400).json({ error: "Thiếu token." });
        res.json(await questService.previewToken(token));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** POST /api/quests/start { token, mode, selectedQuestIds } — store + run */
router.post("/start", async (req, res, next) => {
    try {
        const { token, mode, selectedQuestIds } = req.body || {};
        if (!token) return res.status(400).json({ error: "Thiếu token." });
        res.status(201).json(
            await questService.startAccount({ token, mode, selectedQuestIds }),
        );
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** POST /api/quests/:accountId/stop — stop the run loop (keeps the record) */
router.post("/:accountId/stop", async (req, res, next) => {
    try {
        await questService.stopAccount(req.params.accountId);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

/** DELETE /api/quests/:accountId — stop + delete the account record */
router.delete("/:accountId", async (req, res, next) => {
    try {
        await questService.removeAccount(req.params.accountId);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/quests/stream — Server-Sent Events for realtime progress.
 * Auth via ?token= (EventSource can't set headers); handled by authMiddleware +
 * adminOnly on the mount. Streams every questService.bus event.
 */
router.get("/stream", async (req, res, next) => {
    try {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        // Initial snapshot so the UI can render current state immediately.
        res.write(
            `data: ${JSON.stringify({ type: "snapshot", accounts: await questService.listAccounts() })}\n\n`,
        );

        const onEvent = (evt) => {
            try {
                res.write(`data: ${JSON.stringify(evt)}\n\n`);
            } catch {}
        };
        questService.bus.on("event", onEvent);
        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);

        req.on("close", () => {
            clearInterval(keepAlive);
            questService.bus.off("event", onEvent);
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
