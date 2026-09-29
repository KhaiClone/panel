const express = require("express");
const router = express.Router();
const logrotate = require("../services/logrotate");

/**
 * GET /logrotate
 * Install state, PM2 status and current settings of pm2-logrotate on this node.
 */
router.get("/", async (req, res, next) => {
    try {
        res.json(await logrotate.getStatus());
    } catch (err) {
        next(err);
    }
});

/**
 * POST /logrotate/install
 * Install the module and apply safe defaults. Idempotent.
 */
router.post("/install", async (req, res, next) => {
    try {
        res.json(await logrotate.install());
    } catch (err) {
        next(err);
    }
});

/**
 * POST /logrotate/ensure
 * Install with defaults only when missing; an existing install is untouched.
 * Joins the boot-time install when that is still running. → status + changed,
 * or status + skipped on a node with PM2_LOGROTATE=off.
 */
router.post("/ensure", async (req, res, next) => {
    try {
        if (logrotate.optedOut()) {
            return res.json({ ...(await logrotate.getStatus()), changed: false, skipped: "PM2_LOGROTATE=off on this node" });
        }
        res.json(await logrotate.ensureInstalled());
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /logrotate
 * body: { max_size?, retain?, compress?, rotateInterval?, workerInterval?, rotateModule? }
 * Unknown keys and invalid values are rejected by the service.
 */
router.put("/", async (req, res, next) => {
    try {
        res.json(await logrotate.setConfig(req.body || {}));
    } catch (err) {
        err.status = err.status || 400;
        next(err);
    }
});

module.exports = router;
