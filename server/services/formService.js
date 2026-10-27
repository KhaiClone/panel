const crypto = require("crypto");
const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");

// ─────────────────────────────────────────────────────────────────────────────
//  Forms — what /form on ArnTo-assistant posts in a ticket:
//
//    1. a message (text + a note beside an "open" button), and optionally a
//       reminder the shop's own account (ArnTo-SelfBot) sends right after;
//    2. the Discord modal the button opens — up to 5 text inputs;
//    3. once sent, a card only the viewer roles can open. What the customer
//       typed stays in the bot (never on the panel) and the bot deletes it
//       `retentionDays` after it was sent.
//
//  Managed on the Forms page. The bot reads it from /api/external/forms (cached,
//  with its last copy as a fallback) and is told to re-read it after a change
//  made here (bus "form.refresh"). The bot seeds it once from its old built-in
//  forms (importFrom); the project that did is the owner — the only one whose
//  key may read it.
//
//  Storage: one JSON document in data/shared.sqlite (kv "__forms").
// ─────────────────────────────────────────────────────────────────────────────

const KV = "__forms";
const REFRESH = "form.refresh";
const MAX_FORMS = 25; // /form's autocomplete lists 25 choices
const MAX_FIELDS = 5; // a Discord modal takes 5 inputs
// The bot sends "$rq <base64url of the text>" and deletes it; the selfbot decodes
// and sends the text. 1400 bytes → ~1870 characters, under Discord's 2000.
const SELFBOT_BYTES = 1400;
const KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SNOWFLAKE = /^\d{17,20}$/;
// Same as ticketMenuService.
const CUSTOM_EMOJI = /^<a?:[A-Za-z0-9_~]{2,32}:\d{17,20}>$/;
const UNICODE_EMOJI = /^(?=.*[^\x00-\x7f])[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣]{1,16}$/u;

// What the bot fills in (ArnTo-assistant functions/formConfig.js).
const VARS = {
    message: ["{days}", "{form}"],
    done: ["{staff}", "{user}", "{form}", "{days}"],
};

// The bot's texts, as they were before the page — used when one is left empty.
const DEFAULT_SETTINGS = {
    defaultKey: "",
    viewerRoles: [],
    retentionDays: 7,
    savedText: "# ✅ Thông Tin Tài Khoản Đã Được Lưu",
    viewLabel: "Xem Thông Tin",
    viewEmoji: "👀",
    doneText: "{staff} Đã điền form xong!",
};
const DEFAULT_FORM = { modalTitle: "📝 Thông Tin Mật", buttonLabel: "Mở Form", buttonEmoji: "📝" };

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ── Storage ──────────────────────────────────────────────────────────────────

const empty = () => ({ owner: null, imported: false, forms: [], settings: { ...DEFAULT_SETTINGS }, updatedAt: null });

const load = () => {
    const r = sharedStore.raw().prepare("SELECT value FROM kv WHERE name = ?").get(KV);
    const doc = r?.value ? JSON.parse(r.value) : {};
    return { ...empty(), ...doc, settings: { ...DEFAULT_SETTINGS, ...(doc.settings || {}) } };
};

const store = (doc) => {
    doc.updatedAt = Date.now();
    sharedStore.raw().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(KV, JSON.stringify(doc));
    return doc;
};

/** The bot re-reads its forms — only for a change it did not make itself. */
const tellBot = (doc) => {
    try {
        if (doc.owner && discordBus.canHandle(doc.owner, REFRESH)) {
            Promise.resolve(discordBus.notify(doc.owner, REFRESH, { updatedAt: doc.updatedAt })).catch(() => {});
        }
    } catch {
        /* the bot's cache expires on its own */
    }
};

/** load → fn(doc) → save; `notify: false` when the bot made the change. */
const mutate = (fn, { notify = true } = {}) => {
    const doc = load();
    const out = fn(doc);
    store(doc);
    if (notify) tellBot(doc);
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

const keyOf = (v, what = "The key") => {
    const k = str(v, 64).toLowerCase();
    if (!KEY.test(k)) throw httpError(400, `${what} may only use a-z, 0-9, - and _ (up to 32 characters)`);
    return k;
};

const selfbotOf = (v) => {
    const s = String(v ?? "").trim();
    if (Buffer.byteLength(s, "utf8") > SELFBOT_BYTES) {
        throw httpError(400, `The selfbot reminder is too long — at most ${SELFBOT_BYTES} bytes (about ${Math.floor(SELFBOT_BYTES / 1.5)} Vietnamese characters)`);
    }
    return s;
};

/** Lenient twin for imported data: a bad value is dropped, not refused. */
const soft = (fn, fallback = "") => {
    try {
        return fn();
    } catch {
        return fallback;
    }
};

const findForm = (doc, key) => {
    const f = doc.forms.find((x) => x.key === String(key || "").toLowerCase());
    if (!f) throw httpError(404, `No form "${key}"`);
    return f;
};

const move = (arr, from, to) => {
    const i = Math.max(0, Math.min(arr.length - 1, Math.round(Number(to)) || 0));
    const [x] = arr.splice(from, 1);
    arr.splice(i, 0, x);
};

/**
 * The modal's inputs. A field keeps its id (the modal input's custom id) across
 * edits, so a form opened before a change still lands on the right label.
 */
const fieldsOf = (list) => {
    if (!Array.isArray(list) || !list.length) throw httpError(400, "A form needs at least one field");
    if (list.length > MAX_FIELDS) throw httpError(400, `A Discord form takes at most ${MAX_FIELDS} fields`);
    const seen = new Set();
    return list.map((f, i) => {
        const label = str(f?.label, 45);
        if (!label) throw httpError(400, `Field ${i + 1} needs a label`);
        const id = f?.id ? keyOf(f.id, `Field ${i + 1}'s id`) : crypto.randomBytes(4).toString("hex");
        if (seen.has(id)) throw httpError(400, `Two fields use the id "${id}"`);
        seen.add(id);
        return {
            id,
            label,
            description: str(f.description, 100),
            placeholder: str(f.placeholder, 100),
            style: f.style === "paragraph" ? "paragraph" : "short",
            required: f.required !== false,
        };
    });
};

const formFields = (input, current = {}) => {
    const has = (k) => input[k] !== undefined;
    const name = has("name") ? str(input.name, 100) : current.name;
    if (!name) throw httpError(400, "The form needs a name");
    const out = {
        name,
        enabled: has("enabled") ? !!input.enabled : current.enabled ?? true,
        message: has("message") ? text(input.message, 2500, "The message") : current.message || "",
        note: has("note") ? text(input.note, 1000, "The note beside the button") : current.note || "",
        buttonLabel: has("buttonLabel") ? str(input.buttonLabel, 80) || DEFAULT_FORM.buttonLabel : current.buttonLabel || DEFAULT_FORM.buttonLabel,
        buttonEmoji: has("buttonEmoji") ? emojiOf(input.buttonEmoji, "The button's emoji") : current.buttonEmoji ?? DEFAULT_FORM.buttonEmoji,
        modalTitle: has("modalTitle") ? str(input.modalTitle, 45) || DEFAULT_FORM.modalTitle : current.modalTitle || DEFAULT_FORM.modalTitle,
        fields: has("fields") ? fieldsOf(input.fields) : current.fields,
        selfbotText: has("selfbotText") ? selfbotOf(input.selfbotText) : current.selfbotText || "",
    };
    if (!out.message) throw httpError(400, "The form needs a message — what the customer reads in the ticket");
    if (!out.fields?.length) throw httpError(400, "A form needs at least one field");
    return out;
};

// ── Reading ──────────────────────────────────────────────────────────────────

const view = (doc = load()) => ({
    owner: doc.owner,
    imported: doc.imported,
    forms: doc.forms,
    settings: doc.settings,
    updatedAt: doc.updatedAt,
    limits: { forms: MAX_FORMS, fields: MAX_FIELDS, selfbotBytes: SELFBOT_BYTES },
    vars: VARS,
});

const get = () => view();

/** May this project's key read the forms? The first one to import owns them. */
const canAccess = (botId) => {
    const { owner } = load();
    return !owner || owner === botId;
};

// ── Forms ────────────────────────────────────────────────────────────────────

const createForm = (input = {}, opts) =>
    mutate((doc) => {
        const key = keyOf(input.key);
        if (doc.forms.some((f) => f.key === key)) throw httpError(409, `A form already uses the key "${key}"`);
        if (doc.forms.length >= MAX_FORMS) throw httpError(409, `/form lists at most ${MAX_FORMS} forms`);
        const form = { key, ...formFields(input) };
        doc.forms.push(form);
        if (!doc.settings.defaultKey) doc.settings.defaultKey = key;
        return form;
    }, opts);

const updateForm = (key, input = {}, opts) =>
    mutate((doc) => {
        const f = findForm(doc, key);
        Object.assign(f, formFields(input, f));
        return f;
    }, opts);

/** Answers already sent keep their labels — the bot stored them with the answers. */
const deleteForm = (key, opts) =>
    mutate((doc) => {
        const f = findForm(doc, key);
        doc.forms = doc.forms.filter((x) => x !== f);
        if (doc.settings.defaultKey === f.key) doc.settings.defaultKey = doc.forms[0]?.key || "";
    }, opts);

const moveForm = (key, position, opts) =>
    mutate((doc) => {
        move(doc.forms, doc.forms.indexOf(findForm(doc, key)), position);
    }, opts);

// ── Settings ─────────────────────────────────────────────────────────────────

const updateSettings = (input = {}, opts) =>
    mutate((doc) => {
        const has = (k) => input[k] !== undefined;
        const s = doc.settings;
        if (has("defaultKey")) {
            const k = str(input.defaultKey, 32).toLowerCase();
            if (k) findForm(doc, k);
            s.defaultKey = k;
        }
        if (has("viewerRoles")) {
            const list = Array.isArray(input.viewerRoles) ? input.viewerRoles : String(input.viewerRoles || "").split(/[\s,]+/);
            const roles = [...new Set(list.map((r) => str(r, 20)).filter(Boolean))];
            for (const r of roles) if (!SNOWFLAKE.test(r)) throw httpError(400, `"${r}" is not a role ID`);
            if (!roles.length) throw httpError(400, "At least one role must be able to read the answers");
            s.viewerRoles = roles;
        }
        if (has("retentionDays")) {
            const days = Number(input.retentionDays);
            if (!Number.isInteger(days) || days < 1 || days > 90) throw httpError(400, "Keep the answers for 1 to 90 days");
            s.retentionDays = days;
        }
        if (has("savedText")) s.savedText = text(input.savedText, 1000, "The saved card's text") || DEFAULT_SETTINGS.savedText;
        if (has("viewLabel")) s.viewLabel = str(input.viewLabel, 80) || DEFAULT_SETTINGS.viewLabel;
        if (has("viewEmoji")) s.viewEmoji = emojiOf(input.viewEmoji, "The view button's emoji");
        if (has("doneText")) s.doneText = text(input.doneText, 1000, "The ping after sending") || DEFAULT_SETTINGS.doneText;
    }, opts);

// ── Seeding from the bot's old built-in forms ────────────────────────────────

/**
 * Once: the bot's built-in forms and its settings (viewer role, retention,
 * texts). Forms already made on the page are kept; the caller becomes the owner.
 * → { imported: bool, forms } (count added)
 */
const importFrom = (owner, { forms = [], settings = {} } = {}) =>
    mutate(
        (doc) => {
            if (doc.imported) return { imported: false, forms: 0 };
            if (!doc.owner) doc.owner = owner || null;
            let added = 0;
            for (const f of Array.isArray(forms) ? forms : []) {
                const key = soft(() => keyOf(f.key), "");
                if (!key || doc.forms.some((x) => x.key === key) || doc.forms.length >= MAX_FORMS) continue;
                const fields = soft(() => fieldsOf(f.fields), []);
                const message = str(f.message, 2500);
                if (!fields.length || !message) continue;
                doc.forms.push({
                    key,
                    name: str(f.name, 100) || key,
                    enabled: f.enabled !== false,
                    message,
                    note: str(f.note, 1000),
                    buttonLabel: str(f.buttonLabel, 80) || DEFAULT_FORM.buttonLabel,
                    buttonEmoji: soft(() => emojiOf(f.buttonEmoji, "")),
                    modalTitle: str(f.modalTitle, 45) || DEFAULT_FORM.modalTitle,
                    fields,
                    selfbotText: soft(() => selfbotOf(f.selfbotText)),
                });
                added++;
            }

            const s = doc.settings;
            const roles = (Array.isArray(settings.viewerRoles) ? settings.viewerRoles : []).map(String).filter((r) => SNOWFLAKE.test(r));
            if (!s.viewerRoles.length && roles.length) s.viewerRoles = [...new Set(roles)];
            const days = Number(settings.retentionDays);
            if (Number.isInteger(days) && days >= 1 && days <= 90) s.retentionDays = days;
            if (settings.savedText) s.savedText = str(settings.savedText, 1000);
            if (settings.viewLabel) s.viewLabel = str(settings.viewLabel, 80);
            if (settings.viewEmoji !== undefined) s.viewEmoji = soft(() => emojiOf(settings.viewEmoji, ""));
            if (settings.doneText) s.doneText = str(settings.doneText, 1000);
            const def = str(settings.defaultKey, 32).toLowerCase();
            if (doc.forms.some((f) => f.key === def)) s.defaultKey = def;
            else if (!s.defaultKey) s.defaultKey = doc.forms[0]?.key || "";

            doc.imported = true;
            return { imported: true, forms: added };
        },
        { notify: false },
    );

module.exports = {
    KV,
    REFRESH,
    MAX_FORMS,
    MAX_FIELDS,
    SELFBOT_BYTES,
    get,
    canAccess,
    createForm,
    updateForm,
    deleteForm,
    moveForm,
    updateSettings,
    importFrom,
};
