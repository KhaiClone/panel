const os = require("os");
const util = require("util");
const axios = require("axios");

// ─────────────────────────────────────────────────────────────────────────────
//  Panel log — one Discord channel (DISCORD_PANEL_LOG_WEBHOOK) for everything
//  the panel has to say, except the customer-facing expiry / renewal alerts:
//
//    notice   what the bell shows: bot started / stopped, node offline, …
//    error    every console.error of the server (warn: every console.warn)
//    system   panel started, moving, back to active; backups; Lavalink report
//    staff    sign-ins and sign-outs, every change staff make (owner: what the
//             owner changed about staff)
//
//  Bot expiry warnings / removals and the stock renewal reminders stay on
//  DISCORD_ALERT_WEBHOOK — they ping buyers, so that channel may be one they
//  can see; this one carries IPs and errors and must stay private.
//  Unset (or not a Discord webhook URL) = nothing is sent.
//
//  Lines are batched into one message every few seconds (Discord takes about 30
//  webhook posts a minute), the same warning or error repeated within 10
//  minutes is counted instead of re-sent, and anything that looks like a token
//  or a webhook URL is masked. The log is best effort: a line that cannot be
//  posted is dropped (the server's own log still has it).
// ─────────────────────────────────────────────────────────────────────────────

const FLUSH_MS = 4000;
const MAX_QUEUE = 300;
const MAX_LINE = 500;
const MAX_DESC = 3900;
const REPEAT_MS = 10 * 60 * 1000;

const ICON = { notice: "🔔", system: "🖥️", staff: "👤", owner: "👑", warn: "⚠️", error: "❌" };
const COLOR = { error: 0xed4245, warn: 0xf0b232, other: 0x5865f2 };

// The real console, for what this module itself has to say: going through the
// captured one would feed its own failures back into the queue.
const orig = { error: console.error.bind(console), warn: console.warn.bind(console) };

let queue = [];
let dropped = 0;
let timer = null;
let sending = false;
let pausedUntil = 0;
let lastSentAt = null;
let lastError = null;
const repeats = new Map(); // line → { at, count } for warn / error

const url = () => process.env.DISCORD_PANEL_LOG_WEBHOOK || "";
const enabled = () => /^https:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/.test(url());

/** Mask what must never reach a channel: webhook URLs, JWTs, Discord tokens. */
const redact = (s) =>
    String(s)
        .replace(/https:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"'`)]+/g, "[webhook]")
        .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "[jwt]")
        .replace(/\b(?:mfa\.[\w-]{20,}|[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{25,})\b/g, "[token]")
        .replace(/\b(Bearer|Bot)\s+[\w.-]{20,}/g, "$1 [token]");

const clean = (s) =>
    redact(s)
        .replace(/\x1b\[[0-9;]*m/g, "") // eslint-disable-line no-control-regex
        .replace(/\s*\n\s*/g, " ⏎ ")
        .trim()
        .slice(0, MAX_LINE);

/** As inline code — for server messages, so paths and names keep their underscores. */
const code = (s) => `\`${s.replace(/`/g, "ʼ")}\``;

/**
 * Queue one line. `kind`: notice | system | staff | owner | warn | error.
 * Text is Discord markdown; { code: true } shows it verbatim instead.
 */
const add = (kind, text, { code: asCode = false } = {}) => {
    if (!enabled()) return;
    let line = clean(text);
    if (!line) return;
    if (kind === "warn" || kind === "error") {
        const now = Date.now();
        const seen = repeats.get(line);
        if (seen && now - seen.at < REPEAT_MS) {
            seen.count++;
            return;
        }
        repeats.set(line, { at: now, count: 0 });
        if (repeats.size > 500) {
            for (const [k, v] of repeats) if (now - v.at >= REPEAT_MS) repeats.delete(k);
        }
        const more = seen?.count ? ` (+${seen.count} more like it in the 10 min before)` : "";
        line = (asCode ? code(line) : line) + more;
    } else if (asCode) {
        line = code(line);
    }
    queue.push({ kind, at: Date.now(), line });
    if (queue.length > MAX_QUEUE) {
        queue.shift();
        dropped++;
    }
    schedule();
};

const schedule = () => {
    if (timer) return;
    timer = setTimeout(flush, Math.max(FLUSH_MS, pausedUntil - Date.now()));
    timer.unref?.();
};

const render = (e) => `${ICON[e.kind] || "•"} <t:${Math.floor(e.at / 1000)}:T> ${e.line}`;

/** Post what is queued, one message per call. Resolves when it is done. */
const flush = async () => {
    timer = null;
    if (sending || !queue.length) return;
    if (!enabled()) {
        queue = [];
        return;
    }
    const batch = [];
    let len = 0;
    if (dropped) {
        batch.push({ kind: "warn", at: Date.now(), line: `${dropped} older line(s) dropped — the log was too busy` });
        len += 80;
        dropped = 0;
    }
    while (queue.length && len + render(queue[0]).length + 1 <= MAX_DESC) {
        const e = queue.shift();
        batch.push(e);
        len += render(e).length + 1;
    }
    const worst = batch.some((e) => e.kind === "error") ? "error" : batch.some((e) => e.kind === "warn") ? "warn" : "other";
    sending = true;
    try {
        await axios.post(
            url(),
            {
                embeds: [{ description: batch.map(render).join("\n"), color: COLOR[worst], footer: { text: os.hostname() }, timestamp: new Date().toISOString() }],
                allowed_mentions: { parse: [] },
            },
            { timeout: 10_000 },
        );
        lastSentAt = Date.now();
        lastError = null;
    } catch (err) {
        if (err.response?.status === 429) {
            // Rate-limited: put the lines back and wait as long as Discord says.
            const wait = Number(err.response.data?.retry_after) || 5;
            pausedUntil = Date.now() + wait * 1000;
            queue.unshift(...batch.filter((e) => e.line));
        } else {
            lastError = { at: Date.now(), message: err.response?.data?.message || err.message };
            orig.error(`[PanelLog] Could not post ${batch.length} line(s): ${err.message}`);
        }
    } finally {
        sending = false;
        if (queue.length) schedule();
    }
};

/** From now on every console.error / console.warn of the server also goes to the log. */
let captured = false;
const captureConsole = () => {
    if (captured) return;
    captured = true;
    for (const level of ["error", "warn"]) {
        console[level] = (...args) => {
            orig[level](...args);
            try {
                add(level, util.format(...args), { code: true });
            } catch {
                /* the log must never break logging */
            }
        };
    }
};

/** For Panel Settings → Overview. */
const status = () => ({ configured: enabled(), set: !!url(), queued: queue.length, lastSentAt, lastError });

module.exports = {
    add,
    flush,
    enabled,
    status,
    captureConsole,
    // for tests
    _redact: redact,
    _reset: () => {
        queue = [];
        dropped = 0;
        pausedUntil = 0;
        repeats.clear();
        if (timer) clearTimeout(timer);
        timer = null;
    },
    _queued: () => queue.map(render),
};
