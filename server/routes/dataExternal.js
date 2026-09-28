const express = require("express");
const db = require("../db");
const sharedStore = require("../services/sharedStore");
const discordBus = require("../services/discordBus");

// Mounted at /api/external/data behind apiKeyMiddleware. Only a PROJECT key
// works here: ownership is per project (services/sharedStore.js), and the
// shared PANEL_API_KEY does not say which project is calling.
//
//   GET  /                     manifest: this project's names + the Discord bus
//   GET  /:name?op=&query=     reads  (get | find | findOne) — pass even while
//                              the panel is moving, like every GET
//   POST /:name  { op, … }     writes (create, findOneAndUpdate, add, … and adopt)

const router = express.Router();

// A whole collection travels in one body (a bot's first adopt, /decor-load's
// createMany) — well above the panel's usual 2 MB. index.js skips its global
// parser for this path.
router.use(express.json({ limit: "32mb" }));

router.use((req, res, next) => {
    if (!req.apiCaller?.botId) {
        return res.status(403).json({ error: "Shared data needs a project API key (Panel Settings → API Keys), not the shared key" });
    }
    next();
});

const reply = (res, fn) => {
    try {
        const result = fn();
        res.json({ result: result === undefined ? null : result });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
};

router.get("/", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.apiCaller.botId });
        res.json({
            project: { botId: req.apiCaller.botId, name: bot?.name || null },
            names: sharedStore.namesOf(req.apiCaller.botId).map((n) => ({ name: n.name, kind: n.kind, state: n.state })),
            bus: { channelId: discordBus.channelId(), panelBotId: discordBus.panelBotId() },
        });
    } catch (err) {
        next(err);
    }
});

/** POST / { op: "hello", commands } — a bot says which bus commands it handles. */
router.post("/", (req, res) => {
    if (req.body?.op !== "hello") return res.status(400).json({ error: 'POST / only takes { op: "hello", commands }' });
    const caps = discordBus.recordHello(req.apiCaller.botId, Array.isArray(req.body.commands) ? req.body.commands : []);
    res.json({ result: caps, bus: { channelId: discordBus.channelId(), panelBotId: discordBus.panelBotId() } });
});

router.get("/:name", (req, res) => {
    const op = String(req.query.op || "get");
    if (!sharedStore.READ_OPS.has(op)) return res.status(400).json({ error: `GET only reads (${[...sharedStore.READ_OPS].join(", ")})` });
    let query;
    try {
        query = req.query.query ? JSON.parse(String(req.query.query)) : undefined;
    } catch {
        return res.status(400).json({ error: "query must be JSON" });
    }
    reply(res, () => sharedStore.run(req.params.name, op, { query }, req.apiCaller.botId));
});

router.post("/:name", (req, res) => {
    const { op, query, data, items, value, by } = req.body || {};
    if (typeof op !== "string") return res.status(400).json({ error: "op is required" });
    if (op === "adopt") return reply(res, () => sharedStore.adopt(req.params.name, req.apiCaller.botId, value));
    reply(res, () => sharedStore.run(req.params.name, op, { query, data, items, value, by }, req.apiCaller.botId));
});

module.exports = router;
