const express = require("express");
const path = require("path");
const fs = require("fs");
const router = express.Router();

const db = require("../db");
const pm2Service = require("../services/pm2Service");
const gitService = require("../services/gitService");

// Root directory where all buyer bot folders live (e.g. /root/bots)
const BOTS_ROOT = () => process.env.BOTS_ROOT_DIR;

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the working directory of a bot.
 * - source === "local"  → use the stored localPath directly
 * - source === "git"    → construct from BOTS_ROOT/buyerID/botID (default)
 */
const botDir = (bot) => {
    if (bot.source === "local" && bot.localPath) return bot.localPath;
    return path.join(BOTS_ROOT(), bot.buyerID, bot.botID);
};

// ─────────────────────────────────────────────────────────────────────────────
//  List & Read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/bots
 * Returns all bots enriched with live PM2 status.
 */
router.get("/", async (req, res, next) => {
    try {
        const bots = await db.find("bots");
        const pm2List = await pm2Service.getProcessList();

        // Fetch live PM2 status for each bot in parallel using the cached list
        const enriched = await Promise.all(
            bots.map(async (bot) => {
                const live = await pm2Service.getBotStatus(bot.pm2Name, pm2List);
                return { ...bot, live };
            }),
        );

        res.json(enriched);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/bots/:id
 * Returns a single bot by _id with live status.
 */
router.get("/:id", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const pm2List = await pm2Service.getProcessList();
        const live = await pm2Service.getBotStatus(bot.pm2Name, pm2List);
        res.json({ ...bot, live });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Create Bot — clone from GitHub
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/bots
 * Clone a git repo, install deps, and register the bot in the DB.
 *
 * Body: {
 *   buyerID     string  — Discord user ID of the buyer
 *   botID       string  — Short unique slug for the bot (e.g. "mybot")
 *   name        string  — Display name
 *   repoUrl     string  — Git repository URL
 *   branch      string  — Git branch (default: "main")
 *   startScript string  — Entry file (default: "index.js")
 *   expiresAt   string  — ISO date string (optional)
 *   groupId     string  — Group _id to assign (optional)
 *   maxMemory   string  — PM2 memory limit e.g. "300M", "1G" (optional)
 * }
 */
router.post("/", async (req, res, next) => {
    try {
        const {
            buyerID,
            botID,
            name,
            repoUrl,
            branch = "main",
            startScript = "index.js",
            expiresAt,
            groupId = null,
            maxMemory = null,
            currentPrice = null,
        } = req.body;

        // Validate required fields
        if (!buyerID || !botID || !name || !repoUrl) {
            return res.status(400).json({
                error: "buyerID, botID, name, and repoUrl are required",
            });
        }

        // Prevent duplicate botID under same buyer
        const existing = await db.findOne("bots", { buyerID, botID });
        if (existing) {
            return res.status(409).json({
                error: `Bot "${botID}" already exists for buyer "${buyerID}"`,
            });
        }

        const dir = path.join(BOTS_ROOT(), buyerID, botID);

        // Ensure buyer directory exists
        fs.mkdirSync(path.join(BOTS_ROOT(), buyerID), { recursive: true });

        // 1. Clone repository
        console.log(`[Bots] Cloning ${repoUrl} → ${dir}`);
        await gitService.cloneRepo(repoUrl, dir, branch);

        // 2. Install npm dependencies
        console.log(`[Bots] Installing deps for ${botID}`);
        await gitService.installDeps(dir);

        // 3. Save to DB
        const pm2Name = `${buyerID}-${botID}`;
        const botRecord = await db.create("bots", {
            buyerID,
            botID,
            name,
            repoUrl,
            branch,
            startScript,
            pm2Name,
            source: "git",
            localPath: null,
            groupId,
            maxMemory,
            currentPrice,
            expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
            createdAt: Date.now(),
        });

        console.log(`[Bots] Created bot "${name}" (${pm2Name})`);
        res.status(201).json(botRecord);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Import Local Folder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/bots/import-local
 * Register a bot from an existing folder on the server (no git clone).
 * The folder may still be a git repo — git pull on update will work normally.
 *
 * Body: {
 *   buyerID     string  — Discord user ID of the buyer
 *   botID       string  — Short unique slug
 *   name        string  — Display name
 *   localPath   string  — Absolute path to the folder on the server
 *   startScript string  — Entry file (default: "index.js")
 *   installDeps boolean — Run npm install before starting (default: true)
 *   expiresAt   string  — ISO date string (optional)
 *   groupId     string  — Group _id (optional)
 *   maxMemory   string  — PM2 memory limit (optional)
 * }
 */
router.post("/import-local", async (req, res, next) => {
    try {
        const {
            buyerID,
            botID,
            name,
            localPath,
            startScript = "index.js",
            installDeps = true,
            expiresAt,
            groupId = null,
            maxMemory = null,
            currentPrice = null,
        } = req.body;

        if (!buyerID || !botID || !name || !localPath) {
            return res.status(400).json({
                error: "buyerID, botID, name, and localPath are required",
            });
        }

        // Validate the path exists on disk
        if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) {
            return res.status(400).json({
                error: `Path "${localPath}" does not exist or is not a directory`,
            });
        }

        // Prevent duplicate botID under same buyer
        const existing = await db.findOne("bots", { buyerID, botID });
        if (existing) {
            return res.status(409).json({
                error: `Bot "${botID}" already exists for buyer "${buyerID}"`,
            });
        }

        // Optionally install / refresh dependencies
        if (installDeps && fs.existsSync(path.join(localPath, "package.json"))) {
            console.log(`[Bots] Installing deps for local bot ${botID}`);
            await gitService.installDeps(localPath);
        }

        // Check if it's a git repo (for informational field)
        let repoUrl = null;
        let branch = null;
        try {
            const { stdout: remoteOut } = await require("util").promisify(require("child_process").exec)(
                `git -C "${localPath}" remote get-url origin`,
            );
            repoUrl = remoteOut.trim();
            const { stdout: branchOut } = await require("util").promisify(require("child_process").exec)(
                `git -C "${localPath}" rev-parse --abbrev-ref HEAD`,
            );
            branch = branchOut.trim();
        } catch {
            // Not a git repo — that's fine
        }

        const pm2Name = `${buyerID}-${botID}`;
        const botRecord = await db.create("bots", {
            buyerID,
            botID,
            name,
            repoUrl,
            branch,
            startScript,
            pm2Name,
            source: "local",
            localPath,
            groupId,
            maxMemory,
            currentPrice,
            expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
            createdAt: Date.now(),
        });

        console.log(`[Bots] Imported local bot "${name}" (${pm2Name}) from ${localPath}`);
        res.status(201).json(botRecord);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Update Metadata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PUT /api/bots/:id
 * Update editable metadata fields.
 *
 * Body: { name?, expiresAt?, startScript?, groupId?, maxMemory? }
 */
router.put("/:id", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { name, expiresAt, startScript, groupId, maxMemory, currentPrice } = req.body;

        const updates = {};
        if (name !== undefined) updates.name = name;
        if (startScript !== undefined) updates.startScript = startScript;
        if (groupId !== undefined) updates.groupId = groupId;
        if (maxMemory !== undefined) updates.maxMemory = maxMemory || null;
        if (currentPrice !== undefined) updates.currentPrice = currentPrice || null;
        if (expiresAt !== undefined) {
            updates.expiresAt = expiresAt
                ? new Date(expiresAt).getTime()
                : null;
        }

        const updated = await db.findOneAndUpdate(
            "bots",
            { _id: req.params.id },
            updates,
        );

        // If maxMemory changed and the bot is running, apply the new limit live
        if (maxMemory !== undefined) {
            const live = await pm2Service.getBotStatus(bot.pm2Name);
            if (live.status === "online") {
                await pm2Service.setMemoryLimit(bot.pm2Name, maxMemory || null);
            }
        }

        res.json(updated);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Delete Bot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DELETE /api/bots/:id
 * Stop the bot, remove from PM2, optionally delete source directory, remove DB record.
 * NOTE: local-sourced bots are NOT deleted from disk.
 */
router.delete("/:id", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        // Stop & unregister from PM2
        await pm2Service.deleteBot(bot.pm2Name);

        // Only delete source files for git-managed bots
        if (bot.source !== "local") {
            const dir = botDir(bot);
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }

        // Remove from DB
        await db.findOneAndDelete("bots", { _id: req.params.id });

        console.log(`[Bots] Deleted bot "${bot.name}" (${bot.pm2Name})`);
        res.json({ message: `Bot "${bot.name}" deleted successfully` });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Process Control
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/bots/:id/start */
router.post("/:id/start", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        if (bot.expiresAt && bot.expiresAt <= Date.now()) {
            return res.status(403).json({ error: "Bot is expired. Please extend to start." });
        }

        const dir = botDir(bot);
        const output = await pm2Service.startBot(
            bot.pm2Name,
            dir,
            bot.startScript,
            bot.maxMemory || null,
        );
        res.json({ message: "Bot started", output });
    } catch (err) {
        next(err);
    }
});

/** POST /api/bots/:id/stop */
router.post("/:id/stop", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const output = await pm2Service.stopBot(bot.pm2Name);
        res.json({ message: "Bot stopped", output });
    } catch (err) {
        next(err);
    }
});

/** POST /api/bots/:id/restart */
router.post("/:id/restart", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        if (bot.expiresAt && bot.expiresAt <= Date.now()) {
            return res.status(403).json({ error: "Bot is expired. Please extend to start." });
        }

        const output = await pm2Service.restartBot(bot.pm2Name);
        res.json({ message: "Bot restarted", output });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Git Update
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/bots/:id/update
 * Pull latest git changes, reinstall deps, and restart the bot.
 * For local bots that are also git repos, git pull still works.
 * For local bots with no remote, only npm install + restart is performed.
 */
router.post("/:id/update", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        if (bot.expiresAt && bot.expiresAt <= Date.now()) {
            return res.status(403).json({ error: "Bot is expired. Please extend to start." });
        }

        const dir = botDir(bot);
        let pullOutput = "(skipped — no git remote)";

        // Attempt git pull; silently skip if not a git repo
        try {
            pullOutput = await gitService.pullRepo(dir);
        } catch {
            // Not a git repo or no remote configured — skip
        }

        await gitService.installDeps(dir);
        const restartOutput = await pm2Service.restartBot(bot.pm2Name);

        console.log(`[Bots] Updated bot "${bot.name}"`);
        res.json({
            message: "Bot updated and restarted",
            pullOutput,
            restartOutput,
        });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  .env Editor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/bots/:id/env
 * Read the .env file of the bot. Returns empty string if no .env exists.
 */
router.get("/:id/env", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const envPath = path.join(botDir(bot), ".env");
        const content = fs.existsSync(envPath)
            ? fs.readFileSync(envPath, "utf8")
            : "";
        res.json({ content });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/bots/:id/env
 * Overwrite the .env file with new content.
 *
 * Body: { content: string }
 */
router.put("/:id/env", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { content } = req.body;
        if (content === undefined)
            return res.status(400).json({ error: "content is required" });

        const envPath = path.join(botDir(bot), ".env");
        fs.writeFileSync(envPath, content, "utf8");

        res.json({ message: ".env saved successfully" });
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  File Manager
// ─────────────────────────────────────────────────────────────────────────────

const resolveSafePath = (baseDir, reqPath) => {
    // Normalize requested path to remove ../ etc.
    const target = path.normalize(path.join(baseDir, reqPath || ""));
    // Ensure the target is still inside baseDir
    if (!target.startsWith(path.normalize(baseDir))) {
        throw new Error("Invalid path");
    }
    return target;
};

/**
 * GET /api/bots/:id/fs/list?path=...
 * Lists directories and files for a given path relative to the bot's root folder.
 */
router.get("/:id/fs/list", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const baseDir = botDir(bot);
        if (!fs.existsSync(baseDir)) return res.json({ files: [] });

        let targetDir;
        try {
            targetDir = resolveSafePath(baseDir, req.query.path);
        } catch (e) {
            return res.status(400).json({ error: "Invalid path" });
        }

        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
            return res.status(400).json({ error: "Directory not found" });
        }

        const items = fs.readdirSync(targetDir).map(name => {
            const fullPath = path.join(targetDir, name);
            const stat = fs.statSync(fullPath);
            return {
                name,
                isDir: stat.isDirectory(),
                size: stat.size,
                mtime: stat.mtimeMs
            };
        });

        // Sort directories first, then alphabetically
        items.sort((a, b) => {
            if (a.isDir && !b.isDir) return -1;
            if (!a.isDir && b.isDir) return 1;
            return a.name.localeCompare(b.name);
        });

        res.json({ files: items });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/bots/:id/fs/read?path=...
 * Returns the contents of a specific file. Max 1MB.
 */
router.get("/:id/fs/read", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const baseDir = botDir(bot);
        let targetFile;
        try {
            targetFile = resolveSafePath(baseDir, req.query.path);
        } catch (e) {
            return res.status(400).json({ error: "Invalid path" });
        }

        if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
            return res.status(404).json({ error: "File not found" });
        }

        const stat = fs.statSync(targetFile);
        if (stat.size > 1024 * 1024) {
            return res.status(400).json({ error: "File too large to edit (max 1MB)" });
        }

        const content = fs.readFileSync(targetFile, "utf8");
        res.json({ content });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/bots/:id/fs/write
 * Writes updated content to a specific file.
 * Body: { path: string, content: string }
 */
router.put("/:id/fs/write", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { path: reqPath, content } = req.body;
        if (content === undefined || !reqPath) {
            return res.status(400).json({ error: "path and content are required" });
        }

        const baseDir = botDir(bot);
        let targetFile;
        try {
            targetFile = resolveSafePath(baseDir, reqPath);
        } catch (e) {
            return res.status(400).json({ error: "Invalid path" });
        }

        fs.writeFileSync(targetFile, content, "utf8");
        res.json({ message: "File saved successfully" });
    } catch (err) {
        next(err);
    }
});

const multer = require("multer");

const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        try {
            const bot = await db.findOne("bots", { _id: req.params.id });
            if (!bot) return cb(new Error("Bot not found"));
            
            const baseDir = botDir(bot);
            const targetDir = resolveSafePath(baseDir, req.body.path || "");
            
            if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
                return cb(new Error("Directory not found"));
            }
            cb(null, targetDir);
        } catch (e) {
            cb(e);
        }
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage });

/**
 * POST /api/bots/:id/fs/create
 * Creates a file or directory.
 * Body: { path: string, type: 'file' | 'dir' }
 */
router.post("/:id/fs/create", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { path: reqPath, type } = req.body;
        if (!reqPath || !type) {
            return res.status(400).json({ error: "path and type are required" });
        }

        const baseDir = botDir(bot);
        let targetPath;
        try {
            targetPath = resolveSafePath(baseDir, reqPath);
        } catch (e) {
            return res.status(400).json({ error: "Invalid path" });
        }

        if (fs.existsSync(targetPath)) {
            return res.status(400).json({ error: "Path already exists" });
        }

        if (type === "dir") {
            fs.mkdirSync(targetPath, { recursive: true });
        } else {
            fs.writeFileSync(targetPath, "", "utf8");
        }

        res.json({ message: `${type === 'dir' ? 'Directory' : 'File'} created successfully` });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/bots/:id/fs/delete
 * Deletes a file or directory.
 * Body: { path: string }
 */
router.delete("/:id/fs/delete", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { path: reqPath } = req.body;
        if (!reqPath) {
            return res.status(400).json({ error: "path is required" });
        }

        const baseDir = botDir(bot);
        let targetPath;
        try {
            targetPath = resolveSafePath(baseDir, reqPath);
        } catch (e) {
            return res.status(400).json({ error: "Invalid path" });
        }

        if (!fs.existsSync(targetPath)) {
            return res.status(404).json({ error: "Path not found" });
        }

        if (targetPath === baseDir || targetPath === path.normalize(baseDir)) {
            return res.status(400).json({ error: "Cannot delete the root directory" });
        }

        fs.rmSync(targetPath, { recursive: true, force: true });
        res.json({ message: "Deleted successfully" });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/bots/:id/fs/rename
 * Renames a file or directory.
 * Body: { oldPath: string, newPath: string }
 */
router.put("/:id/fs/rename", async (req, res, next) => {
    try {
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const { oldPath, newPath } = req.body;
        if (!oldPath || !newPath) {
            return res.status(400).json({ error: "oldPath and newPath are required" });
        }

        const baseDir = botDir(bot);
        let targetOldPath, targetNewPath;
        try {
            targetOldPath = resolveSafePath(baseDir, oldPath);
            targetNewPath = resolveSafePath(baseDir, newPath);
        } catch (e) {
            return res.status(400).json({ error: "Invalid path" });
        }

        if (!fs.existsSync(targetOldPath)) {
            return res.status(404).json({ error: "Original path not found" });
        }

        if (fs.existsSync(targetNewPath)) {
            return res.status(400).json({ error: "Destination path already exists" });
        }

        if (targetOldPath === baseDir || targetOldPath === path.normalize(baseDir)) {
            return res.status(400).json({ error: "Cannot rename the root directory" });
        }

        fs.renameSync(targetOldPath, targetNewPath);
        res.json({ message: "Renamed successfully" });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/bots/:id/fs/upload
 * Uploads a file to the specified directory.
 * Form Data: path (string), file (File)
 */
router.post("/:id/fs/upload", upload.single("file"), async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded" });
        }
        res.json({ message: "File uploaded successfully", file: req.file.originalname });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
