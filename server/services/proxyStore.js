/**
 * proxyStore.js
 * Registry for the proxies YOU supply to the panel (bought/rented), as opposed to
 * the agent VPSes which the panel already owns (see proxyPool.js for the pool that
 * merges both). Owns storage, credential encryption, health checks and IP rotation.
 *
 * Deliberately feature-agnostic: a record carries `uses` (["quest", ...]) so the
 * same proxy list can back future features without another table. Auto Quest is
 * the first consumer.
 *
 * DB model `proxies` (one record per proxy endpoint):
 *   { _id, label, protocol, host, port, username, password{iv,tag,data}|null,
 *     type: "static" | "rotating", rotateUrl, rotateMinIntervalSec,
 *     rotateIdleIntervalSec, enabled, uses: [], note,
 *     lastRotatedAt, lastRotateError, lastCheckedAt, lastIp, lastError, failCount,
 *     createdAt, updatedAt }
 *
 * type "static"   → one fixed exit IP; nothing to rotate.
 * type "rotating" → the provider gives a URL that changes the exit IP behind the
 *                   SAME host:port. Fetching it is the only way to rotate, so the
 *                   agent object stays valid across a rotation — see rotate().
 */

const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const db = require("../db");
const agentCrypto = require("./agentCrypto");

const MODEL = "proxies";
const PROTOCOLS = ["http", "https", "socks4", "socks5"];
const KNOWN_USES = ["quest"];

// Where a health check asks "what IP am I coming from?". Several, tried in order:
// a residential/rotating proxy can be fine for the traffic you care about while one
// particular echo service stalls behind it, and reporting that as "proxy dead" sends
// you debugging the wrong thing. Ordered by measured latency through a real proxy.
// PROXY_IP_CHECK_URL overrides the list with a single endpoint.
const IP_CHECK_URLS = process.env.PROXY_IP_CHECK_URL
    ? [process.env.PROXY_IP_CHECK_URL]
    : [
          "https://ipv4.icanhazip.com",
          "https://checkip.amazonaws.com",
          "https://ipinfo.io/ip",
          "https://api.ipify.org?format=json",
      ];

// What the pool actually exists to reach. A proxy that answers this is usable even
// when every IP echo above is having a bad day.
const REACH_CHECK_URL = "https://discord.com/api/v9/experiments";

/** Credentials are encrypted at rest with the same secret as quest tokens. */
function _secret() {
    return process.env.QUEST_ENC_SECRET || process.env.JWT_SECRET || "quest-fallback-secret";
}

// ── Normalization ────────────────────────────────────────────────────────────────

function _num(v, fallback) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
}

function _err(message, status = 400) {
    const e = new Error(message);
    e.status = status;
    return e;
}

/**
 * Validate + normalize an incoming draft into a storable record body.
 * `existing` is passed on update so an omitted password keeps the stored one.
 */
function _normalize(input = {}, existing = null) {
    const protocol = String(input.protocol ?? existing?.protocol ?? "http").toLowerCase();
    if (!PROTOCOLS.includes(protocol))
        throw _err(`Giao thức không hợp lệ (chọn: ${PROTOCOLS.join(", ")}).`);

    const host = String(input.host ?? existing?.host ?? "").trim();
    if (!host) throw _err("Thiếu host của proxy.");

    const port = _num(input.port ?? existing?.port, 0);
    if (port < 1 || port > 65535) throw _err("Port proxy không hợp lệ.");

    const type = String(input.type ?? existing?.type ?? "static").toLowerCase();
    if (type !== "static" && type !== "rotating")
        throw _err("Loại proxy phải là static hoặc rotating.");

    // A rotating proxy without its rotate link is just a static proxy that lies
    // about itself, so refuse it rather than silently never rotating.
    const rotateUrl = String(input.rotateUrl ?? existing?.rotateUrl ?? "").trim();
    if (type === "rotating") {
        if (!rotateUrl) throw _err("Proxy xoay cần link đổi IP.");
        if (!/^https?:\/\//i.test(rotateUrl))
            throw _err("Link đổi IP phải bắt đầu bằng http:// hoặc https://");
    }

    const uses = Array.isArray(input.uses)
        ? input.uses.map(String).filter((u) => KNOWN_USES.includes(u))
        : (existing?.uses ?? ["quest"]);

    const body = {
        label: String(input.label ?? existing?.label ?? "").trim() || `${host}:${port}`,
        protocol,
        host,
        port,
        username: String(input.username ?? existing?.username ?? "").trim(),
        type,
        rotateUrl: type === "rotating" ? rotateUrl : null,
        // Guard rails so a burst of runs never hammers the provider's rotate endpoint.
        rotateMinIntervalSec: Math.max(
            0,
            _num(input.rotateMinIntervalSec ?? existing?.rotateMinIntervalSec, 60),
        ),
        // 0 = no background rotation; the proxy then only rotates between runs.
        rotateIdleIntervalSec: Math.max(
            0,
            _num(input.rotateIdleIntervalSec ?? existing?.rotateIdleIntervalSec, 0),
        ),
        enabled:
            input.enabled === undefined ? existing?.enabled !== false : input.enabled !== false,
        uses: uses.length ? uses : ["quest"],
        note: String(input.note ?? existing?.note ?? "").trim(),
        updatedAt: Date.now(),
    };

    // password: undefined → keep stored one, "" → clear, string → re-encrypt.
    if (input.password !== undefined) {
        const pw = String(input.password);
        body.password = pw ? agentCrypto.encrypt(pw, _secret()) : null;
    } else if (existing) {
        body.password = existing.password ?? null;
    } else {
        body.password = null;
    }

    return body;
}

/** Decrypt a record's password. Returns "" when unset or undecryptable. */
function _password(rec) {
    if (!rec?.password) return "";
    try {
        return agentCrypto.decrypt(rec.password, _secret());
    } catch {
        return "";
    }
}

/** Public shape — never leaks the credential, only whether one is stored. */
function publicView(rec) {
    return {
        _id: rec._id,
        label: rec.label,
        protocol: rec.protocol,
        host: rec.host,
        port: rec.port,
        username: rec.username ?? "",
        hasPassword: !!rec.password,
        type: rec.type,
        rotateUrl: rec.rotateUrl ?? null,
        rotateMinIntervalSec: rec.rotateMinIntervalSec ?? 60,
        rotateIdleIntervalSec: rec.rotateIdleIntervalSec ?? 0,
        enabled: rec.enabled !== false,
        uses: rec.uses ?? ["quest"],
        note: rec.note ?? "",
        lastRotatedAt: rec.lastRotatedAt ?? null,
        lastRotateError: rec.lastRotateError ?? null,
        lastCheckedAt: rec.lastCheckedAt ?? null,
        lastIp: rec.lastIp ?? null,
        lastError: rec.lastError ?? null,
        lastUsedAt: rec.lastUsedAt ?? null,
        failCount: rec.failCount ?? 0,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
    };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────────

async function all() {
    return (await db.get(MODEL)) || [];
}

async function list() {
    return (await all())
        .sort((a, b) => String(a.label).localeCompare(String(b.label)))
        .map(publicView);
}

async function get(id) {
    return (await all()).find((p) => p._id === id) || null;
}

/** Enabled proxies a given feature is allowed to use, in a stable order. */
async function usable(feature = "quest") {
    return (await all())
        .filter((p) => p.enabled !== false && (p.uses ?? ["quest"]).includes(feature))
        .sort((a, b) => String(a._id).localeCompare(String(b._id)));
}

async function create(input) {
    const body = _normalize(input);
    return publicView(
        await db.create(MODEL, {
            ...body,
            failCount: 0,
            createdAt: Date.now(),
        }),
    );
}

async function update(id, patch) {
    const existing = await get(id);
    if (!existing) throw _err("Không tìm thấy proxy.", 404);
    const body = _normalize(patch, existing);
    return publicView(await db.findOneAndUpdate(MODEL, { _id: id }, body));
}

async function remove(id) {
    const gone = await db.findOneAndDelete(MODEL, { _id: id });
    if (!gone) throw _err("Không tìm thấy proxy.", 404);
    return true;
}

/** Internal field writes (health/rotate bookkeeping) — never user input. */
async function _touch(id, fields) {
    await db.findOneAndUpdate(MODEL, { _id: id }, { ...fields, updatedAt: Date.now() });
}

// ── Connecting through a proxy ───────────────────────────────────────────────────

/** proxyUrl WITH credentials — keep it out of logs and API responses. */
function proxyUrl(rec) {
    const auth = rec.username
        ? `${encodeURIComponent(rec.username)}:${encodeURIComponent(_password(rec))}@`
        : "";
    return `${rec.protocol}://${auth}${rec.host}:${rec.port}`;
}

/** Same URL with the credential masked — safe to show. */
function displayUrl(rec) {
    const auth = rec.username ? `${rec.username}:***@` : "";
    return `${rec.protocol}://${auth}${rec.host}:${rec.port}`;
}

/**
 * An axios-compatible httpsAgent that tunnels outbound HTTPS through this proxy.
 * Both agent types dial a fresh connection per request, so a rotation that lands
 * between requests is picked up without rebuilding the agent.
 */
function buildAgent(rec) {
    const url = proxyUrl(rec);
    return rec.protocol.startsWith("socks") ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
}

const ATTEMPT_TIMEOUT_MS = 12_000;

/**
 * Health check: what IP does this proxy egress from, and can it reach Discord?
 *
 * The two questions are answered separately on purpose. Reachability is what the
 * pool is for; the exit IP is a nicety that depends on third-party echo services,
 * any of which can stall behind a residential proxy. A proxy that reaches Discord
 * but whose IP we could not read is a PASS, not a failure.
 */
async function test(id) {
    const rec = await get(id);
    if (!rec) throw _err("Không tìm thấy proxy.", 404);
    const started = Date.now();

    let ip = null;
    let lastErr = null;
    for (const url of IP_CHECK_URLS) {
        try {
            const res = await axios.get(url, {
                httpsAgent: buildAgent(rec),
                proxy: false,
                timeout: ATTEMPT_TIMEOUT_MS,
            });
            ip = res.data?.ip || (typeof res.data === "string" ? res.data.trim() : null);
            if (ip) break;
        } catch (err) {
            lastErr = err;
        }
    }

    // Auth failures are conclusive — every endpoint will fail the same way, and the
    // reachability probe would only add another 12 seconds to say so.
    if (!ip && lastErr?.response?.status === 407) {
        const message = _explain(lastErr);
        await _touch(id, {
            lastCheckedAt: Date.now(),
            lastError: message,
            failCount: (rec.failCount ?? 0) + 1,
        });
        return { ok: false, error: message, latencyMs: Date.now() - started };
    }

    let reachable = false;
    let reachMs = null;
    const reachStarted = Date.now();
    try {
        await axios.get(REACH_CHECK_URL, {
            httpsAgent: buildAgent(rec),
            proxy: false,
            timeout: ATTEMPT_TIMEOUT_MS,
            validateStatus: () => true,
        });
        reachable = true;
        reachMs = Date.now() - reachStarted;
    } catch (err) {
        lastErr = lastErr || err;
    }

    if (!ip && !reachable) {
        const message = _explain(lastErr);
        await _touch(id, {
            lastCheckedAt: Date.now(),
            lastError: message,
            failCount: (rec.failCount ?? 0) + 1,
        });
        return { ok: false, error: message, latencyMs: Date.now() - started };
    }

    await _touch(id, {
        lastCheckedAt: Date.now(),
        lastIp: ip ?? rec.lastIp ?? null,
        lastError: null,
        failCount: 0,
    });
    return {
        ok: true,
        ip,
        reachable,
        reachMs,
        latencyMs: Date.now() - started,
        // Say so out loud rather than showing a blank IP and letting it read as broken.
        note: ip ? null : "Không đọc được exit IP, nhưng proxy vẫn tới được Discord.",
    };
}

/**
 * Turn a transport failure into something actionable. Raw axios text ("Request
 * failed with status code 407") sends you looking for a bug in the panel when the
 * proxy is simply refusing the credentials you typed.
 */
function _explain(err) {
    const status = err.response?.status;
    if (status === 407)
        return "407 — proxy từ chối user/pass. Kiểm tra lại credential, và xem nhà cung cấp có yêu cầu whitelist IP của panel không.";
    if (status === 403) return "403 — proxy từ chối kết nối (IP của panel chưa được cấp quyền?).";
    if (status) return `HTTP ${status} từ proxy.`;
    const code = err.code || "";
    if (code === "ECONNREFUSED") return "Proxy từ chối kết nối — sai host/port, hoặc proxy đã tắt.";
    if (code === "ETIMEDOUT" || code === "ECONNABORTED") return "Hết thời gian chờ — proxy không phản hồi.";
    if (code === "ENOTFOUND") return "Không phân giải được host của proxy.";
    return err.message || "Không kết nối được qua proxy.";
}

// ── Rotation ─────────────────────────────────────────────────────────────────────

/**
 * Fetch the provider's rotate link to change this proxy's exit IP.
 *
 * Rotation is throttled by rotateMinIntervalSec — providers meter these calls, and
 * a burst of runs starting together would otherwise fire one request each. Pass
 * `force` for the manual button, which is an explicit human decision.
 *
 * Callers must ensure the proxy is NOT mid-run: nothing here breaks a live HTTPS
 * request, but the multi-step OAuth flow in questEngine._completeAchievement can
 * straddle a rotation. proxyPool only rotates on assignment / release, never during.
 */
async function rotate(id, { force = false, reason = "manual" } = {}) {
    const rec = await get(id);
    if (!rec) throw _err("Không tìm thấy proxy.", 404);
    if (rec.type !== "rotating" || !rec.rotateUrl) return { ok: false, skipped: "not_rotating" };

    const minMs = (rec.rotateMinIntervalSec ?? 60) * 1000;
    const since = Date.now() - (rec.lastRotatedAt ?? 0);
    if (!force && minMs > 0 && since < minMs)
        return { ok: false, skipped: "throttled", retryInSec: Math.ceil((minMs - since) / 1000) };

    try {
        await axios.get(rec.rotateUrl, { timeout: 20_000, validateStatus: () => true });
        await _touch(id, { lastRotatedAt: Date.now(), lastRotateError: null });
        console.log(`[Proxy] rotated "${rec.label}" (${reason})`);
        return { ok: true, rotatedAt: Date.now() };
    } catch (err) {
        const message = err.message || "Gọi link đổi IP thất bại.";
        await _touch(id, { lastRotatedAt: Date.now(), lastRotateError: message });
        return { ok: false, error: message };
    }
}

// ── Background idle rotation ─────────────────────────────────────────────────────
//
// Rotates proxies that opted in (rotateIdleIntervalSec > 0) while they are IDLE.
// `isBusy` is injected by proxyPool, the only module that knows which proxies
// currently have a run leased — that is what keeps a rotation from ever landing in
// the middle of an auto quest run.

let _timer = null;
let _isBusy = () => false;

function setBusyProbe(fn) {
    if (typeof fn === "function") _isBusy = fn;
}

async function _idleSweep() {
    let recs;
    try {
        recs = await all();
    } catch {
        return;
    }
    for (const rec of recs) {
        if (rec.enabled === false) continue;
        if (rec.type !== "rotating" || !rec.rotateUrl) continue;
        const every = (rec.rotateIdleIntervalSec ?? 0) * 1000;
        if (every <= 0) continue;
        if (Date.now() - (rec.lastRotatedAt ?? 0) < every) continue;
        if (_isBusy(rec._id)) continue; // a run is using it — leave the IP alone
        await rotate(rec._id, { reason: "idle" }).catch(() => {});
    }
}

function startRotationScheduler() {
    if (_timer) return;
    _timer = setInterval(() => _idleSweep().catch(() => {}), 30_000);
    if (_timer.unref) _timer.unref();
    console.log("[Proxy] idle rotation scheduler started");
}

// ── Bulk import ──────────────────────────────────────────────────────────────────

/**
 * Parse pasted lines into drafts. Accepted per line:
 *   host:port
 *   host:port:user:pass
 *   protocol://user:pass@host:port
 * Blank lines and lines starting with # are ignored. Returns { drafts, errors }.
 */
function parseBulk(text, defaults = {}) {
    const drafts = [];
    const errors = [];
    const lines = String(text ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));

    for (const line of lines) {
        try {
            if (/^[a-z0-9]+:\/\//i.test(line)) {
                const u = new URL(line);
                drafts.push({
                    ...defaults,
                    protocol: u.protocol.replace(":", ""),
                    host: u.hostname,
                    port: parseInt(u.port, 10),
                    username: decodeURIComponent(u.username || ""),
                    password: decodeURIComponent(u.password || ""),
                });
                continue;
            }
            const parts = line.split(":");
            if (parts.length !== 2 && parts.length !== 4) {
                errors.push({ line, error: "Sai định dạng." });
                continue;
            }
            drafts.push({
                ...defaults,
                host: parts[0],
                port: parseInt(parts[1], 10),
                username: parts[2] ?? "",
                password: parts[3] ?? "",
            });
        } catch (e) {
            errors.push({ line, error: e.message });
        }
    }
    return { drafts, errors };
}

/** Create every parsed draft; per-line failures are reported, not thrown. */
async function bulkCreate(text, defaults = {}) {
    const { drafts, errors } = parseBulk(text, defaults);
    const created = [];
    for (const d of drafts) {
        try {
            created.push(await create(d));
        } catch (e) {
            errors.push({ line: `${d.host}:${d.port}`, error: e.message });
        }
    }
    return { created, errors };
}

module.exports = {
    PROTOCOLS,
    KNOWN_USES,
    publicView,
    list,
    get,
    usable,
    create,
    update,
    remove,
    proxyUrl,
    displayUrl,
    buildAgent,
    test,
    rotate,
    setBusyProbe,
    startRotationScheduler,
    parseBulk,
    bulkCreate,
    _touch,
};
