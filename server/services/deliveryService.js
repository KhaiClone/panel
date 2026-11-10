const crypto = require("crypto");
const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");

// ─────────────────────────────────────────────────────────────────────────────
//  Deliveries — goods a staff member hands over by hand with /giaotay on
//  ArnTo-assistant (a mail, a promo link, a gift link…): the staff member picks
//  the customer, a delivery type and types the goods; the bot DMs them.
//
//  A delivery type is everything the bot says for one kind of goods:
//
//    pledge     (types that need a confirmation) a DM with the rules and a
//               button; the goods are only sent once the customer presses it.
//               It becomes the "confirmed" text then.
//    goods      the DM that carries the goods — the typed text whole, or split
//               into named fields ("Gmail|Password" with ":" between them).
//    ticket     what the bot posts where the command ran: "check your DMs",
//               and, for a pledge, a line once the customer has confirmed.
//    blocked    the customer's DMs are closed: a notice in the ticket with a
//               "try again" button — the goods never appear in the ticket.
//    expired    replaces the pledge / the blocked notice when the delivery was
//               not received in time.
//
//  Rules are written once (the Rules tab) and ticked per type, so two kinds of
//  goods can share some rules and not others.
//
//  The panel only keeps this configuration. A delivery itself — the goods, who
//  it is for — stays in the bot and is deleted `keepDays` after the command
//  (the type's setting, copied onto the delivery when it is made). The bot
//  reads the configuration from /api/external/deliveries (cached, with its last
//  copy as a fallback) and is told to re-read it after a change made here (bus
//  "delivery.refresh"). The first project whose key reads it owns it.
//
//  Storage: one JSON document in data/shared.sqlite (kv "__deliveries").
// ─────────────────────────────────────────────────────────────────────────────

const KV = "__deliveries";
const REFRESH = "delivery.refresh";
const MAX_TYPES = 25; // /giaotay's autocomplete lists 25 choices
const MAX_RULES = 50;
const MAX_TYPE_RULES = 20;
const MAX_FIELDS = 10;
const MAX_ITEM = 1500; // what staff may type as the goods (the bot enforces it)
const MAX_IMAGE_URL = 2000; // Discord's embed URL limit is 2048
// Discord: an embed description takes 4096 characters, a message's text 2000.
// The filled-in variables (mentions, timestamps) need some of that.
const EMBED_TEXT = 3800;
const GOODS_TEXT = EMBED_TEXT - MAX_ITEM; // the goods may be written into it
const TICKET_TEXT = 1500;
const KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Same as ticketMenuService.
const CUSTOM_EMOJI = /^<a?:[A-Za-z0-9_~]{2,32}:\d{17,20}>$/;
const UNICODE_EMOJI = /^(?=.*[^\x00-\x7f])[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣]{1,16}$/u;

// What the bot fills in (ArnTo-assistant functions/handDelivery.js).
const COMMON = ["{user}", "{staff}", "{product}", "{expires}", "{expiresIn}"];
const VARS = {
    pledge: [...COMMON, "{rules}"],
    confirmed: [...COMMON, "{time}"],
    goods: [...COMMON, "{item}"],
    ticket: COMMON,
    blocked: COMMON,
    expired: COMMON,
};

// The texts a new type starts with — the admin rewrites them on the page.
const DEFAULT_TYPE = {
    confirm: true,
    keepDays: 7,
    separator: ":",
    codeBlock: true,
    pledgeText:
        "## 📦 Xác nhận nhận hàng: {product}\nTrước khi nhận hàng, bạn vui lòng đọc kỹ và đồng ý với các điều sau:\n\n{rules}\n\nBấm nút bên dưới để xác nhận và nhận hàng. Hạn xác nhận: {expires}.",
    pledgeButton: "Tôi đồng ý & nhận hàng",
    pledgeEmoji: "✅",
    confirmedText: "## ✅ Bạn đã xác nhận nhận hàng: {product}\nThời gian xác nhận: {time}",
    goodsTitle: "{product}",
    goodsText: "### Cảm ơn quý khách đã ủng hộ ArnTo Shop.",
    goodsImage: "",
    goodsFooter: "",
    ticketNotice: "{user}\n## Vui lòng kiểm tra tin nhắn riêng của bạn để nhận {product}.",
    ticketDone: "✅ {user} đã xác nhận và nhận {product}.",
    blockedText:
        "## :x: Không thể gửi tin nhắn riêng\nBot không gửi được {product} cho bạn do DMs bị chặn. Bạn mở DMs rồi bấm nút bên dưới để nhận lại nhé.",
    blockedImage: "",
    retryButton: "Thử lại",
    retryEmoji: "🔁",
    expiredText: "## ⌛ Đơn giao {product} đã hết hạn\nBạn vui lòng liên hệ shop để được giao lại.",
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ── Storage ──────────────────────────────────────────────────────────────────

const empty = () => ({ owner: null, types: [], rules: [], updatedAt: null });

const load = () => {
    const r = sharedStore.raw().prepare("SELECT value FROM kv WHERE name = ?").get(KV);
    return { ...empty(), ...(r?.value ? JSON.parse(r.value) : {}) };
};

const store = (doc) => {
    doc.updatedAt = Date.now();
    sharedStore.raw().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(KV, JSON.stringify(doc));
    return doc;
};

/** The bot re-reads its delivery types. */
const tellBot = (doc) => {
    try {
        if (doc.owner && discordBus.canHandle(doc.owner, REFRESH)) {
            Promise.resolve(discordBus.notify(doc.owner, REFRESH, { updatedAt: doc.updatedAt })).catch(() => {});
        }
    } catch {
        /* the bot's cache expires on its own */
    }
};

/** load → fn(doc) → save → tell the bot. */
const mutate = (fn) => {
    const doc = load();
    const out = fn(doc);
    store(doc);
    tellBot(doc);
    return out === undefined ? view(doc) : out;
};

// ── Validation ───────────────────────────────────────────────────────────────

const str = (v, max) => String(v ?? "").trim().slice(0, max);

/** Like str, but refuses instead of cutting — a long text silently cut is a broken message. */
const text = (v, max, what) => {
    const s = String(v ?? "").trim();
    if (s.length > max) throw httpError(400, `${what} is too long — at most ${max} characters`);
    return s;
};

const emojiOf = (v, what) => {
    const e = str(v, 64);
    if (!e || CUSTOM_EMOJI.test(e) || UNICODE_EMOJI.test(e)) return e;
    throw httpError(400, `${what}: "${e}" is not an emoji — use a Unicode emoji or a server emoji like <:name:123…>`);
};

const keyOf = (v) => {
    const k = str(v, 64).toLowerCase();
    if (!KEY.test(k)) throw httpError(400, "The key may only use a-z, 0-9, - and _ (up to 32 characters)");
    return k;
};

/** Discord refuses the whole message over a bad image URL, so it is checked here (like stockService). */
const imageOf = (v, what) => {
    const url = String(v ?? "").trim();
    if (!url) return "";
    if (url.length > MAX_IMAGE_URL) throw httpError(400, `${what} is too long`);
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw httpError(400, `${what} is not a valid link`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw httpError(400, `${what} must start with http:// or https://`);
    return url;
};

const findType = (doc, key) => {
    const t = doc.types.find((x) => x.key === String(key || "").toLowerCase());
    if (!t) throw httpError(404, `No delivery type "${key}"`);
    return t;
};

const findRule = (doc, id) => {
    const r = doc.rules.find((x) => x.id === String(id || ""));
    if (!r) throw httpError(404, "That rule no longer exists");
    return r;
};

const move = (arr, from, to) => {
    const i = Math.max(0, Math.min(arr.length - 1, Math.round(Number(to)) || 0));
    const [x] = arr.splice(from, 1);
    arr.splice(i, 0, x);
};

/** The rules as the bot writes them for {rules}: each rule's text, in the type's order, one per line. */
const rulesText = (doc, ids) =>
    ids
        .map((id) => doc.rules.find((r) => r.id === id)?.text)
        .filter(Boolean)
        .join("\n");

/** The pledge with its rules written in (appended when the text has no {rules}) — what must fit an embed. */
const pledgeWith = (pledgeText, rules) => {
    if (!rules) return pledgeText.replace(/\{rules\}/g, "").trim();
    return pledgeText.includes("{rules}") ? pledgeText.replace(/\{rules\}/g, rules) : `${pledgeText}\n\n${rules}`;
};

const checkPledge = (doc, t) => {
    if (!t.confirm) return;
    if (!t.pledgeText) throw httpError(400, "A type that needs a confirmation needs a confirmation message");
    if (pledgeWith(t.pledgeText, rulesText(doc, t.rules)).length > EMBED_TEXT) {
        throw httpError(400, `The confirmation message with its rules is too long — at most ${EMBED_TEXT} characters together`);
    }
};

const typeFields = (doc, input, current = {}) => {
    const has = (k) => input[k] !== undefined;
    const pick = (k, fn) => (has(k) ? fn(input[k]) : current[k] ?? DEFAULT_TYPE[k]);
    const name = has("name") ? str(input.name, 100) : current.name;
    if (!name) throw httpError(400, "The delivery type needs a name");

    let keepDays = current.keepDays ?? DEFAULT_TYPE.keepDays;
    if (has("keepDays")) {
        keepDays = Number(input.keepDays);
        if (!Number.isInteger(keepDays) || keepDays < 1 || keepDays > 90) throw httpError(400, "Keep a delivery for 1 to 90 days");
    }

    let fields = current.fields || [];
    if (has("fields")) {
        const list = (Array.isArray(input.fields) ? input.fields : String(input.fields || "").split("|")).map((f) => str(f, 64)).filter(Boolean);
        if (list.length > MAX_FIELDS) throw httpError(400, `At most ${MAX_FIELDS} fields`);
        fields = list;
    }

    let rules = current.rules || [];
    if (has("rules")) {
        rules = [...new Set((Array.isArray(input.rules) ? input.rules : []).map(String))];
        for (const id of rules) findRule(doc, id);
        if (rules.length > MAX_TYPE_RULES) throw httpError(400, `A type takes at most ${MAX_TYPE_RULES} rules`);
    }

    const out = {
        name,
        enabled: has("enabled") ? !!input.enabled : current.enabled ?? true,
        confirm: has("confirm") ? !!input.confirm : current.confirm ?? DEFAULT_TYPE.confirm,
        keepDays,
        fields,
        separator: has("separator") ? String(input.separator ?? "").slice(0, 5) || DEFAULT_TYPE.separator : current.separator || DEFAULT_TYPE.separator,
        codeBlock: has("codeBlock") ? !!input.codeBlock : current.codeBlock ?? DEFAULT_TYPE.codeBlock,
        rules,
        pledgeText: pick("pledgeText", (v) => text(v, EMBED_TEXT, "The confirmation message")),
        pledgeButton: pick("pledgeButton", (v) => str(v, 80) || DEFAULT_TYPE.pledgeButton),
        pledgeEmoji: pick("pledgeEmoji", (v) => emojiOf(v, "The confirm button's emoji")),
        confirmedText: pick("confirmedText", (v) => text(v, EMBED_TEXT, "The text after confirming") || DEFAULT_TYPE.confirmedText),
        goodsTitle: pick("goodsTitle", (v) => str(v, 200)),
        goodsText: pick("goodsText", (v) => text(v, GOODS_TEXT, "The goods message")),
        goodsImage: pick("goodsImage", (v) => imageOf(v, "The goods message's image URL")),
        goodsFooter: pick("goodsFooter", (v) => str(v, 500)),
        ticketNotice: pick("ticketNotice", (v) => text(v, TICKET_TEXT, "The ticket notice")),
        ticketDone: pick("ticketDone", (v) => text(v, TICKET_TEXT, "The ticket line after confirming")),
        blockedText: pick("blockedText", (v) => text(v, EMBED_TEXT, "The blocked-DMs notice") || DEFAULT_TYPE.blockedText),
        blockedImage: pick("blockedImage", (v) => imageOf(v, "The blocked-DMs notice's image URL")),
        retryButton: pick("retryButton", (v) => str(v, 80) || DEFAULT_TYPE.retryButton),
        retryEmoji: pick("retryEmoji", (v) => emojiOf(v, "The retry button's emoji")),
        expiredText: pick("expiredText", (v) => text(v, EMBED_TEXT, "The expired text") || DEFAULT_TYPE.expiredText),
    };
    checkPledge(doc, out);
    return out;
};

// ── Reading ──────────────────────────────────────────────────────────────────

const view = (doc = load()) => ({
    owner: doc.owner,
    types: doc.types,
    rules: doc.rules,
    updatedAt: doc.updatedAt,
    defaults: DEFAULT_TYPE,
    limits: { types: MAX_TYPES, rules: MAX_RULES, typeRules: MAX_TYPE_RULES, fields: MAX_FIELDS, item: MAX_ITEM, embedText: EMBED_TEXT, goodsText: GOODS_TEXT, ticketText: TICKET_TEXT },
    vars: VARS,
});

const get = () => view();

/** May this project's key read the delivery types? The first one to read them owns them. */
const canAccess = (botId) => {
    const { owner } = load();
    return !owner || owner === botId;
};

/**
 * The bot's read: the first project to ask becomes the owner (the one told to
 * re-read after a change, and the only key that may read from then on).
 */
const readFor = (botId) => {
    const doc = load();
    if (!doc.owner && botId) {
        doc.owner = botId;
        store(doc);
    }
    return view(doc);
};

// ── Delivery types ───────────────────────────────────────────────────────────

const createType = (input = {}) =>
    mutate((doc) => {
        const key = keyOf(input.key);
        if (doc.types.some((t) => t.key === key)) throw httpError(409, `A delivery type already uses the key "${key}"`);
        if (doc.types.length >= MAX_TYPES) throw httpError(409, `/giaotay lists at most ${MAX_TYPES} delivery types`);
        const type = { key, ...typeFields(doc, input) };
        doc.types.push(type);
        return type;
    });

const updateType = (key, input = {}) =>
    mutate((doc) => {
        const t = findType(doc, key);
        Object.assign(t, typeFields(doc, input, t));
        return t;
    });

/** Deliveries already made keep working — the bot copied the type onto each. */
const deleteType = (key) =>
    mutate((doc) => {
        const t = findType(doc, key);
        doc.types = doc.types.filter((x) => x !== t);
    });

const moveType = (key, position) =>
    mutate((doc) => {
        move(doc.types, doc.types.indexOf(findType(doc, key)), position);
    });

// ── Rules ────────────────────────────────────────────────────────────────────

const ruleFields = (input, current = {}) => {
    const has = (k) => input[k] !== undefined;
    const out = {
        name: has("name") ? str(input.name, 100) : current.name,
        text: has("text") ? text(input.text, 1000, "The rule") : current.text,
    };
    if (!out.text) throw httpError(400, "The rule needs its text — what the customer reads");
    if (!out.name) out.name = out.text.replace(/\s+/g, " ").slice(0, 60);
    return out;
};

const createRule = (input = {}) =>
    mutate((doc) => {
        if (doc.rules.length >= MAX_RULES) throw httpError(409, `At most ${MAX_RULES} rules`);
        const rule = { id: crypto.randomBytes(4).toString("hex"), ...ruleFields(input) };
        doc.rules.push(rule);
        return rule;
    });

/** A longer rule must still fit the confirmation message of every type that uses it. */
const updateRule = (id, input = {}) =>
    mutate((doc) => {
        const r = findRule(doc, id);
        Object.assign(r, ruleFields(input, r));
        for (const t of doc.types) {
            if (!t.rules.includes(r.id)) continue;
            try {
                checkPledge(doc, t);
            } catch {
                throw httpError(400, `With this text the confirmation message of "${t.name}" is too long — at most ${EMBED_TEXT} characters with its rules`);
            }
        }
        return r;
    });

/** The rule leaves every type that ticked it. */
const deleteRule = (id) =>
    mutate((doc) => {
        const r = findRule(doc, id);
        doc.rules = doc.rules.filter((x) => x !== r);
        for (const t of doc.types) t.rules = t.rules.filter((x) => x !== r.id);
    });

const moveRule = (id, position) =>
    mutate((doc) => {
        move(doc.rules, doc.rules.indexOf(findRule(doc, id)), position);
    });

module.exports = {
    KV,
    REFRESH,
    MAX_TYPES,
    MAX_ITEM,
    EMBED_TEXT,
    DEFAULT_TYPE,
    get,
    canAccess,
    readFor,
    createType,
    updateType,
    deleteType,
    moveType,
    createRule,
    updateRule,
    deleteRule,
    moveRule,
};
