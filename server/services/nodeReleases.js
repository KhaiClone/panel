const axios = require("axios");

// ─────────────────────────────────────────────────────────────────────────────
//  Node.js releases on offer for a project's version picker.
//
//  nodejs.org/dist/index.json lists every release; the picker only needs the
//  newest of each major line. Cached, and a failure yields an empty list — the
//  picker still works with the system node and the versions already on a node.
// ─────────────────────────────────────────────────────────────────────────────

const INDEX_URL = "https://nodejs.org/dist/index.json";
const CACHE_MS = 6 * 60 * 60 * 1000;
const OLDEST_MAJOR = 14; // anything older is long dead and rarely still runs a bot

let cache = { at: 0, list: [] };

/** [{ version: "22.12.0", major: 22, lts: "Jod" | null, date }] newest major first. */
const latestPerMajor = async () => {
    if (Date.now() - cache.at < CACHE_MS && cache.list.length) return cache.list;
    try {
        const { data } = await axios.get(INDEX_URL, { timeout: 15_000 });
        const byMajor = new Map();
        // index.json is newest-first, so the first hit per major is its latest.
        for (const r of data) {
            const version = String(r.version || "").replace(/^v/, "");
            const major = parseInt(version, 10);
            if (!/^\d+\.\d+\.\d+$/.test(version) || major < OLDEST_MAJOR || byMajor.has(major)) continue;
            byMajor.set(major, { version, major, lts: r.lts || null, date: r.date || null });
        }
        cache = { at: Date.now(), list: [...byMajor.values()].sort((a, b) => b.major - a.major) };
    } catch (err) {
        console.warn(`[Node] Could not fetch the Node.js release list: ${err.message}`);
    }
    return cache.list;
};

module.exports = { latestPerMajor };
