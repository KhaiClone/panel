const crypto = require("crypto");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const sharedStore = require("./sharedStore");
const agentCrypto = require("./agentCrypto");
const lifecycle = require("./lifecycle");
const panelLog = require("./panelLog");

// ─────────────────────────────────────────────────────────────────────────────
//  Staff access — people the owner lets into some pages of the panel.
//
//  Staff have no panel password, so there is nothing to hand to a friend: they
//  sign in with their own Discord account (OAuth2, scopes identify +
//  guilds.members.read). To let someone else in they would have to give away
//  that whole Discord account.
//
//    who            the owner adds each Discord user by hand. Holding the Staff
//                   role in the shop's server is REQUIRED but not enough; the
//                   panel never gives or takes that role, it only checks it —
//                   at login and every ROLE_CHECK_MS while signed in. Losing it
//                   ends the session; the entry stays, so getting the role
//                   back is enough to sign in again.
//    what           per page: "view" (GET) or "edit" (everything). PAGES is the
//                   whole list; every other route is the owner's alone
//                   (middleware/auth.js — deny by default). GRANTS are the
//                   parts of a page held back unless ticked (Orders revenue).
//    one at a time  a new login ends the user's other sessions, so two people
//                   sharing one account keep throwing each other out. Every
//                   sign-in (flagged when the device is new), sign-out and
//                   change they make is in the audit log AND in the panel log
//                   channel (services/panelLog.js), as are the owner's changes
//                   to who has access.
//
//  Discord sends people back to ONE fixed address: the launcher
//  (panel-launcher on Vercel), which forwards /auth/discord/callback?code=…
//  to whichever panel is active — so a panel move changes nothing in the
//  Discord Developer Portal. The client secret stays here; the launcher only
//  ever sees the one-time code, worthless without it.
//
//  Storage: data/shared.sqlite (travels with a panel move). Sessions are rows,
//  not just signed tokens, so the owner can end one at any moment.
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ROLE_CHECK_MS = 10 * 60 * 1000;
const SWEEP_EVERY_MS = 2 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const AUDIT_KEEP = 5000;
const SESSIONS_KEEP_DAYS = 90;
const SETTINGS = "__staff.settings";
const DISCORD_API = "https://discord.com/api/v10";
const SCOPES = "identify guilds.members.read";

// ArnTo Shop's server and its Staff role — both editable on the page.
const DEFAULT_GUILD_ID = "1103736775815471257";
const DEFAULT_ROLE_ID = "1134354122867482716";

/** The pages staff can be given. Keys are what routes and the client use. */
const PAGES = [
    { key: "orders", label: "Orders", section: "Shop" },
    { key: "stock", label: "Stock", section: "Shop" },
    { key: "vouchers", label: "Vouchers", section: "Shop" },
    { key: "ticketMenus", label: "Ticket Menus", section: "Shop" },
    { key: "forms", label: "Forms", section: "Shop" },
    { key: "supporters", label: "Supporters", section: "Shop" },
    { key: "resellers", label: "Resellers", section: "Shop" },
    { key: "messages", label: "Messages", section: "Shop" },
    { key: "webhooks", label: "Webhooks", section: "Shop" },
    { key: "quests", label: "Auto Quest", section: "Auto Services" },
    { key: "badges", label: "Auto Badge", section: "Auto Services" },
    { key: "decors", label: "Decors", section: "Auto Services" },
    { key: "pricing", label: "Pricing", section: "Auto Services" },
];
const PAGE_KEYS = new Set(PAGES.map((p) => p.key));
const LEVELS = new Set(["view", "edit"]);

/**
 * Parts of a page shown only to the people the owner ticks, on top of its
 * view/edit level — worth nothing without the page itself. Orders is why: staff
 * need the page to run orders, but its totals are the shop's income.
 */
const GRANTS = [
    { key: "orders.revenue", page: "orders", label: "See revenue", hint: "The revenue totals, overall and per seller" },
];
const GRANT_PAGE = Object.fromEntries(GRANTS.map((g) => [g.key, g.page]));

/** Why a session ended, as the person who was signed out reads it. */
const END_REASONS = {
    replaced: "Your account signed in somewhere else.",
    logout: "You signed out.",
    kicked: "The owner signed you out.",
    removed: "Your panel access was removed.",
    role_lost: "You no longer have the Staff role.",
    left_guild: "You are no longer in the server.",
    discord_revoked: "The panel's access to your Discord account was revoked.",
    expired: "Your session expired.",
};

const httpError = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});
const now = () => Date.now();

// ── Storage ──────────────────────────────────────────────────────────────────

let made = null;
const conn = () => {
    const c = sharedStore.raw();
    if (made === c) return c;
    c.exec(`
        CREATE TABLE IF NOT EXISTS staff (
            user_id TEXT PRIMARY KEY,
            user_tag TEXT,
            avatar TEXT,                        -- Discord avatar hash
            perms TEXT NOT NULL DEFAULT '{}',   -- { page: "view" | "edit" }
            grants TEXT NOT NULL DEFAULT '[]',  -- keys of GRANTS (JSON)
            note TEXT NOT NULL DEFAULT '',
            added_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_login_at INTEGER,
            roles TEXT,                         -- their role ids in the server (JSON), from the last role check
            roles_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS staff_sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            device TEXT,                        -- random id the browser keeps (new-device notice only)
            ip TEXT,
            ua TEXT,
            discord_token TEXT,                 -- their access token, AES-GCM (JSON), for the role re-check
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            role_checked_at INTEGER NOT NULL,
            ended_at INTEGER,
            end_reason TEXT                     -- a key of END_REASONS
        );
        CREATE INDEX IF NOT EXISTS staff_sessions_by_user ON staff_sessions(user_id, created_at);
        CREATE TABLE IF NOT EXISTS staff_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            session_id TEXT,
            action TEXT NOT NULL,               -- login | logout | "POST /api/stock/products" …
            status INTEGER,
            ip TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS staff_audit_by_user ON staff_audit(user_id, id);
    `);
    // Tables made before the roles were kept (the Messages page works out each
    // person's channels from them).
    const cols = c.pragma("table_info(staff)").map((col) => col.name);
    if (!cols.includes("roles")) c.exec("ALTER TABLE staff ADD COLUMN roles TEXT");
    if (!cols.includes("roles_at")) c.exec("ALTER TABLE staff ADD COLUMN roles_at INTEGER");
    // …and before grants: nobody had one.
    if (!cols.includes("grants")) c.exec("ALTER TABLE staff ADD COLUMN grants TEXT NOT NULL DEFAULT '[]'");
    made = c;
    return c;
};

const kvGet = (name) => {
    const r = conn().prepare("SELECT value FROM kv WHERE name = ?").get(name);
    return r ? JSON.parse(r.value) : null;
};
const kvSet = (name, value) => conn().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(name, JSON.stringify(value));

const secret = () => {
    if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set");
    return process.env.JWT_SECRET;
};
const seal = (text) => JSON.stringify(agentCrypto.encrypt(text, secret()));
const unseal = (json) => agentCrypto.decrypt(JSON.parse(json), secret());

// ── Settings ─────────────────────────────────────────────────────────────────

const rawSettings = () => ({
    clientId: "",
    secretEnc: null,
    redirectUri: "",
    guildId: DEFAULT_GUILD_ID,
    roleId: DEFAULT_ROLE_ID,
    ...(kvGet(SETTINGS) || {}),
});

const isConfigured = (s = rawSettings()) => !!(s.clientId && s.secretEnc && s.redirectUri && s.guildId && s.roleId);

/** What the page shows — the client secret never leaves the panel. */
const getSettings = () => {
    const s = rawSettings();
    return {
        clientId: s.clientId,
        hasSecret: !!s.secretEnc,
        redirectUri: s.redirectUri,
        guildId: s.guildId,
        roleId: s.roleId,
        configured: isConfigured(s),
    };
};

const SNOWFLAKE = /^\d{15,25}$/;

const setSettings = (patch = {}) => {
    const s = rawSettings();
    const next = { ...s };
    if (patch.clientId !== undefined) {
        const v = String(patch.clientId).trim();
        if (v && !SNOWFLAKE.test(v)) throw httpError(400, "The Client ID is the application's numeric ID");
        next.clientId = v;
    }
    // Empty = keep the stored one; it is never sent back to the browser.
    if (patch.clientSecret !== undefined && String(patch.clientSecret).trim()) {
        next.secretEnc = seal(String(patch.clientSecret).trim());
    }
    if (patch.redirectUri !== undefined) {
        const v = String(patch.redirectUri).trim();
        if (v) {
            let u;
            try { u = new URL(v); } catch { throw httpError(400, "The redirect URL is not a valid URL"); }
            if (u.protocol !== "https:") throw httpError(400, "The redirect URL must be https");
            if (u.pathname !== "/auth/discord/callback") throw httpError(400, "The redirect URL must end in /auth/discord/callback");
        }
        next.redirectUri = v;
    }
    for (const k of ["guildId", "roleId"]) {
        if (patch[k] === undefined) continue;
        const v = String(patch[k]).trim();
        if (!SNOWFLAKE.test(v)) throw httpError(400, `${k === "guildId" ? "Server" : "Role"} ID must be a Discord ID`);
        next[k] = v;
    }
    kvSet(SETTINGS, next);
    panelLog.add("owner", "Owner changed the staff Discord login settings");
    return getSettings();
};

// ── Staff ────────────────────────────────────────────────────────────────────

const parsePerms = (json) => {
    let p = {};
    try { p = JSON.parse(json || "{}"); } catch { /* treat as none */ }
    return Object.fromEntries(Object.entries(p).filter(([k, v]) => PAGE_KEYS.has(k) && LEVELS.has(v)));
};

const cleanPerms = (perms) => {
    if (!perms || typeof perms !== "object") throw httpError(400, "perms must be an object { page: \"view\" | \"edit\" }");
    const out = {};
    for (const [k, v] of Object.entries(perms)) {
        if (!PAGE_KEYS.has(k)) throw httpError(400, `Unknown page "${k}"`);
        if (v === "none" || v === null || v === "") continue;
        if (!LEVELS.has(v)) throw httpError(400, `Level for ${k} must be view or edit`);
        out[k] = v;
    }
    return out;
};

// A grant goes with its page: taking the page away takes the grant too.
const parseGrants = (json, perms) => {
    let g = [];
    try { g = JSON.parse(json || "[]"); } catch { /* treat as none */ }
    return Array.isArray(g) ? GRANTS.map((x) => x.key).filter((k) => g.includes(k) && perms[GRANT_PAGE[k]]) : [];
};

const cleanGrants = (grants, perms) => {
    if (!Array.isArray(grants)) throw httpError(400, "grants must be a list");
    for (const k of grants) if (!GRANT_PAGE[k]) throw httpError(400, `Unknown grant "${k}"`);
    return GRANTS.map((x) => x.key).filter((k) => grants.includes(k) && perms[GRANT_PAGE[k]]);
};

const PAGE_LABEL = Object.fromEntries(PAGES.map((p) => [p.key, p.label]));
const describePerms = (perms, grants = []) =>
    Object.entries(perms)
        .map(([k, v]) => {
            const extra = GRANTS.filter((g) => g.page === k && grants.includes(g.key)).map((g) => ` + ${g.label.toLowerCase()}`);
            return `${PAGE_LABEL[k] || k} (${v}${extra.join("")})`;
        })
        .join(", ") || "no pages";
const who = (s) => `**${s?.userTag || s?.userId}**`;

const rowToStaff = (r) => {
    if (!r) return r;
    const perms = parsePerms(r.perms);
    return {
        userId: r.user_id,
        userTag: r.user_tag || null,
        avatar: r.avatar || null,
        perms,
        grants: parseGrants(r.grants, perms),
        note: r.note || "",
        addedAt: r.added_at,
        updatedAt: r.updated_at,
        lastLoginAt: r.last_login_at || null,
    };
};

const getStaff =(userId) => rowToStaff(conn().prepare("SELECT * FROM staff WHERE user_id = ?").get(String(userId)));

const keepRoles = (userId, roles) =>
    conn().prepare("UPDATE staff SET roles = ?, roles_at = ? WHERE user_id = ?").run(JSON.stringify(roles || []), now(), String(userId));

/**
 * Their role ids in the server as of the last check (login, then every
 * ROLE_CHECK_MS while signed in): { roles, at } — or null before the first one.
 */
const rolesOf = (userId) => {
    const r = conn().prepare("SELECT roles, roles_at FROM staff WHERE user_id = ?").get(String(userId));
    if (!r?.roles) return null;
    try {
        return { roles: JSON.parse(r.roles), at: r.roles_at };
    } catch {
        return null;
    }
};

const activeSessionOf = (userId) =>
    conn()
        .prepare("SELECT * FROM staff_sessions WHERE user_id = ? AND ended_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1")
        .get(String(userId), now());

const list = () =>
    conn()
        .prepare("SELECT * FROM staff ORDER BY added_at")
        .all()
        .map((r) => {
            const s = activeSessionOf(r.user_id);
            return { ...rowToStaff(r), online: s ? { id: s.id, since: s.created_at, lastSeenAt: s.last_seen_at, ip: s.ip, ua: s.ua } : null };
        });

const add = async ({ userId, perms, grants, note }) => {
    const id = String(userId || "").trim();
    if (!SNOWFLAKE.test(id)) throw httpError(400, "Enter the person's Discord user ID");
    if (getStaff(id)) throw httpError(409, "This person already has panel access");
    const p = cleanPerms(perms || {});
    const g = cleanGrants(grants || [], p);
    // Their name, when the panel's Discord bot can look it up; the login fills it in otherwise.
    let tag = null;
    try { tag = (await require("./discordBus").userTag(id)) || null; } catch { /* unknown user or bus down */ }
    const t = now();
    conn()
        .prepare("INSERT INTO staff (user_id, user_tag, perms, grants, note, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, tag, JSON.stringify(p), JSON.stringify(g), String(note || "").slice(0, 300), t, t);
    const added = getStaff(id);
    panelLog.add("owner", `Owner gave ${who(added)} (\`${id}\`) panel access — ${describePerms(p, g)}`);
    return added;
};

const update = (userId, { perms, grants, note } = {}) => {
    const cur = getStaff(userId);
    if (!cur) throw httpError(404, "Not a staff member");
    const p = perms !== undefined ? cleanPerms(perms) : cur.perms;
    const g = cleanGrants(grants !== undefined ? grants : cur.grants, p);
    const n = note !== undefined ? String(note).slice(0, 300) : cur.note;
    conn()
        .prepare("UPDATE staff SET perms = ?, grants = ?, note = ?, updated_at = ? WHERE user_id = ?")
        .run(JSON.stringify(p), JSON.stringify(g), n, now(), cur.userId);
    if (JSON.stringify(p) !== JSON.stringify(cur.perms) || JSON.stringify(g) !== JSON.stringify(cur.grants)) {
        panelLog.add("owner", `Owner changed the pages of ${who(cur)}: ${describePerms(cur.perms, cur.grants)} → ${describePerms(p, g)}`);
    }
    return getStaff(cur.userId);
};

const remove = (userId) => {
    const cur = getStaff(userId);
    if (!cur) throw httpError(404, "Not a staff member");
    endSessionsOf(cur.userId, "removed");
    conn().prepare("DELETE FROM staff WHERE user_id = ?").run(cur.userId);
    panelLog.add("owner", `Owner removed the panel access of ${who(cur)}`);
    return { removed: cur.userId };
};

// ── Sessions ─────────────────────────────────────────────────────────────────

const endSession = (id, reason) =>
    conn().prepare("UPDATE staff_sessions SET ended_at = ?, end_reason = ?, discord_token = NULL WHERE id = ? AND ended_at IS NULL").run(now(), reason, id).changes;

const endSessionsOf = (userId, reason, exceptId = null) =>
    conn()
        .prepare("UPDATE staff_sessions SET ended_at = ?, end_reason = ?, discord_token = NULL WHERE user_id = ? AND ended_at IS NULL AND id IS NOT ?")
        .run(now(), reason, String(userId), exceptId).changes;

const sessionToPublic = (r) => ({
    id: r.id,
    userId: r.user_id,
    ip: r.ip,
    ua: r.ua,
    device: r.device ? r.device.slice(0, 8) : null,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    roleCheckedAt: r.role_checked_at,
    endedAt: r.ended_at || null,
    endReason: r.end_reason || null,
    active: !r.ended_at && r.expires_at > now(),
});

const sessions = ({ userId, limit = 50 } = {}) => {
    const n = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const rows = userId
        ? conn().prepare("SELECT * FROM staff_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(String(userId), n)
        : conn().prepare("SELECT * FROM staff_sessions ORDER BY created_at DESC LIMIT ?").all(n);
    return rows.map(sessionToPublic);
};

const kick = (sessionId) => {
    const r = conn().prepare("SELECT * FROM staff_sessions WHERE id = ?").get(String(sessionId));
    if (!r) throw httpError(404, "No such session");
    if (!endSession(r.id, "kicked")) throw httpError(409, "That session has already ended");
    audit({ userId: r.user_id, sessionId: r.id, action: "kicked by owner", log: { kind: "owner", text: `Owner signed ${who(getStaff(r.user_id) || { userId: r.user_id })} out` } });
    return sessionToPublic(conn().prepare("SELECT * FROM staff_sessions WHERE id = ?").get(r.id));
};

/**
 * The staff member behind a token's (sub, sid), or a 401 saying why not.
 * Runs on every staff request — one indexed SELECT, plus a write at most
 * once a minute for "last seen".
 */
const authenticate = (userId, sessionId) => {
    const r = conn().prepare("SELECT * FROM staff_sessions WHERE id = ?").get(String(sessionId || ""));
    if (!r || r.user_id !== String(userId)) throw httpError(401, "Session not found — sign in again");
    if (r.ended_at) throw httpError(401, END_REASONS[r.end_reason] || "Session ended", { reason: r.end_reason });
    if (r.expires_at <= now()) {
        endSession(r.id, "expired");
        throw httpError(401, END_REASONS.expired, { reason: "expired" });
    }
    const staff = getStaff(r.user_id);
    if (!staff) {
        endSession(r.id, "removed");
        throw httpError(401, END_REASONS.removed, { reason: "removed" });
    }
    if (now() - r.last_seen_at > TOUCH_EVERY_MS) {
        conn().prepare("UPDATE staff_sessions SET last_seen_at = ? WHERE id = ?").run(now(), r.id);
    }
    return { staff, session: { id: r.id, expiresAt: r.expires_at } };
};

/** May this staff member use `page` with this HTTP method? */
const can = (staff, page, method = "GET") => {
    const level = staff?.perms?.[page];
    if (!level) return false;
    return level === "edit" || ["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase());
};

/** Does this staff member hold `grant` (a key of GRANTS)? Never without its page. */
const has = (staff, grant) => !!GRANT_PAGE[grant] && !!staff?.perms?.[GRANT_PAGE[grant]] && !!staff?.grants?.includes(grant);

// ── Audit ────────────────────────────────────────────────────────────────────

let auditCount = 0;
/**
 * One row of the audit log, and its line in the panel log channel. `page`
 * names the page of a staff write; `log` replaces the default line
 * ({ kind, text }, or false for none).
 */
const audit = ({ userId, sessionId = null, action, status = null, ip = null, page = null, log = null }) => {
    conn()
        .prepare("INSERT INTO staff_audit (user_id, session_id, action, status, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(String(userId), sessionId, String(action).slice(0, 300), status, ip, now());
    if (++auditCount % 100 === 0) {
        conn().prepare("DELETE FROM staff_audit WHERE id <= (SELECT MAX(id) FROM staff_audit) - ?").run(AUDIT_KEEP);
    }
    if (log === false) return;
    if (log) return panelLog.add(log.kind, log.text);
    const name = who(getStaff(userId) || { userId });
    const result = status == null ? "" : ` → ${status < 400 ? "✅" : "❌"} ${status}`;
    panelLog.add("staff", `${name}${page ? ` · ${PAGE_LABEL[page] || page}` : ""} · \`${String(action).slice(0, 200)}\`${result}`);
};

const auditLog = ({ userId, limit = 100, before } = {}) => {
    const n = Math.min(Math.max(parseInt(limit) || 100, 1), 500);
    const b = parseInt(before) || Number.MAX_SAFE_INTEGER;
    const rows = userId
        ? conn().prepare("SELECT * FROM staff_audit WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(String(userId), b, n)
        : conn().prepare("SELECT * FROM staff_audit WHERE id < ? ORDER BY id DESC LIMIT ?").all(b, n);
    return rows.map((r) => ({ id: r.id, userId: r.user_id, sessionId: r.session_id, action: r.action, status: r.status, ip: r.ip, at: r.created_at }));
};

// ── Discord login ────────────────────────────────────────────────────────────

const sign = (text) => crypto.createHmac("sha256", secret()).update(`staff-oauth:${text}`).digest("base64url");

/** A fresh state for the authorize URL: random, timestamped, signed. */
const makeState = () => {
    const body = `${crypto.randomBytes(16).toString("base64url")}.${now()}`;
    return `${body}.${sign(body)}`;
};

const checkState = (state) => {
    const parts = String(state || "").split(".");
    if (parts.length !== 3) return false;
    const body = `${parts[0]}.${parts[1]}`;
    const want = Buffer.from(sign(body));
    const got = Buffer.from(parts[2]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
    const at = Number(parts[1]);
    return Number.isFinite(at) && now() - at < STATE_TTL_MS && at <= now() + 60_000;
};

/** Where the Login page sends the browser. The browser keeps `state` to compare on return. */
const authorizeUrl = () => {
    const s = rawSettings();
    if (!isConfigured(s)) throw httpError(503, "Discord login is not set up on this panel yet");
    const state = makeState();
    const q = new URLSearchParams({
        client_id: s.clientId,
        response_type: "code",
        redirect_uri: s.redirectUri,
        scope: SCOPES,
        state,
        prompt: "none", // no consent screen again once they have agreed
    });
    return { url: `https://discord.com/oauth2/authorize?${q}`, state };
};

const discordGet = (path, accessToken) =>
    axios.get(`${DISCORD_API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10_000 });

/**
 * Their roles in the shop's server, or a reason they cannot have any:
 * { roles } | { gone: "left_guild" | "discord_revoked" }. Throws on anything
 * else (rate limit, Discord down) — the caller decides what that means.
 */
const memberOf = async (accessToken, guildId) => {
    try {
        const { data } = await discordGet(`/users/@me/guilds/${guildId}/member`, accessToken);
        return { roles: Array.isArray(data?.roles) ? data.roles : [] };
    } catch (err) {
        const st = err.response?.status;
        if (st === 404) return { gone: "left_guild" };
        if (st === 401) return { gone: "discord_revoked" };
        throw err;
    }
};

const avatarOf = (u) => u?.avatar || null;
const tagOf = (u) => (u?.discriminator && u.discriminator !== "0" ? `${u.username}#${u.discriminator}` : u?.username || null);

/**
 * Finish a Discord login: code → their identity → checks → a session.
 * Returns { token, staff, expiresAt }.
 */
const login = async ({ code, state, device, ip, ua }) => {
    const s = rawSettings();
    if (!isConfigured(s)) throw httpError(503, "Discord login is not set up on this panel yet");
    if (!checkState(state)) throw httpError(400, "This sign-in link is invalid or too old — try again");
    if (!code || typeof code !== "string") throw httpError(400, "Discord did not send a sign-in code");

    let tokenSet;
    try {
        const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: s.redirectUri });
        const { data } = await axios.post(`${DISCORD_API}/oauth2/token`, body.toString(), {
            auth: { username: s.clientId, password: unseal(s.secretEnc) },
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 10_000,
        });
        tokenSet = data;
    } catch (err) {
        const d = err.response?.data;
        if (d?.error === "invalid_grant") throw httpError(400, "This sign-in code was already used or has expired — try again");
        if (d?.error === "invalid_client") throw httpError(502, "Discord refused the panel's Client ID / Secret — check them under Panel Settings → Staff");
        throw httpError(502, `Discord sign-in failed: ${d?.error_description || d?.error || err.message}`);
    }
    const scopes = String(tokenSet.scope || "").split(" ");
    if (!scopes.includes("identify") || !scopes.includes("guilds.members.read")) {
        throw httpError(400, "Discord did not grant the permissions the panel needs — try again and accept them");
    }

    let me;
    try {
        me = (await discordGet("/users/@me", tokenSet.access_token)).data;
    } catch (err) {
        throw httpError(502, `Could not read your Discord account: ${err.message}`);
    }
    const staff = getStaff(me.id);
    if (!staff) throw httpError(403, "This Discord account has no access to the panel");

    let member;
    try {
        member = await memberOf(tokenSet.access_token, s.guildId);
    } catch (err) {
        throw httpError(502, `Could not check your roles on Discord: ${err.message}`);
    }
    if (member.gone === "left_guild") throw httpError(403, "You are not in the server — panel access needs the Staff role there");
    if (member.gone) throw httpError(403, "Discord refused the role check — try again");
    if (!member.roles.includes(s.roleId)) throw httpError(403, "Panel access needs the Staff role in the server");

    const dev = /^[A-Za-z0-9_-]{8,64}$/.test(String(device || "")) ? String(device) : null;
    const seenDevice = dev && conn().prepare("SELECT 1 FROM staff_sessions WHERE user_id = ? AND device = ? LIMIT 1").get(staff.userId, dev);

    const id = crypto.randomBytes(18).toString("base64url");
    const t = now();
    const expiresAt = t + SESSION_TTL_MS;
    const replaced = endSessionsOf(staff.userId, "replaced");
    conn()
        .prepare(`INSERT INTO staff_sessions (id, user_id, device, ip, ua, discord_token, created_at, last_seen_at, expires_at, role_checked_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, staff.userId, dev, ip || null, String(ua || "").slice(0, 300) || null, seal(tokenSet.access_token), t, t, expiresAt, t);
    conn()
        .prepare("UPDATE staff SET user_tag = ?, avatar = ?, last_login_at = ? WHERE user_id = ?")
        .run(tagOf(me) || staff.userTag, avatarOf(me), t, staff.userId);
    keepRoles(staff.userId, member.roles);
    const ended = replaced ? `ended ${replaced} other session${replaced > 1 ? "s" : ""}` : "";
    audit({
        userId: staff.userId,
        sessionId: id,
        action: ended ? `login (${ended})` : "login",
        ip,
        log: {
            kind: "staff",
            text: [
                `**${tagOf(me) || staff.userTag || staff.userId}** signed in`,
                !seenDevice && "🆕 **new device**",
                ip && `IP ${ip}`,
                ended,
                ua && `\`${String(ua).slice(0, 120)}\``,
            ]
                .filter(Boolean)
                .join(" · "),
        },
    });

    const token = jwt.sign({ kind: "staff", sub: staff.userId, sid: id }, secret(), { expiresIn: Math.floor(SESSION_TTL_MS / 1000) });
    return { token, staff: getStaff(staff.userId), expiresAt };
};

const logout = (sessionId) => {
    const r = conn().prepare("SELECT user_id FROM staff_sessions WHERE id = ?").get(String(sessionId || ""));
    if (r && endSession(sessionId, "logout")) {
        audit({ userId: r.user_id, sessionId, action: "logout", log: { kind: "staff", text: `${who(getStaff(r.user_id) || { userId: r.user_id })} signed out` } });
    }
};

// ── Role re-check ────────────────────────────────────────────────────────────

let sweeping = false;
const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
        const s = rawSettings();
        const t = now();
        const expired = conn().prepare("UPDATE staff_sessions SET ended_at = ?, end_reason = 'expired', discord_token = NULL WHERE ended_at IS NULL AND expires_at <= ?").run(t, t);
        if (expired.changes) console.log(`[Staff] ${expired.changes} session(s) expired`);
        conn().prepare("DELETE FROM staff_sessions WHERE ended_at IS NOT NULL AND ended_at < ?").run(t - SESSIONS_KEEP_DAYS * 86_400_000);

        const due = conn().prepare("SELECT * FROM staff_sessions WHERE ended_at IS NULL AND role_checked_at < ?").all(t - ROLE_CHECK_MS);
        for (const r of due) {
            let member;
            try {
                member = await memberOf(unseal(r.discord_token), s.guildId);
            } catch (err) {
                // Discord down or rate-limited: keep them in, try again next sweep.
                console.warn(`[Staff] Role check for ${r.user_id} failed: ${err.message}`);
                continue;
            }
            const reason = member.gone || (member.roles.includes(s.roleId) ? null : "role_lost");
            if (reason) {
                endSession(r.id, reason);
                audit({
                    userId: r.user_id,
                    sessionId: r.id,
                    action: `signed out: ${reason}`,
                    log: { kind: "staff", text: `${who(getStaff(r.user_id) || { userId: r.user_id })} signed out — ${END_REASONS[reason]}` },
                });
                console.log(`[Staff] Session of ${r.user_id} ended: ${reason}`);
            } else {
                conn().prepare("UPDATE staff_sessions SET role_checked_at = ? WHERE id = ?").run(now(), r.id);
                keepRoles(r.user_id, member.roles);
            }
        }
    } finally {
        sweeping = false;
    }
};

const status = () => ({ ...getSettings(), staff: conn().prepare("SELECT COUNT(*) AS c FROM staff").get().c, online: list().filter((x) => x.online).length });

const start = () => {
    conn();
    setInterval(lifecycle.guard(() => sweep().catch((e) => console.error("[Staff] Sweep failed:", e.message))), SWEEP_EVERY_MS);
    console.log("[Staff] Staff access service started");
};

module.exports = {
    PAGES,
    GRANTS,
    END_REASONS,
    SESSION_TTL_MS,
    getSettings,
    setSettings,
    isConfigured: () => isConfigured(),
    list,
    getStaff,
    rolesOf,
    add,
    update,
    remove,
    sessions,
    kick,
    authenticate,
    can,
    has,
    audit,
    auditLog,
    authorizeUrl,
    login,
    logout,
    status,
    sweep,
    start,
    // for tests
    _checkState: checkState,
    _makeState: makeState,
};
