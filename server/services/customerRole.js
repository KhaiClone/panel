const cron = require("node-cron");
const db = require("../db");
const discordBus = require("./discordBus");
const lifecycle = require("./lifecycle");
const panelLog = require("./panelLog");

// ─────────────────────────────────────────────────────────────────────────────
//  The customer role — a Discord role for everyone using the bot service
//  (user, 2026-11-14).
//
//  Who: the customer (buyerID) of at least one project marked as a customer
//  project (services/customerProjects.js) that has not expired — websites and
//  services count, projects that never expire count. Personal and team projects
//  never give it. The role goes when the customer's last such project expires,
//  is deleted or stops being a customer project.
//
//  The owner can take the role off anyone by hand, right on Discord, and the
//  panel must not give it back (user, 2026-11-14) — not even when they buy
//  again — until "Allow again" on the panel. So the panel remembers whom it
//  gave the role to and when; one of those found without it, who has not left
//  and rejoined the server since (Discord's joinedAt is later then), was
//  un-roled by hand and goes on the "removed by hand" list. Someone who holds
//  the role without the panel having given it (given by hand) is never touched
//  — unless they are a customer, then the panel takes over (and takes it off
//  when their service ends).
//
//  The panel's own bot is not in the shop server, so the Discord part is done
//  by the bot that announced role.members / role.set on the bus (ArnTo-Shop,
//  functions/panelRoles.js); everything decided is decided here.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "customer_role";
const DEFAULT_ROLE_ID = "1247011723563503616"; // the role the owner named, 2026-11-14
const SNOWFLAKE = /^\d{15,25}$/;
const SYNC_AT = "15 * * * *"; // every hour
const SOON_MS = 5000;

function _err(message, status = 400) {
    const e = new Error(message);
    e.status = status;
    return e;
}

// One change at a time: the hourly sync, a "Sync now" and the owner's buttons
// all read and write the same value (quick.db writes it back whole).
let chain = Promise.resolve();
const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
};

const getState = async () => ({ enabled: true, roleId: DEFAULT_ROLE_ID, granted: {}, excluded: {}, last: null, ...((await db.get(KEY)) || {}) });
const saveState = (s) => db.set(KEY, s);

/** buyerId → { name, projects: [names] } for everyone who should have the role now. */
const wanted = async () => {
    const now = Date.now();
    const out = new Map();
    for (const b of await db.find("bots")) {
        if (!b.customer?.enabled || !SNOWFLAKE.test(String(b.buyerID || ""))) continue;
        if (b.expiresAt && b.expiresAt <= now) continue;
        const e = out.get(b.buyerID) || { name: null, projects: [] };
        e.name = e.name || b.customer.buyerDisplayName || b.customer.buyerName || null;
        e.projects.push(b.name);
        out.set(b.buyerID, e);
    }
    return out;
};

const shopBot = () => {
    const target = discordBus.handlerOf?.("role.members");
    if (!target || !discordBus.canHandle?.(target, "role.set")) return null;
    return target;
};

/**
 * One pass: find who the owner un-roled by hand, give the role to customers
 * missing it, take it from those whose service ended. → the `last` summary.
 */
const syncNow = () =>
    serial(async () => {
        const s = await getState();
        if (!s.enabled) return { skipped: "off" };
        if (!discordBus.status?.().ready) return { skipped: "bus" };
        const target = shopBot();
        const now = Date.now();
        if (!target) {
            s.last = { at: now, error: "No bot has announced role.members and role.set on the bus — update and restart ArnTo-Shop" };
            await saveState(s);
            return s.last;
        }
        const want = await wanted();
        const ids = [...new Set([...want.keys(), ...Object.keys(s.granted)])];
        if (!ids.length) {
            s.last = { at: now, added: 0, removed: 0, excludedByHand: 0, failed: [], error: null };
            await saveState(s);
            return s.last;
        }

        let info;
        try {
            info = await discordBus.request(target, "role.members", { roleId: s.roleId, userIds: ids }, { timeoutMs: 60_000 });
        } catch (err) {
            s.last = { at: now, error: `The shop bot did not report the members (${err.message})` };
            await saveState(s);
            return s.last;
        }
        if (!info?.canManage) {
            s.last = {
                at: now,
                error: `The shop bot cannot manage the role ${info?.roleName ? `"${info.roleName}"` : s.roleId} — give it Manage Roles and put its own role above this one`,
                guildName: info?.guildName || null,
                roleName: info?.roleName || null,
            };
            await saveState(s);
            return s.last;
        }
        const members = info.members || {};

        // 1. Given by the panel, gone now, still in the server since → taken off by hand.
        const byHand = [];
        for (const [id, g] of Object.entries(s.granted)) {
            const m = members[id];
            if (!m?.inGuild || m.hasRole) continue;
            if (m.joinedAt && m.joinedAt > g.at) continue; // left and came back: not the owner's doing
            s.excluded[id] = { at: now, by: "discord", name: want.get(id)?.name || m.tag || null };
            delete s.granted[id];
            byHand.push(id);
        }

        // 2. Customers: give it to those missing it; take over those who already have it.
        const add = [];
        for (const id of want.keys()) {
            if (s.excluded[id]) continue;
            const m = members[id];
            if (!m?.inGuild) continue;
            if (m.hasRole) {
                if (!s.granted[id]) s.granted[id] = { at: now, adopted: true };
            } else add.push(id);
        }

        // 3. Service ended: take it from those the panel manages.
        const remove = [];
        for (const id of Object.keys(s.granted)) {
            if (want.has(id)) continue;
            const m = members[id];
            if (m?.inGuild && m.hasRole) remove.push(id);
            else delete s.granted[id];
        }

        let res = { added: [], removed: [], skipped: [], failed: [] };
        if (add.length || remove.length) {
            try {
                res = await discordBus.request(target, "role.set", { roleId: s.roleId, add, remove }, { timeoutMs: 120_000 });
            } catch (err) {
                // 504: the bot will still do it — the next pass sees the result and takes it over.
                s.last = { at: now, error: `Changing the roles failed (${err.message})` };
                await saveState(s);
                return s.last;
            }
        }
        const done = Date.now();
        for (const id of res.added || []) s.granted[id] = { at: done };
        for (const id of res.removed || []) delete s.granted[id];
        s.last = {
            at: now,
            added: (res.added || []).length,
            removed: (res.removed || []).length,
            excludedByHand: byHand.length,
            failed: (res.failed || []).slice(0, 20),
            error: null,
            guildName: info.guildName || null,
            roleName: info.roleName || null,
        };
        await saveState(s);

        const name = (id) => want.get(id)?.name || members[id]?.tag || id;
        if (res.added?.length || res.removed?.length) {
            panelLog.add("system", `Customer role: given to ${res.added.length}, taken from ${res.removed.length} (service ended)`);
        }
        for (const id of byHand) panelLog.add("owner", `Customer role: ${name(id)} (${id}) had it taken off by hand — the panel will not give it back`);
        if (res.failed?.length) console.warn(`[CustomerRole] ${res.failed.length} change(s) failed: ${res.failed.map((f) => `${f.id}: ${f.error}`).join("; ")}`);
        return s.last;
    });

let soon = null;
/** After a project changed: one pass a few seconds later (several changes → one pass). */
const syncSoon = () => {
    if (soon) return;
    soon = setTimeout(() => {
        soon = null;
        if (!lifecycle.isActive || lifecycle.isActive()) syncNow().catch((err) => console.warn(`[CustomerRole] ${err.message}`));
    }, SOON_MS);
    soon.unref?.();
};

// ── The owner's buttons ──────────────────────────────────────────────────────

const userIdOf = (v) => {
    const id = String(v || "").trim();
    if (!SNOWFLAKE.test(id)) throw _err("Invalid Discord user ID");
    return id;
};

/** Take the role off now and keep it off (the same as doing it on Discord). */
const keepOff = (userId) =>
    serial(async () => {
        const id = userIdOf(userId);
        const s = await getState();
        const name = (await wanted()).get(id)?.name || null;
        s.excluded[id] = { at: Date.now(), by: "panel", name };
        delete s.granted[id];
        await saveState(s);
        panelLog.add("owner", `Customer role: owner keeps ${name || id} off it`);
        let discord = null;
        const target = shopBot();
        if (target && discordBus.status?.().ready) {
            try {
                discord = await discordBus.request(target, "role.set", { roleId: s.roleId, remove: [id] }, { timeoutMs: 30_000 });
            } catch (err) {
                discord = { error: err.message };
            }
        } else discord = { error: "The shop bot cannot be reached now — take the role off on Discord, or it goes on the next sync" };
        return { ok: true, discord };
    });

/** Back to normal: the next pass gives the role again if they are a customer. */
const allow = (userId) =>
    serial(async () => {
        const id = userIdOf(userId);
        const s = await getState();
        if (!s.excluded[id]) return { ok: true };
        const name = s.excluded[id].name;
        delete s.excluded[id];
        await saveState(s);
        panelLog.add("owner", `Customer role: owner allowed ${name || id} again`);
        syncSoon();
        return { ok: true };
    });

const setSettings = ({ enabled, roleId } = {}) =>
    serial(async () => {
        const s = await getState();
        if (enabled !== undefined) s.enabled = !!enabled;
        if (roleId !== undefined) {
            const r = String(roleId).trim();
            if (!SNOWFLAKE.test(r)) throw _err("The role ID is the role's numeric Discord ID");
            // Another role: who the panel gave the old one to says nothing about the new one.
            if (r !== s.roleId) s.granted = {};
            s.roleId = r;
        }
        await saveState(s);
        panelLog.add("owner", `Customer role: ${s.enabled ? "on" : "off"}, role ${s.roleId}`);
        if (s.enabled) syncSoon();
        return view();
    });

/** What the page shows. */
const view = async () => {
    const s = await getState();
    const want = await wanted();
    const customers = [...want.entries()].map(([id, w]) => ({
        id,
        name: w.name,
        projects: w.projects,
        state: s.excluded[id] ? "excluded" : s.granted[id] ? "has-role" : "waiting",
    }));
    const excluded = Object.entries(s.excluded).map(([id, x]) => ({ id, name: x.name || want.get(id)?.name || null, at: x.at, by: x.by, customer: want.has(id) }));
    return {
        enabled: s.enabled,
        roleId: s.roleId,
        busReady: !!discordBus.status?.().ready,
        botReady: !!shopBot(),
        last: s.last,
        managed: Object.keys(s.granted).length,
        customers: customers.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id))),
        excluded: excluded.sort((a, b) => b.at - a.at),
    };
};

let task = null;
const start = () => {
    if (task) return;
    task = cron.schedule(SYNC_AT, lifecycle.guard(() => {
        syncNow().catch((err) => console.error("[CustomerRole] Hourly sync failed:", err.message));
    }));
    console.log("[CustomerRole] Customer role sync scheduled — every hour at :15");
};

module.exports = { DEFAULT_ROLE_ID, syncNow, syncSoon, keepOff, allow, setSettings, view, start };
