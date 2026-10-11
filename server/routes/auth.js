const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const staffService = require("../services/staffService");
const lifecycle = require("../services/lifecycle");
const { identify, tokenOf, clientIp, AUTH_REQUIRED } = require("../middleware/auth");
const router = express.Router();

/**
 * Two ways in:
 *
 *  - The OWNER: ADMIN_USERNAME + ADMIN_PASSWORD_HASH in .env, full access.
 *    To change the password, regenerate the hash and restart the panel:
 *      node -e "console.log(require('bcryptjs').hashSync('newpassword',10))"
 *  - STAFF: Discord login only (services/staffService.js) — the owner adds them
 *    and picks their pages under Panel Settings → Staff. They have no password.
 */

/**
 * POST /api/auth/login
 * Validates username + password against the env credentials.
 * Returns a signed JWT valid for 24 hours.
 * Body: { username: string, password: string }
 */
router.post("/login", async (req, res, next) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: "Username and password are required" });
        }

        if (username !== process.env.ADMIN_USERNAME) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const validPassword = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
        if (!validPassword) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const token = jwt.sign(
            { username },
            process.env.JWT_SECRET,
            { expiresIn: "24h" },
        );

        res.json({ token, username });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/auth/verify
 * Who the token belongs to:
 *   { valid, kind: "owner", username }
 *   { valid, kind: "staff", username, userId, avatar, perms, expiresAt }
 * A staff 401 carries `reason` (why the session ended) for the login page.
 */
router.get("/verify", (req, res) => {
    let who;
    try {
        who = identify(tokenOf(req));
    } catch (err) {
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
