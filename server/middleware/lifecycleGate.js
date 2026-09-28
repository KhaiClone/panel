const lifecycle = require("../services/lifecycle");

// Mounted on /api ahead of every router. While the panel is not simply
// "active" (see services/lifecycle.js) it keeps answering reads, but refuses
// anything that would change state:
//
//   starting / maintenance  reads pass, writes → 503 (try again shortly)
//   fenced                  everything → 503 PANEL_SUPERSEDED, except what the
//                           Panel page needs to show where the panel went
//
// /health and /auth always pass: the move itself polls the new panel's health,
// and a fenced panel should still let you log in to read that message.

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

const lifecycleGate = (req, res, next) => {
    const { state, info } = lifecycle.get();
    if (state === "active") return next();

    const p = req.path;
    if (p === "/health" || p.startsWith("/auth/")) return next();
    if (p === "/panel/migration" && req.method === "GET") return next();

    if (state === "fenced") {
        return res.status(503).json({
            error: info?.to ? `The panel has moved to ${info.to}` : "This panel has been replaced by a newer one on another node",
            code: "PANEL_SUPERSEDED",
            movedTo: info?.to || null,
        });
    }
    if (READS.has(req.method)) return next();
    return res.status(503).json(
        state === "maintenance"
            ? { error: `The panel is moving to ${info?.to || "another server"} — try again in a few minutes`, code: "PANEL_MAINTENANCE" }
            : { error: "The panel is starting — try again in a moment", code: "PANEL_STARTING" },
    );
};

module.exports = lifecycleGate;
