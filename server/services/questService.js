/**
 * questService.js
 * Discord Quest runner. Owns account storage (panel DB), the background
 * run loop, restart recovery, and a realtime event bus (consumed by the SSE route).
 * The Discord logic lives in questEngine.js.
 *
 * DB model `quest_accounts` (one record per Discord account):
 *   { _id, accountId, username, tokenEncrypted, tokenIv, tokenTag,
 *     mode: "all" | "select", selectedQuestIds: [], status, completedCount,
 *     error, addedAt, updatedAt, retentionExpiresAt,
 *     openOrders: [externalId], priceLater: { externalId, buyerId, at, baseCount } | null }
 *   (openOrders / priceLater: its orders in the shop's books — see autoShopOrders)
 * status: "running" | "done" | "stopped" | "token_dead" | "error"
 * While Auto Quest is paused (questSettings) a "running" record is not looping; the
 * API shows it as "paused" and restore() launches it on the resume.
 *
 * RETENTION — single-quest ("lẻ") accounts are kept for ONE WEEK only.
 * `retentionExpiresAt` is set to now + 7 days on every start and swept hourly;
 * once it passes, the whole record (token included), its live quest state and its
 * webhook are deleted and it stops being listed anywhere. Monthly subscribers
 * (quest_monthly) are NOT affected — their data lives as long as the plan.
 */

const { EventEmitter } = require("events");
const crypto = require("crypto");
const db = require("../db");
const {
    QuestAutocompleter,
    resolveDiscordAccount,
    warmBuildNumber,
    summarizeQuest,
    isInvalidTokenError,
    _fields,
} = require("./questEngine");
const proxyPool = require("./proxyPool");
const questSettings = require("./questSettings");
const lifecycle = require("./lifecycle");
const callbacks = require("./callbackService");
const shopOrders = require("./autoShopOrders");
const pricingStore = require("./pricingStore");

const MODEL = "quest_accounts";
const { isEnrolled, isCompleted, isCompletable } = _fields;

// ── Retention: keep a single-quest account for one week, then erase it ───────────
const RETENTION_DAYS = Math.max(1, parseInt(process.env.QUEST_RETENTION_DAYS || "7", 10) || 7);
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** When this record must be erased. Legacy records (no field) count from their last
 *  activity, so anything already older than the window is purged on the next sweep. */
function _expiryOf(rec) {
    const explicit = Number(rec?.retentionExpiresAt);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return (Number(rec?.updatedAt) || Number(rec?.addedAt) || 0) + RETENTION_MS;
}
function _isExpired(rec) {
    return _expiryOf(rec) <= Date.now();
}

// ── Token encryption at rest (aes-256-gcm, key from env secret) ──────────────────
const ALGO = "aes-256-gcm";
function _key() {
    const secret =
        process.env.QUEST_ENC_SECRET || process.env.JWT_SECRET || "quest-fallback-secret";
    return crypto.createHash("sha256").update(secret).digest();
}
function _encrypt(token) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, _key(), iv);
    const enc = Buffer.concat([cipher.update(String(token), "utf8"), cipher.final()]);
    return {
        tokenEncrypted: enc.toString("base64"),
        tokenIv: iv.toString("base64"),
        tokenTag: cipher.getAuthTag().toString("base64"),
    };
}
function _decrypt(rec) {
    try {
        const d = crypto.createDecipheriv(ALGO, _key(), Buffer.from(rec.tokenIv, "base64"));
        d.setAuthTag(Buffer.from(rec.tokenTag, "base64"));
        return Buffer.concat([
            d.update(Buffer.from(rec.tokenEncrypted, "base64")),
            d.final(),
        ]).toString("utf8");
    } catch {
        return null;
    }
}

// ── Realtime bus + in-memory run state ───────────────────────────────────────────
const bus = new EventEmitter();
bus.setMaxListeners(0);
// accountId -> { abort, completer }
const running = new Map();
// accountId -> the egress lease held for the whole run (see proxyPool.acquire).
// Held, not just used: while a lease is out the pool refuses to rotate that
// proxy's IP, so an account never has the ground move under it mid-run.
const leases = new Map();
// accountId -> { [questId]: { name, taskType, needed, done, percent, state, media } }
// Kept so the snapshot / list can render rich quest cards even after a page reload.
const liveState = new Map();
// accountId -> { url, ref, username }: caller (arnto-auto) webhook to notify on
// quest events. `username` rides along so arnto-auto can name the account in its
// notification without another round-trip to the panel.
const webhooks = new Map();

// Forward meaningful events to the account's webhook (arnto-auto → notify the buyer).
// run_start lists every quest a run is about to do, once — arnto-auto posts them all
// as waiting in its order feed and ticks each off on quest_done.
function _dispatchWebhook(accountId, event) {
    const hook = webhooks.get(accountId);
    if (!hook?.url && !hook?.botId) return;
    if (!["run_start", "quest_start", "quest_done", "status", "removed"].includes(event.type)) return;
    // Address and x-api-key follow the project that registered it (callbackService).
    callbacks.send(hook.url, hook.botId, {
        ...event,
        accountId,
        ref: hook.ref ?? null,
        username: hook.username ?? null,
        plan: "single",
    }, "quest.event");
}

function _updateLive(accountId, evt) {
    if (
        !["quest_start", "quest_progress", "quest_done", "quest_pending", "quest_skipped"].includes(
            evt.type,
        )
    )
        return;
    let acc = liveState.get(accountId);
    if (!acc) {
        acc = {};
        liveState.set(accountId, acc);
    }
    const q = acc[evt.questId] || {};
    if (evt.name) q.name = evt.name;
    if (evt.taskType) q.taskType = evt.taskType;
    if (evt.needed != null) q.needed = evt.needed;
    if (evt.done != null) q.done = evt.done;
    if (evt.percent != null) q.percent = evt.percent;
    if (evt.media) q.media = evt.media;
    if (evt.type === "quest_done") {
        q.state = "done";
        q.percent = 100;
    } else if (evt.type === "quest_skipped") {
        q.state = "skipped";
        q.error = evt.reason ?? null;
    } else if (evt.type === "quest_pending") {
        // A pre-run placeholder card; never downgrade one already running/finished.
        if (q.state !== "running" && q.state !== "done") q.state = "pending";
        if (q.percent == null) q.percent = 0;
    } else {
        q.state = "running";
    }
    acc[evt.questId] = q;
}

// `webhook: false` keeps an event on the panel (live state + /quests) without telling
// arnto-auto — a token check the admin ran without notifying the buyer.
function _publish(accountId, event, { webhook = true } = {}) {
    _updateLive(accountId, event);
    if (webhook) _dispatchWebhook(accountId, event);
    bus.emit("event", { accountId, at: Date.now(), ...event });
}

// ── External producers (e.g. the monthly batch) ──────────────────────────────────
// The monthly runner lives in questMonthly.js but its accounts should show the same
// live quest cards + realtime stream on /quests as single-quest accounts. These let
// it feed the shared liveState + bus. Unlike _publish this does NOT dispatch the
// per-account webhook — monthly owns its own webhook delivery to arnto-auto.
function emitExternalEvent(accountId, event) {
    _updateLive(accountId, event);
    bus.emit("event", { accountId, at: Date.now(), ...event });
}
function getLive(accountId) {
    return liveState.get(accountId) ?? {};
}
function clearLive(accountId) {
    liveState.delete(accountId);
}

// ── DB helpers ───────────────────────────────────────────────────────────────────
async function _getRec(accountId) {
    return db.findOne(MODEL, { accountId });
}
async function _updateRec(accountId, patch) {
    const rec = await db.findOneAndUpdate(
        MODEL,
        { accountId },
        { ...patch, updatedAt: Date.now() },
    );
    return rec;
}
async function _setStatus(accountId, status, extra = {}, { notify = true } = {}) {
    await _updateRec(accountId, { status, ...extra });
    _publish(accountId, { type: "status", status, ...extra }, { webhook: notify });
    if (status === "done") await _closeOrders(await _getRec(accountId), "completed");
}

// ── The shop's books (autoShopOrders) ────────────────────────────────────────────
// A record is an account, and orders come and go on it. `openOrders` are the shop
// orders (externalIds) its run still owes; `priceLater` is one whose price is only
// known once the run lists its quests — added by hand, or from an ArnTo-Auto that
// does not say what was paid — opened at run_start at the regular per-quest price.
// A finished run completes them; removing the account (or the retention sweep)
// before that cancels them. A start without a payment while an order is open is
// that order going on (the buyer sent a fresh token), and a resume is never a new
// order.

/** Open the price-later order for `quests` quests (none → nothing to charge). */
async function _openPriceLater(rec, quests, want = "pending") {
    const later = rec?.priceLater;
    if (!later || !(quests > 0)) return rec;
    const { autoQuest } = await pricingStore.getPricing();
    await shopOrders.open({
        externalId: later.externalId,
        source: shopOrders.SOURCE.quest,
        buyerId: later.buyerId,
        name: shopOrders.questName(quests),
        price: quests * autoQuest.pricePerItem,
        orderDate: later.at,
        want,
    });
    return _updateRec(rec.accountId, { priceLater: null, openOrders: [...(rec.openOrders || []), later.externalId] });
}

async function _closeOrders(rec, want) {
    if (!rec) return;
    // A run that finished before its quests were ever listed (failed pre-scan):
    // priced by what it completed.
    if (want === "completed" && rec.priceLater) {
        rec = await _openPriceLater(rec, (rec.completedCount ?? 0) - (rec.priceLater.baseCount ?? 0), "completed");
    }
    if (!rec.openOrders?.length && !rec.priceLater) return;
    if (await _getRec(rec.accountId)) await _updateRec(rec.accountId, { openOrders: [], priceLater: null });
    for (const id of rec.openOrders || []) await shopOrders.settle(id, want);
}

/** Public account view (no token material). */
function _publicRec(r) {
    return {
        accountId: r.accountId,
        username: r.username,
        mode: r.mode,
        selectedQuestIds: r.selectedQuestIds ?? [],
        // Paused: the record keeps "running" (that is what the resume looks for),
        // but nothing is looping.
        status:
            r.status === "running" && !running.has(r.accountId) && questSettings.peek().paused
                ? "paused"
                : r.status,
        completedCount: r.completedCount ?? 0,
        error: r.error ?? null,
        running: running.has(r.accountId),
        ref: r.webhookRef ?? null,
        addedAt: r.addedAt,
        updatedAt: r.updatedAt,
        retentionExpiresAt: _expiryOf(r),
        quests: liveState.get(r.accountId) ?? {},
    };
}

/** Expired accounts are hidden immediately, even before the sweep erases them. */
async function listAccounts() {
    const recs = (await db.get(MODEL)) || [];
    return recs.filter((r) => !_isExpired(r)).map(_publicRec);
}

async function getAccount(accountId) {
    const rec = await _getRec(accountId);
    return rec && !_isExpired(rec) ? _publicRec(rec) : null;
}

/** Resolve a token and fetch its quests (for the UI to pick from). No storage. */
async function previewToken(token) {
    const resolved = await resolveDiscordAccount(token, await proxyPool.agentForKey(token));
    if (!resolved.ok) {
        const e = new Error(resolved.reason);
        e.vi = resolved.reasonVi; // what /api/external/quests answers (shown to the buyer)
        e.status = resolved.invalidToken ? 401 : 502;
        throw e;
    }
    const completer = new QuestAutocompleter(resolved.api, { label: resolved.username });
    const quests = await completer.fetchQuests();
    // One-time dev aid: log the raw asset/colors of the first quest so the CDN URL
    // pattern & field names can be verified against a real quest if an image 404s.
    if (quests[0]?.config) {
        console.log(
            "[Quest] sample config.assets:",
            JSON.stringify(quests[0].config.assets ?? null),
            "colors:",
            JSON.stringify(quests[0].config.colors ?? null),
        );
    }
    return {
        accountId: resolved.accountId,
        username: resolved.username,
        quests: quests
            .filter((q) => !isCompleted(q) && isCompletable(q))
            .map(summarizeQuest),
    };
}

/**
 * Add (or update) an account and start running.
 * mode "all"  → run every available quest.
 * mode "select" → run only selectedQuestIds.
 */
/**
 * `order` ({ id, price, reseller } — autoShopOrders.orderArg): ArnTo-Auto's payment
 * for this run. `manual`: added by hand on /quests. `resume`: the same order again.
 */
async function startAccount({
    token,
    mode = "all",
    selectedQuestIds = [],
    webhookUrl,
    webhookBotId = null,
    ref,
    order = null,
    manual = false,
    resume = false,
}) {
    // Paused: the order is stored like any other and waits for the resume, which
    // launches it via restore(). Nothing runs yet, so no lease either.
    const { paused } = await questSettings.get();
    const lease = paused ? null : await proxyPool.acquire(token);
    const resolved = await resolveDiscordAccount(token, lease ? lease.agent : await proxyPool.agentForKey(token));
    if (!resolved.ok) {
        // A dead token is not the proxy's fault; anything else might be.
        lease?.release({ failed: !resolved.invalidToken });
        const e = new Error(resolved.reason);
        e.vi = resolved.reasonVi; // what /api/external/quests answers (shown to the buyer)
        e.status = resolved.invalidToken ? 401 : 502;
        throw e;
    }
    const accountId = resolved.accountId;
    const cleanIds = [...new Set((selectedQuestIds ?? []).map(String).filter(Boolean))];
    const enc = _encrypt(token);
    const existing = await _getRec(accountId);
    // Preserve an existing webhook if the caller didn't supply a new one.
    const hookUrl = webhookUrl ?? existing?.webhookUrl ?? null;
    // The owner goes with the URL: a new URL brings its caller's project.
    const hookBotId = webhookUrl || webhookBotId ? webhookBotId : (existing?.webhookBotId ?? null);
    const hookRef = ref ?? existing?.webhookRef ?? null;
    if (hookUrl || hookBotId) webhooks.set(accountId, { url: hookUrl, botId: hookBotId, ref: hookRef, username: resolved.username });

    // The shop's books: a paid order opens now; anything else that is not a resume
    // and finds no order open becomes one priced at run_start.
    const buyerId = hookRef || accountId;
    let openOrders = existing?.openOrders ?? [];
    let priceLater = existing?.priceLater ?? null;
    if (order) {
        const externalId = `quest:${order.id}`;
        await shopOrders.open({
            externalId,
            source: shopOrders.SOURCE.quest,
            buyerId,
            name: shopOrders.questName(mode === "select" ? cleanIds.length : 0),
            price: order.price,
            reseller: order.reseller,
        });
        if (!openOrders.includes(externalId)) openOrders = [...openOrders, externalId];
    } else if (!resume && !openOrders.length && !priceLater) {
        priceLater = {
            externalId: `quest:${manual ? "manual" : "auto"}:${accountId}:${Date.now()}`,
            buyerId,
            at: Date.now(),
            baseCount: existing?.completedCount ?? 0,
        };
    }

    const record = {
        accountId,
        username: resolved.username,
        ...enc,
        mode: mode === "select" ? "select" : "all",
        selectedQuestIds: mode === "select" ? cleanIds : [],
        webhookUrl: hookUrl,
        webhookBotId: hookBotId,
        webhookRef: hookRef,
        status: "running",
        completedCount: existing?.completedCount ?? 0,
        error: null,
        addedAt: existing?.addedAt ?? Date.now(),
        updatedAt: Date.now(),
        // Each new run restarts the one-week clock; nothing survives past it.
        retentionExpiresAt: Date.now() + RETENTION_MS,
        openOrders,
        priceLater,
    };
    if (existing) await db.findOneAndUpdate(MODEL, { accountId }, record);
    else await db.create(MODEL, record);

    // (Re)start the loop with the freshly resolved api. _stopLoop first, so the
    // previous run's lease is returned before this one is registered.
    _stopLoop(accountId);
    if (!paused) _launch(accountId, resolved, record, lease);
    return _publicRec(record);
}

function _httpError(message, status) {
    const e = new Error(message);
    e.status = status;
    return e;
}

/**
 * Run a stored single-quest account again — stopped, failed or finished — with its
 * saved token, mode and owner. Same as a new order: the one-week clock restarts.
 */
async function resumeAccount(accountId) {
    const rec = await _getRec(accountId);
    if (!rec || _isExpired(rec)) throw _httpError("Account not found.", 404);
    if (running.has(accountId)) throw _httpError("The account is already running.", 409);
    const token = _decrypt(rec);
    if (!token) throw _httpError("Could not decrypt the token (secret changed?).", 409);
    return startAccount({ token, mode: rec.mode, selectedQuestIds: rec.selectedQuestIds ?? [], resume: true });
}

/** Give the account's egress route back to the pool. Safe to call twice. */
function _releaseLease(accountId, opts) {
    const lease = leases.get(accountId);
    if (!lease) return;
    leases.delete(accountId);
    lease.release(opts);
}

function _stopLoop(accountId) {
    const r = running.get(accountId);
    if (r) {
        r.abort.stopped = true;
        running.delete(accountId);
    }
    _releaseLease(accountId);
}

async function stopAccount(accountId) {
    _stopLoop(accountId);
    if (await _getRec(accountId)) await _setStatus(accountId, "stopped");
    return true;
}

async function removeAccount(accountId) {
    _stopLoop(accountId);
    liveState.delete(accountId);
    const rec = await db.findOneAndDelete(MODEL, { accountId });
    _publish(accountId, { type: "removed" });
    webhooks.delete(accountId);
    // Gone before its run finished: its orders never completed.
    await _closeOrders(rec, "cancelled");
    return true;
}

// ── Token check (the "Check token" action on /quests) ────────────────────────────
const UNREADABLE_TOKEN = "Could not decrypt the stored token (secret changed?).";

/**
 * One look at whether Discord still takes a stored token: GET /users/@me through the
 * account's usual egress. agentForKey, not acquire(): no lease, so a check never
 * rotates a proxy a run is using, and it holds nothing afterwards.
 *   valid   — Discord answered 200.
 *   dead    — 401/403 (what a run treats as a dead token), or the panel's copy is
 *             unreadable (`unreadable`: the panel's fault, not the buyer's).
 *   unknown — no verdict (Discord or the proxy unreachable): nothing is changed.
 * `reason` is English (stored on the record, shown on /quests) and keeps the HTTP code.
 */
async function tokenVerdict(token) {
    if (!token) return { state: "dead", unreadable: true, reason: UNREADABLE_TOKEN };
    const resolved = await resolveDiscordAccount(token, await proxyPool.agentForKey(token));
    if (resolved.ok) return { state: "valid", reason: null, username: resolved.username };
    return { state: resolved.invalidToken ? "dead" : "unknown", reason: resolved.reason };
}

/**
 * Check a single-quest account's token. A dead token is recorded the way the run loop
 * records one — the loop stops, status token_dead — and `notify` decides whether
 * arnto-auto hears it (it DMs the buyer to send a new token and pauses the order's
 * feed message). Off, only the panel knows. A finished run is only reported: its order
 * is done and nothing would use the token again. A token that works changes nothing.
 * Returns { accountId, username, plan, state, reason, status, notified, note }.
 */
async function checkToken(accountId, { notify = false } = {}) {
    const rec = await _getRec(accountId);
    if (!rec || _isExpired(rec)) throw _httpError("Account not found.", 404);
    const verdict = await tokenVerdict(_decrypt(rec));
    const out = {
        accountId,
        username: rec.username,
        plan: "single",
        state: verdict.state,
        reason: verdict.reason,
        status: _publicRec(rec).status,
        notified: false,
        note: null,
    };

    if (verdict.state === "valid") {
        if (rec.status === "token_dead") out.note = "The token works again — Run again resumes the account.";
        return out;
    }
    if (verdict.state === "unknown") {
        out.note = "Discord gave no verdict — nothing was changed.";
        return out;
    }
    if (rec.status === "done") {
        out.note = "The run had already finished — nothing was changed and the buyer is not told.";
        return out;
    }

    // Same route arnto-auto would be told by (_dispatchWebhook) — and it needs the buyer.
    const hook = webhooks.get(accountId);
    const canTell = !!(hook && (hook.url || hook.botId) && hook.ref);
    const tell = notify && canTell && !verdict.unreadable;
    // A running loop would hit the same wall on its next request; stop it now (it
    // exits without writing, like a Stop) and return its lease.
    _stopLoop(accountId);
    await _setStatus(accountId, "token_dead", { error: `Token check: ${verdict.reason}` }, { notify: tell });
    out.status = "token_dead";
    out.notified = tell;
    if (notify && !tell) {
        out.note = verdict.unreadable
            ? "The panel cannot read its own copy of the token — not the buyer's to fix, so they are not told."
            : "No buyer is linked to this account — nobody to tell.";
    }
    return out;
}

// ── Retention sweep ──────────────────────────────────────────────────────────────
/**
 * Erase every single-quest account whose week is up: stops its run, deletes the DB
 * record (encrypted token included), drops its live quest state and its webhook.
 * Nothing about the owner is kept afterwards.
 */
async function purgeExpired() {
    const recs = (await db.get(MODEL)) || [];
    let purged = 0;
    for (const rec of recs) {
        if (!_isExpired(rec)) continue;
        try {
            await removeAccount(rec.accountId);
            purged++;
        } catch (e) {
            console.warn(`[Quest] retention purge ${rec.accountId} error: ${e.message}`);
        }
    }
    if (purged) console.log(`[Quest] Retention: erased ${purged} account(s) older than ${RETENTION_DAYS}d.`);
    return purged;
}

/** Purge now, then keep checking hourly. */
function startRetentionSweep() {
    purgeExpired().catch((e) => console.warn("[Quest] retention sweep:", e.message));
    const timer = setInterval(
        lifecycle.guard(() => purgeExpired().catch((e) => console.warn("[Quest] retention sweep:", e.message))),
        SWEEP_INTERVAL_MS,
    );
    timer.unref?.();
    return timer;
}

// ── Run loop ─────────────────────────────────────────────────────────────────────
// Seconds before a run whose egress route died (questEngine `egressDown`) starts
// again, once, on a fresh lease — a rotating proxy has a moment to come back.
const EGRESS_RETRY_DELAY_SEC = 60;

function _launch(accountId, resolved, record, lease = null, attempt = 1) {
    if (lease) leases.set(accountId, lease);
    const abort = { stopped: false };
    const completer = new QuestAutocompleter(resolved.api, {
        label: resolved.username,
        abort,
        onEvent: (e) => _publish(accountId, e),
    });
    const entry = { abort, completer, done: null };
    running.set(accountId, entry);
    entry.done = _runLoop(accountId, completer, abort, record, attempt).catch((err) => {
        console.error(`[Quest] ${resolved.username} loop crash:`, err.message);
    });
}

/**
 * Start a stored "running" account: lease, resolve, loop (restore() and the egress
 * retry). False when it could not start — the record then says why.
 */
async function _resume(rec, attempt = 1) {
    const token = _decrypt(rec);
    if (!token) {
        await _setStatus(rec.accountId, "token_dead", {
            error: "Could not decrypt the stored token (secret changed?).",
        });
        return false;
    }
    const lease = await proxyPool.acquire(token);
    const resolved = await resolveDiscordAccount(token, lease.agent);
    if (!resolved.ok) {
        lease.release({ failed: !resolved.invalidToken });
        await _setStatus(rec.accountId, resolved.invalidToken ? "token_dead" : "error", {
            error: resolved.reason,
        });
        return false;
    }
    _launch(rec.accountId, resolved, rec, lease, attempt);
    return true;
}

/** The second go after `egressDown` — unless the account was stopped, removed,
 *  restarted or paused meanwhile (the resume picks a paused one up). */
async function _retryAfterEgressDown(accountId) {
    const rec = await _getRec(accountId);
    if (!rec || rec.status !== "running" || running.has(accountId)) return;
    if ((await questSettings.get()).paused) return;
    await _resume(rec, 2);
}

/**
 * Stop every run loop WITHOUT touching its DB status, so restore() — on this
 * panel or on the one it hands over to — picks each account back up where it
 * was. (stopAccount would mark them "stopped" for good.) Resolves once the
 * loops have noticed, or after timeoutMs.
 */
async function suspendAll({ timeoutMs = 30_000 } = {}) {
    const ids = [...running.keys()];
    const loops = ids.map((id) => running.get(id)?.done).filter(Boolean);
    for (const id of ids) _stopLoop(id);
    await Promise.race([Promise.allSettled(loops), new Promise((r) => setTimeout(r, timeoutMs))]);
    return ids.length;
}

/** How many accounts are running right now (the panel-move preflight shows it). */
const runningCount = () => running.size;

/**
 * The global pause (questSettings.paused is already set): stop every loop the same
 * way a panel move does, so the DB keeps "running" and restore() resumes them. Does
 * not wait — a loop notices within one heartbeat and exits without writing anything.
 */
function pauseAll() {
    const ids = [...running.keys()];
    for (const id of ids) _stopLoop(id);
    // UI only — the buyer is not told about a pause.
    for (const id of ids) emitExternalEvent(id, { type: "status", status: "paused" });
    return ids.length;
}

async function _runLoop(accountId, completer, abort, record, attempt = 1) {
    const mode = record.mode;
    const selected = new Set((record.selectedQuestIds ?? []).map(String));
    _publish(accountId, { type: "status", status: "running" });

    // Pre-scan: enroll everything we intend to run, then show every quest that will
    // run as a "pending" card up front — so the panel loads the FULL set immediately
    // instead of one-by-one. Enroll is idempotent, so the loop below re-enrolling is
    // harmless. quest_pending is not forwarded to the arnto webhook (see _dispatchWebhook):
    // the whole set goes there as one run_start instead.
    try {
        let scan = await completer.fetchQuests();
        if (scan.length && !abort.stopped) {
            if (mode === "select") await completer.enrollSelected([...selected]);
            else await completer.autoAccept(scan);
            scan = await completer.fetchQuests();
            const queued = [];
            for (const q of scan) {
                if (
                    isEnrolled(q) &&
                    !isCompleted(q) &&
                    isCompletable(q) &&
                    (mode === "all" || selected.has(String(q.id)))
                ) {
                    const s = summarizeQuest(q);
                    _publish(accountId, {
                        type: "quest_pending",
                        questId: s.id,
                        name: s.name,
                        taskType: s.taskType,
                        needed: s.needed,
                        media: s.media,
                    });
                    queued.push({ questId: String(s.id), name: s.name, taskType: s.taskType ?? null });
                }
            }
            if (queued.length) {
                _dispatchWebhook(accountId, { type: "run_start", quests: queued });
                await _openPriceLater(await _getRec(accountId), queued.length).catch((e) =>
                    console.warn(`[Quest] ${record.username}: shop order not opened: ${e.message}`),
                );
            }
        }
    } catch {
        // A failed pre-scan is non-fatal — the main loop below re-fetches anyway.
    }

    let guard = 0;
    try {
        while (!abort.stopped && guard++ < 50) {
            let quests = await completer.fetchQuests();
            if (!quests.length) break;

            // Enroll what we intend to run, then re-fetch to see enrolled state.
            if (mode === "select") await completer.enrollSelected([...selected]);
            else quests = await completer.autoAccept(quests);
            quests = await completer.fetchQuests();

            const actionable = quests.filter(
                (q) =>
                    isEnrolled(q) &&
                    !isCompleted(q) &&
                    isCompletable(q) &&
                    !completer.completedIds.has(q.id) &&
                    (mode === "all" || selected.has(String(q.id))),
            );
            if (!actionable.length) break; // nothing left → done

            // A pass can run for hours, so take the soonest-expiring quest first —
            // otherwise a quest can expire while it is still waiting its turn.
            actionable.sort((a, b) => {
                const ea = new Date(
                    a.config?.expires_at ?? a.config?.expiresAt ?? 8.64e15,
                ).getTime();
                const eb = new Date(
                    b.config?.expires_at ?? b.config?.expiresAt ?? 8.64e15,
                ).getTime();
                return ea - eb;
            });

            for (const q of actionable) {
                if (abort.stopped) break;
                const r = await completer.processQuest(q);
                if (r?.skipped) continue;
                const cur = (await _getRec(accountId))?.completedCount ?? 0;
                await _updateRec(accountId, { completedCount: cur + 1 });
            }
        }
        if (!abort.stopped) {
            running.delete(accountId);
            _releaseLease(accountId);
            await _setStatus(accountId, "done");
        }
    } catch (err) {
        // A stopped run was already unregistered by _stopLoop, lease included — and
        // by now its slot may belong to a newer run of the same account (restart,
        // pause → resume), which this one must not unregister.
        if (err?.aborted || abort.stopped) return;
        running.delete(accountId);
        if (err?.egressDown && attempt === 1) {
            // The route died, not the account: a fresh IP (lease back as failed) and
            // one more go. The record stays "running", so a restart meanwhile resumes it.
            _releaseLease(accountId, { failed: true });
            console.warn(`[Quest] ${record.username}: ${err.message} — running it again in ${EGRESS_RETRY_DELAY_SEC}s`);
            const retry = lifecycle.guard(() =>
                _retryAfterEgressDown(accountId).catch((e) =>
                    console.warn(`[Quest] ${record.username} retry error: ${e.message}`),
                ),
            );
            setTimeout(retry, EGRESS_RETRY_DELAY_SEC * 1000).unref?.();
        } else if (!err?.egressDown && isInvalidTokenError(err)) {
            _releaseLease(accountId);
            await _setStatus(accountId, "token_dead", {
                error: "Discord rejected the token (invalid or expired).",
            });
        } else {
            // The run died for a non-token reason — a rotating proxy gets a fresh IP
            // now that nothing is using it, rather than waiting for its idle timer.
            _releaseLease(accountId, { failed: true });
            console.error(`[Quest] ${record.username} loop error:`, err.message);
            await _setStatus(accountId, "error", { error: err.message });
        }
    }
}

/** Restart accounts that were running before a server restart. */
async function restore() {
    warmBuildNumber();
    const { paused } = await questSettings.get();
    const recs = (await db.get(MODEL)) || [];
    let restored = 0;
    let waiting = 0;
    for (const rec of recs) {
        // Past its week: erase instead of resuming — never re-arm a webhook for it.
        if (_isExpired(rec)) {
            await removeAccount(rec.accountId).catch(() => {});
            continue;
        }
        if (rec.webhookUrl || rec.webhookBotId)
            webhooks.set(rec.accountId, {
                url: rec.webhookUrl,
                botId: rec.webhookBotId ?? null,
                ref: rec.webhookRef ?? null,
                username: rec.username,
            });
        if (rec.status !== "running") continue;
        // Already looping (a resume racing a restart or a maintenance exit).
        if (running.has(rec.accountId)) continue;
        if (paused) {
            waiting++;
            continue;
        }
        try {
            if (await _resume(rec)) restored++;
        } catch (e) {
            console.warn(`[Quest] restore ${rec.username} error: ${e.message}`);
        }
    }
    if (restored) console.log(`[Quest] Restored ${restored} account(s).`);
    if (waiting) console.log(`[Quest] Paused — ${waiting} account(s) wait for the resume.`);
    return restored;
}

module.exports = {
    bus,
    listAccounts,
    getAccount,
    previewToken,
    startAccount,
    resumeAccount,
    pauseAll,
    stopAccount,
    removeAccount,
    checkToken,
    tokenVerdict,
    restore,
    suspendAll,
    runningCount,
    purgeExpired,
    startRetentionSweep,
    RETENTION_DAYS,
    emitExternalEvent,
    getLive,
    clearLive,
};
