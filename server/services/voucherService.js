const crypto = require("crypto");
const { customAlphabet } = require("nanoid");
const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");
const lifecycle = require("./lifecycle");

// ─────────────────────────────────────────────────────────────────────────────
//  Vouchers — rewards an admin hands out and claims by hand.
//
//    grant    the admin gives a voucher to members (Discord IDs) on the Vouchers
//             page; ArnTo-assistant DMs each of them the code — bus
//             "voucher.granted", sealed, one command for the whole batch.
//    redeem   a member runs /voucher dung on the assistant (POST
//             /api/external/vouchers/redeem). The panel checks the voucher
//             (on, not expired, theirs if it is for granted members only,
//             uses left for them and overall) and records a PENDING use; the
//             assistant posts a card with Claim / Reject in the claim channel.
//    claim    an admin presses Claim (or Reject) on that card, or on the page.
//             Claimed = the admin hands the reward over themselves. Rejected
//             gives the use back. From the page the assistant is told to
//             update the card and DM the member ("voucher.resolved").
//
//  Uses per member: the voucher's `per_user` (0 = no limit), or the member's own
//  limit when the admin set one while granting. Pending and claimed uses count;
//  rejected ones do not.
//  Storage: data/shared.sqlite (travels with a panel move).
// ─────────────────────────────────────────────────────────────────────────────

const CMD_GRANTED = "voucher.granted";
const CMD_RESOLVED = "voucher.resolved";
const SNOWFLAKE = /^\d{17,20}$/;
const CODE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const MAX_GRANT = 200; // members per grant
const DM_SETTLE_MS = 10 * 60_000; // a DM batch never queued this long ago → failed
const SETTINGS = "__voucher.settings";

const newCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8);
const newId = customAlphabet("0123456789ABCDEFGHJKLMNPQRSTUVWXYZ", 8);
const httpError = (status, message, extra) => Object.assign(new Error(message), { status }, extra);
const str = (v, max) => String(v ?? "").trim().slice(0, max);

// ── Storage ──────────────────────────────────────────────────────────────────

let made = null;
const conn = () => {
    const c = sharedStore.raw();
    if (made === c) return c;
    c.exec(`
        CREATE TABLE IF NOT EXISTS vouchers (
            id TEXT PRIMARY KEY,
            code TEXT NOT NULL UNIQUE,         -- what members type, upper case
            name TEXT NOT NULL,                -- the reward
            description TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            audience TEXT NOT NULL,            -- granted (members it was given to) | public (anyone with the code)
            per_user INTEGER NOT NULL,         -- uses per member, 0 = no limit
            total INTEGER NOT NULL,            -- uses overall, 0 = no limit
            expires_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS voucher_grants (
            voucher_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            user_tag TEXT,
            uses INTEGER,                      -- this member's own limit (null = the voucher's per_user)
            granted_at INTEGER NOT NULL,
            dm TEXT NOT NULL,                  -- off | pending | sent | dm_blocked | unknown_user | failed
            dm_at INTEGER,
            bus_id TEXT,
            PRIMARY KEY (voucher_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS voucher_redemptions (
            id TEXT PRIMARY KEY,
            voucher_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            user_tag TEXT,
            note TEXT,
            status TEXT NOT NULL,              -- pending | claimed | rejected
            created_at INTEGER NOT NULL,
            channel_id TEXT,                   -- the claim card on Discord
            message_id TEXT,
            resolved_at INTEGER,
            staff_id TEXT,                     -- who claimed / rejected (null: the panel)
            staff_tag TEXT,
            via TEXT,                          -- discord | panel
            reason TEXT                        -- why it was rejected
        );
        CREATE INDEX IF NOT EXISTS voucher_redemptions_by_user ON voucher_redemptions(voucher_id, user_id, status);
        CREATE INDEX IF NOT EXISTS voucher_redemptions_by_status ON voucher_redemptions(status, created_at);
    `);
    made = c;
    return c;
};

// ── Settings ─────────────────────────────────────────────────────────────────

const cleanIds = (v) => [...new Set((Array.isArray(v) ? v.join(" ") : String(v || "")).match(/\d{17,20}/g) || [])];

/** Where claim cards go, who is pinged, which roles may claim besides Administrators. */
const getSettings = () => {
    const r = conn().prepare("SELECT value FROM kv WHERE name = ?").get(SETTINGS);
    const s = r ? JSON.parse(r.value) : {};
    return { channelId: s.channelId || null, pingRoleId: s.pingRoleId || null, staffRoleIds: s.staffRoleIds || [] };
};

const setSettings = (input = {}) => {
    const one = (v) => {
        const id = str(v, 32);
        if (id && !SNOWFLAKE.test(id)) throw httpError(400, `"${id}" is not a Discord ID`);
        return id || null;
    };
    const next = { ...getSettings() };
    if (input.channelId !== undefined) next.channelId = one(input.channelId);
    if (input.pingRoleId !== undefined) next.pingRoleId = one(input.pingRoleId);
    if (input.staffRoleIds !== undefined) next.staffRoleIds = cleanIds(input.staffRoleIds).slice(0, 25);
    conn().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(SETTINGS, JSON.stringify(next));
    return next;
};

// ── Vouchers ─────────────────────────────────────────────────────────────────

const count = (v, max) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
};

const usageOf = (voucherId) => {
    const out = { pending: 0, claimed: 0, rejected: 0 };
    for (const r of conn().prepare("SELECT status, COUNT(*) n FROM voucher_redemptions WHERE voucher_id = ? GROUP BY status").all(voucherId)) out[r.status] = r.n;
    out.used = out.pending + out.claimed;
    out.granted = conn().prepare("SELECT COUNT(*) n FROM voucher_grants WHERE voucher_id = ?").get(voucherId).n;
    return out;
};

const toVoucher = (r) =>
    r && {
        id: r.id,
        code: r.code,
        name: r.name,
        description: r.description,
        enabled: !!r.enabled,
        audience: r.audience,
        perUser: r.per_user,
        total: r.total,
        expiresAt: r.expires_at,
        counts: usageOf(r.id),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };

const voucherRow = (ref) => conn().prepare("SELECT * FROM vouchers WHERE id = ? OR code = ?").get(String(ref || ""), String(ref || "").trim().toUpperCase());
const requireVoucher = (ref) => {
    const r = voucherRow(ref);
    if (!r) throw httpError(404, "Voucher not found");
    return r;
};

const listVouchers = () => conn().prepare("SELECT * FROM vouchers ORDER BY created_at DESC").all().map(toVoucher);
const getVoucher = (ref) => toVoucher(requireVoucher(ref));

/** The editable parts, normalised over what is there now. */
const cleanVoucher = (input, current = {}) => {
    const pick = (k, fallback) => (input[k] === undefined ? current[k] ?? fallback : input[k]);
    const name = str(pick("name", ""), 100);
    if (!name) throw httpError(400, "The voucher name is required");
    const audience = pick("audience", "granted") === "public" ? "public" : "granted";
    const exp = pick("expiresAt", null);
    const expiresAt = exp === null || exp === "" ? null : Number(exp);
    if (expiresAt !== null && !(Number.isFinite(expiresAt) && expiresAt > 0)) throw httpError(400, "Invalid expiry date");
    return {
        name,
        description: str(pick("description", ""), 1500),
        audience,
        per_user: count(pick("perUser", 1), 10_000),
        total: count(pick("total", 0), 1_000_000),
        expires_at: expiresAt,
        enabled: pick("enabled", true) ? 1 : 0,
    };
};

const cleanCode = (code, exceptId = "") => {
    const c = str(code, 32).toUpperCase();
    if (!CODE.test(c)) throw httpError(400, "The code may only use A-Z, 0-9, - and _ (3 to 32 characters)");
    if (conn().prepare("SELECT id FROM vouchers WHERE code = ? AND id != ?").get(c, exceptId)) throw httpError(409, `Another voucher already uses the code "${c}"`);
    return c;
};

const uniqueCode = () => {
    for (;;) {
        const c = newCode();
        if (!conn().prepare("SELECT 1 FROM vouchers WHERE code = ?").get(c)) return c;
    }
};

const createVoucher = (input = {}) => {
    const v = cleanVoucher(input);
    const code = str(input.code, 32) ? cleanCode(input.code) : uniqueCode();
    const id = crypto.randomBytes(8).toString("hex");
    const now = Date.now();
    conn()
        .prepare(
            `INSERT INTO vouchers (id, code, name, description, enabled, audience, per_user, total, expires_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, code, v.name, v.description, v.enabled, v.audience, v.per_user, v.total, v.expires_at, now, now);
    return getVoucher(id);
};

const updateVoucher = (ref, input = {}) => {
    const row = requireVoucher(ref);
    const current = { name: row.name, description: row.description, audience: row.audience, perUser: row.per_user, total: row.total, expiresAt: row.expires_at, enabled: !!row.enabled };
    const v = cleanVoucher(input, current);
    const code = input.code === undefined ? row.code : cleanCode(input.code, row.id);
    conn()
        .prepare("UPDATE vouchers SET code = ?, name = ?, description = ?, enabled = ?, audience = ?, per_user = ?, total = ?, expires_at = ?, updated_at = ? WHERE id = ?")
        .run(code, v.name, v.description, v.enabled, v.audience, v.per_user, v.total, v.expires_at, Date.now(), row.id);
    return getVoucher(row.id);
};

/** With its members and its history. Refused while a use waits for a claim. */
const deleteVoucher = (ref) => {
    const row = requireVoucher(ref);
    const c = conn();
    if (c.prepare("SELECT 1 FROM voucher_redemptions WHERE voucher_id = ? AND status = 'pending'").get(row.id)) {
        throw httpError(409, "A use of this voucher is waiting for a claim — claim or reject it first");
    }
    c.transaction(() => {
        c.prepare("DELETE FROM voucher_redemptions WHERE voucher_id = ?").run(row.id);
        c.prepare("DELETE FROM voucher_grants WHERE voucher_id = ?").run(row.id);
        c.prepare("DELETE FROM vouchers WHERE id = ?").run(row.id);
    })();
    return { deleted: true };
};

// ── Uses ─────────────────────────────────────────────────────────────────────

const grantRow = (voucherId, userId) => conn().prepare("SELECT * FROM voucher_grants WHERE voucher_id = ? AND user_id = ?").get(voucherId, userId);
const usedBy = (voucherId, userId) =>
    conn().prepare("SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id = ? AND user_id = ? AND status IN ('pending', 'claimed')").get(voucherId, userId).n;
/** 0 = no limit. */
const limitFor = (row, grant) => (grant && grant.uses !== null && grant.uses !== undefined ? grant.uses : row.per_user);
const left = (limit, used) => (limit ? Math.max(limit - used, 0) : null);

/** Why `userId` cannot use the voucher now, or null. */
const refusal = (row, userId, now = Date.now()) => {
    if (!row.enabled) return { reason: "disabled" };
    if (row.expires_at && row.expires_at <= now) return { reason: "expired" };
    const grant = grantRow(row.id, userId);
    if (row.audience === "granted" && !grant) return { reason: "not_granted" };
    const limit = limitFor(row, grant);
    const used = usedBy(row.id, userId);
    if (limit && used >= limit) return { reason: "limit_user", used, limit };
    if (row.total && usageOf(row.id).used >= row.total) return { reason: "limit_total" };
    return null;
};

// ── Redemptions ──────────────────────────────────────────────────────────────

const toRedemption = (r) => ({
    id: r.id,
    voucherId: r.voucher_id,
    voucherName: r.voucher_name ?? null,
    voucherCode: r.voucher_code ?? null,
    userId: r.user_id,
    userTag: r.user_tag,
    note: r.note,
    status: r.status,
    createdAt: r.created_at,
    channelId: r.channel_id,
    messageId: r.message_id,
    resolvedAt: r.resolved_at,
    staffId: r.staff_id,
    staffTag: r.staff_tag,
    via: r.via,
    reason: r.reason,
});

const REDEMPTION_SELECT = `
    SELECT r.*, v.name AS voucher_name, v.code AS voucher_code
    FROM voucher_redemptions r
    LEFT JOIN vouchers v ON v.id = r.voucher_id`;

/**
 * One use with what the claim card shows: the voucher, and the member's uses of it.
 * → { redemption, voucher: { id, code, name, description }, usage: { used, limit } }
 */
const viewOf = (id) => {
    const r = conn().prepare(`${REDEMPTION_SELECT} WHERE r.id = ?`).get(String(id || ""));
    if (!r) throw httpError(404, "This voucher use no longer exists");
    const v = conn().prepare("SELECT * FROM vouchers WHERE id = ?").get(r.voucher_id);
    return {
        redemption: toRedemption(r),
        voucher: v ? { id: v.id, code: v.code, name: v.name, description: v.description } : null,
        usage: v ? { used: usedBy(v.id, r.user_id), limit: limitFor(v, grantRow(v.id, r.user_id)) } : null,
    };
};

/**
 * A member uses a voucher (ArnTo-assistant's /voucher dung).
 * → { ok: true, view, card: { channelId, pingRoleId } }
 *   { ok: false, reason: "not_found" | "disabled" | "expired" | "not_granted" | "limit_user" | "limit_total", used?, limit? }
 */
const redeem = ({ code, userId, userTag, note } = {}) => {
    userId = String(userId || "").trim();
    if (!SNOWFLAKE.test(userId)) throw httpError(400, "Invalid member Discord ID");
    const c = conn();
    const id = newId();
    const out = c.transaction(() => {
        const row = c.prepare("SELECT * FROM vouchers WHERE code = ?").get(str(code, 32).toUpperCase());
        if (!row) return { ok: false, reason: "not_found" };
        const no = refusal(row, userId);
        if (no) return { ok: false, ...no };
        c.prepare(
            "INSERT INTO voucher_redemptions (id, voucher_id, user_id, user_tag, note, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
        ).run(id, row.id, userId, str(userTag, 64) || null, str(note, 300) || null, Date.now());
        return { ok: true };
    })();
    if (!out.ok) return out;
    const { channelId, pingRoleId } = getSettings();
    return { ok: true, view: viewOf(id), card: { channelId, pingRoleId } };
};

/** Where the assistant posted the claim card — the page's claims update it. */
const attachCard = (id, { channelId, messageId } = {}) => {
    if (!SNOWFLAKE.test(String(channelId || "")) || !SNOWFLAKE.test(String(messageId || ""))) throw httpError(400, "channelId and messageId are required");
    const res = conn().prepare("UPDATE voucher_redemptions SET channel_id = ?, message_id = ? WHERE id = ?").run(String(channelId), String(messageId), String(id));
    if (!res.changes) throw httpError(404, "This voucher use no longer exists");
    return { ok: true };
};

/** May this Discord member claim? Administrators, or a staff role from the settings. */
const canClaim = ({ isAdmin, roleIds } = {}) => {
    if (isAdmin) return true;
    const staff = getSettings().staffRoleIds;
    return Array.isArray(roleIds) && roleIds.some((r) => staff.includes(String(r)));
};

/**
 * pending → claimed | rejected. A use already settled is a 409 carrying its
 * current view, so a stale card can still be brought up to date.
 * From the panel the assistant is told to update the card and DM the member.
 */
const resolve = (id, status, { staffId, staffTag, via = "panel", reason } = {}) => {
    const res = conn()
        .prepare("UPDATE voucher_redemptions SET status = ?, resolved_at = ?, staff_id = ?, staff_tag = ?, via = ?, reason = ? WHERE id = ? AND status = 'pending'")
        .run(
            status,
            Date.now(),
            SNOWFLAKE.test(String(staffId || "")) ? String(staffId) : null,
            str(staffTag, 64) || null,
            via === "discord" ? "discord" : "panel",
            status === "rejected" ? str(reason, 300) || null : null,
            String(id),
        );
    const view = viewOf(id);
    if (!res.changes) {
        const r = view.redemption;
        throw httpError(409, `This use was already ${r.status}${r.staffTag ? ` by ${r.staffTag}` : ""}`, { view });
    }
    if (via !== "discord") announce(view);
    return view;
};

const claim = (id, who) => resolve(id, "claimed", who);
const reject = (id, who) => resolve(id, "rejected", who);

/** Bus "voucher.resolved": the assistant updates the card and DMs the member. */
const announce = (view) => {
    const target = discordBus.handlerOf(CMD_RESOLVED);
    if (!target) return false;
    discordBus.notify(target, CMD_RESOLVED, view, { sealed: true }).catch((err) => console.warn(`[Voucher] ${CMD_RESOLVED} not queued: ${err.message}`));
    return true;
};

/** Newest first; narrowed to one voucher and/or one status. */
const listRedemptions = ({ voucherId, status, limit = 500 } = {}) => {
    const n = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    const where = [];
    const args = [];
    if (voucherId) {
        where.push("r.voucher_id = ?");
        args.push(requireVoucher(voucherId).id);
    }
    if (["pending", "claimed", "rejected"].includes(status)) {
        where.push("r.status = ?");
        args.push(status);
    }
    return conn()
        .prepare(`${REDEMPTION_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.created_at DESC LIMIT ?`)
        .all(...args, n)
        .map(toRedemption);
};

// ── Members (grants) ─────────────────────────────────────────────────────────

const toGrant = (r) => ({
    userId: r.user_id,
    userTag: r.user_tag,
    uses: r.uses,
    used: r.used,
    grantedAt: r.granted_at,
    dm: r.dm,
    dmAt: r.dm_at,
});

const listGrants = (ref) => {
    const row = requireVoucher(ref);
    return conn()
        .prepare(
            `SELECT g.*, (SELECT COUNT(*) FROM voucher_redemptions r
                          WHERE r.voucher_id = g.voucher_id AND r.user_id = g.user_id AND r.status IN ('pending', 'claimed')) AS used
             FROM voucher_grants g WHERE g.voucher_id = ? ORDER BY g.granted_at DESC`,
        )
        .all(row.id)
        .map(toGrant);
};

/** "" / null → the voucher's own limit; a number → this member's limit (0 = no limit). */
const cleanUses = (v) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0) throw httpError(400, "Invalid number of uses");
    return Math.min(n, 10_000);
};

/**
 * Give the voucher to members (Discord IDs or mentions in any text) and, with
 * `notify`, have the assistant DM them the code. A member who already has it
 * keeps their uses so far; `uses` (when given) replaces their own limit.
 * → { added, updated, unknown: [ids], dm: "queued" | "off" | "unavailable" }
 */
const grant = async (ref, { userIds, uses, notify = true } = {}) => {
    const row = requireVoucher(ref);
    const ids = cleanIds(userIds);
    if (!ids.length) throw httpError(400, "No Discord IDs found");
    if (ids.length > MAX_GRANT) throw httpError(400, `At most ${MAX_GRANT} members at a time`);
    const limit = uses === undefined ? undefined : cleanUses(uses);

    // The panel's bot looks the members up: an id nobody has is left out.
    const tags = new Map();
    const unknown = [];
    for (let i = 0; i < ids.length; i += 10) {
        await Promise.all(
            ids.slice(i, i + 10).map(async (id) => {
                try {
                    tags.set(id, (await discordBus.userTag(id)) || null);
                } catch (err) {
                    if (err.code === 10013) unknown.push(id);
                    else tags.set(id, null);
                }
            }),
        );
    }
    const members = ids.filter((id) => !unknown.includes(id));

    const target = notify ? discordBus.handlerOf(CMD_GRANTED) : null;
    const canDm = !!target && !!discordBus.status().ready;
    const dm = !notify ? "off" : canDm ? "queued" : "unavailable";

    const c = conn();
    const now = Date.now();
    let added = 0;
    let updated = 0;
    c.transaction(() => {
        for (const id of members) {
            const had = grantRow(row.id, id);
            const own = limit === undefined ? (had ? had.uses : null) : limit;
            const state = canDm ? "pending" : had && !notify ? had.dm : "off";
            c.prepare(
                `INSERT INTO voucher_grants (voucher_id, user_id, user_tag, uses, granted_at, dm, dm_at, bus_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                 ON CONFLICT(voucher_id, user_id) DO UPDATE SET
                     user_tag = COALESCE(excluded.user_tag, user_tag), uses = excluded.uses, dm = excluded.dm,
                     dm_at = excluded.dm_at, bus_id = CASE WHEN excluded.dm = 'pending' THEN NULL ELSE bus_id END`,
            ).run(row.id, id, tags.get(id) || had?.user_tag || null, own, had?.granted_at || now, state, canDm ? now : had?.dm_at || null);
            if (had) updated++;
            else added++;
        }
    })();

    if (canDm && members.length) sendGrantDms(row.id, members, target);
    return { added, updated, unknown, dm };
};

/** One command for the batch; the answer (or settle()) records each member's DM. */
const sendGrantDms = (voucherId, userIds, target) => {
    const row = conn().prepare("SELECT * FROM vouchers WHERE id = ?").get(voucherId);
    const users = userIds.map((id) => ({ id, uses: limitFor(row, grantRow(row.id, id)) }));
    let busId = null;
    discordBus
        .request(
            target,
            CMD_GRANTED,
            {
                voucher: { code: row.code, name: row.name, description: row.description, audience: row.audience, expiresAt: row.expires_at },
                users,
            },
            {
                sealed: true,
                timeoutMs: 30_000 + users.length * 1500,
                onQueued: (id) => {
                    busId = id;
                    const set = conn().prepare("UPDATE voucher_grants SET bus_id = ? WHERE voucher_id = ? AND user_id = ? AND dm = 'pending' AND bus_id IS NULL");
                    conn().transaction(() => userIds.forEach((u) => set.run(id, voucherId, u)))();
                },
            },
        )
        .then((result) => applyDmResults(voucherId, busId, userIds, result))
        .catch((err) => {
            // Unanswered: settle() reads the answer from the outbox when it comes.
            if (err.status === 504) return;
            console.warn(`[Voucher] DMs for ${row.code} failed: ${err.message}`);
            markDm(voucherId, busId, userIds, "failed");
        });
};

const DM_STATES = new Set(["sent", "dm_blocked", "unknown_user", "failed"]);

const markDm = (voucherId, busId, userIds, state) => {
    const set = conn().prepare(
        "UPDATE voucher_grants SET dm = ? WHERE voucher_id = ? AND user_id = ? AND dm = 'pending' AND (bus_id IS ? OR bus_id IS NULL)",
    );
    conn().transaction(() => userIds.forEach((u) => set.run(state, voucherId, u, busId)))();
};

const applyDmResults = (voucherId, busId, userIds, result) => {
    const results = result?.results || {};
    const set = conn().prepare("UPDATE voucher_grants SET dm = ? WHERE voucher_id = ? AND user_id = ? AND dm = 'pending' AND bus_id IS ?");
    conn().transaction(() => {
        for (const u of userIds) set.run(DM_STATES.has(results[u]) ? results[u] : "failed", voucherId, u, busId);
    })();
};

/** DM one member again (they opened their DMs). */
const resendDm = (ref, userId) => {
    const row = requireVoucher(ref);
    const g = grantRow(row.id, String(userId));
    if (!g) throw httpError(404, "This member does not have the voucher");
    const target = discordBus.handlerOf(CMD_GRANTED);
    if (!target) throw httpError(503, `ArnTo-assistant has not announced "${CMD_GRANTED}" — update and restart the bot`);
    if (!discordBus.status().ready) throw httpError(503, "The panel's Discord bus is not ready");
    conn().prepare("UPDATE voucher_grants SET dm = 'pending', dm_at = ?, bus_id = NULL WHERE voucher_id = ? AND user_id = ?").run(Date.now(), row.id, g.user_id);
    sendGrantDms(row.id, [g.user_id], target);
    return { dm: "queued" };
};

const updateGrant = (ref, userId, { uses } = {}) => {
    const row = requireVoucher(ref);
    const res = conn().prepare("UPDATE voucher_grants SET uses = ? WHERE voucher_id = ? AND user_id = ?").run(cleanUses(uses), row.id, String(userId));
    if (!res.changes) throw httpError(404, "This member does not have the voucher");
    return { ok: true };
};

/** Take it back — their past uses stay in the history. */
const revoke = (ref, userId) => {
    const row = requireVoucher(ref);
    const res = conn().prepare("DELETE FROM voucher_grants WHERE voucher_id = ? AND user_id = ?").run(row.id, String(userId));
    if (!res.changes) throw httpError(404, "This member does not have the voucher");
    return { deleted: true };
};

/**
 * DM batches whose answer was lost (timeout, restart): close them from the
 * outbox row. One still on its way waits; one that never got queued fails.
 */
const settle = () => {
    const now = Date.now();
    const pending = conn().prepare("SELECT voucher_id, user_id, bus_id, dm_at FROM voucher_grants WHERE dm = 'pending'").all();
    for (const g of pending) {
        const bus = discordBus.get(g.bus_id);
        if (bus?.status === "done") applyDmResults(g.voucher_id, g.bus_id, [g.user_id], bus.result);
        else if (bus?.status === "failed") markDm(g.voucher_id, g.bus_id, [g.user_id], "failed");
        else if (bus) continue;
        else if (now - (g.dm_at || 0) > DM_SETTLE_MS) markDm(g.voucher_id, g.bus_id, [g.user_id], "failed");
    }
};

// ── What a member sees (/voucher on the assistant) ───────────────────────────

/**
 * The vouchers given to `userId` that are on and not expired, with their uses.
 * Vouchers for anyone with the code are not listed — the code is the secret.
 */
const mine = (userId) => {
    userId = String(userId || "");
    if (!SNOWFLAKE.test(userId)) throw httpError(400, "Invalid member Discord ID");
    const now = Date.now();
    return conn()
        .prepare(
            `SELECT v.*, g.uses AS grant_uses FROM voucher_grants g JOIN vouchers v ON v.id = g.voucher_id
             WHERE g.user_id = ? AND v.enabled = 1 AND (v.expires_at IS NULL OR v.expires_at > ?) ORDER BY g.granted_at DESC`,
        )
        .all(userId, now)
        .map((r) => {
            const limit = limitFor(r, { uses: r.grant_uses });
            const used = usedBy(r.id, userId);
            const pending = conn().prepare("SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id = ? AND user_id = ? AND status = 'pending'").get(r.id, userId).n;
            const totalLeft = r.total ? Math.max(r.total - usageOf(r.id).used, 0) : null;
            return { code: r.code, name: r.name, description: r.description, expiresAt: r.expires_at, used, limit, remaining: left(limit, used), pending, totalLeft };
        });
};

/** Who answers on the bus — for the Vouchers page's warnings. */
const status = () => ({
    busReady: !!discordBus.status().ready,
    dmSender: discordBus.handlerOf(CMD_GRANTED),
    cardUpdater: discordBus.handlerOf(CMD_RESOLVED),
    settings: getSettings(),
});

const start = () => {
    conn();
    settle();
    setInterval(
        lifecycle.guard(() => {
            try {
                settle();
            } catch (e) {
                console.error("[Voucher] Settle failed:", e.message);
            }
        }),
        60_000,
    );
    console.log("[Voucher] Voucher service started");
};

module.exports = {
    CMD_GRANTED,
    CMD_RESOLVED,
    getSettings,
    setSettings,
    listVouchers,
    getVoucher,
    createVoucher,
    updateVoucher,
    deleteVoucher,
    redeem,
    attachCard,
    canClaim,
    claim,
    reject,
    viewOf,
    listRedemptions,
    listGrants,
    grant,
    resendDm,
    updateGrant,
    revoke,
    settle,
    mine,
    status,
    start,
};
