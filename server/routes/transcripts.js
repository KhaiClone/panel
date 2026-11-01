const express = require("express");
const transcripts = require("../services/transcriptService");
const staffService = require("../services/staffService");
const { clientIp } = require("../middleware/auth");

// Transcripts (services/transcriptService.js):
//   /api/transcripts           the Transcripts page (pageAuth("transcripts")) — read-only
//   /api/transcripts/view      the transcript itself, for the page's sandboxed frame;
//                              the view ticket from /:id/open is the only key
//   /api/external/transcripts  the shop bot sends the list of its transcript channel
//
//   GET /                 ?q=&kind=&period=&page=&pageSize= — the list, newest closed first
//   GET /:id/open         → { ticket, name, expiresAt }; asks the bot over the bus
//   GET /view/:ticket     the HTML (gzip), sandboxed
//   GET  /state           (external) { newestId, count } — where the bot reads on from
//   POST /                (external) { entries: [...] } — at most 200 at a time

const handle = (fn) => async (req, res) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
};

const panel = express.Router();
panel.get("/", handle((req) => transcripts.list(req.query || {})));

// Opening is a read ("view" is enough), yet it shows a customer's chat — staff
// opens are audited like their writes (middleware/auth.js does those).
panel.get("/:id/open", (req, res, next) => {
    if (req.auth?.kind === "staff") {
        const name = transcripts.row(req.params.id)?.name || req.params.id;
        const { staff, session } = req.auth;
        const ip = clientIp(req);
        res.on("finish", () => {
            try {
                staffService.audit({ userId: staff.userId, sessionId: session.id, action: `open transcript ${name}`, status: res.statusCode, ip, page: "transcripts" });
            } catch (err) {
                console.error(`[Staff] Audit write failed: ${err.message}`);
            }
        });
    }
    next();
});
panel.get("/:id/open", handle((req) => transcripts.open(req.params.id)));

// Shown inside a frame: errors as plain text, not JSON.
const viewer = express.Router();
viewer.get("/:ticket", async (req, res) => {
    try {
        await transcripts.view(req.params.ticket, res);
    } catch (err) {
        if (res.headersSent || res.destroyed) return;
        res.status(err.status || 500).set({ "Content-Security-Policy": transcripts.SANDBOX, "Cache-Control": "no-store" }).type("text/plain").send(err.message);
    }
});

const external = express.Router();
external.use((req, res, next) => {
    if (!req.apiCaller?.botId) return res.status(403).json({ error: "Transcripts need a project API key (Panel Settings → API Keys)" });
    next();
});
external.get("/state", handle((req) => transcripts.state(req.apiCaller.botId)));
external.post("/", handle((req) => transcripts.ingest(req.apiCaller.botId, req.body || {})));

module.exports = { panel, viewer, external };
