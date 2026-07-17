const express = require("express");
const path = require("path");
const router = express.Router();
const nginx = require("../services/nginx");
const { resolveSafe } = require("../utils/paths");

// pm2Name becomes part of the config filename — never allow path characters.
const validName = (name) => typeof name === "string" && /^[\w.-]+$/.test(name);
// domain/email are interpolated into the certbot command line.
const validDomain = (d) => typeof d === "string" && /^[a-zA-Z0-9.-]+$/.test(d);
const validEmail = (e) => typeof e === "string" && /^[\w.+-]+@[a-zA-Z0-9.-]+$/.test(e);

/**
 * POST /nginx/config
 * body: { pm2Name, mode, port, apiPort, root, dir, distFolder, domain, extraConfig }
 * dir/distFolder are relative to the node's roots — the agent resolves them
 * itself so panel-side absolute paths never leak onto this VPS.
 */
router.post("/config", async (req, res, next) => {
    try {
        const { pm2Name, mode, port, apiPort, root, dir, distFolder, domain, extraConfig } = req.body;
        if (!validName(pm2Name)) return res.status(400).json({ error: "Valid pm2Name is required" });
        if (!dir) return res.status(400).json({ error: "dir is required" });
        if (domain && !validDomain(domain)) return res.status(400).json({ error: "Invalid domain" });

        const distAbs = path.isAbsolute(distFolder || "")
            ? (() => { throw new Error("distFolder must be relative to the project dir"); })()
            : resolveSafe(root, dir, distFolder || "");

        await nginx.writeConfig(pm2Name, {
            mode,
            port: port ? parseInt(port) : undefined,
            apiPort: apiPort ? parseInt(apiPort) : undefined,
            distFolder: distAbs,
            domain: domain || null,
            extraConfig: extraConfig || "",
        });
        res.json({ message: `nginx config written for ${pm2Name}` });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /nginx/config/:pm2Name
 */
router.delete("/config/:pm2Name", async (req, res, next) => {
    try {
        if (!validName(req.params.pm2Name)) return res.status(400).json({ error: "Valid pm2Name is required" });
        await nginx.removeConfig(req.params.pm2Name);
        res.json({ message: `nginx config removed for ${req.params.pm2Name}` });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /nginx/config/:pm2Name/exists
 */
router.get("/config/:pm2Name/exists", (req, res) => {
    if (!validName(req.params.pm2Name)) return res.status(400).json({ error: "Valid pm2Name is required" });
    res.json({ exists: nginx.configExists(req.params.pm2Name) });
});

/**
 * GET /nginx/list
 * pm2Names of every panel-managed nginx config on this node.
 */
router.get("/list", (req, res) => {
    res.json({ configs: nginx.listConfigs() });
});

/**
 * POST /nginx/ssl
 * body: { domain, email }
 */
router.post("/ssl", async (req, res, next) => {
    try {
        const { domain, email } = req.body;
        if (!validDomain(domain)) return res.status(400).json({ error: "Valid domain is required" });
        if (email && !validEmail(email)) return res.status(400).json({ error: "Invalid email" });
        await nginx.enableSSL(domain, email || null);
        res.json({ message: `SSL enabled for ${domain}` });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
