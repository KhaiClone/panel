const express = require("express");
const router = express.Router();
const ufw = require("../services/ufw");

const parsePort = (value) => {
    const port = parseInt(value);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
};

/**
 * POST /ufw/open   body: { port }
 */
router.post("/open", async (req, res, next) => {
    try {
        const port = parsePort(req.body.port);
        if (!port) return res.status(400).json({ error: "Valid port is required" });
        await ufw.openPort(port);
        res.json({ message: `Port ${port} opened` });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /ufw/close   body: { port }
 */
router.post("/close", async (req, res, next) => {
    try {
        const port = parsePort(req.body.port);
        if (!port) return res.status(400).json({ error: "Valid port is required" });
        await ufw.closePort(port);
        res.json({ message: `Port ${port} closed` });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /ufw/free-port?start=3000&end=9000
 */
router.get("/free-port", async (req, res, next) => {
    try {
        const start = parsePort(req.query.start) || 3000;
        const end = parsePort(req.query.end) || 9000;
        res.json({ port: await ufw.findFreePort(start, end) });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /ufw/status
 * Raw `ufw status numbered` output.
 */
router.get("/status", async (req, res, next) => {
    try {
        res.json({ raw: await ufw.status() });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
