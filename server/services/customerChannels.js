const { ChannelType, PermissionFlagsBits } = require("discord.js");
const db = require("../db");
const executor = require("./executor");
const discordBus = require("./discordBus");
const panelLog = require("./panelLog");
const { setEnvKey, envValue } = require("../utils/envText");

// ─────────────────────────────────────────────────────────────────────────────
//  Customer projects, phase 2 — a log channel and a backup channel in Kho for
//  each customer project, made by the panel's bot (user, 2026-11-13).
//
//  Projects post there with webhooks kept in their own .env, the way
//  template-discord-bot reads them (WEBHOOK_LOG / WEBHOOK_BACKUP; the key names
//  are per project, other bots may use their own). The webhook URL is a secret:
//  it is written to the project's .env and nowhere else — the panel keeps only
//  the channel and webhook ids, and never logs or returns the URL.
//
//  The channels are named after the project's base name (customer-bot-id) and
//  follow it in the daily sync (services/customerProjects.js), like the panel
//  name. Nothing here deletes a channel the owner did not just ask for: setting
//  up rolls back only what it created itself when a later step fails.
//
//  Discord limits: 50 channels per category (the owner lists more categories
//  per kind to go past it), 500 per server, and a channel can be renamed only
//  twice per 10 minutes — discord.js would wait that out, so a rename is never
//  awaited for more than a few seconds.
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS = "customer_channels_settings";
// The Kho categories the owner gave on 2026-11-13; changeable in Panel Settings.
const DEFAULTS = { log: ["1259103646969237657"], backup: ["1259891232566415420"] };
const KINDS = {
    log: { label: "log", envKey: "WEBHOOK_LOG", webhookName: "Log" },
    backup: { label: "backup", envKey: "WEBHOOK_BACKUP", webhookName: "Backup" },
};
const CATEGORY_LIMIT = 50;
const GUILD_LIMIT = 500;
const NEEDED = ["ViewChannel", "ManageChannels", "ManageWebhooks"];
const SNOWFLAKE = /^\d{15,25}$/;
const WEBHOOK_URL = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{15,25})\/([\w-]+)\/?$/;
const EDIT_WAIT_MS = 8000;

function _err(message, status = 400, details = null) {
    const e = new Error(message);
    e.status = status;
    if (details) e.details = details;
    return e;
}

const kindsOf = (kinds) => {
    const list = (Array.isArray(kinds) && kinds.length ? kinds : Object.keys(KINDS)).map(String);
    const bad = list.find((k) => !KINDS[k]);
    if (bad) throw _err(`Unknown channel kind "${bad}"`);
    return [...new Set(list)];
};

const envKeyOf = (bot, kind) => bot.customer?.envKeys?.[kind] || KINDS[kind].envKey;

const needClient = () => {
    const client = discordBus.discordClient();
    if (!client) throw _err("The panel's Discord bot is not connected — try again once it is", 503);
    return client;
};

const discordCode = (err) => err?.code ?? err?.rawError?.code;

/**
 * "done" within `ms`, else "pending" — the work goes on regardless. A failure
 * before the deadline rejects; one after it is dropped (it must not become an
 * unhandled rejection, which ends the process).
 */
const within = (promise, ms) => {
    const done = promise.then(() => "done");
    done.catch(() => {});
    let timer;
    const late = new Promise((r) => {
        timer = setTimeout(() => r("pending"), ms);
    });
    return Promise.race([done, late]).finally(() => clearTimeout(timer));
};

// ── Settings ─────────────────────────────────────────────────────────────────

const getSettings = async () => {
    const s = (await db.get(SETTINGS)) || {};
    return { log: s.log?.length ? s.log : DEFAULTS.log, backup: s.backup?.length ? s.backup : DEFAULTS.backup };
};

/**
 * What the panel's bot can do in one category. Read from Discord every time
 * (force), not from the bot's cache: a category made private by hand without
 * the bot in it is one the bot no longer gets updates for, so its cached copy
 * kept the old, public permissions and the page went on saying "Public" after
 * the owner had fixed it (2026-11-13). Discord now says Missing Access instead.
 */
const inspectCategory = async (client, id) => {
    let cat;
    try {
        cat = await client.channels.fetch(id, { force: true });
    } catch (err) {
        const code = discordCode(err);
        const error =
            code === 10003 ? "No such channel"
            : code === 50001 ? "The panel's bot cannot see this category — add the bot (or one of its roles) to it with View Channel"
            : `Discord did not answer (${err.message})`;
        return { id, ok: false, error };
    }
    if (!cat || cat.type !== ChannelType.GuildCategory) return { id, ok: false, error: "Not a category" };
    const me = cat.guild.members.me;
    const perms = me ? cat.permissionsFor(me) : null;
    const missing = NEEDED.filter((p) => !perms?.has(PermissionFlagsBits[p]));
    const count = cat.children?.cache?.size ?? 0;
    const open = !!cat.permissionsFor(cat.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel);
    return {
        id,
        ok: !missing.length,
        name: cat.name,
        guildId: cat.guild.id,
        guildName: cat.guild.name,
        count,
        full: count >= CATEGORY_LIMIT,
        missing,
        public: open,
        error: missing.length ? `The panel's bot is missing ${missing.join(", ")} here` : null,
        cat,
    };
};

const strip = ({ cat, ...rest }) => rest; // eslint-disable-line no-unused-vars

/** The categories and what the panel's bot can do in each — for Panel Settings. */
const describeSettings = async () => {
    const s = await getSettings();
    const client = discordBus.discordClient();
    if (!client) {
        return { busReady: false, limit: CATEGORY_LIMIT, log: s.log.map((id) => ({ id })), backup: s.backup.map((id) => ({ id })) };
    }
    const out = { busReady: true, limit: CATEGORY_LIMIT };
    for (const kind of Object.keys(KINDS)) {
        out[kind] = [];
        for (const id of s[kind]) out[kind].push(strip(await inspectCategory(client, id)));
    }
    return out;
};

const setSettings = async (patch = {}) => {
    const client = needClient();
    const s = await getSettings();
    const next = { ...s };
    for (const kind of Object.keys(KINDS)) {
        if (patch[kind] === undefined) continue;
        const ids = [...new Set((Array.isArray(patch[kind]) ? patch[kind] : String(patch[kind]).split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean))];
        if (!ids.length) throw _err(`Give at least one ${KINDS[kind].label} category`);
        if (ids.length > 10) throw _err(`At most 10 ${KINDS[kind].label} categories`);
        for (const id of ids) {
            if (!SNOWFLAKE.test(id)) throw _err(`"${id}" is not a Discord ID`);
            const c = await inspectCategory(client, id);
            if (!c.name) throw _err(`${id}: ${c.error || "not usable"}`);
        }
        next[kind] = ids;
    }
    await db.set(SETTINGS, next);
    panelLog.add("owner", "Owner changed the Kho categories for customer project channels");
    return describeSettings();
};

/** The first listed category of this kind with room left, checked for permissions. */
const pickCategory = async (client, kind) => {
    const { [kind]: ids } = await getSettings();
    const problems = [];
    for (const id of ids) {
        const c = await inspectCategory(client, id);
        if (!c.cat) {
            problems.push(`${id}: ${c.error}`);
            continue;
        }
        if (c.missing.length) throw _err(`${c.error} (category "${c.name}")`, 409);
        if (c.full) {
            problems.push(`"${c.name}" is full`);
            continue;
        }
        if (c.cat.guild.channels.cache.size >= GUILD_LIMIT) throw _err(`The server "${c.guildName}" has reached Discord's ${GUILD_LIMIT}-channel limit`, 409);
        return c.cat;
    }
    throw _err(
        `No ${KINDS[kind].label} category can be used (${problems.join("; ") || "none listed"}) — fix it or add another category in Panel Settings → Integrations`,
        409,
    );
};

// ── Names ────────────────────────────────────────────────────────────────────

const channelNameOf = (bot, base) => base || bot.customer?.baseName || String(bot.botID || "project").toLowerCase();

const topicOf = (bot, projectName) =>
    [
        `Customer project ${projectName || bot.name}`,
        `customer ${bot.buyerID}`,
        bot.customer?.botUserId ? `bot ${bot.customer.botUserId}` : null,
        `panel id ${bot._id}`,
    ]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 900) + " — named by the panel; a rename here is undone in the daily sync.";

// ── .env ─────────────────────────────────────────────────────────────────────

const readEnv = async (bot) => {
    try {
        return (await executor.fsRead(bot, ".env")).content || "";
    } catch (err) {
        if (err.status === 404) return "";
        throw _err(`Could not read the project's .env (${err.message})`, 502);
    }
};

const parseWebhookUrl = (url) => {
    const m = WEBHOOK_URL.exec(String(url || "").trim());
    return m ? { id: m[1], token: m[2] } : null;
};

/** Where a webhook URL from a .env posts — { channelId, channelName, guildId, guildName } — or why not. */
const whereItPosts = async (client, url) => {
    const w = parseWebhookUrl(url);
    if (!w) return { error: "Not a Discord webhook URL" };
    let hook;
    try {
        hook = await client.fetchWebhook(w.id, w.token);
    } catch (err) {
        return { error: discordCode(err) === 10015 ? "The webhook no longer exists" : `Discord: ${err.message}` };
    }
    const out = { webhookId: hook.id, channelId: hook.channelId, guildId: hook.guildId || null, channelName: null, guildName: null };
    try {
        const ch = await client.channels.fetch(hook.channelId);
        Object.assign(out, { channelName: ch.name, guildName: ch.guild?.name || null, categoryId: ch.parentId || null });
    } catch {
        out.error = "The panel's bot cannot see that channel";
    }
    return out;
};

// ── Set up ───────────────────────────────────────────────────────────────────

/**
 * A new channel inherits the category's permissions — a category kept private
 * must give a private channel. Copying the category's overwrites is tried
 * first; Discord refuses that when the bot lacks one of the copied permissions,
 * so then the channel is made bare and synced. Anything still more visible than
 * its category is deleted again: a backup channel holds customer data.
 */
const createPrivateChannel = async (cat, { name, topic, reason }) => {
    const base = { name, type: ChannelType.GuildText, parent: cat.id, topic, reason };
    let channel;
    try {
        channel = await cat.guild.channels.create({
            ...base,
            permissionOverwrites: cat.permissionOverwrites.cache.map((o) => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny })),
        });
    } catch (err) {
        if (discordCode(err) !== 50013) throw err;
        channel = await cat.guild.channels.create(base);
    }
    const everyone = cat.guild.roles.everyone;
    const catOpen = !!cat.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel);
    const isOpen = (ch) => !!ch.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel);
    if (!catOpen && isOpen(channel)) channel = (await channel.lockPermissions().catch(() => null)) || channel;
    if (!catOpen && isOpen(channel)) {
        await channel.delete("Came out more visible than its private category").catch(() => {});
        throw _err(
            `The new channel came out visible to everyone although "${cat.name}" is private, so it was deleted again — give the panel's bot Manage Permissions in that category`,
            409,
        );
    }
    return channel;
};

/**
 * Make the project's channels (all kinds by default, or `kinds`), a webhook in
 * each, and write the webhook URLs to its .env. A key that already has a value
 * is not overwritten unless `replace` — the answer (409, details.taken) says
 * where the current one posts, so the owner can link that channel instead.
 * Anything created is removed again if a later step fails.
 *
 * `reuse` { kind: channelId }: a customer back with the same bot gets its old
 * channel again (customerRetire.reusableFor) — only a new webhook is made in
 * it, and a failure removes that webhook, never the old channel.
 * → { channels: patch for customer.channels, created: [kinds] }
 */
const setUp = async (bot, { kinds, replace = false, baseName, reuse = {} } = {}) => {
    const client = needClient();
    const current = bot.customer?.channels || {};
    const todo = kindsOf(kinds).filter((k) => !current[k]?.channelId || current[k].missing);
    if (!todo.length) throw _err("These channels are already set up for this project", 409);
    const old = {};
    for (const kind of todo) {
        if (!reuse[kind]) continue;
        try {
            old[kind] = await client.channels.fetch(reuse[kind], { force: true });
        } catch (err) {
            throw _err(`The old ${KINDS[kind].label} channel cannot be used (${discordCode(err) === 10003 ? "it was deleted" : err.message})`, 409);
        }
    }

    const envText = await readEnv(bot);
    if (!replace) {
        const taken = [];
        for (const kind of todo) {
            const key = envKeyOf(bot, kind);
            const value = envValue(envText, key);
            if (value) taken.push({ kind, key, ...(await whereItPosts(client, value)) });
        }
        if (taken.length) {
            throw _err(
                `${taken.map((t) => t.key).join(" and ")} already ${taken.length > 1 ? "have values" : "has a value"} in this project's .env`,
                409,
                { code: "ENV_TAKEN", taken: taken.map(({ webhookId, ...t }) => t) }, // eslint-disable-line no-unused-vars
            );
        }
    }

    const cats = {};
    for (const kind of todo) if (!old[kind]) cats[kind] = await pickCategory(client, kind);

    const name = channelNameOf(bot, baseName);
    const topic = topicOf(bot);
    const reason = `Customer project ${bot.name} (bot-panel)`;
    const made = []; // { kind, channel, webhook, reused }
    try {
        for (const kind of todo) {
            const entry = { kind, channel: null, webhook: null, reused: !!old[kind] };
            made.push(entry);
            entry.channel = old[kind] || (await createPrivateChannel(cats[kind], { name, topic, reason }));
            entry.webhook = await entry.channel.createWebhook({ name: KINDS[kind].webhookName, reason });
        }
        let text = envText;
        for (const m of made) text = setEnvKey(text, envKeyOf(bot, m.kind), m.webhook.url);
        await executor.fsWrite(bot, ".env", text);
    } catch (err) {
        for (const m of made) {
            if (m.reused) {
                if (m.webhook) await client.deleteWebhook(m.webhook.id).catch(() => {});
            } else if (m.channel) await m.channel.delete("Setting up the project's channels failed").catch(() => {});
        }
        if (err.status) throw err;
        throw _err(`Setting up the channels failed (${err.message}) — nothing was kept`, 502);
    }

    const channels = { ...current };
    for (const m of made) {
        channels[m.kind] = {
            channelId: m.channel.id,
            webhookId: m.webhook.id,
            guildId: m.channel.guild.id,
            categoryId: m.channel.parentId,
            name: m.channel.name,
            ...(m.reused ? { reusedAt: Date.now() } : { createdAt: Date.now() }),
        };
    }
    const what = (list) => list.map((m) => KINDS[m.kind].label).join(" + ");
    const fresh = made.filter((m) => !m.reused);
    const again = made.filter((m) => m.reused);
    panelLog.add(
        "owner",
        `Owner ${[fresh.length ? `set up the ${what(fresh)} channel${fresh.length > 1 ? "s" : ""}` : null, again.length ? `reused the old ${what(again)} channel${again.length > 1 ? "s" : ""}` : null]
            .filter(Boolean)
            .join(" and ")} of "${bot.name}" in ${made[0].channel.guild.name}`,
    );
    return { channels, created: todo, reused: again.map((m) => m.kind) };
};

// ── Link ─────────────────────────────────────────────────────────────────────

/**
 * Adopt the channels the project's .env already posts to. Only channels in a
 * server the categories are in (Kho) can be adopted, and a channel another
 * project already has stays with it — two projects renaming one channel to
 * their own names every day would never settle.
 * → { channels, results: [{ kind, key, status, channelName?, reason? }] }
 */
const link = async (bot, { kinds } = {}) => {
    const client = needClient();
    const envText = await readEnv(bot);
    const settings = await getSettings();
    const homes = new Set();
    for (const id of [...settings.log, ...settings.backup]) {
        const c = await inspectCategory(client, id);
        if (c.guildId) homes.add(c.guildId);
    }
    const others = (await db.find("bots")).filter((b) => b._id !== bot._id && b.customer?.channels);
    const ownerOf = (channelId) => others.find((b) => Object.values(b.customer.channels).some((c) => c?.channelId === channelId));

    const channels = { ...(bot.customer?.channels || {}) };
    const results = [];
    for (const kind of kindsOf(kinds)) {
        const key = envKeyOf(bot, kind);
        const value = envValue(envText, key);
        if (!value) {
            results.push({ kind, key, status: "skipped", reason: `There is no ${key} in the .env` });
            continue;
        }
        const where = await whereItPosts(client, value);
        if (where.error && !where.channelId) {
            results.push({ kind, key, status: "skipped", reason: where.error });
            continue;
        }
        if (!where.guildId || !homes.has(where.guildId) || where.error) {
            results.push({ kind, key, status: "skipped", reason: where.error || "It posts outside the server of the customer channel categories" });
            continue;
        }
        const other = ownerOf(where.channelId);
        if (other) {
            results.push({ kind, key, status: "skipped", channelName: where.channelName, reason: `#${where.channelName} already belongs to "${other.name}" — use Set up to give this project its own` });
            continue;
        }
        channels[kind] = {
            channelId: where.channelId,
            webhookId: where.webhookId,
            guildId: where.guildId,
            categoryId: where.categoryId || null,
            name: where.channelName,
            linkedAt: Date.now(),
        };
        results.push({ kind, key, status: "linked", channelName: where.channelName });
    }
    const linked = results.filter((r) => r.status === "linked");
    if (linked.length) panelLog.add("owner", `Owner linked ${linked.map((r) => `#${r.channelName}`).join(", ")} to "${bot.name}"`);
    return { channels, results };
};

// ── Daily sync ───────────────────────────────────────────────────────────────

/**
 * Keep each linked channel named after the project and say what is broken: a
 * channel or webhook deleted on Discord. Discord being unreachable is not
 * "deleted" — only its own Unknown Channel / Unknown Webhook answers are.
 * → { skipped } with the bus down, else { channels, problems }
 */
const sync = async (bot, { baseName, projectName, editWaitMs = EDIT_WAIT_MS } = {}) => {
    const current = bot.customer?.channels;
    if (!current || !Object.values(current).some((c) => c?.channelId)) return { channels: current || undefined, problems: [] };
    const client = discordBus.discordClient();
    if (!client) return { skipped: true };

    const name = channelNameOf(bot, baseName);
    const topic = topicOf(bot, projectName);
    const channels = { ...current };
    const problems = [];
    for (const kind of Object.keys(KINDS)) {
        const c = current[kind];
        if (!c?.channelId) continue;
        const label = KINDS[kind].label;
        let ch;
        try {
            ch = await client.channels.fetch(c.channelId);
        } catch (err) {
            if (discordCode(err) === 10003) {
                channels[kind] = { ...c, missing: true };
                problems.push(`The ${label} channel was deleted on Discord`);
            } else problems.push(`The ${label} channel could not be checked (${err.message})`);
            continue;
        }
        const next = { ...c, name: ch.name, missing: false };
        if (ch.name !== name || (ch.topic || "") !== topic) {
            const r = await within(ch.edit({ name, topic, reason: "The customer project's name changed" }), editWaitMs).catch((err) => {
                problems.push(`The ${label} channel could not be renamed (${err.message})`);
                return "failed";
            });
            if (r === "done") next.name = name;
        }
        try {
            await client.fetchWebhook(c.webhookId);
            next.webhookMissing = false;
        } catch (err) {
            if (discordCode(err) === 10015) {
                next.webhookMissing = true;
                problems.push(`The ${label} channel's webhook was deleted — the project can no longer post there`);
            }
        }
        channels[kind] = next;
    }
    return { channels, problems };
};

module.exports = {
    KINDS,
    DEFAULTS,
    CATEGORY_LIMIT,
    getSettings,
    describeSettings,
    setSettings,
    parseWebhookUrl,
    setUp,
    link,
    sync,
};
