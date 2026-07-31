/**
 * questMonthly.js
 * Monthly quest subscriptions on the panel (ported from arnto-auto). arnto-auto keeps
 * payment; when a monthly plan is paid it calls activate() here. The panel then runs
 * ALL quests for active subscribers on the schedule (Tue/Sat) + a daily enroll scan,
 * and webhooks quest events back to arnto-auto (DM the buyer).
 *
 * DB model `quest_monthly`: { _id, accountId, username, tokenEncrypted, tokenIv,
 *   tokenTag, monthlyExpiresAt, webhookUrl, ref, addedAt, updatedAt }
 */

const crypto = require("crypto");
const axios = require("axios");
const db = require("../db");
const questService = require("./questService");
const {
    QuestAutocompleter,
    resolveDiscordAccount,
    isInvalidTokenError,
    summarizeQuest,
    _fields,
} = require("./questEngine");

const MODEL = "quest_monthly";
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_DAYS = [2, 6]; // Tue, Sat
const RUN_HOUR = () => parseInt(process.env.MONTHLY_RUN_HOUR || "9", 10) || 9;
const ENROLL_HOUR = () => parseInt(process.env.MONTHLY_ENROLL_HOUR || "3", 10) || 3;
const { isEnrolled, isCompleted, isCompletable, getQuestName, getTaskType } = _fields;

// ── token crypto (same scheme as questService) ──────────────────────────────────
const ALGO = "aes-256-gcm";
const _key = () =>
    crypto
        .createHash("sha256")
        .update(process.env.QUEST_ENC_SECRET || process.env.JWT_SECRET || "quest-fallback-secret")
        .digest();
function _encrypt(token) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv(ALGO, _key(), iv);
    const enc = Buffer.concat([c.update(String(token), "utf8"), c.final()]);
    return { tokenEncrypted: enc.toString("base64"), tokenIv: iv.toString("base64"), tokenTag: c.getAuthTag().toString("base64") };
}
function _decrypt(r) {
    try {
        const d = crypto.createDecipheriv(ALGO, _key(), Buffer.from(r.tokenIv, "base64"));
        d.setAuthTag(Buffer.from(r.tokenTag, "base64"));
        return Buffer.concat([d.update(Buffer.from(r.tokenEncrypted, "base64")), d.final()]).toString("utf8");
    } catch {
        return null;
    }
}
function _isActive(r) {
    const t = new Date(r?.monthlyExpiresAt ?? 0).getTime();
    return Number.isFinite(t) && t > Date.now();
}
function _webhook(rec, event) {
    if (!rec.webhookUrl) return;
    axios
        .post(
            rec.webhookUrl,
            { ...event, accountId: rec.accountId, ref: rec.ref ?? null },
            // arnto-auto's /api/quest-event authenticates with the shared key.
            { timeout: 8000, headers: { "x-api-key": process.env.PANEL_API_KEY || "" } },
        )
        .catch(() => {});
}

// ── Public API ───────────────────────────────────────────────────────────────────
async function activate({ token, months = 1, ref, webhookUrl }) {
    const resolved = await resolveDiscordAccount(token);
    if (!resolved.ok) {
        const e = new Error(resolved.reason);
        e.status = resolved.invalidToken ? 401 : 502;
        throw e;
    }
    const m = Math.max(0, parseInt(months, 10) || 0);
    const accountId = resolved.accountId;
    const existing = await db.findOne(MODEL, { accountId });
    const base = _isActive(existing) ? new Date(existing.monthlyExpiresAt).getTime() : Date.now();
    const monthlyExpiresAt = new Date(base + m * MONTH_MS).toISOString();
    const rec = {
        accountId,
        username: resolved.username,
        ..._encrypt(token),
        monthlyExpiresAt,
        webhookUrl: webhookUrl ?? existing?.webhookUrl ?? null,
        ref: ref ?? existing?.ref ?? null,
        addedAt: existing?.addedAt ?? Date.now(),
        updatedAt: Date.now(),
    };
    if (existing) await db.findOneAndUpdate(MODEL, { accountId }, rec);
    else await db.create(MODEL, rec);
    return { accountId, username: resolved.username, monthlyExpiresAt, months: m };
}

async function listActive() {
    return ((await db.get(MODEL)) || []).filter(_isActive);
}

function _publicRec(r) {
    return {
        accountId: r.accountId,
        username: r.username,
        monthlyExpiresAt: r.monthlyExpiresAt,
        active: _isActive(r),
        ref: r.ref ?? null,
    };
}
async function list() {
    return ((await db.get(MODEL)) || []).map(_publicRec);
}
async function remove(accountId) {
    await db.findOneAndDelete(MODEL, { accountId });
    return true;
}

// ── Run: complete ALL quests for every active subscriber (one pass) ──────────────
async function runBatch() {
    const accts = await listActive();
    let processed = 0,
        completed = 0;
    for (const rec of accts) {
        const token = _decrypt(rec);
        if (!token) continue;
        try {
            const resolved = await resolveDiscordAccount(token);
            if (!resolved.ok) {
                if (resolved.invalidToken) {
                    questService.emitExternalEvent(rec.accountId, { type: "status", status: "token_dead" });
                    _webhook(rec, { type: "status", status: "token_dead" });
                }
                continue;
            }
            // Reset this account's live state so /quests shows the current batch, then
            // feed quest_start/progress/done (with media) into the shared realtime bus
            // — this is what makes monthly accounts render quest cards like single ones.
            questService.clearLive(rec.accountId);
            questService.emitExternalEvent(rec.accountId, { type: "status", status: "running" });
            const completer = new QuestAutocompleter(resolved.api, {
                label: rec.username,
                onEvent: (e) => questService.emitExternalEvent(rec.accountId, e),
            });

            // Pre-scan: enroll everything up front, then emit a "pending" card for
            // every quest that will run — so the panel shows the FULL set immediately
            // (before completing them one by one). Enroll is idempotent, so the loop
            // below re-enrolling is harmless.
            let scan = await completer.fetchQuests();
            if (scan.length) {
                await completer.autoAccept(scan);
                scan = await completer.fetchQuests();
                for (const q of scan) {
                    if (isEnrolled(q) && !isCompleted(q) && isCompletable(q)) {
                        const s = summarizeQuest(q);
                        questService.emitExternalEvent(rec.accountId, {
                            type: "quest_pending",
                            questId: s.id,
                            name: s.name,
                            taskType: s.taskType,
                            needed: s.needed,
                            media: s.media,
                        });
                    }
                }
            }

            let guard = 0;
            while (guard++ < 10) {
                let quests = await completer.fetchQuests();
                if (!quests.length) break;
                quests = await completer.autoAccept(quests);
                const actionable = quests.filter(
                    (q) => isEnrolled(q) && !isCompleted(q) && isCompletable(q) && !completer.completedIds.has(q.id),
                );
                if (!actionable.length) break;
                for (const q of actionable) {
                    await completer.processQuest(q);
                    completed++;
                    _webhook(rec, { type: "quest_done", questName: getQuestName(q), taskType: getTaskType(q) });
                }
            }
            // Back to the idle "monthly" badge once this account's pass is done.
            questService.emitExternalEvent(rec.accountId, { type: "status", status: "monthly" });
            processed++;
        } catch (e) {
            if (isInvalidTokenError(e)) {
                questService.emitExternalEvent(rec.accountId, { type: "status", status: "token_dead" });
                _webhook(rec, { type: "status", status: "token_dead" });
            } else console.error(`[Monthly] ${rec.username} error: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, 3000));
    }
    return { processed, completed, total: accts.length };
}

// ── Daily enroll-only scan (no completion) ───────────────────────────────────────
async function runEnrollScan() {
    const accts = await listActive();
    let processed = 0;
    for (const rec of accts) {
        const token = _decrypt(rec);
        if (!token) continue;
        try {
            const resolved = await resolveDiscordAccount(token);
            if (!resolved.ok) continue;
            const completer = new QuestAutocompleter(resolved.api, { label: rec.username });
            const quests = await completer.fetchQuests();
            if (quests.length) await completer.autoAccept(quests);
            processed++;
        } catch (e) {
            if (!isInvalidTokenError(e)) console.error(`[MonthlyEnroll] ${rec.username}: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, 3000));
    }
    return { processed, total: accts.length };
}

// ── Schedulers (Asia/Ho_Chi_Minh; catch-up + crash-safe like arnto-auto) ─────────
function _vnParts() {
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Ho_Chi_Minh",
        weekday: "short",
        hour: "numeric",
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { weekday: dayMap[p.weekday], hour: parseInt(p.hour, 10) % 24, dateStr: `${p.year}-${p.month}-${p.day}` };
}

let runInProgress = false;
let enrollInProgress = false;

async function _checkRun() {
    try {
        const { weekday, hour, dateStr } = _vnParts();
        if (!RUN_DAYS.includes(weekday) || hour < RUN_HOUR()) return;
        if (runInProgress) return;
        if ((await db.get("quest_monthly_last_run")) === dateStr) return;
        runInProgress = true;
        try {
            console.log(`[Monthly] Scheduled run start (${dateStr})`);
            const res = await runBatch();
            await db.set("quest_monthly_last_run", dateStr);
            console.log(`[Monthly] Done: ${res.processed}/${res.total} account(s), ${res.completed} quest(s).`);
        } finally {
            runInProgress = false;
        }
    } catch (e) {
        console.warn("[Monthly] scheduler:", e.message);
    }
}

async function _checkEnroll() {
    try {
        const { hour, dateStr } = _vnParts();
        if (hour < ENROLL_HOUR()) return;
        if (enrollInProgress) return;
        if ((await db.get("quest_monthly_last_enroll")) === dateStr) return;
        enrollInProgress = true;
        try {
            console.log(`[MonthlyEnroll] Daily enroll scan start (${dateStr})`);
            const res = await runEnrollScan();
            await db.set("quest_monthly_last_enroll", dateStr);
            console.log(`[MonthlyEnroll] Done: ${res.processed}/${res.total} account(s).`);
        } finally {
            enrollInProgress = false;
        }
    } catch (e) {
        console.warn("[MonthlyEnroll] scheduler:", e.message);
    }
}

function start() {
    _checkRun().catch(() => {});
    _checkEnroll().catch(() => {});
    setInterval(() => _checkRun().catch(() => {}), 60 * 1000);
    setInterval(() => _checkEnroll().catch(() => {}), 60 * 1000);
}

module.exports = { activate, list, remove, listActive, runBatch, runEnrollScan, start };
