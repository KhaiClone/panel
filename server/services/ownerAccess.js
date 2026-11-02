const crypto = require("crypto");
const net = require("net");
const db = require("../db");
const lifecycle = require("./lifecycle");
const panelLog = require("./panelLog");
const discordBus = require("./discordBus");

// ─────────────────────────────────────────────────────────────────────────────
//  Owner sign-in by device — the .env account works only on devices (browsers)
//  the owner has approved.
//
//  The password used to be the whole lock: whoever held it (or a copied
//  token) had every page, the Terminal included, from anywhere. Now:
//
//    known device  the password is enough, as before.
//    new device    a right password is not: the panel's bot posts the sign-in
//                  (device, IP, browser) on Discord with Allow / Deny. Allow
//                  remembers the device and lets it in; Deny turns it away,
//                  and its IP cannot ask again for DENY_BLOCK_MS. A wrong
//                  password never reaches Discord (anyone could fill the
//                  channel with buttons) — it only counts toward FAIL_LIMIT.
//    every call    the owner's token counts only with an approved device's
//                  key, on EVERY request (middleware/auth.js): a token copied
//                  to another machine is worthless.
//
//  Why a device and not an IP (the first version, never deployed, went by
//  IP): the server only ever sees the network's public IP, never the
//  device's own (192.168.x.x stays inside the home network). Everyone on the
//  same Wi-Fi or mobile network shares that IP, so it let them in on the
//  password alone — and it changes with the network, signing the owner out.
//
//  The device key is 32 random bytes the panel gives the browser at a right
//  password, in an httpOnly cookie (the page's own scripts cannot read it,
//  so a script slipped into the page cannot carry it off). Only its sha256
//  is kept here. Cookies belong to one domain: after a panel move to another
//  node's domain, each device is new once. Clearing the browser's data, a
//  private window or another browser on the same machine is a new device too.
//
//  The approvals go to APPROVAL_CHANNEL_ID (the user's panel log channel;
//  OWNER_APPROVAL_CHANNEL_ID in .env overrides it), pinging @everyone. That
//  channel sits in the owner's own server, where nobody else is — so whoever
//  clicks is the owner (the user's call: the clicker is not checked). The
//  panel's bot (PANEL_DISCORD_TOKEN) posts them, so it must be in that
//  server: a webhook's messages cannot carry buttons that call back.
//
//  ADMIN_ALLOWED_IPS (.env, comma-separated) let any device in from those
//  IPs — the way back in when Discord or the bot is down: edit .env over SSH,
//  restart the panel. IPv6 there goes by its /64.
//
//  A device unused for FORGET_AFTER_MS is dropped.
//
//  Storage: panel.sqlite "owner_access" { devices, blocked }, held in memory —
//  the middleware asks on every request and cannot wait for the DB. Waiting
//  sign-ins live in memory only: a restart drops them (sign in again).
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "owner_access";
const COOKIE = "bp_owner_device";
const COOKIE_MAX_AGE_MS = 400 * 86_400_000; // the longest a browser keeps a cookie
const DEVICE_KEY = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const PENDING_TTL_MS = 10 * 60 * 1000;
const DENY_BLOCK_MS = 24 * 60 * 60 * 1000;
const FORGET_AFTER_MS = 30 * 86_400_000;
const TOUCH_EVERY_MS = 15 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_PENDING = 20;
const MAX_WAITERS = 5;
const BUTTON = "owner-device";
const APPROVAL_CHANNEL_ID = "1497117161079181433";
const approvalChannel = () => String(process.env.OWNER_APPROVAL_CHANNEL_ID || "").trim() || APPROVAL_CHANNEL_ID;
const COLOR = { pending: 0xf0b232, approved: 0x57f287, denied: 0xed4245, expired: 0x80848e };

const httpError = (status, message) => Object.assign(new Error(message), { status });
const now = () => Date.now();
const unix = (t) => Math.floor(t / 1000);
const clip = (s, n) => String(s || "").replace(/`/g, "ʼ").slice(0, n);
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

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
const fromEnvIp = (ip) => {
    const k = ipKey(ip);
    return !!k && envIps().includes(k);
};

// ── Devices ──────────────────────────────────────────────────────────────────

/** This browser's device key, from its cookie, or null. */
const deviceOf = (req) => {
    for (const part of String(req?.headers?.cookie || "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0 && part.slice(0, i).trim() === COOKIE) {
            const v = part.slice(i + 1).trim();
            return DEVICE_KEY.test(v) ? v : null;
        }
    }
    return null;
};

/** The device key this browser keeps from now on — a new one when it has none. Sets the cookie. */
const ensureDevice = (req, res) => {
    const key = deviceOf(req) || crypto.randomBytes(32).toString("base64url");
    const https = req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
    res.cookie(COOKIE, key, { httpOnly: true, sameSite: "lax", secure: https, path: "/", maxAge: COOKIE_MAX_AGE_MS });
    return key;
};

/** "Chrome on Windows" — from the user agent, for the owner to recognise a device. */
const deviceName = (ua) => {
    const s = String(ua || "");
    const browser = /Edg(A|iOS)?\//.test(s)
        ? "Edge"
        : /coc_coc_browser/i.test(s)
          ? "Coc Coc"
          : /OPR\/|Opera/.test(s)
            ? "Opera"
            : /SamsungBrowser/.test(s)
              ? "Samsung Internet"
              : /Firefox\/|FxiOS/.test(s)
                ? "Firefox"
                : /Chrome\/|CriOS/.test(s)
                  ? "Chrome"
                  : /Safari\//.test(s)
                    ? "Safari"
                    : "A browser";
    // iOS user agents say "like Mac OS X", Android ones "Linux": ask those first.
    const os = /iPhone|iPad|iPod/.test(s)
        ? "iOS"
        : /Android/.test(s)
          ? "Android"
          : /Windows/.test(s)
            ? "Windows"
            : /Mac OS X|Macintosh/.test(s)
              ? "macOS"
              : /CrOS/.test(s)
                ? "ChromeOS"
                : /Linux/.test(s)
                  ? "Linux"
                  : null;
    return os ? `${browser} on ${os}` : browser;
};

// ── Storage ──────────────────────────────────────────────────────────────────

// devices: [{ id, hash, name, ua, approvedAt, approvedBy, lastSeenAt, lastIp }]
// blocked: [{ ip, until, by }]
let state = { devices: [], blocked: [] };
let loaded = false;
const touched = new Map(); // device id → when its lastSeenAt was last written
const pending = new Map(); // id → a sign-in waiting for Allow / Deny
const failures = new Map(); // ip key → times of wrong passwords

const load = async () => {
    try {
        const v = await db.get(KEY);
        state = { devices: Array.isArray(v?.devices) ? v.devices : [], blocked: Array.isArray(v?.blocked) ? v.blocked : [] };
    } catch (err) {
        console.error(`[Owner] Could not load the approved devices: ${err.message}`);
    }
    loaded = true;
};
const ready = load();

// Every write is the whole list as it is in memory, one after another.
let writing = Promise.resolve();
const persist = () => {
    const snap = JSON.parse(JSON.stringify(state));
    writing = writing.then(() => db.set(KEY, snap)).catch((err) => console.error(`[Owner] Could not save the approved devices: ${err.message}`));
    return writing;
};

const forgotten = (d, t) => (d.lastSeenAt || d.approvedAt || 0) < t - FORGET_AFTER_MS;

/** Is the list in memory yet? (Until then the middleware answers 503, not 401.) */
const isLoaded = () => loaded;

/**
 * May the owner's account be used by this browser? `device` is its key
 * (deviceOf), `ip` where it is now. Stamps the device as used.
 */
const allowed = ({ ip, device }) => {
    if (fromEnvIp(ip)) return true;
    if (!device) return false;
    const h = sha256(device);
    const t = now();
    const d = state.devices.find((x) => x.hash === h);
    if (!d || forgotten(d, t)) return false;
    d.lastSeenAt = t;
    if (ip) d.lastIp = String(ip);
    if (lifecycle.isActive() && t - (touched.get(d.id) || 0) >= TOUCH_EVERY_MS) {
        touched.set(d.id, t);
        persist();
    }
    return true;
};

// ── Wrong passwords ──────────────────────────────────────────────────────────
// Counted per IP: a new device costs nothing, a new IP does.

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

const deviceField = (p) => ({ name: "Device", value: clip(p.name, 100), inline: true });
const ipField = (p) => ({ name: "IP", value: p.ip ? `\`${clip(p.ip, 60)}\`` : "unknown", inline: true });
const uaField = (p) => ({ name: "Browser", value: p.ua ? `\`${clip(p.ua, 300)}\`` : "unknown" });

// @everyone so the phone rings: someone with the right password is waiting.
const askMessage = (p) => ({
    content: "@everyone",
    embeds: [
        {
            title: "Owner sign-in from a new device",
            description:
                "The right username and password were entered on a device the owner account does not know. " +
                "**Allow** lets that browser in and remembers it; **Deny** turns it away, and its IP cannot ask again for 24 hours.",
            color: COLOR.pending,
            fields: [deviceField(p), ipField(p), { name: "Expires", value: `<t:${unix(p.expiresAt)}:R>`, inline: true }, uaField(p)],
            timestamp: new Date(p.createdAt).toISOString(),
        },
    ],
    components: [
        {
            type: 1,
            components: [
                { type: 2, style: 3, label: "Allow this device", custom_id: `${BUTTON}:allow:${p.id}` },
                { type: 2, style: 4, label: "Deny", custom_id: `${BUTTON}:deny:${p.id}` },
            ],
        },
    ],
    allowedMentions: { parse: ["everyone"] },
});

const doneMessage = (p) => {
    const title = { approved: "Owner sign-in allowed", denied: "Owner sign-in denied", expired: "Owner sign-in request expired" }[p.status];
    const by = p.decidedBy ? [{ name: p.status === "approved" ? "Allowed by" : "Denied by", value: `${clip(p.decidedBy, 100)} · <t:${unix(p.decidedAt)}:f>` }] : [];
    const description = {
        approved: `**${clip(p.name, 100)}** may now use the owner account.`,
        denied: p.ipKey ? `\`${p.ipKey}\` cannot ask again until <t:${unix(p.decidedAt + DENY_BLOCK_MS)}:f>.` : "Turned away.",
        expired: "Nobody answered within 10 minutes — the browser has to sign in again.",
    }[p.status];
    return {
        embeds: [{ title, description, color: COLOR[p.status], fields: [deviceField(p), ipField(p), ...by, uaField(p)], timestamp: new Date(p.createdAt).toISOString() }],
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

const waitView = (p, key) => ({ id: p.id, key, name: p.name, ip: p.ip, expiresAt: p.expiresAt });

/**
 * A right password on a device not on the list: post Allow / Deny on Discord.
 * Returns { id, key, name, ip, expiresAt } — the browser polls with id + key
 * (poll()); only that browser can collect the sign-in. Signing in again on
 * the same device joins the request already open instead of posting another.
 */
const requestApproval = async ({ ip, ua, device }) => {
    if (!device) throw httpError(400, "This browser has no device key — allow cookies for the panel and sign in again");
    const key = ipKey(ip);
    const t = now();
    const block = key && state.blocked.find((b) => b.ip === key && b.until > t);
    if (block) {
        const hours = Math.max(1, Math.ceil((block.until - t) / 3_600_000));
        throw httpError(403, `Sign-ins from this IP were denied on Discord — try again in ${hours} hour${hours > 1 ? "s" : ""}`);
    }
    const h = sha256(device);
    const waiter = crypto.randomBytes(24).toString("base64url");
    const open = [...pending.values()].find((p) => p.deviceHash === h && isOpen(p, t));
    if (open) {
        if (open.waiters.size >= MAX_WAITERS) throw httpError(429, "Too many sign-ins on this device are already waiting for approval");
        open.waiters.set(waiter, false);
        return waitView(open, waiter);
    }
    if ([...pending.values()].filter((p) => isOpen(p, t)).length >= MAX_PENDING) {
        throw httpError(429, "Too many sign-ins are waiting for approval — try again later");
    }
    if (!lifecycle.isActive()) throw httpError(503, "The panel is not ready (starting or moving) — try again in a minute");

    const p = {
        id: crypto.randomBytes(9).toString("base64url"),
        deviceHash: h,
        name: deviceName(ua),
        ip: ip ? String(ip) : null,
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
        p.message = await discordBus.post(approvalChannel(), askMessage(p));
    } catch (err) {
        console.warn(`[Owner] Could not post the sign-in approval for ${p.name} (${p.ip}): ${err.message}`);
        throw httpError(
            503,
            `This device is not approved yet, and the approval could not be posted on Discord (${err.message}). ` +
                "To get in anyway, add your IP to ADMIN_ALLOWED_IPS in the panel's .env and restart the panel.",
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
 * "approved" is answered once per key, and only to the device that asked
 * (`device`, its cookie) — the route signs that browser in.
 */
const poll = (id, key, device) => {
    const p = pending.get(String(id || ""));
    const k = String(key || "");
    if (!p || !p.waiters.has(k)) return { status: "expired" };
    if (p.status === "pending" && p.expiresAt <= now()) expire(p);
    if (p.status === "approved") {
        if (p.waiters.get(k) || !device || sha256(device) !== p.deviceHash) return { status: "expired" };
        p.waiters.set(k, true);
        return { status: "approved", ip: p.ip, name: p.name, decidedBy: p.decidedBy };
    }
    return { status: p.status, expiresAt: p.expiresAt };
};

/** Allow / Deny from Discord. Returns the request, or null when it is no longer open. */
const decide = (id, action, by) => {
    const p = pending.get(String(id || ""));
    const t = now();
    if (!p || !isOpen(p, t)) return null;
    if (action === "allow") {
        const d = { id: crypto.randomBytes(6).toString("hex"), hash: p.deviceHash, name: p.name, ua: p.ua, approvedAt: t, approvedBy: by, lastSeenAt: t, lastIp: p.ip };
        state.devices = [...state.devices.filter((x) => x.hash !== p.deviceHash), d];
        if (p.ipKey) state.blocked = state.blocked.filter((b) => b.ip !== p.ipKey);
        p.status = "approved";
        touched.set(d.id, t);
    } else {
        if (p.ipKey) state.blocked = [...state.blocked.filter((b) => b.ip !== p.ipKey), { ip: p.ipKey, until: t + DENY_BLOCK_MS, by }];
        p.status = "denied";
    }
    p.decidedBy = by;
    p.decidedAt = t;
    persist();
    const what = p.status === "approved" ? "allowed" : "denied (its IP waits 24 hours)";
    panelLog.add("owner", `Owner device **${clip(p.name, 100)}** ${what} on Discord by ${by} · IP ${p.ip || "unknown"}`);
    console.log(`[Owner] ${p.name} (${p.ip}) ${p.status} by ${by}`);
    return p;
};

discordBus.onButton(BUTTON, async (i, [action, id]) => {
    const by = i.user?.tag || i.user?.username || i.user?.id || "someone";
    const p = decide(id, action === "allow" ? "allow" : "deny", by);
    await i.update(p ? doneMessage(p) : closedMessage(i.message));
});

// ── The page (Panel Settings → Security) ─────────────────────────────────────

/** Everything the page shows; `ip` and `device` are the caller's own. */
const list = ({ ip, device }) => {
    const t = now();
    const mine = device ? sha256(device) : null;
    const cur = ipKey(ip);
    return {
        currentIp: ip || null,
        devices: state.devices
            .filter((d) => !forgotten(d, t))
            .map(({ hash, ...d }) => ({ ...d, forgetAt: (d.lastSeenAt || d.approvedAt) + FORGET_AFTER_MS, current: hash === mine }))
            .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0)),
        env: envIps().map((x) => ({ ip: x, current: x === cur })),
        blocked: state.blocked.filter((b) => b.until > t),
        pending: [...pending.values()]
            .filter((p) => isOpen(p, t))
            .map((p) => ({ id: p.id, name: p.name, ip: p.ip, ua: p.ua, createdAt: p.createdAt, expiresAt: p.expiresAt })),
        limits: { forgetDays: FORGET_AFTER_MS / 86_400_000, denyHours: DENY_BLOCK_MS / 3_600_000, waitMinutes: PENDING_TTL_MS / 60_000, failLimit: FAIL_LIMIT },
    };
};

/** Can approvals be posted (and ping @everyone) right now? { ok, channel, guild, botTag, error } */
const approvals = () => discordBus.canPost(approvalChannel(), ["MentionEveryone"]);

/** The owner account stops working on that device. */
const remove = (id) => {
    const d = state.devices.find((x) => x.id === String(id || ""));
    if (!d) throw httpError(404, "This device is not on the list");
    state.devices = state.devices.filter((x) => x !== d);
    touched.delete(d.id);
    persist();
    panelLog.add("owner", `Owner device **${clip(d.name, 100)}** removed on the panel`);
};

const unblock = (ip) => {
    const key = ipKey(ip);
    if (!state.blocked.some((b) => b.ip === key)) throw httpError(404, "This IP is not blocked");
    state.blocked = state.blocked.filter((b) => b.ip !== key);
    persist();
    panelLog.add("owner", `Owner sign-ins from \`${key}\` unblocked on the panel`);
};

// ── Housekeeping ─────────────────────────────────────────────────────────────

const sweep = () => {
    const t = now();
    for (const p of pending.values()) {
        if (p.status === "pending" && p.expiresAt <= t) expire(p);
        // Decided ones stay a while, so the waiting browser still hears the answer.
        else if (p.status !== "pending" && p.decidedAt < t - PENDING_TTL_MS) pending.delete(p.id);
    }
    const gone = state.devices.filter((d) => forgotten(d, t));
    const ended = state.blocked.filter((b) => b.until <= t);
    if (gone.length || ended.length) {
        state.devices = state.devices.filter((d) => !forgotten(d, t));
        state.blocked = state.blocked.filter((b) => b.until > t);
        persist();
        for (const d of gone) panelLog.add("owner", `Owner device **${clip(d.name, 100)}** forgotten — not used for ${FORGET_AFTER_MS / 86_400_000} days`);
    }
    for (const [k, times] of failures) if (!times.some((x) => x > t - FAIL_WINDOW_MS)) failures.delete(k);
};

const start = () => {
    setInterval(lifecycle.guard(() => sweep()), SWEEP_EVERY_MS);
    console.log(`[Owner] Owner sign-in by device: ${state.devices.length} approved, ${envIps().length} IP(s) in ADMIN_ALLOWED_IPS`);
};

module.exports = {
    ipKey,
    deviceOf,
    ensureDevice,
    deviceName,
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
    COOKIE,
    // for tests
    _ready: ready,
    _sweep: sweep,
};
