const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const staffService = require("../services/staffService");
const lifecycle = require("../services/lifecycle");
const ownerAccess = require("../services/ownerAccess");
const panelLog = require("../services/panelLog");
const { identify, authenticate, tokenOf, clientIp, AUTH_REQUIRED } = require("../middleware/auth");
const router = express.Router();

/**
 * Two ways in:
 *
 *  - The OWNER: ADMIN_USERNAME + ADMIN_PASSWORD_HASH in .env, full access —
 *    on an approved device only; a new device is allowed or denied on Discord
 *    (services/ownerAccess.js). To change the password, regenerate the hash
 *    and restart the panel:
 *      node -e "console.log(require('bcryptjs').hashSync('newpassword',10))"
 *  - STAFF: Discord login only (services/staffService.js) — the owner adds them
 *    and picks their pages under Panel Settings → Staff. They have no password.
 */

const ownerToken = (username) => jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: "24h" });

const signedIn = (ip, ua, how = "") =>
    panelLog.add("owner", [`**Owner** signed in${how}`, ownerAccess.deviceName(ua), `IP ${ip || "unknown"}`].join(" · "));

/**
 * POST /api/auth/login
 * Validates username + password against the env credentials. A right
 * password also (re)sets this browser's device cookie.
 * Body: { username: string, password: string }
 *   200 { token, username }            a JWT valid for 24 hours (approved device)
 *   202 { pending: { id, key, name, ip, expiresAt } }
 *                                      right password, new device: Allow / Deny
 *                                      is on Discord; poll POST /login/pending
 *   429                                too many wrong passwords from this IP
 */
router.post("/login", async (req, res, next) => {
    try {
        const { username, password } = req.body || {};

        if (!username || !password) {
            return res.status(400).json({ error: "Username and password are required" });
        }

        const ip = clientIp(req);
        const ua = req.headers["user-agent"];
        ownerAccess.checkFailures(ip);

        const validPassword = username === process.env.ADMIN_USERNAME && (await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH));
        if (!validPassword) {
            ownerAccess.failed(ip);
            return res.status(401).json({ error: "Invalid credentials" });
        }
        ownerAccess.succeeded(ip);

        if (!ownerAccess.isLoaded()) return res.status(503).json({ error: "The panel is starting — try again in a moment" });
        const device = ownerAccess.ensureDevice(req, res);
        if (ownerAccess.allowed({ ip, device })) {
            signedIn(ip, ua);
            return res.json({ token: ownerToken(username), username });
        }
        res.status(202).json({ pending: await ownerAccess.requestApproval({ ip, ua, device }) });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/**
 * POST /api/auth/login/pending { id, key }
 * The login page asks every few seconds while Allow / Deny waits on Discord:
 *   { status: "pending", expiresAt } | { status: "denied" } | { status: "expired" }
 *   { status: "approved", token, username }  — once, to the browser holding
 *                                              `key` and the device's cookie
 */
router.post("/login/pending", (req, res) => {
    const { id, key } = req.body || {};
    const r = ownerAccess.poll(id, key, ownerAccess.deviceOf(req));
    if (r.status !== "approved") return res.json(r);
    signedIn(clientIp(req), req.headers["user-agent"], ` (allowed on Discord by ${r.decidedBy})`);
    const username = process.env.ADMIN_USERNAME;
    res.json({ status: "approved", token: ownerToken(username), username });
});

/**
 * GET /api/auth/verify
 * Who the token belongs to:
 *   { valid, kind: "owner", username }
 *   { valid, kind: "staff", username, userId, avatar, perms, expiresAt }
 * A 401 carries `reason` (why the session ended — or, for the owner, that the
 * device is not approved) for the login page.
 */
router.get("/verify", (req, res) => {
    let who;
    try {
        who = authenticate(req);
    } catch (err) {
        if (err.status === 503) return res.status(503).json({ error: err.message, code: err.code });
        return res.status(401).json({ valid: false, error: err.message, code: AUTH_REQUIRED, ...(err.reason ? { reason: err.reason } : {}) });
    }
    if (who.kind === "owner") return res.json({ valid: true, kind: "owner", username: who.username });
    const s = who.staff;
    res.json({
        valid: true,
        kind: "staff",
        username: s.userTag || s.userId,
        userId: s.userId,
        avatar: s.avatar,
        perms: s.perms,
        expiresAt: who.session.expiresAt,
    });
});

/** GET /api/auth/discord — is Discord login available on this panel? */
router.get("/discord", (req, res) => {
    res.json({ enabled: staffService.isConfigured() });
});

/** POST /api/auth/discord/start — { url, state }: the browser keeps state and goes to url. */
router.post("/discord/start", (req, res) => {
    try {
        res.json(staffService.authorizeUrl());
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

/**
 * POST /api/auth/discord { code, state, device }
 * The callback page hands over what Discord sent back (through the launcher).
 * Returns the same shape as /verify, plus the token.
 */
router.post("/discord", async (req, res) => {
    // A login writes a session row: not while the panel is moving or replaced.
    if (!lifecycle.isActive()) {
        return res.status(503).json({ error: "The panel is not ready (starting or moving) — try again in a minute" });
    }
    try {
        const { code, state, device } = req.body || {};
        const { token, staff, expiresAt } = await staffService.login({
            code,
            state,
            device,
            ip: clientIp(req),
            ua: req.headers["user-agent"],
        });
        res.json({
            token,
            kind: "staff",
            username: staff.userTag || staff.userId,
            userId: staff.userId,
            avatar: staff.avatar,
            perms: staff.perms,
            expiresAt,
        });
    } catch (err) {
        if (!err.status || err.status >= 500) console.error(`[Staff] Discord login failed: ${err.message}`);
        res.status(err.status || 500).json({ error: err.message });
    }
});

/** POST /api/auth/logout — ends a staff session (an owner token just expires). */
router.post("/logout", (req, res) => {
    try {
        const who = identify(tokenOf(req));
        if (who.kind === "staff") staffService.logout(who.session.id);
    } catch {
        /* already signed out */
    }
    res.json({ ok: true });
});

module.exports = router;
