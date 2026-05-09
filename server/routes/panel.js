const express = require("express");
const panelService = require("../services/panelService");
const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/panel/status
//  Returns the panel's PM2 process status, CPU, memory, uptime, etc.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/status", async (req, res, next) => {
    try {
        const status = await panelService.getPanelStatus();
        res.json(status);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/panel/restart
//  Restart the panel process via PM2.
//  Response is sent BEFORE the restart happens (delayed by ~1.5s).
// ─────────────────────────────────────────────────────────────────────────────
router.post("/restart", async (req, res, next) => {
    try {
        const result = await panelService.restartPanel();
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/panel/rebuild
//  Run `npm run build` then restart. Build output is returned.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/rebuild", async (req, res, next) => {
    try {
        const result = await panelService.rebuildPanel();
        if (!result.success) {
            return res.status(500).json(result);
        }
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/panel/logs?lines=100
//  Fetch last N lines of panel PM2 logs.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/logs", async (req, res, next) => {
    try {
        const lines = Math.min(parseInt(req.query.lines) || 100, 500);
        const logs = await panelService.getPanelLogs(lines);
        res.json({ logs });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
