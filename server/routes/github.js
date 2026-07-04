const express = require("express");
const githubService = require("../services/githubService");
const keySyncService = require("../services/keySyncService");
const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/github/keys
//  List all SSH keys on the VPS.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/keys", async (req, res, next) => {
    try {
        const keys = await githubService.listKeys();
        res.json(keys);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/github/keys
//  Generate or import a new SSH key.
//  Body: { name, mode: "generate"|"import", comment?, privateKey?, publicKey? }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/keys", async (req, res, next) => {
    try {
        const { name, mode, comment, privateKey, publicKey } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: "Key name is required" });
        }

        // Sanitize name — only allow alphanumeric, hyphens, underscores
        const safeName = name.trim();
        if (!/^[a-zA-Z0-9_-]+$/.test(safeName)) {
            return res.status(400).json({
                error: "Key name can only contain letters, numbers, hyphens, and underscores",
            });
        }

        let result;
        if (mode === "import") {
            if (!privateKey || !privateKey.trim()) {
                return res.status(400).json({ error: "Private key content is required for import" });
            }
            result = await githubService.importKey(safeName, privateKey, publicKey || null);
        } else {
            // Default: generate
            result = await githubService.generateKey(safeName, comment || "");
        }

        // Push the new key to every online worker node (best-effort)
        let sync = [];
        try { sync = await keySyncService.syncKeyToAllNodes(safeName); } catch { /* nodes optional */ }

        res.status(201).json({ ...result, sync });
    } catch (err) {
        if (err.message.includes("already exists")) {
            return res.status(409).json({ error: err.message });
        }
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /api/github/keys/:name
//  Delete an SSH key pair.
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/keys/:name", async (req, res, next) => {
    try {
        const { name } = req.params;
        githubService.deleteKey(name);

        // Remove the key from every online worker node too (best-effort)
        let sync = [];
        try { sync = await keySyncService.deleteKeyOnAllNodes(name); } catch { /* nodes optional */ }

        res.json({ message: `Key "${name}" deleted`, sync });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/github/keys/:name/test
//  Test SSH connection using a specific key.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/keys/:name/test", async (req, res, next) => {
    try {
        const result = await githubService.testConnection(req.params.name);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/github/test
//  Test default SSH connection to GitHub.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/test", async (req, res, next) => {
    try {
        const result = await githubService.testConnection();
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/github/git-config
//  Get global git user.name and user.email.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/git-config", async (req, res, next) => {
    try {
        const config = await githubService.getGitConfig();
        res.json(config);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUT /api/github/git-config
//  Set global git user.name and user.email.
//  Body: { name?, email? }
// ─────────────────────────────────────────────────────────────────────────────
router.put("/git-config", async (req, res, next) => {
    try {
        const { name, email } = req.body;
        const config = await githubService.setGitConfig(name, email);

        // Propagate git identity to every online worker node (best-effort)
        let sync = [];
        try { sync = await keySyncService.syncGitConfigToAllNodes(); } catch { /* nodes optional */ }

        res.json({ ...config, sync });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/github/sync-status
//  Compares the panel's keys + git config against every node.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/sync-status", async (req, res, next) => {
    try {
        res.json(await keySyncService.getSyncStatus());
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/github/sync/:nodeId
//  Force a full re-sync of all keys + git config to one node.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/sync/:nodeId", async (req, res, next) => {
    try {
        const db = require("../db");
        const node = await db.findOne("nodes", { _id: req.params.nodeId });
        if (!node) return res.status(404).json({ error: "Node not found" });

        const healthy = await require("../services/nodeService").checkNodeHealth(node);
        if (!healthy) return res.status(400).json({ error: `Node "${node.name}" is offline` });

        await keySyncService.syncAllToNode(node);
        res.json({ message: `Synced all keys + git config to "${node.name}"` });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
