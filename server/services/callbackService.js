const axios = require("axios");
const db = require("../db");
const nodeService = require("./nodeService");
const integrations = require("./integrationService");
const apiKeys = require("./apiKeyService");

// ─────────────────────────────────────────────────────────────────────────────
//  Callbacks — the URLs other projects register for the panel to call back
//  (quest / badge events: arnto-auto sends http://localhost:1942/api/quest-event).
//
//  "localhost" in such a URL means the CALLER's machine, which is the panel's
//  machine only while both happen to share a node. So the URL is kept exactly
//  as registered, together with its OWNER, and the address is worked out at
//  send time from where the owner runs now — the same rule as integrations:
//  127.0.0.1 on the panel's node, that node's WireGuard IP otherwise. Moving
//  the panel or migrating the project keeps callbacks working.
//
//  Owner = the project whose API key registered the callback (webhookBotId on
//  the record, see apiKeyService). Callbacks registered with the shared
//  PANEL_API_KEY have none; for a loopback one the project linked under
//  Integrations on the same port stands in. Neither → an orphan: sent as
//  registered, and a panel move rewrites it to the old node (panelMigration).
//
//  A callback is signed with its owner's key when it has one — the caller
//  checks x-api-key against the one key it holds — else with PANEL_API_KEY.
// ─────────────────────────────────────────────────────────────────────────────

// Where callback URLs are stored: a `webhookUrl` (+ `webhookBotId`) per record,
// plus the .env keys that hold one for callbacks the panel registers itself.
const CALLBACK_MODELS = ["quest_accounts", "quest_monthly", "badge_orders"];
const CALLBACK_ENV = ["ARNTO_QUEST_WEBHOOK_URL"];

const LOOPBACK_HOST_RE = /^(https?:\/\/)(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?=[:/]|$)/i;

/** `url` with its loopback host replaced by `host`, byte-for-byte otherwise; null when not loopback. */
const relocateUrl = (url, host) => {
    if (!host || !integrations.isLoopbackUrl(url)) return null;
    return String(url).replace(LOOPBACK_HOST_RE, `$1${host}`);
};

const portOf = (url) => {
    try {
        const u = new URL(url);
        return Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    } catch {
        return null;
    }
};

/**
 * The project a callback belongs to, or null. The Integrations stand-in only
 * applies to loopback URLs: a key must never go to an outside host just
 * because its port happens to match.
 */
const ownerOf = async (url, ownerBotId) => {
    if (ownerBotId) {
        const bot = await db.findOne("bots", { _id: ownerBotId });
        if (bot) return bot;
    }
    if (!integrations.isLoopbackUrl(url)) return null;
    const link = await integrations.linkOnPort(portOf(url));
    return link ? (await db.findOne("bots", { _id: link.botId })) || null : null;
};

/**
 * Where to send a callback and how to sign it → { url, key, owner }.
 * `fromNodeId` = the node the panel sends from (default: this one).
 */
const resolve = async (url, ownerBotId, { fromNodeId } = {}) => {
    const owner = await ownerOf(url, ownerBotId);
    let target = url;
    if (owner && integrations.isLoopbackUrl(url)) {
        try {
            const addr = await integrations.addressFor(owner, portOf(url), fromNodeId ?? nodeService.panelNodeId());
            target = relocateUrl(url, addr.host);
        } catch (err) {
            console.warn(`[Callback] ${owner.name}: ${err.message} — sending to ${url} as registered`);
        }
    }
    const key = (owner && (await apiKeys.keyFor(owner._id))) || process.env.PANEL_API_KEY || "";
    return { url: target, key, owner };
};

/** Fire-and-forget POST, errors swallowed — callbacks never break the run that emits them. */
const send = (url, ownerBotId, body) => {
    if (!url) return;
    resolve(url, ownerBotId)
        .then((t) => axios.post(t.url, body, { timeout: 8000, headers: { "x-api-key": t.key } }))
        .catch(() => {});
};

/**
 * Every loopback callback the panel holds, grouped by URL and owner:
 * [{ url, ownerBotId, ownerName, sources: ["10 in quest_monthly", ".env ARNTO_QUEST_WEBHOOK_URL"] }]
 * ownerBotId null = an orphan.
 */
const audit = async () => {
    const groups = new Map();
    const owners = new Map();
    const note = async (url, recOwner, source) => {
        const memo = `${url}|${recOwner || ""}`;
        if (!owners.has(memo)) owners.set(memo, await ownerOf(url, recOwner));
        const owner = owners.get(memo);
        const id = `${url}|${owner?._id || ""}`;
        if (!groups.has(id)) groups.set(id, { url, ownerBotId: owner?._id || null, ownerName: owner?.name || null, counts: new Map() });
        const counts = groups.get(id).counts;
        counts.set(source, (counts.get(source) || 0) + 1);
    };
    for (const model of CALLBACK_MODELS) {
        for (const r of (await db.get(model)) || []) {
            if (typeof r?.webhookUrl === "string" && integrations.isLoopbackUrl(r.webhookUrl)) {
                await note(r.webhookUrl, r.webhookBotId || null, model);
            }
        }
    }
    for (const key of CALLBACK_ENV) {
        if (integrations.isLoopbackUrl(process.env[key])) await note(process.env[key], null, `.env ${key}`);
    }
    return [...groups.values()].map(({ counts, ...g }) => ({
        ...g,
        sources: [...counts].map(([source, n]) => (source.startsWith(".env") ? source : `${n} in ${source}`)),
    }));
};

/**
 * Rewrite ORPHAN loopback callbacks to `host` (the panel's old node, during a
 * move) — one write per collection. Owned ones are left alone: they follow
 * their project. Returns the count.
 */
const relocateOrphans = async (host) => {
    let count = 0;
    for (const model of CALLBACK_MODELS) {
        const rows = (await db.get(model)) || [];
        let changed = false;
        const next = [];
        for (const r of rows) {
            const url = typeof r?.webhookUrl === "string" ? relocateUrl(r.webhookUrl, host) : null;
            if (!url || (await ownerOf(r.webhookUrl, r.webhookBotId || null))) {
                next.push(r);
                continue;
            }
            changed = true;
            count++;
            next.push({ ...r, webhookUrl: url });
        }
        if (changed) await db.set(model, next);
    }
    return count;
};

module.exports = { CALLBACK_ENV, relocateUrl, portOf, ownerOf, resolve, send, audit, relocateOrphans };
