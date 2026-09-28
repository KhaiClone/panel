const crypto = require("crypto");
const axios = require("axios");
const sharedStore = require("./sharedStore");
const lifecycle = require("./lifecycle");

// ─────────────────────────────────────────────────────────────────────────────
//  The public decor site (decor.thunderbolt.io.vn, static on Vercel) reads
//  data/decors.json + data/categories.json from its own repo, so it keeps
//  working whatever VPS is down. This keeps those two files equal to the
//  shared decor data: a minute after the data changes, the new snapshot is
//  committed through the GitHub API and the host redeploys.
//
//    DECOR_SITE_GITHUB_TOKEN  fine-grained token, Contents: read & write on the repo only
//    DECOR_SITE_REPO          owner/name (default KhaiClone/decor-site), branch DECOR_SITE_BRANCH (master)
//
//  No token = off (status says so). Nothing is committed when the rendered
//  files did not change.
// ─────────────────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 60_000;
const WATCH = new Set(["decors", "importedDecors", "prices", "decorCategories"]);
const LAST = "__decorSite.hash";

const token = () => process.env.DECOR_SITE_GITHUB_TOKEN || "";
const repo = () => process.env.DECOR_SITE_REPO || "KhaiClone/decor-site";
const branch = () => process.env.DECOR_SITE_BRANCH || "master";

let timer = null;
let last = { at: null, ok: null, message: null };

const kvGet = (name) => {
    const r = sharedStore.raw().prepare("SELECT value FROM kv WHERE name = ?").get(name);
    return r ? JSON.parse(r.value) : null;
};
const kvSet = (name, value) => sharedStore.raw().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(name, JSON.stringify(value));

const gh = axios.create({ baseURL: "https://api.github.com", timeout: 30_000 });
const headers = () => ({ Authorization: `Bearer ${token()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });

const putFile = async (path, text, message) => {
    const url = `/repos/${repo()}/contents/${path}`;
    const current = await gh.get(url, { headers: headers(), params: { ref: branch() } }).catch((err) => {
        if (err.response?.status === 404) return null;
        throw err;
    });
    await gh.put(
        url,
        { message, content: Buffer.from(text).toString("base64"), branch: branch(), ...(current?.data?.sha ? { sha: current.data.sha } : {}) },
        { headers: headers() },
    );
};

/** Render and commit when different from the last published snapshot. */
const publish = async ({ force = false } = {}) => {
    if (!token()) return { ok: false, message: "DECOR_SITE_GITHUB_TOKEN is not set — publishing is off" };
    const decorService = require("./decorService");
    if (!decorService.onPanel()) return { ok: false, message: "The decor data is not on the panel yet" };
    const decors = JSON.stringify(await decorService.listDecors());
    const categories = JSON.stringify(await decorService.listCategories());
    const hash = crypto.createHash("sha256").update(decors).update("\n").update(categories).digest("hex");
    if (!force && kvGet(LAST) === hash) return { ok: true, message: "Unchanged — nothing to publish" };
    const count = JSON.parse(decors).length;
    await putFile("data/decors.json", decors, `data: ${count} decors (panel snapshot)`);
    await putFile("data/categories.json", categories, "data: categories (panel snapshot)");
    kvSet(LAST, hash);
    return { ok: true, message: `Published ${count} decors to ${repo()}` };
};

const run = async (opts) => {
    try {
        const r = await publish(opts);
        last = { at: Date.now(), ok: r.ok, message: r.message };
        if (r.ok && !/Unchanged/.test(r.message)) console.log(`[DecorSite] ${r.message}`);
        return r;
    } catch (err) {
        const message = err.response?.data?.message || err.message;
        last = { at: Date.now(), ok: false, message };
        console.error(`[DecorSite] publish failed: ${message}`);
        return { ok: false, message };
    }
};

const start = () => {
    sharedStore.events.on("change", (name) => {
        if (!WATCH.has(name) || !token()) return;
        clearTimeout(timer);
        timer = setTimeout(lifecycle.guard(() => run()), DEBOUNCE_MS);
    });
};

const status = () => ({ configured: !!token(), repo: repo(), branch: branch(), last });

module.exports = { start, publish: (opts) => run(opts), status };
