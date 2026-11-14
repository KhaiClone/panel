const crypto = require("crypto");
const db = require("../db");
const discordBus = require("./discordBus");
const apiKeys = require("./apiKeyService");
const panelLog = require("./panelLog");
const githubUrl = require("../utils/githubUrl");

// ─────────────────────────────────────────────────────────────────────────────
//  Customer projects, phase 3 — what a customer project leaves behind once it
//  is gone from /bots (user, 2026-11-13).
//
//  When a customer project's record is deleted — the Delete button, Bulk
//  remove, or the expiry removal 7 days after an expiry date (some customer
//  projects never expire, so only Delete reaches those) — its resources are
//  written down here, because the record that knew them is about to vanish:
//  its Kho channels, their webhooks, its API keys, its repo.
//
//  Two things happen at once, both undoable and losing nothing: the webhooks
//  are deleted (the URLs die with the project; the messages stay) and its API
//  keys are revoked (a deleted project must not keep a way into the panel).
//  Everything that holds data waits for the owner: the log and backup
//  channels are deleted only by hand — the backup channel shows a "kept until"
//  date (30 days) as a reminder, nothing deletes it by itself — and the repo
//  is archived / deleted from here when it is in the customers' GitHub org
//  (phase 4, services/customerRepos.js), or marked handled by hand. The entry
//  leaves the list once every line is done, or when the owner dismisses it.
//
//  A customer who comes back with the same bot gets the old channels offered
//  again (customerChannels.setUp with `reuse`).
// ─────────────────────────────────────────────────────────────────────────────

const COLLECTION = "retired_projects";
const KEEP_BACKUP_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const KINDS = ["log", "backup"];
const CHANNEL_DONE = ["deleted", "gone", "reused"];

function _err(message, status = 400) {
    const e = new Error(message);
    e.status = status;
    return e;
}

const discordCode = (err) => err?.code ?? err?.rawError?.code;

// One change at a time. Bulk remove deletes its projects in parallel, and the
// list here — like the API keys — is one quick.db value read and written back
// whole: two retires at once would each write a list without the other's
// entry (and one key revocation would be lost). Callers of `serial` must not
// call another `serial` function from inside it.
let chain = Promise.resolve();
const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
};

const all = async () => (await db.get(COLLECTION)) || [];
const saveAll = (list) => db.set(COLLECTION, list);

const isDone = (e) =>
    ["deleted", "none"].includes(e.webhooks.status) &&
    ["revoked", "none"].includes(e.apiKeys.status) &&
    KINDS.every((k) => !e.channels[k] || CHANNEL_DONE.includes(e.channels[k].status)) &&
    ["handled", "none"].includes(e.repo.status);

/** Write the entry back — or drop it when nothing is left to do. */
const put = async (entry, { quiet = false } = {}) => {
    const list = (await all()).filter((e) => e._id !== entry._id);
    if (isDone(entry)) {
        await saveAll(list);
        if (!quiet) panelLog.add("owner", `Cleanup of retired customer project "${entry.name}" is finished`);
        return null;
    }
    await saveAll([...list, entry]);
    return entry;
};

const get = async (rid) => {
    const e = (await all()).find((x) => x._id === rid);
    if (!e) throw _err("This retired project is no longer listed", 404);
    return e;
};

// ── The two things done at once ──────────────────────────────────────────────

const deleteWebhooks = async (entry) => {
    const ids = KINDS.map((k) => entry.channels[k]?.webhookId).filter(Boolean);
    if (!ids.length) return { status: "none", error: null };
    const client = discordBus.discordClient();
    if (!client) return { status: "pending", error: "The panel's Discord bot was not connected" };
    const failed = [];
    for (const id of ids) {
        try {
            await client.deleteWebhook(id, { reason: `Customer project ${entry.name} was removed` });
        } catch (err) {
            if (discordCode(err) !== 10015) failed.push(err.message); // 10015: already gone
        }
    }
    return failed.length ? { status: "pending", error: `Discord: ${failed.join("; ")}` } : { status: "deleted", error: null };
};

const revokeKeys = async (entry) => {
    try {
        const keys = (await apiKeys.list()).filter((k) => k.botId === entry.botId && !k.revokedAt);
        for (const k of keys) await apiKeys.revoke(k._id);
        const count = (entry.apiKeys?.count || 0) + keys.length;
        return { status: count ? "revoked" : "none", count, error: null };
    } catch (err) {
        return { status: "pending", count: entry.apiKeys?.count || 0, error: err.message };
    }
};

/**
 * Called just before a project's record is deleted. Only customer projects
 * are written down; personal and team ones are left alone, as everywhere in
 * this feature. Never throws: the project's removal must not fail over this.
 */
const retire = (bot, opts) => serial(() => retireNow(bot, opts));

const retireNow = async (bot, { reason = "deleted" } = {}) => {
    try {
        const c = bot?.customer;
        if (!c?.enabled) return null;
        // A few seconds from now the record is gone: their last project? then the customer role goes.
        require("./customerRole").syncSoon();
        const channels = {};
        for (const k of KINDS) {
            const ch = c.channels?.[k];
            if (!ch?.channelId) continue;
            channels[k] = { channelId: ch.channelId, guildId: ch.guildId, name: ch.name || null, webhookId: ch.webhookId || null, status: ch.missing ? "gone" : "kept" };
        }
        const entry = {
            _id: crypto.randomBytes(8).toString("hex"),
            botId: bot._id,
            name: bot.name,
            projectType: bot.projectType || "discord",
            buyerID: bot.buyerID,
            buyerName: c.buyerName || null,
            botUserId: c.botUserId || null,
            baseName: c.baseName || null,
            reason,
            retiredAt: Date.now(),
            channels,
            repo: { url: bot.repoUrl || null, status: bot.repoUrl ? "pending" : "none" },
            webhooks: { status: "none", error: null },
            apiKeys: { status: "none", count: 0, error: null },
        };
        entry.webhooks = await deleteWebhooks(entry);
        entry.apiKeys = await revokeKeys(entry);
        const kept = await put(entry, { quiet: true });
        panelLog.add(
            "owner",
            `Customer project "${bot.name}" ${reason === "expired" ? "expired and was removed" : "was removed"} — ` +
                `webhooks ${entry.webhooks.status}, API keys ${entry.apiKeys.status}` +
                (kept ? "; the rest waits on Bots → Retired" : ""),
        );
        return kept;
    } catch (err) {
        console.warn(`[Customers] Could not write down what "${bot?.name}" leaves behind: ${err.message}`);
        return null;
    }
};

// ── The list ─────────────────────────────────────────────────────────────────

const shape = (e) => ({
    ...e,
    channels: Object.fromEntries(
        Object.entries(e.channels).map(([k, ch]) => {
            const { webhookId, ...rest } = ch; // eslint-disable-line no-unused-vars
            return [k, rest];
        }),
    ),
    backupKeptUntil: e.channels.backup ? e.retiredAt + KEEP_BACKUP_DAYS * DAY : null,
});

/**
 * Every retired customer project, newest first. A channel still marked
 * "kept" is looked up: one deleted on Discord meanwhile is "gone" (done).
 */
const list = async () => {
    const client = discordBus.discordClient();
    const seen = []; // { id, kind, name?, gone? }
    if (client) {
        for (const e of await all()) {
            for (const k of KINDS) {
                const ch = e.channels[k];
                if (ch?.status !== "kept") continue;
                try {
                    const live = await client.channels.fetch(ch.channelId);
                    if (live?.name && live.name !== ch.name) seen.push({ id: e._id, kind: k, name: live.name });
                } catch (err) {
                    if (discordCode(err) === 10003) seen.push({ id: e._id, kind: k, gone: true });
                }
            }
        }
    }
    // Applied to a fresh read, so nothing written meanwhile is lost.
    const entries = !seen.length
        ? await all()
        : await serial(async () => {
              const fresh = await all();
              for (const s of seen) {
                  const ch = fresh.find((e) => e._id === s.id)?.channels[s.kind];
                  if (!ch || ch.status !== "kept") continue;
                  if (s.gone) ch.status = "gone";
                  else ch.name = s.name;
              }
              const left = fresh.filter((e) => !isDone(e));
              await saveAll(left);
              return left;
          });
    return entries.sort((a, b) => b.retiredAt - a.retiredAt).map(shape);
};

const answer = (entry) => ({ entry: entry ? shape(entry) : null, finished: !entry });

/** Delete one of the retired project's Kho channels (asked for by the owner). */
const deleteChannel = (rid, kind) => serial(() => deleteChannelNow(rid, kind));
const deleteChannelNow = async (rid, kind) => {
    if (!KINDS.includes(kind)) throw _err(`Unknown channel kind "${kind}"`);
    const entry = await get(rid);
    const ch = entry.channels[kind];
    if (!ch) throw _err(`This project had no ${kind} channel`);
    if (ch.status === "kept") {
        const client = discordBus.discordClient();
        if (!client) throw _err("The panel's Discord bot is not connected — try again once it is", 503);
        try {
            const live = await client.channels.fetch(ch.channelId);
            await live.delete(`Retired customer project ${entry.name} — deleted by the owner`);
            ch.status = "deleted";
            panelLog.add("owner", `Owner deleted #${ch.name || ch.channelId}, the ${kind} channel of retired customer project "${entry.name}"`);
        } catch (err) {
            if (discordCode(err) !== 10003) throw _err(`Discord did not delete it (${err.message})`, 502);
            ch.status = "gone";
        }
    }
    return answer(await put(entry));
};

const retryWebhooks = (rid) =>
    serial(async () => {
        const entry = await get(rid);
        entry.webhooks = await deleteWebhooks(entry);
        return answer(await put(entry));
    });

const retryKeys = (rid) =>
    serial(async () => {
        const entry = await get(rid);
        entry.apiKeys = await revokeKeys(entry);
        return answer(await put(entry));
    });

/** Phase 4: the repo was archived / deleted from the panel (services/customerRepos.js). */
const setRepoResult = (rid, result) =>
    serial(async () => {
        const entry = await get(rid);
        entry.repo = { ...entry.repo, status: "handled", result };
        return answer(await put(entry));
    });

/** The same, for whichever entries still wait on that repo (done from the Repos page). */
const markRepoByKey = (repoKey, result) =>
    serial(async () => {
        for (const entry of await all()) {
            const p = githubUrl.parse(entry.repo?.url);
            if (entry.repo?.status !== "pending" || !p || githubUrl.key(p.owner, p.name) !== repoKey) continue;
            entry.repo = { ...entry.repo, status: "handled", result };
            await put(entry);
        }
    });

/** The owner dealt with the repo themself on GitHub. */
const markRepoHandled = (rid) =>
    serial(async () => {
        const entry = await get(rid);
        if (entry.repo.status === "pending") {
            entry.repo.status = "handled";
            panelLog.add("owner", `Owner marked the repo of retired customer project "${entry.name}" as handled`);
        }
        return answer(await put(entry));
    });

/** Forget the entry. Anything still listed stays where it is. */
const dismiss = (rid) =>
    serial(async () => {
        const entry = await get(rid);
        await saveAll((await all()).filter((e) => e._id !== rid));
        panelLog.add("owner", `Owner dismissed retired customer project "${entry.name}" from the cleanup list`);
        return { ok: true };
    });

// ── A customer who comes back ────────────────────────────────────────────────

/** Old channels of the same bot that still exist: { retiredId, retiredAt, name, channels: { kind: { channelId, name } } }[] */
const reusableFor = async (botUserId) => {
    if (!botUserId) return [];
    const out = [];
    for (const e of await list()) {
        if (e.botUserId !== botUserId) continue;
        const channels = Object.fromEntries(
            KINDS.filter((k) => e.channels[k]?.status === "kept").map((k) => [k, { channelId: e.channels[k].channelId, name: e.channels[k].name }]),
        );
        if (Object.keys(channels).length) out.push({ retiredId: e._id, retiredAt: e.retiredAt, name: e.name, channels });
    }
    return out;
};

/** The channels went back into use by project `name`. */
const markReused = (rid, kinds, name) =>
    serial(async () => {
        const entry = await get(rid);
        for (const k of kinds) if (entry.channels[k]) entry.channels[k] = { ...entry.channels[k], status: "reused", reusedBy: name };
        return put(entry);
    });

module.exports = {
    KEEP_BACKUP_DAYS,
    retire,
    list,
    entries: () => all(),
    get,
    setRepoResult,
    markRepoByKey,
    deleteChannel,
    retryWebhooks,
    retryKeys,
    markRepoHandled,
    dismiss,
    reusableFor,
    markReused,
};
