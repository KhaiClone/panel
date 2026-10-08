const { customAlphabet } = require("nanoid");
const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");

// ─────────────────────────────────────────────────────────────────────────────
//  Supporters — ArnTo-Shop's paid helpers (hỗ trợ viên) and their salary.
//
//    add / remove   on the Supporters page or with /staff-new, /staff-remove.
//                   The shop gives / takes the Supporter role and DMs them the
//                   welcome / farewell text kept here. The Staff role is never
//                   touched: the owner hands it out by hand.
//    credit         salary for an order (/done on the shop), or an adjustment
//                   (+ / −) from the page, /staff-add or /staff-deduct.
//    payout         the whole balance is paid by bank transfer (VietQR on the
//                   page, or /staff-pay on Discord) and goes back to 0.
//
//  Every change is a row in the ledger, so the history is the panel's, not a
//  Discord log channel's. `owed` splits the unpaid balance by who owes it (the
//  seller whose order it was, or who added it) — counted since the last payout.
//
//  The shop does everything on Discord (role, DM, the salary log channel) from
//  one bus command, "supporter.event". A change made on the page is sent to it;
//  one the shop made through /api/external/supporters comes back in the answer
//  and the shop applies it itself. The shop seeds the list once from its old
//  local "supporters" collection (importFrom); the project that did is the
//  owner — the only one whose key may read or change it.
//
//  Storage: data/shared.sqlite (travels with a panel move).
// ─────────────────────────────────────────────────────────────────────────────

const CMD = "supporter.event";
const META = "__supporter.meta"; // { owner, imported, importedAt }
const SETTINGS = "__supporter.settings"; // { welcome, farewell }
const SNOWFLAKE = /^\d{17,20}$/;
const BIN = /^\d{6}$/;
const MAX_AMOUNT = 1_000_000_000;
const CREDIT_KINDS = ["salary", "add", "deduct"];
const KINDS = ["joined", "left", "salary", "add", "deduct", "payout", "import"];
const TEMPLATE_VARS = ["{user}", "{id}", "{tag}"];

const newId = customAlphabet("0123456789ABCDEFGHJKLMNPQRSTUVWXYZ", 10);
const httpError = (status, message, extra) => Object.assign(new Error(message), { status }, extra);
const str = (v, max) => String(v ?? "").trim().slice(0, max);

const DEFAULT_WELCOME = [
    "# Thông Báo Gia Nhập Đội Ngũ Hỗ Trợ Tại ArnTo Shop",
    "Đội ngũ Admin thông báo đến Người dùng {user} ({id}) rằng bạn đã được chúng tôi duyệt vào Đội ngũ Hỗ Trợ Viên (Supporter).",
    "**Vui lòng đọc các hướng dẫn sau để hiểu rõ quy trình làm việc và nhiệm vụ của bạn tại ArnTo Shop**",
    "- <#1425086879753306142> - Quy định Nhân Viên",
    "- <#1456855530298413060> - Hướng dẫn",
    "- <#1425081133183537173> - Tiền lương Hoa Hồng",
    "Ngoài ra còn có các kênh <#1425072181423116329>, <#1457771931540525150> để bạn có thể trao đổi trực tiếp với Admin và sử dụng bot cơ bản.",
    "",
    "Mọi thắc mắc xin liên hệ <@427399742906040333> hoặc <@871329074046435338> để được giải đáp.",
    "",
    "Chúc bạn có những trải nghiệm tuyệt vời tại ArnTo Shop!",
    "",
    "#ArnTo Shop - Giàu Vì Bạn, Sang Vì Tôi",
].join("\n");

const DEFAULT_FAREWELL = [
    "# Thông Báo Lọc Nhân Viên Tại ArnTo Shop",
    "Đội ngũ Admin thông báo đến Người dùng {user} ({id}) rằng bạn đã được cho nghỉ khỏi Đội ngũ Hỗ Trợ Viên.",
    "",
    "Chúng tôi cảm ơn bạn vì những đóng góp của bạn trong thời gian qua. Chúc bạn mọi điều tốt đẹp và thành công trong tương lai!",
    "",
    "#ArnTo Shop - Giàu Vì Bạn, Sang Vì Tôi",
].join("\n");

// ── Storage ──────────────────────────────────────────────────────────────────

let made = null;
const conn = () => {
    const c = sharedStore.raw();
    if (made === c) return c;
    c.exec(`
        CREATE TABLE IF NOT EXISTS supporters (
            user_id TEXT PRIMARY KEY,
            user_tag TEXT,
            bank_code TEXT NOT NULL,           -- the bank's short name (VietQR), e.g. MBBank
            bank_bin TEXT NOT NULL,            -- its 6-digit VietQR BIN
            account_number TEXT NOT NULL,
            account_name TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            balance INTEGER NOT NULL DEFAULT 0, -- VND not paid out yet
            active INTEGER NOT NULL DEFAULT 1,  -- 0: left (kept for the history)
            joined_at INTEGER NOT NULL,
            left_at INTEGER,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS supporter_ledger (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            kind TEXT NOT NULL,                -- joined | left | salary | add | deduct | payout | import
            amount INTEGER NOT NULL,           -- signed change of the balance (0 for joined / left)
            balance INTEGER NOT NULL,          -- the balance after it
            seller_id TEXT,                    -- who owes it (salary: the order's seller)
            order_id TEXT,
            note TEXT,
            by_id TEXT,                        -- who did it (null: the panel)
            by_tag TEXT,
            via TEXT NOT NULL,                 -- discord | panel | import
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS supporter_ledger_by_user ON supporter_ledger(user_id, created_at);
    `);
    made = c;
    return c;
};

const kvGet = (name) => {
    const r = conn().prepare("SELECT value FROM kv WHERE name = ?").get(name);
    return r ? JSON.parse(r.value) : null;
};
const kvSet = (name, value) => conn().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(name, JSON.stringify(value));

const meta = () => ({ owner: null, imported: false, importedAt: null, ...(kvGet(META) || {}) });

/** May this project's key read / change the supporters? The first one to import owns them. */
const canAccess = (botId) => {
    const { owner } = meta();
    return !owner || owner === botId;
};

// ── Settings (the DM texts) ──────────────────────────────────────────────────

const getSettings = () => {
    const s = kvGet(SETTINGS) || {};
    return { welcome: s.welcome || DEFAULT_WELCOME, farewell: s.farewell || DEFAULT_FAREWELL, vars: TEMPLATE_VARS };
};

const setSettings = (input = {}) => {
    const s = kvGet(SETTINGS) || {};
    // Empty = back to the default text.
    if (input.welcome !== undefined) s.welcome = str(input.welcome, 1900) || null;
    if (input.farewell !== undefined) s.farewell = str(input.farewell, 1900) || null;
    kvSet(SETTINGS, s);
    return getSettings();
};

const render = (template, { userId, userTag }) =>
    String(template)
        .replace(/\{user\}/g, `<@${userId}>`)
        .replace(/\{id\}/g, userId)
        .replace(/\{tag\}/g, userTag || userId);

// ── Reading ──────────────────────────────────────────────────────────────────

const row = (userId) => conn().prepare("SELECT * FROM supporters WHERE user_id = ?").get(String(userId || ""));

const requireRow = (userId, { active = true } = {}) => {
    const r = row(userId);
    if (!r || (active && !r.active)) throw httpError(404, "This user is not a supporter");
    return r;
};

/** Unpaid balance by who owes it — the credits since the last payout. */
const owedOf = (userId) => {
    const c = conn();
    const last = c.prepare("SELECT MAX(rowid) FROM supporter_ledger WHERE user_id = ? AND kind = 'payout'").pluck().get(userId) || 0;
    return c
        .prepare(
            `SELECT seller_id, SUM(amount) AS amount FROM supporter_ledger
             WHERE user_id = ? AND rowid > ? AND kind IN ('salary', 'add', 'deduct', 'import')
             GROUP BY seller_id HAVING SUM(amount) != 0 ORDER BY SUM(amount) DESC`,
        )
        .all(userId, last)
        .map((r) => ({ sellerId: r.seller_id || null, amount: r.amount }));
};

const totalsOf = (userId) => {
    const t = conn()
        .prepare(
            `SELECT COALESCE(SUM(CASE WHEN kind IN ('salary', 'add', 'deduct', 'import') THEN amount END), 0) AS earned,
                    COALESCE(-SUM(CASE WHEN kind = 'payout' THEN amount END), 0) AS paid,
                    COUNT(CASE WHEN kind = 'salary' THEN 1 END) AS orders,
                    MAX(CASE WHEN kind = 'payout' THEN created_at END) AS last_payout
             FROM supporter_ledger WHERE user_id = ?`,
        )
        .get(userId);
    return { earned: t.earned, paid: t.paid, orders: t.orders, lastPayoutAt: t.last_payout || null };
};

const toSupporter = (r) =>
    r && {
        userId: r.user_id,
        userTag: r.user_tag,
        bank: { code: r.bank_code, bin: r.bank_bin },
        accountNumber: r.account_number,
        accountName: r.account_name,
        note: r.note,
        balance: r.balance,
        owed: owedOf(r.user_id),
        ...totalsOf(r.user_id),
        active: !!r.active,
        joinedAt: r.joined_at,
        leftAt: r.left_at,
        updatedAt: r.updated_at,
    };

/** Active ones, biggest balance first; `all` adds the ones who left. */
const list = ({ all = false } = {}) =>
    conn()
        .prepare(`SELECT * FROM supporters ${all ? "" : "WHERE active = 1"} ORDER BY active DESC, balance DESC, joined_at`)
        .all()
        .map(toSupporter);

const get = (userId, { active = false } = {}) => toSupporter(requireRow(userId, { active }));

const toEntry = (r) => ({
    id: r.id,
    userId: r.user_id,
    userTag: r.user_tag ?? null,
    kind: r.kind,
    amount: r.amount,
    balance: r.balance,
    sellerId: r.seller_id,
    orderId: r.order_id,
    note: r.note,
    byId: r.by_id,
    byTag: r.by_tag,
    via: r.via,
    createdAt: r.created_at,
});

/** Newest first; narrowed to one supporter and/or one kind. */
const ledger = ({ userId, kind, limit = 500 } = {}) => {
    const n = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    const where = [];
    const args = [];
    if (userId) {
        where.push("l.user_id = ?");
        args.push(String(userId));
    }
    if (KINDS.includes(kind)) {
        where.push("l.kind = ?");
        args.push(kind);
    }
    return conn()
        .prepare(
            `SELECT l.*, s.user_tag FROM supporter_ledger l LEFT JOIN supporters s ON s.user_id = l.user_id
             ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY l.rowid DESC LIMIT ?`,
        )
        .all(...args, n)
        .map(toEntry);
};

// ── Validation ───────────────────────────────────────────────────────────────

const userIdOf = (v) => {
    const id = str(v, 20);
    if (!SNOWFLAKE.test(id)) throw httpError(400, "Invalid Discord user ID");
    return id;
};

const optionalId = (v, what) => {
    const id = str(v, 20);
    if (id && !SNOWFLAKE.test(id)) throw httpError(400, `${what} must be a Discord ID`);
    return id || null;
};

const bankOf = (input, current = {}) => {
    const has = (k) => input[k] !== undefined;
    const code = has("bankCode") ? str(input.bankCode, 32) : current.bank_code;
    const bin = has("bankBin") ? str(input.bankBin, 6) : current.bank_bin;
    const account = has("accountNumber") ? str(input.accountNumber, 32).replace(/\s+/g, "") : current.account_number;
    if (!code || !BIN.test(String(bin || ""))) throw httpError(400, "Pick the bank");
    if (!/^[0-9A-Za-z]{4,32}$/.test(String(account || ""))) throw httpError(400, "Invalid account number");
    return {
        bank_code: code,
        bank_bin: bin,
        account_number: account,
        account_name: has("accountName") ? str(input.accountName, 64).toUpperCase() : current.account_name || "",
    };
};

const amountOf = (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n <= 0) throw httpError(400, "The amount must be a positive number");
    if (n > MAX_AMOUNT) throw httpError(400, "The amount is too large");
    return n;
};

/** Who did it: { byId, byTag, via } — from the page it is just "Panel". */
const whoOf = (who = {}) => ({
    by_id: SNOWFLAKE.test(String(who.byId || "")) ? String(who.byId) : null,
    by_tag: str(who.byTag, 64) || (who.via === "discord" ? null : "Panel"),
    via: who.via === "discord" ? "discord" : who.via === "import" ? "import" : "panel",
});

const addEntry = (userId, { kind, amount = 0, balance, sellerId = null, orderId = null, note = null, createdAt = Date.now() }, who) => {
    const w = whoOf(who);
    const id = newId();
    conn()
        .prepare(
            `INSERT INTO supporter_ledger (id, user_id, kind, amount, balance, seller_id, order_id, note, by_id, by_tag, via, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, userId, kind, amount, balance, sellerId, orderId, note, w.by_id, w.by_tag, w.via, createdAt);
    return toEntry({ ...conn().prepare("SELECT * FROM supporter_ledger WHERE id = ?").get(id), user_tag: row(userId)?.user_tag });
};

// ── Events for the shop ──────────────────────────────────────────────────────

/** What the shop does on Discord for a change: role, DM, salary log. */
const eventOf = (event, r, entry = null) => ({
    event,
    userId: r.user_id,
    userTag: r.user_tag,
    balance: r.balance,
    bank: { code: r.bank_code, bin: r.bank_bin },
    accountNumber: r.account_number,
    accountName: r.account_name,
    entry,
    dm: event === "joined" ? render(getSettings().welcome, { userId: r.user_id, userTag: r.user_tag }) : event === "left" ? render(getSettings().farewell, { userId: r.user_id, userTag: r.user_tag }) : null,
});

const shop = () => {
    const { owner } = meta();
    if (owner && discordBus.canHandle(owner, CMD)) return owner;
    return discordBus.handlerOf(CMD);
};

/**
 * Send a change made on the page to the shop. `wait`: wait for its answer (role
 * given? DM sent?) — the page shows it. Otherwise fire and forget.
 * → { sent: true, result } | { sent: true, queued: true } | { sent: false, error }
 */
const tellShop = async (event, { wait = false } = {}) => {
    const target = shop();
    if (!target) return { sent: false, error: `ArnTo-Shop has not announced "${CMD}" — update and restart the bot` };
    if (!discordBus.status().ready) return { sent: false, error: "The panel's Discord bus is not ready" };
    if (!wait) {
        Promise.resolve(discordBus.notify(target, CMD, event, { sealed: true })).catch((err) => console.warn(`[Supporter] ${CMD} not queued: ${err.message}`));
        return { sent: true, queued: true };
    }
    try {
        return { sent: true, result: await discordBus.request(target, CMD, event, { sealed: true, timeoutMs: 20_000 }) };
    } catch (err) {
        if (err.status === 504) return { sent: true, queued: true };
        return { sent: false, error: err.message };
    }
};

/** From the page: apply the change, then the shop's part. From Discord: hand the event back. */
const finish = async (out, who) => {
    if (who?.via === "discord") return out;
    const wait = out.event.event === "joined" || out.event.event === "left";
    const { event, ...rest } = out;
    return { ...rest, discord: await tellShop(event, { wait }) };
};

// ── Changes ──────────────────────────────────────────────────────────────────

/**
 * A new supporter (or one who left, back again). From the page the panel's bot
 * looks the user up; from Discord the shop sends their tag.
 * → { supporter, event } (Discord) | { supporter, discord } (page)
 */
const add = async (input = {}, who = {}) => {
    const userId = userIdOf(input.userId);
    let userTag = str(input.userTag, 64) || null;
    if (!userTag && who.via !== "discord") {
        try {
            userTag = (await discordBus.userTag(userId)) || null;
        } catch (err) {
            if (err.code === 10013) throw httpError(400, "No Discord user has this ID");
        }
    }
    const old = row(userId);
    if (old?.active) throw httpError(409, "This user is already a supporter");
    const bank = bankOf(input, old || {});
    const note = input.note !== undefined ? str(input.note, 300) : old?.note || "";
    const now = Date.now();
    const c = conn();
    let entry;
    c.transaction(() => {
        if (old) {
            c.prepare(
                `UPDATE supporters SET user_tag = COALESCE(?, user_tag), bank_code = ?, bank_bin = ?, account_number = ?, account_name = ?, note = ?,
                 active = 1, joined_at = ?, left_at = NULL, updated_at = ? WHERE user_id = ?`,
            ).run(userTag, bank.bank_code, bank.bank_bin, bank.account_number, bank.account_name, note, now, now, userId);
        } else {
            c.prepare(
                `INSERT INTO supporters (user_id, user_tag, bank_code, bank_bin, account_number, account_name, note, balance, active, joined_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
            ).run(userId, userTag, bank.bank_code, bank.bank_bin, bank.account_number, bank.account_name, note, now, now);
        }
        entry = addEntry(userId, { kind: "joined", balance: row(userId).balance, note: old ? "Back again" : null, createdAt: now }, who);
    })();
    const r = row(userId);
    return finish({ supporter: toSupporter(r), entry, event: eventOf("joined", r, entry) }, who);
};

/** Bank details, tag or note. */
const update = (userId, input = {}) => {
    const r = requireRow(userId, { active: false });
    const bank = bankOf(input, r);
    const note = input.note !== undefined ? str(input.note, 300) : r.note;
    const userTag = input.userTag !== undefined ? str(input.userTag, 64) || r.user_tag : r.user_tag;
    conn()
        .prepare("UPDATE supporters SET user_tag = ?, bank_code = ?, bank_bin = ?, account_number = ?, account_name = ?, note = ?, updated_at = ? WHERE user_id = ?")
        .run(userTag, bank.bank_code, bank.bank_bin, bank.account_number, bank.account_name, note, Date.now(), r.user_id);
    return get(r.user_id);
};

/** They leave — refused while they are still owed money (pay them first). */
const remove = async (userId, who = {}) => {
    const r = requireRow(userId);
    if (r.balance > 0) throw httpError(409, `Still owed ${r.balance.toLocaleString("vi-VN")}đ — pay it out first`);
    const now = Date.now();
    let entry;
    conn().transaction(() => {
        conn().prepare("UPDATE supporters SET active = 0, left_at = ?, updated_at = ? WHERE user_id = ?").run(now, now, r.user_id);
        entry = addEntry(r.user_id, { kind: "left", balance: r.balance, createdAt: now }, who);
    })();
    const after = row(r.user_id);
    return finish({ supporter: toSupporter(after), entry, event: eventOf("left", after, entry) }, who);
};

/**
 * Money in or out of the balance.
 *   salary   an order's pay (orderId, sellerId = the order's seller)
 *   add      a bonus / correction
 *   deduct   a fine / correction — the balance never goes below 0
 */
const credit = async (userId, input = {}, who = {}) => {
    const kind = CREDIT_KINDS.includes(input.kind) ? input.kind : null;
    if (!kind) throw httpError(400, `kind must be one of ${CREDIT_KINDS.join(", ")}`);
    const r = requireRow(userId);
    const amount = amountOf(input.amount) * (kind === "deduct" ? -1 : 1);
    const sellerId = optionalId(input.sellerId, "The seller");
    const orderId = str(input.orderId, 64) || null;
    const note = str(input.note, 300) || null;
    const c = conn();
    let entry;
    c.transaction(() => {
        const balance = c.prepare("SELECT balance FROM supporters WHERE user_id = ?").pluck().get(r.user_id) + amount;
        if (balance < 0) throw httpError(409, `The balance would go below 0 (it is ${(balance - amount).toLocaleString("vi-VN")}đ)`);
        c.prepare("UPDATE supporters SET balance = ?, updated_at = ? WHERE user_id = ?").run(balance, Date.now(), r.user_id);
        entry = addEntry(r.user_id, { kind, amount, balance, sellerId, orderId, note }, who);
    })();
    const after = row(r.user_id);
    return finish({ supporter: toSupporter(after), entry, event: eventOf("credit", after, entry) }, who);
};

/** The whole balance was transferred to their bank account. */
const payout = async (userId, input = {}, who = {}) => {
    const r = requireRow(userId, { active: false });
    const c = conn();
    let entry;
    c.transaction(() => {
        const balance = c.prepare("SELECT balance FROM supporters WHERE user_id = ?").pluck().get(r.user_id);
        if (balance <= 0) throw httpError(409, "Nothing to pay — the balance is 0");
        c.prepare("UPDATE supporters SET balance = 0, updated_at = ? WHERE user_id = ?").run(Date.now(), r.user_id);
        entry = addEntry(r.user_id, { kind: "payout", amount: -balance, balance: 0, note: str(input.note, 300) || null }, who);
    })();
    const after = row(r.user_id);
    return finish({ supporter: toSupporter(after), entry, event: eventOf("payout", after, entry) }, who);
};

/**
 * The shop checks the Supporter role against the list: gives it to every
 * active supporter who lacks it, and reports who holds it without being one.
 */
const syncRoles = async () => {
    const userIds = conn().prepare("SELECT user_id FROM supporters WHERE active = 1").pluck().all();
    const out = await tellShop({ event: "sync", userIds }, { wait: true });
    if (!out.sent) throw httpError(503, out.error);
    if (out.queued) throw httpError(504, "ArnTo-Shop did not answer in time — try again in a minute");
    return out.result;
};

// ── Import (the shop's old local list, once) ────────────────────────────────

/**
 * body: { supporters: [{ userId, userTag?, bank: { shortName, bin }, account_number,
 *         balance, joinedAt, owed: { [sellerId]: amount } }], welcome?, farewell? }
 * Each balance becomes "import" rows split by who owes it, the rest unattributed.
 */
const importFrom = (botId, body = {}) => {
    if (!botId) throw httpError(403, "A project API key is required");
    const m = meta();
    if (m.imported) return { imported: false, already: true, owner: m.owner };
    const c = conn();
    let count = 0;
    let total = 0;
    c.transaction(() => {
        for (const s of Array.isArray(body.supporters) ? body.supporters : []) {
            const userId = str(s.userId, 20);
            if (!SNOWFLAKE.test(userId) || row(userId)) continue;
            const bin = str(s.bank?.bin, 6);
            const balance = Math.max(0, Math.round(Number(s.balance) || 0));
            const joinedAt = Number(s.joinedAt) > 0 ? Number(s.joinedAt) : Date.now();
            c.prepare(
                `INSERT INTO supporters (user_id, user_tag, bank_code, bank_bin, account_number, account_name, note, balance, active, joined_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, '', '', ?, 1, ?, ?)`,
            ).run(userId, str(s.userTag, 64) || null, str(s.bank?.shortName, 32) || "?", BIN.test(bin) ? bin : "000000", str(s.account_number, 32) || "?", balance, joinedAt, Date.now());
            addEntry(userId, { kind: "joined", balance: 0, note: "Imported from ArnTo-Shop", createdAt: joinedAt }, { via: "import", byTag: "Import" });
            let left = balance;
            let running = 0;
            for (const [sellerId, v] of Object.entries(s.owed || {})) {
                const amount = Math.min(Math.max(0, Math.round(Number(v) || 0)), left);
                if (!amount || !SNOWFLAKE.test(sellerId)) continue;
                left -= amount;
                running += amount;
                addEntry(userId, { kind: "import", amount, balance: running, sellerId, note: "Balance from ArnTo-Shop" }, { via: "import", byTag: "Import" });
            }
            if (left > 0) {
                running += left;
                addEntry(userId, { kind: "import", amount: left, balance: running, note: "Balance from ArnTo-Shop" }, { via: "import", byTag: "Import" });
            }
            count++;
            total += balance;
        }
        const s = kvGet(SETTINGS) || {};
        if (!s.welcome && str(body.welcome, 1900)) s.welcome = str(body.welcome, 1900);
        if (!s.farewell && str(body.farewell, 1900)) s.farewell = str(body.farewell, 1900);
        kvSet(SETTINGS, s);
        kvSet(META, { owner: botId, imported: true, importedAt: Date.now() });
    })();
    console.log(`[Supporter] Imported ${count} supporters (${total}đ owed) from project ${botId}`);
    return { imported: true, supporters: count, balance: total };
};

// ── Status ───────────────────────────────────────────────────────────────────

/** For the page: who answers on Discord, the totals. */
const status = () => {
    const m = meta();
    const t = conn().prepare("SELECT COUNT(*) AS n, COALESCE(SUM(balance), 0) AS owed FROM supporters WHERE active = 1").get();
    return {
        owner: m.owner,
        imported: m.imported,
        importedAt: m.importedAt,
        busReady: !!discordBus.status().ready,
        handler: shop(),
        active: t.n,
        owed: t.owed,
    };
};

const start = () => {
    conn();
    console.log("[Supporter] Supporter service started");
};

module.exports = {
    CMD,
    TEMPLATE_VARS,
    canAccess,
    getSettings,
    setSettings,
    list,
    get,
    ledger,
    add,
    update,
    remove,
    credit,
    payout,
    syncRoles,
    importFrom,
    status,
    start,
};
