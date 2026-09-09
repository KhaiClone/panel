/**
 * proxyPool.js
 * The egress-proxy POLICY layer: given a sticky key, hand back an axios httpsAgent
 * that routes outbound HTTPS through some other IP. Two sources feed the pool:
 *
 *   "node"  — an agent VPS the panel already owns. Every agent exposes an
 *             authenticated HTTPS CONNECT proxy on its agent port
 *             (agent/services/proxy.js), so any node can be egress at no extra cost.
 *   "proxy" — a proxy YOU bought and registered on the /proxies page
 *             (server/services/proxyStore.js). Static or rotating.
 *
 * Which sources are used is a per-feature SETTING, not a hardcoded default — see
 * getSettings(). Auto Quest is the first consumer; `feature` keys the settings so
 * later features get their own switches without touching this file.
 *
 * Selection is STICKY per key (hash): the same key always maps to the same source,
 * so an account keeps one stable egress IP across restarts (until the pool changes).
 *
 * LEASES. acquire() hands back a handle that must be released when the run ends.
 * While a bought proxy is leased it counts as busy, and proxyStore's idle rotation
 * skips it. That is deliberate: rotating a proxy in the middle of an auto quest run
 * is the one thing that can break it (questEngine._completeAchievement straddles
 * several requests in one OAuth flow), so IPs only ever change BETWEEN runs.
 */

const nodeService = require("./nodeService");
const proxyStore = require("./proxyStore");
const db = require("../db");
const { HttpsProxyAgent } = require("https-proxy-agent");

const SETTINGS_KEY = "egress_settings";

// Defaults reproduce the behavior from before this file grew settings: every agent
// node is egress. Bought proxies win when any exist, so adding one to the panel
// takes effect without also having to flip a switch.
const DEFAULTS = {
    quest: {
        useNodes: true,
        useCustomProxies: true,
        // "custom" → bought proxies first, nodes only as fallback.
        // "nodes"  → the reverse. "mixed" → one flat pool, sticky across both.
        priority: "custom",
    },
    // Auto Badge. Sending /science events is short (seconds), so a lease is held
    // only for the length of one order — unlike quest, which holds one for hours.
    badge: {
        useNodes: true,
        useCustomProxies: true,
        priority: "custom",
    },
};

// ── Settings ─────────────────────────────────────────────────────────────────────

function _mergeFeature(stored, feature) {
    const base = DEFAULTS[feature] ?? DEFAULTS.quest;
    return { ...base, ...(stored?.[feature] ?? {}) };
}

/** All feature settings, defaults filled in. */
async function getSettings() {
    const stored = (await db.get(SETTINGS_KEY)) || {};
    const out = {};
    for (const feature of Object.keys(DEFAULTS)) out[feature] = _mergeFeature(stored, feature);
    return out;
}

async function featureSettings(feature = "quest") {
    return _mergeFeature((await db.get(SETTINGS_KEY)) || {}, feature);
}

/** Patch one feature's settings. Unknown keys are dropped. */
async function updateSettings(feature, patch = {}) {
    if (!DEFAULTS[feature]) {
        const e = new Error(`Tính năng không hợp lệ: ${feature}`);
        e.status = 400;
        throw e;
    }
    const stored = (await db.get(SETTINGS_KEY)) || {};
    const next = { ...DEFAULTS[feature], ...(stored[feature] ?? {}) };
    if (patch.useNodes !== undefined) next.useNodes = !!patch.useNodes;
    if (patch.useCustomProxies !== undefined) next.useCustomProxies = !!patch.useCustomProxies;
    if (patch.priority !== undefined) {
        const p = String(patch.priority);
        if (!["custom", "nodes", "mixed"].includes(p)) {
            const e = new Error("priority phải là custom | nodes | mixed");
            e.status = 400;
            throw e;
        }
        next.priority = p;
    }
    await db.set(SETTINGS_KEY, { ...stored, [feature]: next });
    return next;
}

// ── Node source ──────────────────────────────────────────────────────────────────

function _restrictNames() {
    return (process.env.QUEST_PROXY_NODES || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

/** Agent nodes usable as proxies (enabled, not confirmed-down), in a stable order. */
async function proxyNodes() {
    const nodes = await nodeService.getNodes();
    const restrict = _restrictNames(); // empty → every agent qualifies
    return nodes
        .filter((n) => {
            if (n.enabled === false) return false;
            if (n.questProxy === false) return false; // opted out per node
            if (nodeService.isNodeOffline(n._id)) return false; // skip confirmed-down
            if (!restrict.length) return true;
            const name = String(n.name).toLowerCase();
            return restrict.some((w) => name === w || name.includes(w));
        })
        .sort((a, b) => String(a._id).localeCompare(String(b._id)));
}

function _nodeProxyUrl(node) {
    // Auth embedded so https-proxy-agent sends Proxy-Authorization: Basic proxy:<key>.
    return `http://proxy:${encodeURIComponent(node.apiKey)}@${node.host}:${node.port}`;
}

function _nodeEntry(node) {
    return {
        kind: "node",
        id: node._id,
        label: node.name,
        endpoint: `${node.host}:${node.port}`,
        rotating: false,
        build: () => new HttpsProxyAgent(_nodeProxyUrl(node)),
    };
}

function _proxyEntry(rec) {
    return {
        kind: "proxy",
        id: rec._id,
        label: rec.label,
        endpoint: proxyStore.displayUrl(rec),
        rotating: rec.type === "rotating",
        build: () => proxyStore.buildAgent(rec),
    };
}

// ── Pool assembly ────────────────────────────────────────────────────────────────

/**
 * The ordered tiers a feature may draw from. The first non-empty tier wins, so a
 * "custom" priority falls back to nodes only when no bought proxy is available.
 */
async function _tiers(feature) {
    const s = await featureSettings(feature);
    const custom = s.useCustomProxies ? (await proxyStore.usable(feature)).map(_proxyEntry) : [];
    const nodes = s.useNodes ? (await proxyNodes()).map(_nodeEntry) : [];
    if (s.priority === "mixed") return [[...custom, ...nodes]];
    return s.priority === "nodes" ? [nodes, custom] : [custom, nodes];
}

// djb2 string hash → unsigned int, for sticky assignment.
function _hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h;
}

/** What the pool looks like right now — for the settings UI. */
async function describePool(feature = "quest") {
    const s = await featureSettings(feature);
    const custom = (await proxyStore.usable(feature)).map(_proxyEntry);
    const nodes = (await proxyNodes()).map(_nodeEntry);
    const strip = (e) => ({
        kind: e.kind,
        id: e.id,
        label: e.label,
        endpoint: e.endpoint,
        rotating: e.rotating,
        busy: (busy.get(e.id) ?? 0) > 0,
    });
    const tiers = await _tiers(feature);
    const active = tiers.find((t) => t.length) ?? [];
    return {
        settings: s,
        customProxies: custom.map(strip),
        nodes: nodes.map(strip),
        // Which source auto quest is actually drawing from with these settings.
        activeSource: active.length ? active[0].kind : null,
        activeCount: active.length,
    };
}

// ── Leases ───────────────────────────────────────────────────────────────────────

// entry id -> number of live runs holding it. Only bought proxies matter (nodes
// have nothing to rotate), but counting both keeps describePool honest.
const busy = new Map();

function isBusy(id) {
    return (busy.get(id) ?? 0) > 0;
}

function _hold(id) {
    busy.set(id, (busy.get(id) ?? 0) + 1);
}

function _drop(id) {
    const n = (busy.get(id) ?? 0) - 1;
    if (n > 0) busy.set(id, n);
    else busy.delete(id);
}

// proxyStore's idle sweep asks us whether an IP is safe to change right now.
proxyStore.setBusyProbe(isBusy);

/** A no-op handle, so callers never have to null-check before releasing. */
const NO_PROXY = { agent: null, source: null, release: () => {} };

/**
 * Lease an egress route for `key` (sticky). Release the handle when the run ends:
 *
 *   const lease = await proxyPool.acquire(token);
 *   try { ...run with lease.agent... } finally { lease.release(); }
 *
 * Pass { failed: true } to release() when the run died — a rotating proxy then
 * changes IP immediately (still throttled) instead of waiting for its idle timer.
 */
async function acquire(key, { feature = "quest" } = {}) {
    const tiers = await _tiers(feature);
    const pool = tiers.find((t) => t.length);
    if (!pool) return NO_PROXY;

    const entry = pool[_hash(String(key)) % pool.length];
    _hold(entry.id);

    // Rotate BEFORE the run starts, never during: this is the only safe moment.
    // Throttled inside proxyStore, so simultaneous starts share one rotation.
    if (entry.kind === "proxy" && entry.rotating) {
        await proxyStore.rotate(entry.id, { reason: "run-start" }).catch(() => {});
    }
    if (entry.kind === "proxy") {
        await proxyStore._touch(entry.id, { lastUsedAt: Date.now() }).catch(() => {});
    }

    let agent;
    try {
        agent = entry.build();
    } catch (err) {
        // A malformed record must not strand its refcount, or the proxy would look
        // permanently busy and never rotate again.
        _drop(entry.id);
        console.warn(`[Proxy] cannot use "${entry.label}": ${err.message}`);
        return NO_PROXY;
    }

    let released = false;
    return {
        agent,
        source: { kind: entry.kind, id: entry.id, label: entry.label },
        release: ({ failed = false } = {}) => {
            if (released) return;
            released = true;
            _drop(entry.id);
            if (failed && entry.kind === "proxy" && entry.rotating) {
                proxyStore.rotate(entry.id, { reason: "run-failed" }).catch(() => {});
            }
        },
    };
}

/**
 * One-shot agent for a short request (token preview, validation) — no lease, so it
 * does not block rotation. Long-running work must use acquire() instead.
 * Returns null when no egress is configured (caller egresses directly).
 */
async function agentForKey(key, { feature = "quest" } = {}) {
    const tiers = await _tiers(feature);
    const pool = tiers.find((t) => t.length);
    if (!pool) return null;
    return pool[_hash(String(key)) % pool.length].build();
}

/** Kept for callers that only want to know which node a key maps to. */
async function pickProxyNode(key) {
    const nodes = await proxyNodes();
    if (!nodes.length) return null;
    return nodes[_hash(String(key)) % nodes.length];
}

module.exports = {
    getSettings,
    featureSettings,
    updateSettings,
    describePool,
    proxyNodes,
    pickProxyNode,
    acquire,
    agentForKey,
    isBusy,
};
