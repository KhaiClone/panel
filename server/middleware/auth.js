const jwt = require("jsonwebtoken");
const staffService = require("../services/staffService");

/**
 * Who is calling, and may they?
 *
 * Two kinds of token, both signed with JWT_SECRET:
 *   owner  { username }                 the .env account (routes/auth.js /login)
 *   staff  { kind: "staff", sub, sid }  a Discord login (services/staffService.js);
 *                                       sid must still be a live session row
 *
 * Deny by default: `authMiddleware` lets the OWNER through and nobody else.
 * Only the mounts that name a page with `pageAuth(page)` let staff in, and only
 * with that page in their permissions — "view" for GET, "edit" for the rest.
 * A route someone forgets to classify therefore stays owner-only. The terminal
 * WebSocket and the bot log routes, which read the token themselves, use
 * isOwnerToken().
 *
 * Expected header:  Authorization: Bearer <token>   (or ?token= for SSE/downloads)
 *
 * Every 401 from here carries `code: AUTH_REQUIRED`. That code is the ONLY
 * thing the browser treats as "your session died, go to /login" — see the
 * response interceptor in client/src/api/client.js. Staff 401s also carry
 * `reason` (a key of staffService.END_REASONS) so the login page can say why.
 *
 * The distinction matters because 401 is overloaded: a route that resolves a
 * Discord token the admin pasted also answers 401 when THAT token is dead
 * (questService.startAccount, questMonthly.activate). Before this code existed,
 * pasting a dead token into "Add account manually" logged the admin out of the
 * panel — two different auth domains collapsed onto one status number.
 */
const AUTH_REQUIRED = "AUTH_REQUIRED";
const FORBIDDEN = "FORBIDDEN";
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

const tokenOf = (req) => {
    const authHeader = req.headers["authorization"];
    // Fallback to query param for cases where headers aren't possible (downloads, SSE)
    return (authHeader && authHeader.split(" ")[1]) || req.query?.token || null;
};

/** The browser's address: nginx in front of the panel sets X-Real-IP. */
const clientIp = (req) => {
    const peer = req.socket?.remoteAddress || "";
    const local = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    return (local && req.headers["x-real-ip"]) || peer || null;
};

const unauthorized = (message, reason) => Object.assign(new Error(message), { status: 401, reason });

/**
 * { kind: "owner", username } | { kind: "staff", staff, session } —
 * or throws a 401 error (with `reason` when a staff session ended).
 */
const identify = (token) => {
    if (!token) throw unauthorized("Access denied: no token provided");
    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        throw unauthorized("Access denied: invalid or expired token");
    }
    if (decoded.kind === "staff") {
        try {
            const { staff, session } = staffService.authenticate(decoded.sub, decoded.sid);
            return { kind: "staff", staff, session };
        } catch (err) {
            throw unauthorized(err.message, err.reason);
        }
    }
    if (decoded.kind || typeof decoded.username !== "string") throw unauthorized("Access denied: invalid token");
    return { kind: "owner", username: decoded.username };
};

const deny401 = (res, err) =>
    res.status(401).json({ error: err.message, code: AUTH_REQUIRED, ...(err.reason ? { reason: err.reason } : {}) });

/** Owner only. */
const authMiddleware = (req, res, next) => {
    let who;
    try {
        who = identify(tokenOf(req));
    } catch (err) {
        return deny401(res, err);
    }
    if (who.kind !== "owner") {
        return res.status(403).json({ error: "Only the panel owner can do this", code: FORBIDDEN });
    }
    req.auth = who;
    next();
};

/** The owner, or staff holding `page` ("view" covers reads, "edit" everything). Staff writes are audited. */
const pageAuth = (page) => (req, res, next) => {
    let who;
    try {
        who = identify(tokenOf(req));
    } catch (err) {
        return deny401(res, err);
    }
    req.auth = who;
    if (who.kind === "owner") return next();

    if (!staffService.can(who.staff, page, req.method)) {
        const viewOnly = who.staff.perms[page] === "view";
        return res.status(403).json({
            error: viewOnly ? "You can only view this page" : "You have no access to this page",
            code: FORBIDDEN,
        });
    }
    if (!READS.has(req.method)) {
        const action = `${req.method} ${req.originalUrl.split("?")[0]}`;
        const ip = clientIp(req);
        res.on("finish", () => {
            try {
                staffService.audit({ userId: who.staff.userId, sessionId: who.session.id, action, status: res.statusCode, ip, page });
            } catch (err) {
                console.error(`[Staff] Audit write failed: ${err.message}`);
            }
        });
    }
    next();
};

/**
 * May whoever pageAuth let in see the part of the page `grant` covers
 * (staffService.GRANTS)? The owner always; staff only when it was ticked.
 * The route leaves that part out of its response otherwise.
 */
const hasGrant = (auth, grant) => auth?.kind === "owner" || (auth?.kind === "staff" && staffService.has(auth.staff, grant));

/** For code that reads the token itself (terminal WebSocket, bot logs): is it the owner's? */
const isOwnerToken = (token) => {
    try {
        return identify(token).kind === "owner";
    } catch {
        return false;
    }
};

module.exports = { authMiddleware, pageAuth, hasGrant, identify, isOwnerToken, tokenOf, clientIp, AUTH_REQUIRED, FORBIDDEN };
