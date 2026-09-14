const crypto = require("crypto");
const db = require("../db");

// ─────────────────────────────────────────────────────────────────────────────
//  The single Lavalink config, shared by every node.
//
//  One record, same shape as pricingStore: DEFAULTS live in code, the DB holds
//  only what was changed, and get() merges. Adding a field here does not need a
//  migration — existing rows simply pick up its default.
//
//  `nodes` is per-node STATE (last sync, installed version, last error), not
//  config. Config is deliberately identical everywhere: that is the whole point
//  of the feature.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "lavalink_settings";

const DEFAULTS = {
    enabled: true,

    // ── pushed into application.yml ──
    port: 2333,
    address: "0.0.0.0",
    password: "", // generated on first read — never ship a blank one
    sources: {
        youtube: true,
        bandcamp: true,
        soundcloud: true,
        twitch: true,
        vimeo: true,
        nico: true,
        http: true,
        local: false,
    },
    filters: {
        volume: true, equalizer: true, karaoke: true, timescale: true, tremolo: true,
        vibrato: true, distortion: true, rotation: true, channelMix: true, lowPass: true,
    },
    // Lavalink v4's built-in YouTube source no longer works on its own; the
    // plugin is what actually plays. renderYaml() turns the built-in off
    // whenever this plugin is present.
    plugins: [
        {
            dependency: "dev.lavalink.youtube:youtube-plugin:1.18.2",
            repository: "https://maven.lavalink.dev/releases",
            snapshot: false,
        },
    ],
    bufferDurationMs: 400,
    frameBufferDurationMs: 5000,
    opusEncodingQuality: 10,
    resamplingQuality: "LOW",
    trackStuckThresholdMs: 10000,
    youtubePlaylistLoadLimit: 6,
    playerUpdateInterval: 5,
    yamlOverride: null, // non-empty string = hand-written yaml, used verbatim

    // ── how the panel runs it ──
    heap: "512M", // -Xmx; no pm2 memory cap, the JVM reserves its heap up front
    autoUpdate: true,
    autoInstallOnNewNode: true,
    timezone: "Asia/Ho_Chi_Minh",

    // ── release tracking ──
    installedVersion: null,
    latestVersion: null,
    latestPublishedAt: null,
    lastCheckAt: null,
    lastUpdateAt: null,
    lastError: null,

    nodes: {}, // nodeId → { state, version, configSha, lastSyncAt, error }
};

const _bad = (message) => {
    const e = new Error(message);
    e.status = 400;
    return e;
};

const _merge = (stored = {}) => ({
    ...DEFAULTS,
    ...stored,
    sources: { ...DEFAULTS.sources, ...(stored.sources || {}) },
    filters: { ...DEFAULTS.filters, ...(stored.filters || {}) },
    plugins: Array.isArray(stored.plugins) ? stored.plugins : DEFAULTS.plugins,
    nodes: { ...(stored.nodes || {}) },
});

/**
 * The full settings, defaults filled in.
 * A blank password is replaced by a generated one and persisted immediately —
 * rendering application.yml with no password would let anything on the box
 * control the audio server.
 */
const get = async () => {
    const stored = (await db.get(KEY)) || {};
    const merged = _merge(stored);
    if (!merged.password) {
        merged.password = crypto.randomBytes(18).toString("base64url");
        await db.set(KEY, { ...stored, password: merged.password });
    }
    return merged;
};

/** Settings without the password — for anything that might end up in a log. */
const redacted = (settings) => ({ ...settings, password: settings.password ? "••••••••" : "" });

const CONFIG_KEYS = new Set([
    "port", "address", "password", "sources", "filters", "plugins", "yamlOverride",
    "bufferDurationMs", "frameBufferDurationMs", "opusEncodingQuality", "resamplingQuality",
    "trackStuckThresholdMs", "youtubePlaylistLoadLimit", "playerUpdateInterval",
]);

const RUNTIME_KEYS = new Set(["enabled", "heap", "autoUpdate", "autoInstallOnNewNode", "timezone"]);

const _validate = (patch) => {
    if ("port" in patch) {
        const port = parseInt(patch.port, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw _bad(`Invalid port: ${patch.port}`);
        patch.port = port;
    }
    if ("password" in patch) {
        if (typeof patch.password !== "string" || !patch.password.trim()) {
            throw _bad("Password cannot be empty");
        }
        patch.password = patch.password.trim();
    }
    if ("heap" in patch && !/^\d+[MG]$/i.test(String(patch.heap || ""))) {
        throw _bad(`Invalid heap size: ${patch.heap} — use a form like 512M or 2G`);
    }
    if ("plugins" in patch) {
        if (!Array.isArray(patch.plugins)) throw _bad("plugins must be an array");
        patch.plugins = patch.plugins
            .filter((p) => p && typeof p.dependency === "string" && p.dependency.trim())
            .map((p) => ({
                dependency: p.dependency.trim(),
                repository: (p.repository || "https://maven.lavalink.dev/releases").trim(),
                snapshot: p.snapshot === true,
            }));
    }
    if ("yamlOverride" in patch) {
        const v = patch.yamlOverride;
        if (v !== null && typeof v !== "string") throw _bad("yamlOverride must be a string or null");
        patch.yamlOverride = v && v.trim() ? v : null;
    }
    if ("timezone" in patch) {
        try {
            new Intl.DateTimeFormat("en-US", { timeZone: patch.timezone });
        } catch {
            throw _bad(`Unknown timezone: ${patch.timezone}`);
        }
    }
    for (const key of ["bufferDurationMs", "frameBufferDurationMs", "opusEncodingQuality",
        "trackStuckThresholdMs", "youtubePlaylistLoadLimit", "playerUpdateInterval"]) {
        if (key in patch) {
            const n = Number(patch[key]);
            if (!Number.isFinite(n) || n < 0) throw _bad(`Invalid ${key}: ${patch[key]}`);
            patch[key] = Math.round(n);
        }
    }
    return patch;
};

/**
 * Patch the settings. Unknown keys are ignored, and release-tracking fields are
 * not writable from here — those belong to the updater.
 */
const update = async (patch = {}) => {
    const clean = _validate({ ...patch });
    const stored = (await db.get(KEY)) || {};
    const next = { ...stored };

    for (const [k, v] of Object.entries(clean)) {
        if (!CONFIG_KEYS.has(k) && !RUNTIME_KEYS.has(k)) continue;
        if (k === "sources" || k === "filters") {
            next[k] = { ...(stored[k] || {}), ...(v || {}) };
        } else if (typeof DEFAULTS[k] === "boolean") {
            next[k] = Boolean(v);
        } else {
            next[k] = v;
        }
    }

    await db.set(KEY, next);
    return get();
};

/** Release-tracking fields, written by the updater only. */
const setMeta = async (meta = {}) => {
    const stored = (await db.get(KEY)) || {};
    await db.set(KEY, { ...stored, ...meta });
    return get();
};

/** Merge state for one node (last sync, installed version, last error). */
const setNodeState = async (nodeId, patch = {}) => {
    if (!nodeId) return;
    const stored = (await db.get(KEY)) || {};
    const nodes = { ...(stored.nodes || {}) };
    nodes[nodeId] = { ...(nodes[nodeId] || {}), ...patch, updatedAt: Date.now() };
    await db.set(KEY, { ...stored, nodes });
};

/** Forget a node's state — called when the node itself is deleted. */
const forgetNode = async (nodeId) => {
    const stored = (await db.get(KEY)) || {};
    if (!stored.nodes?.[nodeId]) return;
    const nodes = { ...stored.nodes };
    delete nodes[nodeId];
    await db.set(KEY, { ...stored, nodes });
};

module.exports = { KEY, DEFAULTS, get, update, setMeta, setNodeState, forgetNode, redacted };
