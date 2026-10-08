const express = require("express");
const supporters = require("../services/supporterService");
const ticketMenus = require("../services/ticketMenuService");

// Supporters (services/supporterService.js), two routers:
//
//   /api/supporters                    the Supporters page (authMiddleware)
//     GET    /status                   who answers on Discord, totals, the sellers
//     GET    /banks                    VietQR's bank list (cached a day)
//     GET    /settings                 the welcome / farewell DM texts
//     PUT    /settings                 { welcome, farewell } ("" = the default)
//     GET    /?all=1                   supporters (all = with the ones who left)
//     GET    /ledger?userId=&kind=     the salary history, newest first
//     POST   /sync                     the shop checks the Supporter role
//     POST   /                         { userId, bankCode, bankBin, accountNumber, accountName, note }
//     GET    /:userId
//     PUT    /:userId                  bank details / note
//     DELETE /:userId                  they leave (balance must be 0)
//     POST   /:userId/credit           { kind: add | deduct, amount, sellerId, note }
//     POST   /:userId/payout           { note } — the whole balance was transferred
//
//   /api/external/supporters           ArnTo-Shop (apiKeyMiddleware) — a project key,
//                                      and once imported only the owner's. Each change
//                                      answers with `event`, which the shop applies on
//                                      Discord itself (role, DM, salary log).
//     POST   /import                   { supporters, welcome, farewell } its old list, once
//     GET    /                         { imported, supporters }
//     GET    /:userId
//     POST   /                         { userId, userTag, bankCode, bankBin, accountNumber, byId, byTag }
//     DELETE /:userId                  { byId, byTag }
//     POST   /:userId/credit           { kind: salary | add | deduct, amount, sellerId, orderId, note, byId, byTag }
//     POST   /:userId/payout           { note, byId, byTag }

const handle = (fn) => async (req, res) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
};

// ── VietQR banks ─────────────────────────────────────────────────────────────

const BANKS_TTL = 24 * 3600_000;
let banks = { at: 0, list: null };

const bankList = async () => {
    if (banks.list && Date.now() - banks.at < BANKS_TTL) return banks.list;
    try {
        const res = await fetch("https://api.vietqr.io/v2/banks", { signal: AbortSignal.timeout(10_000) });
        const json = await res.json();
        if (!Array.isArray(json?.data)) throw new Error("unexpected answer");
        banks = {
            at: Date.now(),
            // All of them, like /staff-new's autocomplete on the shop.
            list: json.data.map((b) => ({ code: b.shortName, bin: String(b.bin), name: b.name, logo: b.logo || null })),
        };
        return banks.list;
    } catch (err) {
        if (banks.list) return banks.list;
        throw Object.assign(new Error(`Could not load the bank list from VietQR: ${err.message}`), { status: 502 });
    }
};

// ── The page ─────────────────────────────────────────────────────────────────

const panel = express.Router();
const fromPanel = { via: "panel" };

panel.get(
    "/status",
    handle(() => {
        let sellers = [];
        try {
            sellers = ticketMenus.get().sellers.map((s) => ({ id: s.id, name: s.name }));
        } catch {
            /* no ticket menus yet */
        }
        return { ...supporters.status(), sellers };
    }),
);
panel.get("/banks", handle(async () => ({ banks: await bankList() })));
panel.get("/settings", handle(() => supporters.getSettings()));
panel.put("/settings", handle((req) => supporters.setSettings(req.body || {})));
panel.get("/", handle((req) => ({ supporters: supporters.list({ all: !!req.query.all }) })));
panel.get("/ledger", handle((req) => ({ entries: supporters.ledger({ userId: req.query.userId || null, kind: req.query.kind || null }) })));
panel.post("/sync", handle(() => supporters.syncRoles()));
panel.post("/", handle((req) => supporters.add(req.body || {}, fromPanel)));
panel.get("/:userId", handle((req) => supporters.get(req.params.userId)));
panel.put("/:userId", handle((req) => supporters.update(req.params.userId, req.body || {})));
panel.delete("/:userId", handle((req) => supporters.remove(req.params.userId, fromPanel)));
panel.post(
    "/:userId/credit",
    handle((req) => {
        const body = req.body || {};
        // Salary comes from /done with its order; the page adds or deducts.
        if (!["add", "deduct"].includes(body.kind)) throw Object.assign(new Error("kind must be add or deduct"), { status: 400 });
        return supporters.credit(req.params.userId, body, fromPanel);
    }),
);
panel.post("/:userId/payout", handle((req) => supporters.payout(req.params.userId, req.body || {}, fromPanel)));

// ── ArnTo-Shop ───────────────────────────────────────────────────────────────

const external = express.Router();

external.use((req, res, next) => {
    const botId = req.apiCaller?.botId;
    if (!botId) return res.status(403).json({ error: "Supporters need a project API key (Panel Settings → API Keys)" });
    if (!supporters.canAccess(botId)) return res.status(403).json({ error: "The supporters belong to another project" });
    next();
});

const fromDiscord = (req) => ({ via: "discord", byId: req.body?.byId, byTag: req.body?.byTag });

external.post("/import", handle((req) => supporters.importFrom(req.apiCaller.botId, req.body || {})));
external.get("/", handle(() => ({ imported: supporters.status().imported, supporters: supporters.list() })));
external.get("/:userId", handle((req) => supporters.get(req.params.userId)));
external.post("/", handle((req) => supporters.add(req.body || {}, fromDiscord(req))));
external.delete("/:userId", handle((req) => supporters.remove(req.params.userId, fromDiscord(req))));
external.post("/:userId/credit", handle((req) => supporters.credit(req.params.userId, req.body || {}, fromDiscord(req))));
external.post("/:userId/payout", handle((req) => supporters.payout(req.params.userId, req.body || {}, fromDiscord(req))));

module.exports = { panel, external };
