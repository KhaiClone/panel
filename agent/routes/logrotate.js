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
