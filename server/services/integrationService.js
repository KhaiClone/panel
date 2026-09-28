const db = require("../db");
const nodeService = require("./nodeService");

// ─────────────────────────────────────────────────────────────────────────────
//  Where the panel reaches the projects it integrates with.
//
//  These used to be fixed URLs in .env (ARNTO_DM_URL=http://localhost:1942 …),
//  which only work while the project and the panel share a machine. An
//  integration can instead be LINKED to a project + port: the address is then
//  worked out on every call from where that project runs right now —
//    same node as the panel  → http://127.0.0.1:<port>
//    another node            → http://<that node's WireGuard IP>:<port>
//  so migrating the project, or moving the panel, keeps the link working.
//  (The overlay address keeps API ports off the public internet; the node's
//  firewall must accept that port on wg0 — the panel-move preflight checks.)
//
//  An unlinked integration keeps using its .env URL exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "integrations";

const DEFS = {
    dm: { label: "ArnTo-Auto — DM API", env: "ARNTO_DM_URL", fallback: null },
    shop: { label: "ArnTo-Shop — Orders API", env: "SHOP_API_URL", fallback: "http://127.0.0.1:3000" },
    assistant: { label: "ArnTo-assistant — Decor API", env: "ASSISTANT_API_URL", fallback: "http://127.0.0.1:3000" },
};

// A URL that means "this machine" — it breaks the moment the panel moves.
const LOOPBACK_RE = /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i;
const isLoopbackUrl = (url) => LOOPBACK_RE.test(String(url || ""));

const def = (name) => {
    const d = DEFS[name];
    if (!d) {
        const err = new Error(`Unknown integration "${name}"`);
        err.status = 404;
        throw err;
    }
    return d;
};

const getLinks = async () => (await db.get(KEY)) || {};

/** Base URL for `bot` on `port`, as seen by a panel running on `fromNodeId`. */
const addressFor = async (bot, port, fromNodeId) => {
    const nodeId = nodeService.resolveNodeId(bot.nodeId);
    if (nodeId === fromNodeId) return { url: `http://127.0.0.1:${port}`, host: "127.0.0.1", local: true, nodeId };
    const node = await nodeService.getNode(nodeId);
    const host = node.wgOverlayIp || node.host;
    return { url: `http://${host}:${port}`, host, local: false, nodeId, overlay: !!node.wgOverlayIp };
};

/**
 * Resolve one integration. `fromNodeId` defaults to the node this panel runs on;
 * the panel-move preflight passes the target node to see the address the NEW
 * panel will use.
 * → { url, source: "project" | "env" | "default" | "none", ... }
 */
const resolve = async (name, { fromNodeId } = {}) => {
    const d = def(name);
    const link = (await getLinks())[name];
    if (link?.botId) {
        const bot = await db.findOne("bots", { _id: link.botId });
        if (!bot) {
            const err = new Error(`${d.label}: the linked project no longer exists — re-link it on the Panel page`);
            err.status = 503;
            throw err;
        }
        const from = fromNodeId ?? nodeService.panelNodeId();
        return { source: "project", botId: bot._id, botName: bot.name, port: link.port, ...(await addressFor(bot, link.port, from)) };
    }
    const envUrl = process.env[d.env];
    if (envUrl) return { source: "env", url: envUrl.replace(/\/$/, "") };
    if (d.fallback) return { source: "default", url: d.fallback };
    return { source: "none", url: null };
};

/** The integration linked to a project on `port` → { name, botId, port }, or null. */
const linkOnPort = async (port) => {
    if (!port) return null;
    const hit = Object.entries(await getLinks()).find(([, l]) => l?.botId && Number(l.port) === Number(port));
    return hit ? { name: hit[0], ...hit[1] } : null;
};

/** Base URL only — what the shop/assistant/DM clients call on every request. */
const baseUrl = async (name) => (await resolve(name)).url;

/** Everything the Panel page shows, one row per integration. */
const list = async () => {
    const links = await getLinks();
    return Promise.all(
        Object.entries(DEFS).map(async ([name, d]) => {
            const row = { name, label: d.label, env: d.env, envValue: process.env[d.env] || null, link: links[name] || null };
            try {
                const r = await resolve(name);
                row.url = r.url;
                row.source = r.source;
            } catch (err) {
                row.url = null;
                row.source = "error";
                row.error = err.message;
            }
            return row;
        }),
    );
};

/** Link an integration to a project + port, or pass null to unlink. */
const setLink = async (name, link) => {
    def(name);
    const links = await getLinks();
    if (link === null) {
        delete links[name];
    } else {
        const port = parseInt(link?.port, 10);
        if (!port || port < 1 || port > 65535) {
            const err = new Error("A valid port is required");
            err.status = 400;
            throw err;
        }
        const bot = await db.findOne("bots", { _id: link?.botId });
        if (!bot) {
            const err = new Error("Project not found");
            err.status = 404;
            throw err;
        }
        links[name] = { botId: bot._id, port };
    }
    await db.set(KEY, links);
    return links[name] || null;
};

module.exports = { DEFS, resolve, baseUrl, list, setLink, isLoopbackUrl, addressFor, linkOnPort };
