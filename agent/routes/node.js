const express = require("express");
const router = express.Router();
const nodeVersions = require("../services/nodeVersions");

/**
 * GET /node/versions
 * The system node (what unpinned projects run on) and every pinned version
 * already unpacked on this node.
 */
router.get("/versions", async (req, res, next) => {
    try {
        res.json({
            system: await nodeVersions.systemVersion(),
            installed: nodeVersions.listInstalled(),
            dir: nodeVersions.VERSIONS_DIR,
            supported: nodeVersions.SUPPORTED,
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /node/install   body: { version: "20.18.1" }
 * Download + verify + unpack that exact version unless it is already here.
 */
router.post("/install", async (req, res, next) => {
    try {
        const { version } = req.body;
        const alreadyInstalled = nodeVersions.isInstalled(String(version || ""));
        const binDir = await nodeVersions.ensureVersion(version);
        res.json({ version, binDir, downloaded: !alreadyInstalled });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
