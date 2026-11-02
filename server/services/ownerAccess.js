const crypto = require("crypto");
const net = require("net");
const db = require("../db");
const lifecycle = require("./lifecycle");
const panelLog = require("./panelLog");
const discordBus = require("./discordBus");

// ─────────────────────────────────────────────────────────────────────────────
//  Owner sign-in by IP — the .env account works only from IPs the owner has
//  approved.
//
//  The password used to be the whole lock: whoever held it (or a copied
//  token) had every page, the Terminal included, from anywhere. Now:
//
//    known IP     the password is enough, as before.
//    new IP       a right password is not: the panel's bot posts the sign-in
//                 (IP, browser) in the panel log channel with Allow / Deny.
//                 Allow remembers the IP and lets that browser in; Deny turns
//                 it away, and the IP cannot ask again for DENY_BLOCK_MS. A
//                 wrong password never reaches Discord (anyone could fill the
//                 channel with buttons) — it only counts toward FAIL_LIMIT.
//    every call   the owner's token counts only from an approved IP, on EVERY
//                 request (middleware/auth.js): a token copied to another
//                 machine is worthless, and an IP that changes signs you out.
//
//  The panel log channel sits in the owner's own server, where nobody else
//  is — so whoever clicks is the owner (the user's call: the clicker is not
//  checked). It is the channel DISCORD_PANEL_LOG_WEBHOOK posts to, and the
//  panel's bot (PANEL_DISCORD_TOKEN) must be in that server: a webhook's
//  messages cannot carry buttons that call back.
//
//  ADMIN_ALLOWED_IPS (.env, comma-separated) are always let in and never
//  forgotten — the way back in when Discord or the bot is down: edit .env
//  over SSH, restart the panel.
//
//  An approved IP unused for FORGET_AFTER_MS is dropped: a home IP is handed
//  to someone else sooner or later. IPv6 goes by its /64 — the browser's own
//  address inside it changes by itself every day or so.
//
//  Storage: panel.sqlite "owner_access" { ips, blocked }, held in memory —
//  the middleware asks on every request and cannot wait for the DB. Waiting
//  sign-ins live in memory only: a restart drops them (sign in again).
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "owner_access";
const PENDING_TTL_MS = 10 * 60 * 1000;
const DENY_BLOCK_MS = 24 * 60 * 60 * 1000;
const FORGET_AFTER_MS = 30 * 86_400_000;
const TOUCH_EVERY_MS = 15 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_PENDING = 20;
const MAX_WAITERS = 5;
const BUTTON = "owner-ip";
const COLOR = { pending: 0xf0b232, approved: 0x57f287, denied: 0xed4245, expired: 0x80848e };

const httpError = (status, message) => Object.assign(new Error(message), { status });
const now = () => Date.now();
const unix = (t) => Math.floor(t / 1000);
const clip = (s, n) => String(s || "").replace(/`/g, "ʼ").slice(0, n);

// ── Addresses ────────────────────────────────────────────────────────────────

/**
 * How an IP is kept and compared: IPv4 as it is, IPv6 as its /64
 * ("2001:db8:1:2::/64"). null when it is not an IP.
 */
const ipKey = (raw) => {
    let ip = String(raw || "").trim();
    if (/^::ffff:/i.test(ip) && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
    if (net.isIPv4(ip)) return ip;
    ip = ip.replace(/%.*$/, "").replace(/\/64$/, "");
    if (!net.isIPv6(ip)) return null;
    // An IPv4 tail ("64:ff9b::1.2.3.4") stands for the last two groups.
    const groups = (part) => (part ? part.split(":") : []).flatMap((g) => (net.isIPv4(g) ? ["0", "0"] : [g]));
    const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, ""];
    const h = groups(head);
    const t = groups(tail);
    const full = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
    return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
};

const envIps = () => [...new Set(String(process.env.ADMIN_ALLOWED_IPS || "").split(/[\s,]+/).map(ipKey).filter(Boolean))];

// ── Storage ──────────────────────────────────────────────────────────────────

// ips:     [{ ip, approvedAt, approvedBy, ua, lastSeenAt }]
// blocked: [{ ip, until, by }]
let state = { ips: [], blocked: [] };
let loaded = false;
const touched = new Map(); // ip → when its lastSeenAt was last written
const pending = new Map(); // id → a sign-in waiting for Allow / Deny
const failures = new Map(); // ip key → times of wrong passwords

const load = async () => {
    try {
        const v = await db.get(KEY);
        state = { ips: Array.isArray(v?.ips) ? v.ips : [], blocked: Array.isArray(v?.blocked) ? v.blocked : [] };
    } catch (err) {
        console.error(`[Owner] Could not load the approved IPs: ${err.message}`);
    }
    loaded = true;
};
const ready = load();

// Every write is the whole list as it is in memory, one after another.
let writing = Promise.resolve();
const persist = () => {
    const snap = JSON.parse(JSON.stringify(state));
    writing = writing.then(() => db.set(KEY, snap)).catch((err) => console.error(`[Owner] Could not save the approved IPs: ${err.message}`));
    return writing;
};

const forgotten = (e, t) => (e.lastSeenAt || e.approvedAt || 0) < t - FORGET_AFTER_MS;

/** Is the list in memory yet? (Until then the middleware answers 503, not 401.) */
const isLoaded = () => loaded;

/** May the owner's account be used from `ip`? Stamps the IP as used. */
const allowed = (ip) => {
    const key = ipKey(ip);
    if (!key) return false;
    if (envIps().includes(key)) return true;
    const t = now();
    const e = state.ips.find((x) => x.ip === key);
    if (!e || forgotten(e, t)) return false;
    e.lastSeenAt = t;
    if (lifecycle.isActive() && t - (touched.get(key) || 0) >= TOUCH_EVERY_MS) {
        touched.set(key, t);
        persist();
    }
    return true;
};

// ── Wrong passwords ──────────────────────────────────────────────────────────

/** Throws 429 once `ip` has FAIL_LIMIT wrong sign-ins in the last FAIL_WINDOW_MS. */
const checkFailures = (ip) => {
    const key = ipKey(ip) || String(ip);
    const t = now();
    const recent = (failures.get(key) || []).filter((x) => x > t - FAIL_WINDOW_MS);
    failures.set(key, recent);
    if (recent.length >= FAIL_LIMIT) {
        const mins = Math.max(1, Math.ceil((recent[0] + FAIL_WINDOW_MS - t) / 60_000));
        throw httpError(429, `Too many wrong sign-ins from this IP — try again in ${mins} minute${mins > 1 ? "s" : ""}`);
    }
};

const failed = (ip) => {
    const key = ipKey(ip) || String(ip);
    const recent = [...(failures.get(key) || []), now()];
    failures.set(key, recent);
    const locked = recent.length >= FAIL_LIMIT ? ` — ${FAIL_LIMIT} in a row, this IP waits ${FAIL_WINDOW_MS / 60_000} minutes` : "";
    console.log(`[Owner] Wrong sign-in from ${ip}`);
    panelLog.add("warn", `Owner sign-in refused: wrong username or password · IP ${ip || "unknown"}${locked}`);
};

const succeeded = (ip) => failures.delete(ipKey(ip) || String(ip));

// ── Discord messages ─────────────────────────────────────────────────────────

const ipField = (p) => ({ name: "IP", value: `\`${p.ip}\`${p.ipKey !== p.ip ? ` (kept as \`${p.ipKey}\`)` : ""}`, inline: true });
const uaField = (p) => ({ name: "Browser", value: p.ua ? `\`${clip(p.ua, 300)}\`` : "unknown" });

const askMessage = (p) => ({
    embeds: [
        {
            title: "Owner sign-in from a new IP",
            description:
                "The right username and password were entered from an IP the owner account does not know. " +
                "**Allow** lets that browser in and remembers the IP; **Deny** turns it away for 24 hours.",
            color: COLOR.pending,
            fields: [ipField(p), { name: "Expires", value: `<t:${unix(p.expiresAt)}:R>`, inline: true }, uaField(p)],
            timestamp: new Date(p.createdAt).toISOString(),
        },
    ],
    components: [
        {
            type: 1,
            components: [
                { type: 2, style: 3, label: "Allow this IP", custom_id: `${BUTTON}:allow:${p.id}` },
                { type: 2, style: 4, label: "Deny", custom_id: `${BUTTON}:deny:${p.id}` },
            ],
        },
    ],
    allowedMentions: { parse: [] },
});

const doneMessage = (p) => {
    const title = { approved: "Owner sign-in allowed", denied: "Owner sign-in denied", expired: "Owner sign-in request expired" }[p.status];
    const by = p.decidedBy ? [{ name: p.status === "approved" ? "Allowed by" : "Denied by", value: `${clip(p.decidedBy, 100)} · <t:${unix(p.decidedAt)}:f>` }] : [];
    const description = {
        approved: `\`${p.ipKey}\` may now use the owner account.`,
        denied: `\`${p.ipKey}\` cannot ask again until <t:${unix(p.decidedAt + DENY_BLOCK_MS)}:f>.`,
        expired: "Nobody answered within 10 minutes — the browser has to sign in again.",
    }[p.status];
    return {
        embeds: [{ title, description, color: COLOR[p.status], fields: [ipField(p), ...by, uaField(p)], timestamp: new Date(p.createdAt).toISOString() }],
        components: [],
    };
};

// A click on a request this panel does not hold (it restarted, or the request ended).
const closedMessage = (msg) => {
    const old = msg?.embeds?.[0]?.data || msg?.embeds?.[0] || {};
    return {
        embeds: [{ ...old, color: COLOR.expired, footer: { text: "No longer open (expired, or the panel restarted) — sign in again" } }],
        components: [],
    };
};

// ── Waiting sign-ins ─────────────────────────────────────────────────────────

const isOpen = (p, t = now()) => p.status === "pending" && p.expiresAt > t;

const waitView = (p, key) => ({ id: p.id, key, ip: p.ip, expiresAt: p.expiresAt });

/**
 * A right password from an IP not on the list: post Allow / Deny on Discord.
 * Returns { id, key, ip, expiresAt } — the browser polls with id + key
 * (poll()); only that browser can collect the sign-in. A second try from the
 * same IP joins the request already open instead of posting another one.
 */
const requestApproval = async ({ ip, ua }) => {
    const key = ipKey(ip);
    if (!key) throw httpError(403, "The panel cannot tell your IP address, so it cannot be approved");
    const t = now();
    const block = state.blocked.find((b) => b.ip === key && b.until > t);
    if (block) {
        const hours = Math.max(1, Math.ceil((block.until - t) / 3_600_000));
        throw httpError(403, `Sign-ins from this IP were denied on Discord — try again in ${hours} hour${hours > 1 ? "s" : ""}`);
    }
    const waiter = crypto.randomBytes(24).toString("base64url");
    const open = [...pending.values()].find((p) => p.ipKey === key && isOpen(p, t));
    if (open) {
        if (open.waiters.size >= MAX_WAITERS) throw httpError(429, "Too many sign-ins from this IP are already waiting for approval");
        open.waiters.set(waiter, false);
        return waitView(open, waiter);
    }
    if ([...pending.values()].filter((p) => isOpen(p, t)).length >= MAX_PENDING) {
        throw httpError(429, "Too many sign-ins are waiting for approval — try again later");
    }
    if (!lifecycle.isActive()) throw httpError(503, "The panel is not ready (starting or moving) — try again in a minute");

    const p = {
        id: crypto.randomBytes(9).toString("base64url"),
        ip: String(ip),
        ipKey: key,
        ua: String(ua || "").slice(0, 300),
        createdAt: t,
        expiresAt: t + PENDING_TTL_MS,
        status: "pending",
        waiters: new Map([[waiter, false]]), // key → already collected its sign-in
        message: null,
        decidedBy: null,
        decidedAt: null,
    };
    try {
        const { channelId } = await panelLog.channel();
        p.message = await discordBus.post(channelId, askMessage(p));
    } catch (err) {
        console.warn(`[Owner] Could not post the sign-in approval for ${p.ip}: ${err.message}`);
        throw httpError(
            503,
            `This IP is not approved yet, and the approval could not be posted on Discord (${err.message}). ` +
                "To get in anyway, add the IP to ADMIN_ALLOWED_IPS in the panel's .env and restart the panel.",
        );
    }
    pending.set(p.id, p);
    return waitView(p, waiter);
};

const expire = (p) => {
    p.status = "expired";
    p.decidedAt = now();
    if (p.message) discordBus.edit(p.message, doneMessage(p)).catch(() => {});
};

/**
 * What the waiting browser learns: pending | approved | denied | expired.
 * "approved" is answered once per key — the route signs that browser in.
 */
const poll = (id, key) => {
    const p = pending.get(String(id || ""));
    const k = String(key || "");
    if (!p || !p.waiters.has(k)) return { status: "expired" };
    if (p.status === "pending" && p.expiresAt <= now()) expire(p);
    if (p.status === "approved") {
        if (p.waiters.get(k)) return { status: "expired" };
        p.waiters.set(k, true);
        return { status: "approved", ip: p.ip, decidedBy: p.decidedBy };
    }
    return { status: p.status, expiresAt: p.expiresAt };
};

/** Allow / Deny from Discord. Returns the request, or null when it is no longer open. */
const decide = (id, action, by) => {
    const p = pending.get(String(id || ""));
    const t = now();
    if (!p || !isOpen(p, t)) return null;
    if (action === "allow") {
        state.ips = [...state.ips.filter((e) => e.ip !== p.ipKey), { ip: p.ipKey, approvedAt: t, approvedBy: by, ua: p.ua, lastSeenAt: t }];
        state.blocked = state.blocked.filter((b) => b.ip !== p.ipKey);
        p.status = "approved";
        touched.set(p.ipKey, t);
    } else {
        state.blocked = [...state.blocked.filter((b) => b.ip !== p.ipKey), { ip: p.ipKey, until: t + DENY_BLOCK_MS, by }];
        p.status = "denied";
    }
    p.decidedBy = by;
    p.decidedAt = t;
    persist();
    panelLog.add("owner", `Owner IP \`${p.ipKey}\` ${p.status === "approved" ? "allowed" : "denied (24 hours)"} on Discord by ${by}`);
    console.log(`[Owner] ${p.ipKey} ${p.status} by ${by}`);
    return p;
};

discordBus.onButton(BUTTON, async (i, [action, id]) => {
    const by = i.user?.tag || i.user?.username || i.user?.id || "someone";
    const p = decide(id, action === "allow" ? "allow" : "deny", by);
    await i.update(p ? doneMessage(p) : closedMessage(i.message));
});

// ── The page (Panel Settings → Security) ─────────────────────────────────────

/** Everything the page shows; `currentIp` is the caller's own. */
const list = (currentIp) => {
    const t = now();
    const cur = ipKey(currentIp);
    return {
        currentIp: currentIp || null,
        currentKey: cur,
        ips: state.ips
            .filter((e) => !forgotten(e, t))
            .map((e) => ({ ...e, forgetAt: (e.lastSeenAt || e.approvedAt) + FORGET_AFTER_MS, current: e.ip === cur }))
            .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0)),
        env: envIps().map((ip) => ({ ip, current: ip === cur })),
        blocked: state.blocked.filter((b) => b.until > t),
        pending: [...pending.values()]
            .filter((p) => isOpen(p, t))
            .map((p) => ({ id: p.id, ip: p.ip, ua: p.ua, createdAt: p.createdAt, expiresAt: p.expiresAt })),
        limits: { forgetDays: FORGET_AFTER_MS / 86_400_000, denyHours: DENY_BLOCK_MS / 3_600_000, waitMinutes: PENDING_TTL_MS / 60_000, failLimit: FAIL_LIMIT },
    };
};

/** Can approvals be posted right now? { ok, channel, guild, botTag, error } */
const approvals = async () => {
    let where;
    try {
        where = await panelLog.channel();
    } catch (err) {
        return { ok: false, error: err.message };
    }
    return discordBus.canPost(where.channelId);
};

const remove = (ip) => {
    const key = ipKey(ip);
    if (key && envIps().includes(key) && !state.ips.some((e) => e.ip === key)) {
        throw httpError(400, "This IP comes from ADMIN_ALLOWED_IPS in .env — remove it there");
    }
    if (!state.ips.some((e) => e.ip === key)) throw httpError(404, "This IP is not on the list");
    state.ips = state.ips.filter((e) => e.ip !== key);
    touched.delete(key);
    persist();
    panelLog.add("owner", `Owner IP \`${key}\` removed on the panel`);
};

const unblock = (ip) => {
    const key = ipKey(ip);
    if (!state.blocked.some((b) => b.ip === key)) throw httpError(404, "This IP is not blocked");
    state.blocked = state.blocked.filter((b) => b.ip !== key);
    persist();
    panelLog.add("owner", `Owner IP \`${key}\` unblocked on the panel`);
};

// ── Housekeeping ─────────────────────────────────────────────────────────────

const sweep = () => {
    const t = now();
    for (const p of pending.values()) {
        if (p.status === "pending" && p.expiresAt <= t) expire(p);
        // Decided ones stay a while, so the waiting browser still hears the answer.
        else if (p.status !== "pending" && p.decidedAt < t - PENDING_TTL_MS) pending.delete(p.id);
    }
    const gone = state.ips.filter((e) => forgotten(e, t));
    const ended = state.blocked.filter((b) => b.until <= t);
    if (gone.length || ended.length) {
        state.ips = state.ips.filter((e) => !forgotten(e, t));
        state.blocked = state.blocked.filter((b) => b.until > t);
        persist();
        for (const e of gone) panelLog.add("owner", `Owner IP \`${e.ip}\` forgotten — not used for ${FORGET_AFTER_MS / 86_400_000} days`);
    }
    for (const [k, times] of failures) if (!times.some((x) => x > t - FAIL_WINDOW_MS)) failures.delete(k);
};

const start = () => {
    setInterval(lifecycle.guard(() => sweep()), SWEEP_EVERY_MS);
    console.log(`[Owner] Owner sign-in by IP: ${state.ips.length} approved, ${envIps().length} from ADMIN_ALLOWED_IPS`);
};

module.exports = {
    ipKey,
    isLoaded,
    allowed,
    checkFailures,
    failed,
    succeeded,
    requestApproval,
    poll,
    decide,
    list,
    approvals,
    remove,
    unblock,
    start,
    // for tests
    _ready: ready,
    _sweep: sweep,
    _reset: async () => {
        await ready;
        state = { ips: [], blocked: [] };
        pending.clear();
        failures.clear();
        touched.clear();
    },
};
