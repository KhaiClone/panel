const express = require("express");
const fs = require("fs");
const path = require("path");
const panelService = require("../services/panelService");
const router = express.Router();

const ENV_PATH = path.resolve(__dirname, "../../.env");

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

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/panel/env
//  Read the server .env file and return key-value pairs (comments preserved
//  in the written file but not returned here).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/env", async (req, res, next) => {
    try {
        if (!fs.existsSync(ENV_PATH)) {
            return res.json([]);
        }
        const raw = fs.readFileSync(ENV_PATH, "utf8");
        const entries = [];
        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const idx = line.indexOf("=");
            if (idx === -1) continue;
            const key = line.slice(0, idx).trim();
            const value = line.slice(idx + 1);
            if (key) entries.push({ key, value });
        }
        res.json(entries);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUT /api/panel/env
//  Write key-value pairs back to .env, preserving comment/blank lines in their
//  original positions. New keys are appended at the end.
// ─────────────────────────────────────────────────────────────────────────────
router.put("/env", async (req, res, next) => {
    try {
        const { entries } = req.body;
        if (!Array.isArray(entries)) {
            return res.status(400).json({ error: "entries must be an array of {key, value}" });
        }
        for (const e of entries) {
            if (!e.key || typeof e.key !== "string" || e.key.includes("=") || e.key.includes("\n")) {
                return res.status(400).json({ error: `Invalid key: "${e.key}"` });
            }
        }

        const newMap = new Map(entries.map((e) => [e.key.trim(), e.value]));
        const raw = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
        const existingKeys = new Set();
        const outLines = [];

        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            // Preserve blank lines and comments as-is
            if (!trimmed || trimmed.startsWith("#")) {
                outLines.push(line);
                continue;
            }
            const idx = line.indexOf("=");
            if (idx === -1) {
                outLines.push(line);
                continue;
            }
            const key = line.slice(0, idx).trim();
            existingKeys.add(key);
            if (newMap.has(key)) {
                outLines.push(`${key}=${newMap.get(key)}`);
            }
            // If key was deleted (not in newMap) — skip it (omit from output)
        }

        // Append brand-new keys
        for (const { key, value } of entries) {
            const k = key.trim();
            if (!existingKeys.has(k)) {
                outLines.push(`${k}=${value}`);
            }
        }

        // Ensure trailing newline
        const content = outLines.join("\n").replace(/\n+$/, "") + "\n";
        fs.writeFileSync(ENV_PATH, content, "utf8");
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
