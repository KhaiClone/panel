const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const router = express.Router();
const { resolveSafe } = require("../utils/paths");

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 },
});

// Every endpoint takes { root, dir, path } — dir is the bot's folder relative
// to the node's root (e.g. "buyerID/botID"), path is inside that folder.
// resolveSafe guards both segments against traversal.

/**
 * GET /fs/exists?root&dir
 * Whether the bot directory exists on this node.
 */
router.get("/exists", (req, res, next) => {
    try {
        const target = resolveSafe(req.query.root, req.query.dir);
        res.json({ exists: fs.existsSync(target) });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /fs/list?root&dir&path
 * Same item shape as the panel's fs/list.
 */
router.get("/list", (req, res, next) => {
    try {
        const { root, dir } = req.query;
        const baseDir = resolveSafe(root, dir);
        if (!fs.existsSync(baseDir)) return res.json({ files: [] });

        const targetDir = resolveSafe(root, dir, req.query.path);
        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
            return res.status(400).json({ error: "Directory not found" });
        }

        const items = fs.readdirSync(targetDir).map((name) => {
            const fullPath = path.join(targetDir, name);
            const stat = fs.statSync(fullPath);
            return {
                name,
                isDir: stat.isDirectory(),
                size: stat.size,
                mtime: stat.mtimeMs,
            };
        });

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
 * GET /fs/read?root&dir&path&binary
 * binary=true → base64. Max 10MB, same as the panel.
 */
router.get("/read", (req, res, next) => {
    try {
        const targetFile = resolveSafe(req.query.root, req.query.dir, req.query.path);

        if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
            return res.status(404).json({ error: "File not found" });
        }

        const stat = fs.statSync(targetFile);
        if (stat.size > 1024 * 1024 * 10) {
            return res.status(400).json({ error: "File too large to edit (max 10MB)" });
        }

        const content = req.query.binary === "true"
            ? fs.readFileSync(targetFile).toString("base64")
            : fs.readFileSync(targetFile, "utf8");

        res.json({ content });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /fs/write
 * body: { root, dir, path, content, binary }
 * binary=true → content is base64.
 */
router.put("/write", (req, res, next) => {
    try {
        const { root, dir, path: sub, content, binary } = req.body;
        if (sub === undefined || content === undefined) {
            return res.status(400).json({ error: "path and content are required" });
        }

        const targetFile = resolveSafe(root, dir, sub);
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });

        if (binary) {
            fs.writeFileSync(targetFile, Buffer.from(content, "base64"));
        } else {
            fs.writeFileSync(targetFile, content, "utf8");
        }

        res.json({ message: "File saved" });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /fs/create
 * body: { root, dir, path, isDir }
 */
router.post("/create", (req, res, next) => {
    try {
        const { root, dir, path: sub, isDir } = req.body;
        if (!sub) return res.status(400).json({ error: "path is required" });

        const target = resolveSafe(root, dir, sub);
        if (fs.existsSync(target)) return res.status(409).json({ error: "Already exists" });

        if (isDir) {
            fs.mkdirSync(target, { recursive: true });
        } else {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, "", "utf8");
        }

        res.json({ message: "Created" });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /fs/delete?root&dir&path
 * path="" deletes the bot directory itself — used when the panel removes a bot.
 */
router.delete("/delete", (req, res, next) => {
    try {
        const target = resolveSafe(req.query.root, req.query.dir, req.query.path);
        if (!fs.existsSync(target)) return res.json({ message: "Already gone" });

        fs.rmSync(target, { recursive: true, force: true });
        res.json({ message: "Deleted" });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /fs/rename
 * body: { root, dir, from, to }
 */
router.put("/rename", (req, res, next) => {
    try {
        const { root, dir, from, to } = req.body;
        if (!from || !to) return res.status(400).json({ error: "from and to are required" });

        const source = resolveSafe(root, dir, from);
        const dest = resolveSafe(root, dir, to);
        if (!fs.existsSync(source)) return res.status(404).json({ error: "Source not found" });

        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(source, dest);
        res.json({ message: "Renamed" });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /fs/upload  (multipart)
 * fields: root, dir, path (destination folder inside the bot dir)
 * file field name: "file"
 */
router.post("/upload", upload.single("file"), (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const { root, dir, path: sub } = req.body;
        const destDir = resolveSafe(root, dir, sub || "");
        fs.mkdirSync(destDir, { recursive: true });

        const dest = resolveSafe(root, dir, path.join(sub || "", req.file.originalname));
        fs.writeFileSync(dest, req.file.buffer);

        res.json({ message: "Uploaded", name: req.file.originalname });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /fs/download?root&dir&path
 */
router.get("/download", (req, res, next) => {
    try {
        const targetFile = resolveSafe(req.query.root, req.query.dir, req.query.path);

        if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
            return res.status(404).json({ error: "File not found" });
        }

        const fileName = path.basename(targetFile);
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.sendFile(path.resolve(targetFile), { dotfiles: "allow" }, (err) => {
            if (err && !res.headersSent) next(err);
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
