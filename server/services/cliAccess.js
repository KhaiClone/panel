const crypto = require("crypto");
const db = require("../db");
const lifecycle = require("./lifecycle");
const panelLog = require("./panelLog");
const discordBus = require("./discordBus");
const ownerAccess = require("./ownerAccess");

// ─────────────────────────────────────────────────────────────────────────────
//  CLI access keys — the owner's access for a command-line client
//  (scripts/panel-cli.js), without a browser, a password or an SSH key.
//
//  Why: Claude Code works on the panel's repos from more than one machine,
//  and the SSH keys for the VPSes live on only one of them. The owner's own
//  sign-in cannot serve a script: it needs the password, and an approved
//  browser's cookie on every request (services/ownerAccess.js).
//
//  How a key comes to be (the user's choice, 2026-11-17: asked for and
//  allowed on Discord, no copy-paste):
//    1. the script makes a random key on its machine and sends only its
//       sha256, with a name for the machine;
//    2. the panel's bot posts the request (machine, IP, a short code) in the
//       approval channel, pinging @everyone, with Allow 7 / 30 / 90 days,
//       Allow with no expiry, and Deny;
//    3. the script prints the same code and polls; Allow stores the hash and
//       the script saves the key on its machine. The key itself never
//       crosses the network until it is used, and the panel keeps only its
//       hash (as with the owner's device keys).
//  Deny keeps the IP from asking again for DENY_BLOCK_MS. Anyone can ASK —
//  that is the price of no copy-paste (the user accepted it): requests are
//  limited per IP and in total, and "Accept new requests" on Panel Settings →
//  Security turns asking off altogether.
//
//  What a key may do: everything the owner may (the user's choice: always
//  full) — every owner route, bot logs, and a shell on every node through the
//  Terminal WebSocket — but no approved device is needed. middleware/auth.js
//  treats it as the owner with `cli` set; every write it makes and every
//  command it runs goes to the panel log, so the owner sees what was done.
//
//  A key ends when its time runs out (chosen with the Allow button), or when
//  it is revoked on the page. Keys live in panel.sqlite "cli_access", held
//  in memory like the owner's devices (the middleware asks on every request).
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "cli_access";
const PREFIX = "bpc_";
const CLI_KEY = /^bpc_[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const HASH = /^[0-9a-f]{64}$/;
const PENDING_TTL_MS = 10 * 60 * 1000;
const DENY_BLOCK_MS = 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 15 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;
const ASK_LIMIT = 3; // requests per IP …
const ASK_WINDOW_MS = 15 * 60 * 1000; // … in this long
const MAX_PENDING = 3; // open at once, from everyone
const DAY_MS = 86_400_000;
const DURATIONS = [7, 30, 90, 0]; // the Allow buttons; 0 = no expiry
const BUTTON = "cli-key";
const COLOR = { pending: 0xf0b232, approved: 0x57f287, denied: 0xed4245, expired: 0x80848e };
// The code read off the terminal and off Discord: no 0/O, 1/I/L.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const httpError = (status, message) => Object.assign(new Error(message), { status });
const now = () => Date.now();
const unix = (t) => Math.floor(t / 1000);
const clip = (s, n) => String(s || "").replace(/[`\r\n]/g, " ").trim().slice(0, n);
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const daysText = (d) => (d ? `${d} days` : "no expiry");

// ── Storage ──────────────────────────────────────────────────────────────────

// keys:    [{ id, hash, name, askedIp, approvedAt, approvedBy, expiresAt|null, lastUsedAt, lastIp }]
// blocked: [{ ip, until, by }]
// accepting: may new keys be asked for at all
let state = { keys: [], blocked: [], accepting: true };
let loaded = false;
const touched = new Map(); // key id → when its lastUsedAt was last written
const pending = new Map(); // id → a request waiting for Allow / Deny
const asks = new Map(); // ip key → times of requests

const load = async () => {
    try {
        const v = await db.get(KEY);
        state = {
            keys: Array.isArray(v?.keys) ? v.keys : [],
            blocked: Array.isArray(v?.blocked) ? v.blocked : [],
            accepting: v?.accepting !== false,
        };
    } catch (err) {
        console.error(`[CLI] Could not load the CLI keys: ${err.message}`);
    }
    loaded = true;
};
const ready = load();

let writing = Promise.resolve();
const persist = () => {
    const snap = JSON.parse(JSON.stringify(state));
    writing = writing.then(() => db.set(KEY, snap)).catch((err) => console.error(`[CLI] Could not save the CLI keys: ${err.message}`));
    return writing;
};

const isLoaded = () => loaded;
const expired = (k, t = now()) => k.expiresAt != null && k.expiresAt <= t;

// ── Using a key ──────────────────────────────────────────────────────────────

/** Does this token look like a CLI key (and not a JWT)? */
const isKey = (token) => typeof token === "string" && token.startsWith(PREFIX);

/** The live key record for `token`, or null (unknown, revoked or expired). */
const verify = (token) => {
    if (!CLI_KEY.test(String(token || ""))) return null;
    const h = sha256(token);
    const k = state.keys.find((x) => x.hash === h);
    return k && !expired(k) ? k : null;
};

/** Stamp a key as used from `ip`. A new IP goes to the panel log. */
const used = (id, ip) => {
    const k = state.keys.find((x) => x.id === id);
    if (!k) return;
    const t = now();
    const first = !k.lastUsedAt;
    const moved = !first && ip && String(ip) !== k.lastIp;
    k.lastUsedAt = t;
    if (ip) k.lastIp = String(ip);
    if (first || moved) panelLog.add("owner", `CLI key **${clip(k.name, 80)}** used ${first ? "for the first time" : "from a new IP"} · IP ${ip || "unknown"}`);
    if (lifecycle.isActive() && (first || moved || t - (touched.get(k.id) || 0) >= TOUCH_EVERY_MS)) {
        touched.set(k.id, t);
        persist();
    }
};

// ── Discord messages ─────────────────────────────────────────────────────────

const fields = (p) => [
    { name: "Machine", value: clip(p.name, 100) || "unnamed", inline: true },
    { name: "IP", value: p.ip ? `\`${clip(p.ip, 60)}\`` : "unknown", inline: true },
    { name: "Code", value: `\`${p.code}\``, inline: true },
];

const askMessage = (p) => ({
    content: "@everyone",
    embeds: [
        {
            title: "CLI access key requested",
            description:
                "A command-line client (`scripts/panel-cli.js`) asks for a key with **full owner access**: every page, and a shell on every node. " +
                "Allow only if you started it yourself just now **and the code matches the one in your terminal**. " +
                `Deny turns it away, and its IP cannot ask again for 24 hours. This request expires <t:${unix(p.expiresAt)}:R>.`,
            color: COLOR.pending,
            fields: fields(p),
            timestamp: new Date(p.createdAt).toISOString(),
        },
    ],
    components: [
        {
            type: 1,
            components: [
                { type: 2, style: 3, label: "Allow 30 days", custom_id: `${BUTTON}:allow:${p.id}:30` },
                { type: 2, style: 2, label: "Allow 7 days", custom_id: `${BUTTON}:allow:${p.id}:7` },
                { type: 2, style: 2, label: "Allow 90 days", custom_id: `${BUTTON}:allow:${p.id}:90` },
                { type: 2, style: 2, label: "Allow, no expiry", custom_id: `${BUTTON}:allow:${p.id}:0` },
                { type: 2, style: 4, label: "Deny", custom_id: `${BUTTON}:deny:${p.id}` },
            ],
        },
    ],
    allowedMentions: { parse: ["everyone"] },
});

const doneMessage = (p) => {
    const title = { approved: "CLI access key allowed", denied: "CLI access key denied", expired: "CLI access key request expired" }[p.status];
    const by = p.decidedBy ? [{ name: p.status === "approved" ? "Allowed by" : "Denied by", value: `${clip(p.decidedBy, 100)} · <t:${unix(p.decidedAt)}:f>` }] : [];
    const description = {
        approved: `**${clip(p.name, 100)}** has a key with full owner access — ${p.keyExpiresAt ? `until <t:${unix(p.keyExpiresAt)}:f>` : "no expiry"}. Revoke it on Panel Settings → Security.`,
        denied: p.ipKey ? `\`${p.ipKey}\` cannot ask again until <t:${unix(p.decidedAt + DENY_BLOCK_MS)}:f>.` : "Turned away.",
        expired: "Nobody answered within 10 minutes — the client has to ask again.",
    }[p.status];
    return {
        embeds: [{ title, description, color: COLOR[p.status], fields: [...fields(p), ...by], timestamp: new Date(p.createdAt).toISOString() }],
        components: [],
    };
};

const closedMessage = (msg) => {
    const old = msg?.embeds?.[0]?.data || msg?.embeds?.[0] || {};
    return {
        embeds: [{ ...old, color: COLOR.expired, footer: { text: "No longer open (expired, or the panel restarted) — ask again from the client" } }],
        components: [],
    };
};

// ── Requests ─────────────────────────────────────────────────────────────────

const isOpen = (p, t = now()) => p.status === "pending" && p.expiresAt > t;

const newCode = () => {
    const b = crypto.randomBytes(6);
    const c = [...b].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join("");
    return `${c.slice(0, 3)}-${c.slice(3)}`;
};

/** Throws 429 once `ip` asked ASK_LIMIT times in the last ASK_WINDOW_MS; else counts this one. */
const countAsk = (ip) => {
    const key = ownerAccess.ipKey(ip) || String(ip);
    const t = now();
    const recent = (asks.get(key) || []).filter((x) => x > t - ASK_WINDOW_MS);
    if (recent.length >= ASK_LIMIT) {
        const mins = Math.max(1, Math.ceil((recent[0] + ASK_WINDOW_MS - t) / 60_000));
        throw httpError(429, `Too many key requests from this IP — try again in ${mins} minute${mins > 1 ? "s" : ""}`);
    }
    asks.set(key, [...recent, t]);
};

/**
 * POST /api/cli-access/login: a client asks for a key. `keyHash` is the
 * sha256 (hex) of the key it made and keeps. → { id, code, expiresAt }
 */
const requestKey = async ({ name, keyHash, ip }) => {
    if (!state.accepting) throw httpError(403, "New CLI key requests are turned off on this panel (Panel Settings → Security)");
    const hash = String(keyHash || "").toLowerCase();
    if (!HASH.test(hash)) throw httpError(400, "keyHash must be the sha256 (hex) of the key");
    const label = clip(name, 80);
    if (!label) throw httpError(400, "Give the machine a name");
    const key = ownerAccess.ipKey(ip);
    const t = now();
    const block = key && state.blocked.find((b) => b.ip === key && b.until > t);
    if (block) {
        const hours = Math.max(1, Math.ceil((block.until - t) / 3_600_000));
        throw httpError(403, `Key requests from this IP were denied on Discord — try again in ${hours} hour${hours > 1 ? "s" : ""}`);
    }
    if (state.keys.some((k) => k.hash === hash) || [...pending.values()].some((p) => p.keyHash === hash)) {
        throw httpError(409, "This key was already asked for — make a new one");
    }
    if ([...pending.values()].filter((p) => isOpen(p, t)).length >= MAX_PENDING) {
        throw httpError(429, "Too many key requests are waiting for approval — try again later");
    }
    if (!lifecycle.isActive()) throw httpError(503, "The panel is not ready (starting or moving) — try again in a minute");
    countAsk(ip);

    const p = {
        id: crypto.randomBytes(9).toString("base64url"),
        keyHash: hash,
        name: label,
        code: newCode(),
        ip: ip ? String(ip) : null,
        ipKey: key,
        createdAt: t,
        expiresAt: t + PENDING_TTL_MS,
        status: "pending",
        message: null,
        decidedBy: null,
        decidedAt: null,
        keyExpiresAt: null,
    };
    try {
        p.message = await discordBus.post(ownerAccess.approvalChannel(), askMessage(p));
    } catch (err) {
        console.warn(`[CLI] Could not post the key request for ${p.name} (${p.ip}): ${err.message}`);
        throw httpError(503, `The request could not be posted on Discord (${err.message})`);
    }
    pending.set(p.id, p);
    panelLog.add("owner", `CLI key requested for **${p.name}** · IP ${p.ip || "unknown"} · code \`${p.code}\` — Allow / Deny is on Discord`);
    return { id: p.id, code: p.code, expiresAt: p.expiresAt };
};

const expire = (p) => {
    p.status = "expired";
    p.decidedAt = now();
    if (p.message) discordBus.edit(p.message, doneMessage(p)).catch(() => {});
};

/**
 * What the waiting client learns: pending | approved | denied | expired.
 * It proves it is the one that asked with the same key hash. Nothing secret
 * comes back — the client already holds the key.
 */
const poll = (id, keyHash) => {
    const p = pending.get(String(id || ""));
    if (!p || p.keyHash !== String(keyHash || "").toLowerCase()) return { status: "expired" };
    if (p.status === "pending" && p.expiresAt <= now()) expire(p);
    if (p.status === "approved") return { status: "approved", name: p.name, expiresAt: p.keyExpiresAt, decidedBy: p.decidedBy };
    return { status: p.status, expiresAt: p.expiresAt };
};

/** Allow (for `days`, 0 = no expiry) / Deny from Discord. Returns the request, or null when it is no longer open. */
const decide = (id, action, by, days = 30) => {
    const p = pending.get(String(id || ""));
    const t = now();
    if (!p || !isOpen(p, t)) return null;
    if (action === "allow") {
        const d = DURATIONS.includes(Number(days)) ? Number(days) : 30;
        const k = {
            id: crypto.randomBytes(6).toString("hex"),
            hash: p.keyHash,
            name: p.name,
            askedIp: p.ip,
            approvedAt: t,
            approvedBy: by,
            expiresAt: d ? t + d * DAY_MS : null,
            lastUsedAt: null,
            lastIp: null,
        };
        state.keys = [...state.keys, k];
        if (p.ipKey) state.blocked = state.blocked.filter((b) => b.ip !== p.ipKey);
        p.status = "approved";
        p.keyExpiresAt = k.expiresAt;
        panelLog.add("owner", `CLI key for **${p.name}** allowed on Discord by ${by} · ${daysText(d)} · IP ${p.ip || "unknown"}`);
    } else {
        if (p.ipKey) state.blocked = [...state.blocked.filter((b) => b.ip !== p.ipKey), { ip: p.ipKey, until: t + DENY_BLOCK_MS, by }];
        p.status = "denied";
        panelLog.add("owner", `CLI key for **${p.name}** denied on Discord by ${by} (its IP waits 24 hours) · IP ${p.ip || "unknown"}`);
    }
    p.decidedBy = by;
    p.decidedAt = t;
    persist();
    console.log(`[CLI] Key for ${p.name} (${p.ip}) ${p.status} by ${by}`);
    return p;
};

discordBus.onButton(BUTTON, async (i, [action, id, days]) => {
    const by = i.user?.tag || i.user?.username || i.user?.id || "someone";
    const p = decide(id, action === "allow" ? "allow" : "deny", by, days);
    await i.update(p ? doneMessage(p) : closedMessage(i.message));
});

// ── The page (Panel Settings → Security) ─────────────────────────────────────

const list = () => {
    const t = now();
    return {
        accepting: state.accepting,
        keys: state.keys
            .filter((k) => !expired(k, t))
            .map(({ hash, ...k }) => k)
            .sort((a, b) => (b.lastUsedAt || b.approvedAt || 0) - (a.lastUsedAt || a.approvedAt || 0)),
        pending: [...pending.values()]
            .filter((p) => isOpen(p, t))
            .map((p) => ({ id: p.id, name: p.name, ip: p.ip, code: p.code, createdAt: p.createdAt, expiresAt: p.expiresAt })),
        blocked: state.blocked.filter((b) => b.until > t),
        limits: { waitMinutes: PENDING_TTL_MS / 60_000, denyHours: DENY_BLOCK_MS / 3_600_000, askLimit: ASK_LIMIT, askWindowMinutes: ASK_WINDOW_MS / 60_000 },
    };
};

/** The key stops working at once. */
const revoke = (id) => {
    const k = state.keys.find((x) => x.id === String(id || ""));
    if (!k) throw httpError(404, "This key is not on the list");
    state.keys = state.keys.filter((x) => x !== k);
    touched.delete(k.id);
    persist();
    panelLog.add("owner", `CLI key **${clip(k.name, 80)}** revoked on the panel`);
};

const unblock = (ip) => {
    const key = ownerAccess.ipKey(ip);
    if (!state.blocked.some((b) => b.ip === key)) throw httpError(404, "This IP is not blocked");
    state.blocked = state.blocked.filter((b) => b.ip !== key);
    persist();
    panelLog.add("owner", `CLI key requests from \`${key}\` unblocked on the panel`);
};

/** Turn asking for new keys on or off (keys already given keep working). */
const setAccepting = (on) => {
    state.accepting = !!on;
    persist();
    panelLog.add("owner", `CLI key requests turned **${state.accepting ? "on" : "off"}** on the panel`);
};

// ── Housekeeping ─────────────────────────────────────────────────────────────

const sweep = () => {
    const t = now();
    for (const p of pending.values()) {
        if (p.status === "pending" && p.expiresAt <= t) expire(p);
        // Decided ones stay a while, so the waiting client still hears the answer.
        else if (p.status !== "pending" && p.decidedAt < t - PENDING_TTL_MS) pending.delete(p.id);
    }
    const gone = state.keys.filter((k) => expired(k, t));
    const ended = state.blocked.filter((b) => b.until <= t);
    if (gone.length || ended.length) {
        state.keys = state.keys.filter((k) => !expired(k, t));
        state.blocked = state.blocked.filter((b) => b.until > t);
        persist();
        for (const k of gone) panelLog.add("owner", `CLI key **${clip(k.name, 80)}** expired`);
    }
    for (const [k, times] of asks) if (!times.some((x) => x > t - ASK_WINDOW_MS)) asks.delete(k);
};

const start = () => {
    setInterval(lifecycle.guard(() => sweep()), SWEEP_EVERY_MS);
    console.log(`[CLI] CLI access keys: ${state.keys.filter((k) => !expired(k)).length} live, requests ${state.accepting ? "on" : "off"}`);
};

module.exports = {
    isKey,
    verify,
    used,
    isLoaded,
    requestKey,
    poll,
    decide,
    list,
    revoke,
    unblock,
    setAccepting,
    start,
    DURATIONS,
    // for tests
    _ready: ready,
    _sweep: sweep,
};
