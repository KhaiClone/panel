const cron = require("node-cron");
const db = require("../db");
const executor = require("./executor");
const discordBus = require("./discordBus");
const lifecycle = require("./lifecycle");
const panelLog = require("./panelLog");
const customerChannels = require("./customerChannels");
const customerRetire = require("./customerRetire");
const customerRepos = require("./customerRepos");
const customerRole = require("./customerRole");
const { envValue } = require("../utils/envText");

// ─────────────────────────────────────────────────────────────────────────────
//  Customer projects — the /bots projects the owner marks as a customer's.
//
//  The owner hosts customers' bots next to personal and team projects, and only
//  the customers' ones should be named, tracked and later cleaned up the same
//  way (user, 2026-11-13). So nothing here touches a project until the owner
//  turns its switch on; existing projects start off.
//
//  Phase 1 is who the project belongs to:
//   - the bot's Discord id — typed in, or read from the bot token in the
//     project's .env. The first part of a bot token IS the bot's id in base64,
//     so it is decoded here and Discord is never called with the customer's
//     token; the token is not kept or logged.
//   - the customer = bot.buyerID (already a Discord id).
//  Both are looked up by id through the panel's own bot once a day (04:00 VN)
//  and with "Refresh". The project's panel name follows the bot's Discord name
//  while `syncName` is on; naming the project by hand turns that off.
//
//  `baseName` (customer-bot-id) is what the log/backup channels get called and
//  what a new repo should be called. Repos are never renamed when a name
//  changes (user, 2026-11-13) — the id at the end keeps everything findable.
//
//  Phase 2 (services/customerChannels.js): a log and a backup channel in Kho
//  per project, their webhook URLs written to its .env; the daily sync keeps
//  the channels named after the base name too.
//
//  Phase 3 (services/customerRetire.js): what a deleted / expired customer
//  project leaves behind, on Bots → Retired; the same bot back gets its old
//  channels offered again.
//
//  Phase 4 (services/customerRepos.js): the customers' repos in one GitHub
//  org — Bots → Repos, archive / delete, and the repo description follows the
//  project's name in the daily sync.
//
//  Some customer projects never expire — nothing here depends on expiresAt.
// ─────────────────────────────────────────────────────────────────────────────

const SNOWFLAKE = /^\d{15,25}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TOKEN_KEY = "TOKEN"; // template-discord-bot's .env
const SYNC_AT = "0 4 * * *";
const TIMEZONE = "Asia/Ho_Chi_Minh";
const GAP_MS = 1500; // between projects in a sync run — two lookups each

function _err(message, status = 400, extra = {}) {
    const e = new Error(message);
    e.status = status;
    Object.assign(e, extra);
    return e;
}

// ── Names ────────────────────────────────────────────────────────────────────

/**
 * A name GitHub and Discord both accept as-is: lowercase a-z, 0-9 and "-".
 * NFKD also turns the "fancy font" letters people put in bot names (𝓐𝓻𝓷) back
 * into plain ones; \u0111 (đ) has no decomposition, so it is mapped by hand.
 */
const slug = (text, max = 30) =>
    String(text || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\u0111\u0110]/g, "d")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, max)
        .replace(/-+$/, "");

/**
 * customer-bot-<bot id>, or customer-<project id> for a project with no bot
 * (a website, a service). Parts not known yet are left out. ≤ 100 characters:
 * the limit of a GitHub repo name and of a Discord channel name.
 */
const baseName = ({ buyerName, botName, botUserId, botID }) =>
    [slug(buyerName), botUserId ? slug(botName) : "", botUserId || slug(botID, 40)]
        .filter(Boolean)
        .join("-")
        .slice(0, 100);

/** The bot id inside a Discord bot token (its first part, base64), or null. */
const botIdFromToken = (token) => {
    const first = String(token || "").trim().replace(/^Bot\s+/i, "").split(".")[0];
    if (!first) return null;
    const id = Buffer.from(first.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return SNOWFLAKE.test(id) ? id : null;
};

// ── Discord ──────────────────────────────────────────────────────────────────

/** A user by id: { id, username, globalName, bot }, undefined while the bus is down. */
const lookup = async (id) => {
    try {
        return await discordBus.fetchUser(id);
    } catch (err) {
        if (err.code === 10013) throw _err(`Discord has no user with the ID ${id}`, 404, { unknown: true });
        throw _err(`Discord did not answer (${err.message})`, 502);
    }
};

/**
 * A bot id typed in by the owner, checked: digits, and a bot rather than a
 * person. With the bus down it is taken unchecked — the daily sync says so
 * later if it is wrong. Empty → null (a project with no bot).
 */
const checkBotId = async (botUserId) => {
    if (botUserId === undefined || botUserId === null || String(botUserId).trim() === "") return null;
    const id = String(botUserId).trim();
    if (!SNOWFLAKE.test(id)) throw _err("The bot ID is the bot's numeric Discord ID");
    const u = await lookup(id);
    if (u && !u.bot) throw _err(`${u.username} is a person, not a bot — enter the bot's ID`);
    return id;
};

const isDeletedAccount = (u) => /^deleted_user_/i.test(u.username || "");

// ── Records ──────────────────────────────────────────────────────────────────

const getBot = async (id) => {
    const bot = await db.findOne("bots", { _id: id });
    if (!bot) throw _err("Project not found", 404);
    return bot;
};

const tokenKeyOf = (customer) => customer?.envKeys?.token || DEFAULT_TOKEN_KEY;

const cleanKey = (key) => {
    const k = String(key || "").trim();
    if (!ENV_KEY.test(k)) throw _err(`Invalid .env key name: "${k}"`);
    return k;
};

/**
 * Merge `patch` into the project's customer block — read fresh, because the
 * daily sync spends seconds on Discord between reading a project and writing
 * it, and the owner may have changed the switches meanwhile. A name from
 * Discord becomes the panel name only while syncName is on.
 */
const save = async (botId, patch) => {
    const bot = await db.findOne("bots", { _id: botId });
    if (!bot) return null;
    const customer = { ...(bot.customer || {}), ...patch };
    customer.baseName = baseName({ ...customer, botID: bot.botID });
    const updates = { customer };
    if (customer.enabled && customer.syncName && customer.botName && customer.botName !== bot.name) {
        updates.name = customer.botName;
        panelLog.add("system", `Customer project "${bot.name}" is now "${customer.botName}" (its bot's name on Discord)`);
    }
    return db.findOneAndUpdate("bots", { _id: botId }, updates);
};

// ── The bot id from the project's .env ───────────────────────────────────────

const detectBotId = async (bot, tokenKey) => {
    const key = cleanKey(tokenKey || tokenKeyOf(bot.customer));
    let text;
    try {
        text = (await executor.fsRead(bot, ".env")).content || "";
    } catch (err) {
        if (err.status === 404) throw _err("This project has no .env file");
        throw _err(`Could not read the project's .env (${err.message})`, 502);
    }
    const token = envValue(text, key);
    if (!token) throw _err(`There is no ${key} in this project's .env`);
    const id = botIdFromToken(token);
    if (!id) throw _err(`${key} does not look like a Discord bot token`);
    return id;
};

/** The bot id found in the project's .env, plus who that is — nothing is saved. */
const detect = async (id, tokenKey) => {
    const bot = await getBot(id);
    const botUserId = await detectBotId(bot, tokenKey);
    let user;
    try {
        user = await lookup(botUserId);
    } catch (err) {
        if (err.unknown) throw _err("The bot in this token no longer exists on Discord", 404);
        throw err;
    }
    return { botUserId, bot: user ? { username: user.username, name: user.globalName || user.username } : null };
};

// ── Sync ─────────────────────────────────────────────────────────────────────

/**
 * Look the project's bot and customer up again. Names only move forward: a
 * failed lookup, a bot that is gone or a deleted account keeps the last good
 * name and says why in lastError. Bus down → nothing is written.
 */
const syncOne = async (bot) => {
    const c = bot.customer;
    if (!c?.enabled) return { bot, skipped: "off" };
    const patch = {};
    const problems = [];

    if (c.botUserId) {
        try {
            const u = await lookup(c.botUserId);
            if (u === undefined) return { bot, skipped: "bus" };
            if (!u.bot) problems.push("The bot ID belongs to a person, not a bot");
            else {
                patch.botName = u.globalName || u.username;
                patch.botUsername = u.username;
            }
        } catch (err) {
            problems.push(err.unknown ? "The bot no longer exists on Discord" : err.message);
        }
    }
    if (SNOWFLAKE.test(String(bot.buyerID || ""))) {
        try {
            const u = await lookup(bot.buyerID);
            if (u === undefined) return { bot, skipped: "bus" };
            if (isDeletedAccount(u)) problems.push("The customer deleted their Discord account");
            else {
                patch.buyerName = u.username;
                patch.buyerDisplayName = u.globalName || u.username;
            }
        } catch (err) {
            problems.push(err.unknown ? "The customer's Discord account no longer exists" : err.message);
        }
    }

    // Phase 2: the project's Kho channels follow the (possibly new) base name.
    const merged = { ...c, ...patch };
    const ch = await customerChannels.sync(bot, {
        baseName: baseName({ ...merged, botID: bot.botID }),
        projectName: merged.syncName && merged.botName ? merged.botName : bot.name,
    });
    if (!ch.skipped && ch.channels) {
        patch.channels = ch.channels;
        problems.push(...ch.problems);
    }
    // Phase 4: the repo's description follows the project's name (repos are never renamed).
    const repoProblem = await customerRepos.syncDescription(bot, {
        projectName: merged.syncName && merged.botName ? merged.botName : bot.name,
        buyerName: merged.buyerName,
    });
    if (repoProblem) problems.push(`GitHub: ${repoProblem}`);

    patch.checkedAt = Date.now();
    patch.lastError = problems.join(" · ") || null;
    const updated = await save(bot._id, patch);
    return { bot: updated, renamed: !!updated && updated.name !== bot.name, error: patch.lastError };
};

let running = null;
let lastRun = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every customer project, one at a time. A second call joins the running one. */
const syncAll = ({ gapMs = GAP_MS } = {}) => {
    if (running) return running;
    running = (async () => {
        const bots = (await db.find("bots")).filter((b) => b.customer?.enabled);
        const out = { total: bots.length, checked: 0, renamed: 0, problems: 0, skipped: 0 };
        for (const [i, b] of bots.entries()) {
            if (i && gapMs) await sleep(gapMs);
            try {
                const fresh = await db.findOne("bots", { _id: b._id });
                if (!fresh?.customer?.enabled) continue;
                const r = await syncOne(fresh);
                if (r.skipped === "bus") {
                    out.skipped = bots.length - out.checked;
                    break;
                }
                out.checked++;
                if (r.renamed) out.renamed++;
                if (r.error) out.problems++;
            } catch (err) {
                out.problems++;
                console.warn(`[Customers] Name sync of "${b.name}" failed: ${err.message}`);
            }
        }
        lastRun = { at: Date.now(), ...out };
        console.log(`[Customers] Name sync: ${out.checked}/${out.total} checked, ${out.renamed} renamed, ${out.problems} with problems${out.skipped ? `, ${out.skipped} skipped (Discord bus down)` : ""}`);
        return lastRun;
    })().finally(() => {
        running = null;
    });
    return running;
};

// ── Switches ─────────────────────────────────────────────────────────────────

/** After a change worth a lookup right away; the bus being down is not an error. */
const withSync = async (id) => {
    const r = await syncOne(await getBot(id));
    return { bot: r.bot, synced: !r.skipped, error: r.error || null };
};

const enable = async (id, { botUserId, syncName = true, tokenKey } = {}) => {
    const bot = await getBot(id);
    const prev = bot.customer || {};
    const checked = botUserId === undefined ? prev.botUserId || null : await checkBotId(botUserId);
    await save(bot._id, {
        enabled: true,
        botUserId: checked,
        syncName: syncName !== false,
        envKeys: { ...(prev.envKeys || {}), token: cleanKey(tokenKey === undefined ? tokenKeyOf(prev) : tokenKey) },
        enabledAt: Date.now(),
        // A different bot: its old names must not linger in the base name.
        ...(checked !== (prev.botUserId || null) ? { botName: null, botUsername: null } : {}),
    });
    panelLog.add("owner", `Owner marked "${bot.name}" as a customer project`);
    customerRole.syncSoon(); // the customer gets the customer role
    return withSync(bot._id);
};

const disable = async (id) => {
    const bot = await getBot(id);
    if (!bot.customer?.enabled) return { bot };
    // The rest of the block stays: turning it back on keeps the bot id.
    const updated = await save(bot._id, { enabled: false, disabledAt: Date.now() });
    panelLog.add("owner", `Owner stopped treating "${bot.name}" as a customer project`);
    customerRole.syncSoon(); // their last one? then the customer role goes
    return { bot: updated };
};

const update = async (id, { botUserId, syncName, tokenKey, logKey, backupKey } = {}) => {
    const bot = await getBot(id);
    const c = bot.customer;
    if (!c?.enabled) throw _err("This is not a customer project", 409);
    const patch = {};
    if (botUserId !== undefined) {
        patch.botUserId = await checkBotId(botUserId);
        if (patch.botUserId !== (c.botUserId || null)) Object.assign(patch, { botName: null, botUsername: null });
    }
    if (syncName !== undefined) patch.syncName = !!syncName;
    // .env key names: the bot token, and the webhook URLs of the Kho channels.
    const keys = { token: tokenKey, log: logKey, backup: backupKey };
    for (const [k, v] of Object.entries(keys)) {
        if (v !== undefined) patch.envKeys = { ...(patch.envKeys || c.envKeys || {}), [k]: cleanKey(v) };
    }
    await save(bot._id, patch);
    const newBot = "botUserId" in patch && patch.botUserId !== (c.botUserId || null);
    const syncTurnedOn = patch.syncName === true && !c.syncName;
    if (newBot || syncTurnedOn) return withSync(bot._id);
    return { bot: await getBot(bot._id), synced: false, error: null };
};

const refresh = async (id) => withSync(id);

// ── Kho channels (phase 2, services/customerChannels.js) ─────────────────────

const customerBot = async (id) => {
    const bot = await getBot(id);
    if (!bot.customer?.enabled) throw _err("Turn this into a customer project first", 409);
    return bot;
};

/** Make the log/backup channels + webhooks and write the URLs to the .env. */
const setUpChannels = async (id, { kinds, replace } = {}) => {
    const bot = await customerBot(id);
    const r = await customerChannels.setUp(bot, { kinds, replace: !!replace, baseName: bot.customer.baseName });
    await save(bot._id, { channels: r.channels });
    return { bot: await getBot(bot._id), created: r.created, restartNeeded: true };
};

/** Adopt the channels the .env already posts to; they are renamed right away. */
const linkChannels = async (id, { kinds } = {}) => {
    const bot = await customerBot(id);
    const r = await customerChannels.link(bot, { kinds });
    await save(bot._id, { channels: r.channels });
    const synced = r.results.some((x) => x.status === "linked") ? await withSync(bot._id) : { bot: await getBot(bot._id) };
    return { bot: synced.bot, results: r.results, error: synced.error || null };
};

/**
 * Phase 3: the channels this bot had before it was retired (a customer who
 * came back), for the kinds this project does not have yet.
 */
const reusable = async (id) => {
    const bot = await customerBot(id);
    const current = bot.customer.channels || {};
    const free = (k) => !current[k]?.channelId || current[k].missing;
    return (await customerRetire.reusableFor(bot.customer.botUserId))
        .map((r) => ({ ...r, channels: Object.fromEntries(Object.entries(r.channels).filter(([k]) => free(k))) }))
        .filter((r) => Object.keys(r.channels).length);
};

/** Put those old channels back to use: a new webhook in each, renamed after the project. */
const reuseChannels = async (id, { retiredId, replace } = {}) => {
    const bot = await customerBot(id);
    const offer = (await reusable(id)).find((r) => r.retiredId === retiredId);
    if (!offer) throw _err("Those old channels are no longer there for this bot", 409);
    const kinds = Object.keys(offer.channels);
    const reuse = Object.fromEntries(kinds.map((k) => [k, offer.channels[k].channelId]));
    const r = await customerChannels.setUp(bot, { kinds, replace: !!replace, baseName: bot.customer.baseName, reuse });
    await save(bot._id, { channels: r.channels });
    await customerRetire.markReused(retiredId, r.reused, bot.name);
    const synced = await withSync(bot._id); // renames them after this project
    return { bot: synced.bot, created: r.created, reused: r.reused, restartNeeded: true, error: synced.error || null };
};

/** Stop managing one channel. Nothing changes on Discord or in the .env. */
const unlinkChannel = async (id, kind) => {
    const bot = await customerBot(id);
    if (!customerChannels.KINDS[kind]) throw _err(`Unknown channel kind "${kind}"`);
    const channels = { ...(bot.customer.channels || {}) };
    if (!channels[kind]) return { bot };
    const name = channels[kind].name;
    delete channels[kind];
    await save(bot._id, { channels });
    panelLog.add("owner", `Owner unlinked #${name || kind} from "${bot.name}" (the channel itself is untouched)`);
    return { bot: await getBot(bot._id) };
};

// ── Status & schedule ────────────────────────────────────────────────────────

const status = () => ({
    busReady: !!discordBus.status?.().ready,
    schedule: { at: "04:00", timezone: TIMEZONE },
    running: !!running,
    lastRun,
});

let task = null;
const start = () => {
    if (task) return;
    task = cron.schedule(
        SYNC_AT,
        lifecycle.guard(() => {
            syncAll().catch((err) => console.error("[Customers] Daily name sync failed:", err.message));
        }),
        { timezone: TIMEZONE },
    );
    console.log(`[Customers] Name sync scheduled — 04:00 ${TIMEZONE}`);
};

module.exports = {
    SNOWFLAKE,
    slug,
    baseName,
    botIdFromToken,
    checkBotId,
    detect,
    enable,
    disable,
    update,
    refresh,
    setUpChannels,
    linkChannels,
    unlinkChannel,
    reusable,
    reuseChannels,
    syncOne,
    syncAll,
    status,
    start,
};
