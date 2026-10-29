// The Messages page's message, between three shapes:
//   editor   what the editor holds — buttons as rows of { label, url, emoji
//            (text) }, colours as numbers, times as ISO strings
//   API      what Discord takes and what the bot sends back (also Discohook's JSON)
// Both carry `images`: pictures attached by link, [{ url, name }] — the panel's
// own field, not Discord's: the picture is downloaded and sent as a file
// (server/services/imageLinks.js), so plain content can show one.
// The server (services/botMessages.js) checks and normalises whatever it gets,
// so these only have to be faithful, not strict.

export const LIMITS = { content: 2000, embeds: 10, embedTotal: 6000, title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, rows: 5, buttons: 5, label: 80, files: 10 };

export const emptyDraft = () => ({ content: "", embeds: [], components: [], images: [] });

/** The same rule as the server: what attachment:// can name (ASCII letters, digits, _ - .). */
export const fileName = (name, i) => {
    const s = String(name || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .replace(/[^\w.-]+/g, "_")
        .replace(/^[._]+/, "")
        .slice(-100);
    return s || `file-${i + 1}`;
};
export const isImage = (name, type) => (type ? type.startsWith("image/") : /\.(png|jpe?g|gif|webp|avif)$/i.test(name || ""));

/** A link's picture → its file name (the server's rule: .png when it has no picture extension), not one of `taken`. */
export const imageName = (url, taken = new Set()) => {
    let last = "";
    try {
        last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
    } catch {
        /* the name is cosmetic */
    }
    let name = fileName(last || "image", 0);
    if (!isImage(name)) name = `${name}.png`;
    for (let n = 2; taken.has(name); n++) name = fileName(last || "image", 0).replace(/(\.[^.]*)?$/, (ext) => `-${n}${isImage(`x${ext}`) ? ext : ".png"}`);
    return name;
};

const imagesOf = (list) => (Array.isArray(list) ? list.filter((x) => x?.url).map((x) => ({ url: String(x.url), name: x.name || imageName(x.url) })) : []);

/** A message's picture files (Discord's attachments) → image links, for a copy of it. Discord's file links last about a day. */
export const picturesOf = (attachments) => (attachments || []).filter((a) => a?.url && isImage(a.filename, a.contentType)).map((a, i) => ({ url: a.url, name: fileName(a.filename, i) }));
export const emptyEmbed = () => ({ description: "", color: 0x9f92ff, fields: [] });

/** { id, name, animated } → "<:name:id>" / "😀" for the emoji box. */
export const emojiText = (e) => {
    if (!e) return "";
    if (typeof e === "string") return e;
    if (e.id) return `<${e.animated ? "a" : ""}:${e.name || "emoji"}:${e.id}>`;
    return e.name || "";
};

/** The editor's emoji text → Discord's emoji object (for the preview and the JSON). */
export const emojiObject = (s) => {
    const t = String(s || "").trim();
    if (!t) return undefined;
    const m = /^<(a?):([\w~]{1,32}):(\d{17,20})>$/.exec(t) || /^()([\w~]{1,32}):(\d{17,20})$/.exec(t);
    if (m) return { id: m[3], name: m[2], ...(m[1] ? { animated: true } : {}) };
    if (/^\d{17,20}$/.test(t)) return { id: t };
    return { name: t };
};

const pick = (o, keys) => {
    const out = {};
    for (const k of keys) if (o?.[k] != null && o[k] !== "") out[k] = o[k];
    return out;
};

/** A link-preview embed Discord made from a URL in the text is not part of the message. */
const isRich = (e) => !e?.type || e.type === "rich";

const embedToEditor = (e) => ({
    ...pick(e, ["title", "description", "url", "color", "timestamp"]),
    color: typeof e.color === "number" ? e.color : e.color ? parseInt(String(e.color).replace("#", ""), 16) || null : null,
    author: e.author ? pick(e.author, ["name", "url", "icon_url"]) : undefined,
    footer: e.footer ? pick(e.footer, ["text", "icon_url"]) : undefined,
    image: e.image?.url ? { url: e.image.url } : typeof e.image === "string" ? { url: e.image } : undefined,
    thumbnail: e.thumbnail?.url ? { url: e.thumbnail.url } : typeof e.thumbnail === "string" ? { url: e.thumbnail } : undefined,
    fields: (e.fields || []).map((f) => ({ name: f.name || "", value: f.value || "", inline: !!f.inline })),
});

/** Is every component a link button? (Anything else runs the bot's own features.) */
export const onlyLinkButtons = (rows) =>
    (rows || []).every((row) => (row?.components || row || []).every((c) => (c.type == null || c.type === 2) && (c.style === 5 || c.style == null) && !c.custom_id && c.url));

const rowsToEditor = (rows) =>
    (rows || [])
        .map((row) => (Array.isArray(row) ? row : row?.components || []))
        .map((items) => items.map((b) => ({ label: b.label || "", url: b.url || "", emoji: emojiText(b.emoji) })))
        .filter((r) => r.length);

/** API message (Discord, the bot, Discohook) → the editor's draft. */
export const toEditor = (msg = {}) => ({
    content: msg.content || "",
    embeds: (msg.embeds || []).filter(isRich).map(embedToEditor),
    components: msg.components === null ? null : rowsToEditor(msg.components),
    images: imagesOf(msg.images),
});

/** The editor's draft → API message (the JSON view, the preview). */
export const toApi = (d = {}) => {
    const out = {};
    if (d.content) out.content = d.content;
    out.embeds = (d.embeds || []).map((e) => {
        const x = pick(e, ["title", "description", "url", "color", "timestamp"]);
        if (e.author?.name) x.author = pick(e.author, ["name", "url", "icon_url"]);
        if (e.footer?.text) x.footer = pick(e.footer, ["text", "icon_url"]);
        if (e.image?.url) x.image = { url: e.image.url };
        if (e.thumbnail?.url) x.thumbnail = { url: e.thumbnail.url };
        const fields = (e.fields || []).filter((f) => f.name || f.value);
        if (fields.length) x.fields = fields.map((f) => ({ name: f.name, value: f.value, inline: !!f.inline }));
        return x;
    });
    if (d.components === null) out.components = null;
    else
        out.components = (d.components || [])
            .filter((r) => r.length)
            .map((r) => ({
                type: 1,
                components: r.map((b) => ({ type: 2, style: 5, ...(b.label ? { label: b.label } : {}), url: b.url, ...(b.emoji ? { emoji: emojiObject(b.emoji) } : {}) })),
            }));
    const images = imagesOf(d.images);
    if (images.length) out.images = images;
    return out;
};

/**
 * Pasted JSON → API message. Takes a plain message ({ content, embeds, components }),
 * Discohook's backup ({ messages: [{ data }] }) or share data, a bare embed or a list of embeds.
 */
export const fromJson = (text) => {
    const v = JSON.parse(text);
    const m = v?.messages?.[0]?.data || v?.data || v;
    if (Array.isArray(m)) return { embeds: m };
    if (m && typeof m === "object" && !("content" in m) && !("embeds" in m) && !("components" in m) && (m.title || m.description || m.fields)) return { embeds: [m] };
    if (!m || typeof m !== "object" || !("content" in m || "embeds" in m || "components" in m || "images" in m)) throw new Error("No message in this JSON (expected content / embeds)");
    return { content: m.content || "", embeds: m.embeds || [], components: m.components || [], images: imagesOf(m.images) };
};

export const embedChars = (e) =>
    (e.title?.length || 0) + (e.description?.length || 0) + (e.author?.name?.length || 0) + (e.footer?.text?.length || 0) + (e.fields || []).reduce((n, f) => n + (f.name?.length || 0) + (f.value?.length || 0), 0);

/** Nothing Discord would post: no content, embed or picture (buttons alone are not a message). */
export const isEmptyDraft = (d) => !String(d?.content || "").trim() && !(d?.embeds || []).length && !(d?.images || []).length;

/** What the content pings (embeds never ping). */
export const pingsOf = (content = "") => ({
    everyone: /@everyone/.test(content),
    here: /@here/.test(content),
    roles: [...new Set([...String(content).matchAll(/<@&(\d{17,20})>/g)].map((m) => m[1]))],
    users: [...new Set([...String(content).matchAll(/<@!?(\d{17,20})>/g)].map((m) => m[1]))],
});

export const hex = (n) => (typeof n === "number" ? `#${n.toString(16).padStart(6, "0")}` : "");
export const fromHex = (s) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(s || "").trim());
    return m ? parseInt(m[1], 16) : null;
};

/** A short line for lists: the content, or the first embed's title / description. */
export const snippet = (msg, n = 90) => {
    const e = msg?.embeds?.[0];
    const s = String(msg?.content || e?.title || e?.description || e?.author?.name || "").replace(/\s+/g, " ").trim();
    return s.length > n ? `${s.slice(0, n)}…` : s || (!e && msg?.images?.length ? "(image)" : "(embed)");
};
