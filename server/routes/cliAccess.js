const express = require("express");
const cliAccess = require("../services/cliAccess");
const ownerAccess = require("../services/ownerAccess");
const { clientIp } = require("../middleware/auth");

// CLI access keys (services/cliAccess.js).
//
//   login  public: a client asks for a key and waits for Allow / Deny on
//          Discord (scripts/panel-cli.js login). Mounted with no auth.
//   panel  Panel Settings → Security: the keys, waiting requests and denied
//          IPs. Mounted behind authMiddleware (owner only).
// IPs travel in the body, never the URL: an IPv6 one carries "/64".

const fail = (res, next, err) => (err.status ? res.status(err.status).json({ error: err.message }) : next(err));

const login = express.Router();

/**
 * POST /api/cli-access/login { name, keyHash }
 *   200 { id, code, expiresAt }   posted on Discord; poll /login/poll
 *   403 requests off, or this IP was denied   429 too many requests
 */
login.post("/", async (req, res, next) => {
    try {
        const { name, keyHash } = req.body || {};
        res.json(await cliAccess.requestKey({ name, keyHash, ip: clientIp(req) }));
    } catch (err) {
        fail(res, next, err);
    }
});

/**
 * POST /api/cli-access/login/poll { id, keyHash }
 *   { status: "pending", expiresAt } | { status: "denied" } | { status: "expired" }
 *   { status: "approved", name, expiresAt, decidedBy }   expiresAt = the key's (null = never)
 */
login.post("/poll", (req, res) => {
    const { id, keyHash } = req.body || {};
    res.json(cliAccess.poll(id, keyHash));
});

const panel = express.Router();

/** GET /api/cli-access — keys, waiting requests, denied IPs, and whether Discord can take approvals. */
panel.get("/", async (req, res, next) => {
    try {
        res.json({ ...cliAccess.list(), discord: await ownerAccess.approvals() });
    } catch (err) {
        fail(res, next, err);
    }
});

/** POST /api/cli-access/revoke { id } */
panel.post("/revoke", (req, res, next) => {
    try {
        cliAccess.revoke(req.body?.id);
        res.json({ ok: true });
    } catch (err) {
        fail(res, next, err);
    }
});

/** POST /api/cli-access/unblock { ip } */
panel.post("/unblock", (req, res, next) => {
    try {
        cliAccess.unblock(req.body?.ip);
        res.json({ ok: true });
    } catch (err) {
        fail(res, next, err);
    }
});

/** POST /api/cli-access/accepting { on } — may new keys be asked for? */
panel.post("/accepting", (req, res, next) => {
    try {
        cliAccess.setAccepting(req.body?.on === true);
        res.json({ ok: true, accepting: req.body?.on === true });
    } catch (err) {
        fail(res, next, err);
    }
});

module.exports = { login, panel };
