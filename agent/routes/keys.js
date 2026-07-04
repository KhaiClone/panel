const express = require("express");
const router = express.Router();
const ssh = require("../services/ssh");
const { decrypt } = require("../utils/crypto");

// The panel keeps SSH keys + git config in sync across nodes. Private key
// material arrives AES-256-GCM encrypted (see utils/crypto) and is decrypted
// here with this agent's own AGENT_API_KEY.

const dec = (payload) => decrypt(payload, process.env.AGENT_API_KEY);

/** GET /keys/list — key names + fingerprints (never private material) */
router.get("/list", async (req, res, next) => {
    try {
        const keys = await ssh.listKeys();
        // Strip publicKey body to keep the response small; fingerprint is enough to compare
        res.json({ keys: keys.map(({ name, fingerprint, hasPrivate }) => ({ name, fingerprint, hasPrivate })) });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /keys/import
 * body: { name, encPrivate, encPublic?, overwrite? }
 * encPrivate/encPublic are { iv, tag, data } from agentCrypto.encrypt.
 */
router.post("/import", async (req, res, next) => {
    try {
        const { name, encPrivate, encPublic, overwrite = true } = req.body;
        if (!name || !encPrivate) return res.status(400).json({ error: "name and encPrivate are required" });
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: "Invalid key name" });

        let privateKey, publicKey = null;
        try {
            privateKey = dec(encPrivate);
            if (encPublic) publicKey = dec(encPublic);
        } catch {
            return res.status(400).json({ error: "Could not decrypt key payload (API key mismatch?)" });
        }

        const result = await ssh.importKey(name, privateKey, publicKey, { overwrite });
        res.json({ name: result.name, fingerprint: result.fingerprint });
    } catch (err) {
        next(err);
    }
});

/** POST /keys/delete — body: { name } */
router.post("/delete", (req, res, next) => {
    try {
        if (!req.body.name) return res.status(400).json({ error: "name is required" });
        ssh.deleteKey(req.body.name);
        res.json({ message: `Key "${req.body.name}" deleted` });
    } catch (err) {
        next(err);
    }
});

/** POST /keys/test — body: { name? } */
router.post("/test", async (req, res, next) => {
    try {
        res.json(await ssh.testConnection(req.body.name || null));
    } catch (err) {
        next(err);
    }
});

/** GET /keys/git-config */
router.get("/git-config", async (req, res, next) => {
    try {
        res.json(await ssh.getGitConfig());
    } catch (err) {
        next(err);
    }
});

/** POST /keys/git-config — body: { name, email } */
router.post("/git-config", async (req, res, next) => {
    try {
        const { name, email } = req.body;
        res.json(await ssh.setGitConfig(name, email));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
