const express = require("express");
const fs = require("fs");
const router = express.Router();
const git = require("../services/git");
const { resolveSafe, resolveTarget } = require("../utils/paths");

/**
 * POST /git/clone
 * body: { repoUrl, branch, root, dir }
 * Clones into {root}/{dir} — parent directories are created automatically.
 * Deliberately does NOT accept absPath: a fresh clone always belongs under a
 * configured root, and EXTRA_ROOTS exists for pre-existing folders only.
 */
router.post("/clone", async (req, res, next) => {
    try {
        const { repoUrl, branch, root, dir } = req.body;
        if (!repoUrl || !dir) return res.status(400).json({ error: "repoUrl and dir are required" });

        const targetPath = resolveSafe(root, dir);
        if (fs.existsSync(targetPath)) {
            return res.status(409).json({ error: "Target directory already exists" });
        }
        fs.mkdirSync(require("path").dirname(targetPath), { recursive: true });

        const output = await git.cloneRepo(repoUrl, targetPath, branch || "main");
        res.json({ output });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /git/pull
 * body: { root, dir } | { absPath }
 */
router.post("/pull", async (req, res, next) => {
    try {
        const { dir, absPath } = req.body;
        if (!dir && !absPath) return res.status(400).json({ error: "dir or absPath is required" });

        const botPath = resolveTarget(req.body);
        if (!fs.existsSync(botPath)) return res.status(404).json({ error: "Directory not found" });

        const output = await git.pullRepo(botPath);
        res.json({ output });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /git/install
 * body: { root, dir, installCommand } | { absPath, installCommand }
 * installCommand === null/"" skips the install (pre-built projects).
 */
router.post("/install", async (req, res, next) => {
    try {
        const { dir, absPath, installCommand } = req.body;
        if (!dir && !absPath) return res.status(400).json({ error: "dir or absPath is required" });

        const botPath = resolveTarget(req.body);
        if (!fs.existsSync(botPath)) return res.status(404).json({ error: "Directory not found" });

        const output = await git.installDeps(botPath, installCommand);
        res.json({ output });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
