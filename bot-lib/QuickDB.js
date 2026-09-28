const { QuickDB } = require("quick.db");

// ─────────────────────────────────────────────────────────────────────────────
//  QuickDBExtension with shared data — drop-in replacement for a bot's
//  extensions/QuickDB.js (canonical copy: bot-panel/bot-lib/QuickDB.js).
//
//  Names listed in PANEL_SHARED live on the panel (the data the panel and this
//  bot both use); every other name stays in this bot's json.sqlite exactly as
//  before. Calls keep their shape — find / findOne / create / createMany /
//  findOneAndUpdate / findOneAndDelete / deleteMany, and get / set / add / push
//  / delete — so bot code does not change.
//
//    PANEL_API_URL        http://127.0.0.1:4201 — the panel gateway on this node
//    PANEL_API_KEY        this project's own key (Panel Settings → API Keys)
//    PANEL_SHARED         comma separated names, e.g. orders,nextOrderId
//    PANEL_SHARED_TTL_MS  optional: cache whole collections this long (0 = always fresh)
//
//  A listed name NEVER falls back to the local copy: the panel is the only
//  truth for it. When the panel cannot be reached (it is moving, or down), a
//  read answers with the last value this process saw and logs it; a write fails.
//
//  adoptShared() (call it before the bot starts) uploads the local copy of each
//  listed name ONCE, the first time — only for names the admin declared for this
//  project on the panel.
// ─────────────────────────────────────────────────────────────────────────────

const sharedNames = () =>
    new Set(
        String(process.env.PANEL_SHARED || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    );

// Worth answering from the last known value: the panel is unreachable, moving or overloaded.
const transient = (err) => !err.status || err.status >= 500 || err.status === 409 || err.status === 429;

const matches = (e, query = {}) => {
    for (const key in query) if (e?.[key] !== query[key]) return false;
    return true;
};

class PanelData {
    constructor() {
        this.base = String(process.env.PANEL_API_URL || "").replace(/\/+$/, "");
        this.key = process.env.PANEL_API_KEY || "";
        this.ttl = Math.max(0, parseInt(process.env.PANEL_SHARED_TTL_MS || "0", 10) || 0);
        this.whole = new Map(); // name → { at, value } (TTL cache)
        this.last = new Map(); // read key → last answer (fallback)
    }

    async call(method, path, body) {
        if (!this.base || !this.key) throw new Error("[PanelData] PANEL_API_URL / PANEL_API_KEY are not set");
        let res;
        try {
            res = await fetch(`${this.base}/api/external/data${path}`, {
                method,
                headers: { "x-api-key": this.key, ...(body ? { "content-type": "application/json" } : {}) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(30_000),
            });
        } catch (err) {
            throw Object.assign(new Error(`[PanelData] panel unreachable (${err.cause?.code || err.message})`), { status: 0 });
        }
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(`[PanelData] ${json.error || `HTTP ${res.status}`}`), { status: res.status });
        return json;
    }

    remember(key, value) {
        this.last.delete(key);
        this.last.set(key, value);
        if (this.last.size > 500) this.last.delete(this.last.keys().next().value);
    }

    fallback(key, err) {
        if (!transient(err) || !this.last.has(key)) throw err;
        console.warn(`${err.message} — answering from the last known value`);
        return structuredClone(this.last.get(key));
    }

    async read(name, op, query) {
        if (this.ttl > 0) {
            const all = await this.readWhole(name);
            if (op === "get") return all;
            return op === "find" ? all.filter((e) => matches(e, query)) : all.find((e) => matches(e, query));
        }
        const key = `${name}\u0000${op}\u0000${JSON.stringify(query ?? null)}`;
        try {
            const q = new URLSearchParams({ op });
            if (query !== undefined) q.set("query", JSON.stringify(query));
            const { result } = await this.call("GET", `/${encodeURIComponent(name)}?${q}`);
            this.remember(key, result);
            return result;
        } catch (err) {
            return this.fallback(key, err);
        }
    }

    async readWhole(name) {
        const hit = this.whole.get(name);
        if (hit && Date.now() - hit.at < this.ttl) return structuredClone(hit.value);
        try {
            const { result } = await this.call("GET", `/${encodeURIComponent(name)}?op=get`);
            this.whole.set(name, { at: Date.now(), value: result });
            this.remember(`${name}\u0000whole`, result);
            return structuredClone(result);
        } catch (err) {
            return this.fallback(`${name}\u0000whole`, err);
        }
    }

    async write(name, op, args = {}) {
        const { result } = await this.call("POST", `/${encodeURIComponent(name)}`, { op, ...args });
        this.whole.delete(name);
        return result;
    }

    manifest() {
        return this.call("GET", "");
    }
}

class QuickDBExtension extends QuickDB {
    constructor(options) {
        super(options);
        this.shared = sharedNames();
        this.panel = this.shared.size ? new PanelData() : null;
    }

    isShared(name) {
        return this.shared.has(name);
    }

    // ── quick.db primitives ─────────────────────────────────────────────────
    async get(key) {
        return this.isShared(key) ? this.panel.read(key, "get") : super.get(key);
    }
    async set(key, value) {
        return this.isShared(key) ? this.panel.write(key, "set", { value }) : super.set(key, value);
    }
    async add(key, by) {
        return this.isShared(key) ? this.panel.write(key, "add", { by }) : super.add(key, by);
    }
    async push(key, ...items) {
        return this.isShared(key) ? this.panel.write(key, "push", { items }) : super.push(key, ...items);
    }
    async delete(key) {
        return this.isShared(key) ? this.panel.write(key, "delete") : super.delete(key);
    }

    // ── Collections ─────────────────────────────────────────────────────────
    async create(model, data) {
        if (this.isShared(model)) {
            const doc = await this.panel.write(model, "create", { data });
            data._id = doc._id; // callers keep using the object they passed, as before
            return data;
        }
        data._id = require("nanoid").nanoid(24);
        await this.push(model, data);
        return data;
    }
    async createMany(model, arrayData) {
        if (this.isShared(model)) {
            const docs = await this.panel.write(model, "createMany", { items: arrayData });
            arrayData.forEach((e, i) => (e._id = docs[i]._id));
            return arrayData;
        }
        const { nanoid } = require("nanoid");
        arrayData = arrayData.map((e) => {
            e._id = nanoid(24);
            return e;
        });
        await this.push(model, ...arrayData);
        return arrayData;
    }
    async find(model, query = {}) {
        if (this.isShared(model)) return this.panel.read(model, "find", query);
        return ((await this.get(model)) || []).filter((e) => matches(e, query));
    }
    async findOne(model, query) {
        if (this.isShared(model)) return (await this.panel.read(model, "findOne", query)) ?? undefined;
        return ((await this.get(model)) || []).filter((e) => matches(e, query))[0];
    }
    async findOneAndUpdate(model, query, data) {
        if (data?._id) throw new Error("You can't change _id");
        if (this.isShared(model)) return this.panel.write(model, "findOneAndUpdate", { query, data });

        const oldData = (await this.get(model)) || [];
        const newData = oldData;
        const index = oldData.findIndex((e) => matches(e, query));
        if (index === -1) return null;
        newData[index] = { ...oldData[index], ...data };
        await this.set(model, newData);
        return newData[index];
    }
    async findOneAndDelete(model, query) {
        if (this.isShared(model)) return this.panel.write(model, "findOneAndDelete", { query });
        const oldData = (await this.get(model)) || [];
        const index = oldData.findIndex((e) => matches(e, query));
        if (index === -1) return null;
        const newData = [...oldData];
        newData.splice(index, 1);
        await this.set(model, newData);
        return oldData[index];
    }
    async deleteMany(model, query) {
        if (this.isShared(model)) return this.panel.write(model, "deleteMany", { query });
        const oldData = (await this.get(model)) || [];
        const deleted = oldData.filter((e) => matches(e, query));
        const newData = oldData.filter((e) => !matches(e, query));
        await this.set(model, newData);
        return deleted;
    }

    /**
     * Move each PANEL_SHARED name to the panel the first time (its local copy is
     * uploaded; the panel keeps it from then on). Retries while the panel cannot
     * be reached, up to ~5 minutes, and never throws — call it before starting.
     */
    async adoptShared() {
        if (!this.panel) return;
        for (let attempt = 1; attempt <= 20; attempt++) {
            try {
                const { names } = await this.panel.manifest();
                for (const name of this.shared) {
                    const n = names.find((x) => x.name === name);
                    if (!n) {
                        console.error(`[PanelData] "${name}" is in PANEL_SHARED but not declared for this project on the panel`);
                        continue;
                    }
                    if (n.state === "active") continue;
                    const local = await super.get(name);
                    const value = n.kind === "collection" ? local || [] : local ?? null;
                    const r = await this.panel.call("POST", `/${encodeURIComponent(name)}`, { op: "adopt", value });
                    console.log(`[PanelData] "${name}" moved to the panel${r.result?.count != null ? ` (${r.result.count} records)` : ""}`);
                }
                return;
            } catch (err) {
                console.error(`${err.message} — shared data not ready (attempt ${attempt}/20)`);
                if (attempt < 20) await new Promise((r) => setTimeout(r, 15_000));
            }
        }
    }
}

module.exports = QuickDBExtension;
