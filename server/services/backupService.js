const cron = require("node-cron");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const Database = require("better-sqlite3");
const archive = require("./backupArchive");
const lifecycle = require("./lifecycle");
const { envValue } = require("../utils/envText");

// ─────────────────────────────────────────────────────────────────────────────
//  Hourly backup to Discord, and rolling back to one of those backups.
//
//  The file format and the restore itself are services/backupArchive.js (the
//  template-discord-bot mechanism). This side sends a backup as ONE message to
//  DISCORD_BACKUP_WEBHOOK and, for a rollback, reads such a message back by its
//  link — through the same webhook (it can read what it sent), else through the
//  panel's own Discord bot — verifies it, stages its files in restore/ and has
//  the agent restart the panel, which restores them on the way up.
//
//  Every message sent is recorded in data/backup-index.json (message ids, not
//  attachment URLs: those expire after 24 h). It lives outside panel.sqlite so a
//  rollback does not erase the list it was chosen from.
// ─────────────────────────────────────────────────────────────────────────────

const INDEX_FILE = () => path.join(archive.targets().dataDir, "backup-index.json");
const INDEX_MAX = 500;
const LIST_MAX = 50;
const DISCORD_API = "https://discord.com/api/v10";
const MESSAGE_LINK = /discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/;

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Discord's own words when it refuses, else the transport error. */
const reason = (err) => {
    const r = err.response;
    if (!r) return err.message;
    const body = Buffer.isBuffer(r.data) ? r.data.toString("utf8") : typeof r.data === "string" ? r.data : JSON.stringify(r.data);
    return `${r.status} ${String(body || "").slice(0, 200)}`;
};

// ── Webhook ──────────────────────────────────────────────────────────────────

/** { base, thread } of DISCORD_BACKUP_WEBHOOK, or null. */
const webhook = () => {
    const raw = process.env.DISCORD_BACKUP_WEBHOOK;
    if (!raw) return null;
    try {
        const u = new URL(raw);
        const thread = u.searchParams.get("thread_id");
        u.search = "";
        return { base: u.toString().replace(/\/+$/, ""), thread };
    } catch {
        return null;
    }
};

let hookInfoCache = null;
/** { guildId, channelId } the webhook posts to — for "open in Discord" links. */
const hookInfo = async (hook) => {
    if (hookInfoCache?.base === hook.base) return hookInfoCache;
    const { data } = await axios.get(hook.base, { timeout: 15_000 });
    hookInfoCache = { base: hook.base, guildId: data.guild_id || null, channelId: hook.thread || data.channel_id || null };
    return hookInfoCache;
};

/**
 * The words of a backup message: template panel.backup.message (server/templates/panel.js,
 * editable on the Embeds page). Rollback reads the attachments, never this text.
 */
const backupContent = (built) => {
    const { summary } = built;
    try {
        const { content, embeds } = require("./panelTemplates").message("panel.backup.message", {
            ts: archive.readableTs(summary.ts),
            dbs: Object.entries(summary.dbs).map(([kind, d]) => ({
                kind,
                size: archive.fmtSize(d.size),
                gz: archive.fmtSize(d.gz),
                chunks: d.chunks,
                hash8: d.hash8,
                __text: kind,
            })),
            env: !!summary.env,
        });
        return { content, embeds };
    } catch (err) {
        console.warn(`[Backup] message template: ${err.message}`);
        return { content: built.content };
    }
};

const send = async (hook, payload, files) => {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }));
    files.forEach((f, i) => form.append(`files[${i}]`, f.data, { filename: f.name, contentType: "application/octet-stream" }));
    const { data } = await axios.post(hook.base, form, {
        params: { wait: true, ...(hook.thread ? { thread_id: hook.thread } : {}) },
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 300_000,
    });
    return data;
};

// ── Index of sent backups ────────────────────────────────────────────────────

const readIndex = () => {
    try {
        const list = JSON.parse(fs.readFileSync(INDEX_FILE(), "utf8"));
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
};

const appendIndex = (entry) => {
    const list = [...readIndex(), entry].slice(-INDEX_MAX);
    const tmp = `${INDEX_FILE()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list));
    fs.renameSync(tmp, INDEX_FILE());
};

const linkOf = ({ guildId, channelId, messageId }) =>
    guildId && channelId && messageId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : null;

// ── Backup ───────────────────────────────────────────────────────────────────

let running = false;
let last = null; // { at, ok, message }

/**
 * One backup run. Never throws — a failed backup must not hurt the panel
 * (B9); the next run tries again. Returns { ok, entry } or { ok: false, error }.
 */
const performBackup = async ({ reason: why = "scheduled" } = {}) => {
    if (running) return { ok: false, error: "A backup is already running" };
    const hook = webhook();
    if (!hook) {
        console.warn("[Backup] DISCORD_BACKUP_WEBHOOK is not set (or not a URL) — skipped");
        return { ok: false, error: "DISCORD_BACKUP_WEBHOOK is not set" };
    }

    running = true;
    let tmp = null;
    try {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panel-backup-"));
        const t = archive.targets();
        const built = archive.build({
            dbs: [
                { kind: "panel", file: t.panel },
                { kind: "shared", file: t.shared },
            ],
            envFile: t.env,
            tmpDir: tmp,
        });
        const msg = await send(hook, backupContent(built), built.files);
        const info = await hookInfo(hook).catch(() => null);

        const entry = {
            ts: built.ts,
            at: Date.now(),
            reason: why,
            messageId: msg.id,
            channelId: msg.channel_id || info?.channelId || null,
            guildId: info?.guildId || null,
            dbs: built.summary.dbs,
            env: built.summary.env,
            files: built.files.map((f) => ({ name: f.name, size: f.data.length })),
        };
        try {
            appendIndex(entry);
        } catch (err) {
            console.error(`[Backup] Sent, but not recorded in the index: ${err.message}`);
        }

        const what = Object.entries(built.summary.dbs)
            .map(([k, d]) => `${k} ${archive.fmtSize(d.gz)}`)
            .join(", ");
        last = { at: entry.at, ok: true, message: `${what}${built.summary.env ? " + .env" : ""}` };
        console.log(`[Backup] Sent ${built.files.length} file(s) — ${last.message}`);
        return { ok: true, entry };
    } catch (err) {
        const message = reason(err);
        last = { at: Date.now(), ok: false, message };
        console.error(`[Backup] Backup failed: ${message}`);
        return { ok: false, error: message };
    } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
        running = false;
    }
};

const intervalHours = () => Math.min(24, Math.max(1, Math.round(Number(process.env.BACKUP_INTERVAL_HOURS) || 1)));
const scheduleText = () => (intervalHours() === 1 ? "every hour at :30" : `every ${intervalHours()} hours at :30`);

/**
 * Start the backup cron job — at :30 (offset from the expiry check at :00),
 * every BACKUP_INTERVAL_HOURS hours (default 1). Guarded: a panel that is not
 * active (moving, or replaced by a newer one) must not send stale data.
 */
const start = () => {
    const hours = intervalHours();
    cron.schedule(hours === 1 ? "30 * * * *" : `30 */${hours} * * *`, lifecycle.guard(() => performBackup()));
    console.log(`[Backup] Backup service started — runs ${scheduleText()}`);
};

// ── Reading a backup back from Discord ───────────────────────────────────────

/** A message link (Copy Message Link) or a bare message id. */
const parseSource = (source) => {
    const s = String(source || "").trim();
    const m = MESSAGE_LINK.exec(s);
    if (m) return { channelId: m[2], messageId: m[3] };
    if (/^\d{17,20}$/.test(s)) return { channelId: null, messageId: s };
    throw httpError(400, "Paste a Discord message link (Copy Message Link) or a message ID");
};

/**
 * The message, read through the backup webhook (it can read what it sent),
 * else through the panel's Discord bot (when it can see that channel).
 * Fetching it is also what renews the attachments' signed URLs.
 */
const fetchMessage = async ({ channelId, messageId }) => {
    const errors = [];
    const hook = webhook();
    if (hook) {
        try {
            const { data } = await axios.get(`${hook.base}/messages/${messageId}`, {
                params: hook.thread ? { thread_id: hook.thread } : {},
                timeout: 20_000,
            });
            return data;
        } catch (err) {
            errors.push(`backup webhook: ${reason(err)}`);
        }
    }
    const token = process.env.PANEL_DISCORD_TOKEN;
    const channel = channelId || (hook ? (await hookInfo(hook).catch(() => null))?.channelId : null);
    if (token && channel) {
        try {
            const { data } = await axios.get(`${DISCORD_API}/channels/${channel}/messages/${messageId}`, {
                headers: { Authorization: `Bot ${token}` },
                timeout: 20_000,
            });
            return data;
        } catch (err) {
            errors.push(`panel bot: ${reason(err)}`);
        }
    }
    if (!errors.length) throw httpError(400, "Neither DISCORD_BACKUP_WEBHOOK nor PANEL_DISCORD_TOKEN is set — nothing can read the message");
    throw httpError(404, `Could not read that message — ${errors.join("; ")}`);
};

/** The backup files attached to a message: { message, files: [{ name, data }] }. */
const download = async (source) => {
    const ref = parseSource(source);
    const msg = await fetchMessage(ref);
    const atts = (msg.attachments || []).filter((a) => archive.parseName(a.filename));
    if (!atts.length) throw httpError(400, "That message carries no panel backup files");

    const files = [];
    for (const a of atts) {
        try {
            const { data } = await axios.get(a.url, { responseType: "arraybuffer", timeout: 180_000, maxContentLength: 64 * 1024 * 1024 });
            files.push({ name: a.filename, data: Buffer.from(data) });
        } catch (err) {
            throw httpError(502, `Downloading ${a.filename} failed: ${reason(err)}`);
        }
    }
    return { message: { id: msg.id, channelId: msg.channel_id || ref.channelId, timestamp: msg.timestamp }, files };
};

// ── Comparing a backup with what is here now ─────────────────────────────────

const short = (json) => crypto.createHash("sha1").update(json).digest("hex").slice(0, 12);

/** panel.sqlite: every quick.db key → { kind, n, sig } (n = records / keys). */
const panelStats = (file) => {
    const conn = new Database(file, { readonly: true, fileMustExist: true });
    try {
        const keys = {};
        let lease = null;
        let nodes = [];
        for (const { ID, json } of conn.prepare("SELECT ID, json FROM json").all()) {
            let v;
            try {
                v = JSON.parse(json);
            } catch {
                continue;
            }
            const kind = Array.isArray(v) ? "list" : v && typeof v === "object" ? "map" : "value";
            keys[ID] = { kind, n: kind === "list" ? v.length : kind === "map" ? Object.keys(v).length : null, sig: short(json) };
            if (ID === "panel_lease") lease = v;
            if (ID === "nodes" && Array.isArray(v)) nodes = v;
        }
        return { keys, lease, nodes };
    } finally {
        conn.close();
    }
};

/** shared.sqlite: every shared name → { kind, n, sig }, plus its other tables' row counts. */
const sharedStats = (file) => {
    const conn = new Database(file, { readonly: true, fileMustExist: true });
    try {
        const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
        const out = {};
        if (tables.includes("names")) {
            const docs = tables.includes("docs");
            const kv = tables.includes("kv");
            for (const { name, kind } of conn.prepare("SELECT name, kind FROM names").all()) {
                if (kind === "collection" && docs) {
                    const r = conn.prepare("SELECT COUNT(*) n, COALESCE(MAX(seq), 0) s, COALESCE(SUM(LENGTH(doc)), 0) b FROM docs WHERE name = ?").get(name);
                    out[name] = { kind: "list", n: r.n, sig: `${r.n}:${r.s}:${r.b}` };
                } else if (kv) {
                    const row = conn.prepare("SELECT value FROM kv WHERE name = ?").get(name);
                    out[name] = { kind: "value", n: null, sig: row ? short(String(row.value)) : "-" };
                }
            }
        }
        for (const t of tables.filter((t) => !["names", "docs", "kv"].includes(t))) {
            const n = conn.prepare(`SELECT COUNT(*) n FROM "${t.replace(/"/g, '""')}"`).get().n;
            out[`table:${t}`] = { kind: "list", n, sig: String(n) };
        }
        return out;
    } finally {
        conn.close();
    }
};

/** Rows of { key, kind, now, backup, changed } for the keys of both sides. */
const compare = (now, backup) =>
    [...new Set([...Object.keys(now || {}), ...Object.keys(backup || {})])].sort().map((key) => {
        const a = now?.[key];
        const b = backup?.[key];
        return {
            key,
            kind: (b || a).kind,
            now: a ? a.n : undefined,
            backup: b ? b.n : undefined,
            changed: !a || !b || a.sig !== b.sig,
        };
    });

const envKeys = (text) => {
    const map = new Map();
    for (const line of String(text || "").split("\n")) {
        const idx = line.indexOf("=");
        if (idx > 0 && !line.trim().startsWith("#")) map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
    }
    return map;
};

/** Which keys differ — names only, never values. */
const compareEnv = (nowText, backupText) => {
    const a = envKeys(nowText);
    const b = envKeys(backupText);
    return {
        changed: [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)).sort(),
        onlyInBackup: [...b.keys()].filter((k) => !a.has(k)).sort(),
        onlyNow: [...a.keys()].filter((k) => !b.has(k)).sort(),
    };
};

/** What restoring `planned` would change, for the Panel page. */
const describePlan = (planned, message) => {
    const t = archive.targets();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panel-rollback-"));
    try {
        const parts = {};
        const notes = [...planned.warnings];

        if (planned.dbs.panel) {
            const file = path.join(tmp, "panel.sqlite");
            fs.writeFileSync(file, planned.dbs.panel.data);
            const backup = panelStats(file);
            const now = fs.existsSync(t.panel) ? panelStats(t.panel) : { keys: {}, lease: null, nodes: [] };
            const nodeName = (id) => [...now.nodes, ...backup.nodes].find((n) => n._id === id)?.name || id;
            const here = process.env.PANEL_NODE_ID;
            if (backup.lease?.nodeId && here && backup.lease.nodeId !== here) {
                notes.push(`Taken while the panel ran on ${nodeName(backup.lease.nodeId)} — node addresses get the same fix-up as after a move`);
            }
            if ((now.lease?.epoch || 0) > (backup.lease?.epoch || 0)) {
                notes.push(`Epoch stays at ${now.lease.epoch} (the backup has ${backup.lease?.epoch ?? "none"}) so the agents keep following this panel`);
            }
            parts.panel = {
                size: planned.dbs.panel.data.length,
                hash8: planned.dbs.panel.hash8,
                rows: compare(now.keys, backup.keys).filter((r) => r.key !== "panel_lease"),
            };
        }

        if (planned.dbs.shared) {
            const file = path.join(tmp, "shared.sqlite");
            fs.writeFileSync(file, planned.dbs.shared.data);
            parts.shared = {
                size: planned.dbs.shared.data.length,
                hash8: planned.dbs.shared.hash8,
                rows: compare(fs.existsSync(t.shared) ? sharedStats(t.shared) : {}, sharedStats(file)),
            };
        }

        if (planned.env) {
            const nowText = fs.existsSync(t.env) ? fs.readFileSync(t.env, "utf8") : "";
            const backupText = planned.env.data.toString("utf8");
            const diff = compareEnv(nowText, backupText);
            // PANEL_NODE_ID is always kept — it names this machine.
            diff.changed = diff.changed.filter((k) => k !== "PANEL_NODE_ID");
            const said = envValue(backupText, "PANEL_NODE_ID");
            if (said && said !== envValue(nowText, "PANEL_NODE_ID")) notes.push(".env: PANEL_NODE_ID stays this machine's");
            parts.env = diff;
        }

        return {
            ts: planned.ts,
            takenAt: archive.readableTs(planned.ts),
            message,
            parts,
            notes,
        };
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
};

/** Download + verify + compare. Nothing is written. */
const inspect = async (source) => {
    const { message, files } = await download(source);
    return describePlan(archive.plan(files), message);
};

// ── Rolling back ─────────────────────────────────────────────────────────────

/** Remove the backup files waiting in restore/ (only those). Returns their names. */
const clearPending = () => {
    const dir = archive.targets().restoreDir;
    const names = archive.pending();
    for (const n of names) fs.rmSync(path.join(dir, n), { force: true });
    return names;
};

/**
 * Stage the chosen parts of a backup in restore/ and restart the panel; the
 * restore happens on the way up (backupArchive.restore, before dotenv).
 * `parts` = { panel, shared, env } booleans. Files are re-downloaded and
 * re-verified here — nothing from an earlier inspect is trusted.
 */
const rollback = async (source, parts = {}) => {
    const { files } = await download(source);
    const planned = archive.plan(files);

    const keep = (f) => {
        const p = archive.parseName(f.name);
        if (!p || p.ts !== planned.ts) return false;
        if (p.kind === "env") return !!parts.env && planned.env?.name === f.name;
        return !!parts[p.kind] && planned.dbs[p.kind]?.hash8 === p.hash8;
    };
    const chosen = files.filter(keep);
    if (!chosen.some((f) => archive.parseName(f.name).kind !== "env")) {
        throw httpError(400, "Choose at least one database to restore");
    }

    const dir = archive.targets().restoreDir;
    fs.mkdirSync(dir, { recursive: true });
    clearPending();
    for (const f of chosen) fs.writeFileSync(path.join(dir, f.name), f.data);
    // The very check the boot will run, on the files as they now sit on disk.
    try {
        archive.plan(archive.readDir(dir).files);
    } catch (err) {
        clearPending();
        throw err;
    }
    console.log(`[Backup] Rollback to ${planned.ts} staged: ${chosen.map((f) => f.name).join(", ")}`);

    let restartError = null;
    try {
        await require("./panelService").restartPanel();
    } catch (err) {
        restartError = err.response?.data?.error || err.message;
        console.error(`[Backup] Rollback staged but the restart failed: ${restartError}`);
    }
    return { ts: planned.ts, staged: chosen.map((f) => f.name), restarted: !restartError, restartError };
};

// ── Overview for the Panel page ──────────────────────────────────────────────

const overview = () => ({
    configured: !!webhook(),
    canReadWithBot: !!process.env.PANEL_DISCORD_TOKEN,
    schedule: scheduleText(),
    running,
    last,
    entries: readIndex()
        .slice(-LIST_MAX)
        .reverse()
        .map((e) => ({
            ...e,
            link: linkOf(e),
            // What the page sends back to inspect it; carries the channel when known.
            source: linkOf(e) || (e.channelId ? `https://discord.com/channels/@me/${e.channelId}/${e.messageId}` : e.messageId),
        })),
    pending: archive.pending(),
    lastRestore: archive.lastResult(),
});

module.exports = { start, performBackup, overview, inspect, rollback, clearPending };
