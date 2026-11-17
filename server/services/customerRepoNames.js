const cron = require("node-cron");
const db = require("../db");
const executor = require("./executor");
const discordBus = require("./discordBus");
const lifecycle = require("./lifecycle");
const panelLog = require("./panelLog");
const repos = require("./customerRepos");
const githubUrl = require("../utils/githubUrl");

// ─────────────────────────────────────────────────────────────────────────────
//  Customer repos, phase 5 — the panel makes the customers' repos and names
//  them (user, 2026-11-17).
//
//  Repos used to be made by hand on GitHub, named by pasting the customer's
//  username — which stops telling them apart once a customer has a second
//  bot, and leaves the owner remembering which is which. Now:
//   - New repo (Bots → Repos) makes an empty private repo in the org, named by
//     a template — {username}-{botname} unless the owner sets another — from
//     the customer's and the bot's Discord ids.
//   - Every week (Monday 04:30 VN, after the daily name sync at 04:00) each
//     customer repo is renamed to what the template gives now: the customer
//     or the bot changed its name, or the template changed. This replaces
//     "repos are never renamed" (2026-11-13) — the owner's call, 2026-11-17.
//   - A repo can have a name of its own; it is then never renamed by itself.
//
//  Which repos: the one a customer project uses (names from that project,
//  refreshed daily), or one the panel made that waits for its first project.
//  A repo no project uses any more keeps its name — it is on its way to
//  Archive / Delete, and Bots → Retired finds it by that name — and so do an
//  archived repo (GitHub refuses) and one shared by several customer projects.
//
//  A rename turns the old name into a GitHub redirect, which dies the moment
//  a repo takes that name — and with usernames in names, the next customer to
//  pick that username would. A checkout still pulling the old name would then
//  pull THEIR code. So after a rename the projects' records get the new URL
//  and each checkout's origin is pointed at it through its node's agent
//  (1.15.0+, POST /git/remote); one that cannot be reached is tried again at
//  every check. And the panel never hands out a name GitHub still redirects:
//  it counts as taken, and the next free "-2" is used instead.
//
//  A repo keeps its name while that is what the template gives, or that plus
//  "-<n>": two bots of one customer with the same name stay apart, and
//  nothing flips between them from one week to the next.
// ─────────────────────────────────────────────────────────────────────────────

const NAMING = "customer_repo_naming"; // { template, lastCheck }
const RECORDS = "customer_repo_records"; // { [GitHub repo id]: record }
const DEFAULT_TEMPLATE = "{username}-{botname}";
const FIELDS = {
    username: "the customer's Discord username",
    botname: "the bot's name on Discord",
    botid: "the bot's Discord ID",
    customerid: "the customer's Discord ID",
};
const CHECK_AT = "30 4 * * 1";
const TIMEZONE = "Asia/Ho_Chi_Minh";
const SCHEDULE = { day: "Monday", at: "04:30", timezone: TIMEZONE };
const SNOWFLAKE = /^\d{15,25}$/;
const REPO_NAME = /^[\w.-]{1,100}$/;
const FIELD = /\{(\w+)\}/g;
const MAX = 100; // GitHub's limit for a repo name

function _err(message, status = 400, extra = {}) {
    const e = new Error(message);
    e.status = status;
    Object.assign(e, extra);
    return e;
}

// ── Names ────────────────────────────────────────────────────────────────────

/**
 * One field's text as GitHub takes it: lowercase a-z, 0-9, ".", "_", "-".
 * "." and "_" stay — Discord usernames have them (khach.a, louw_). NFKD turns
 * the "fancy font" letters of bot names back into plain ones and drops the
 * Vietnamese marks; đ has no decomposition, so it is mapped by hand.
 */
const part = (text) =>
    String(text || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\u0111\u0110]/g, "d")
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "");

const tidy = (name) => name.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");

/** `base` + `suffix` within GitHub's 100 characters. */
const fitLength = (base, suffix = "") => tidy(base.slice(0, MAX - suffix.length)) + suffix;

const checkTemplate = (input) => {
    const t = String(input ?? "").trim();
    const fields = [...t.matchAll(FIELD)].map((m) => m[1]);
    if (!fields.length) throw _err("The template needs at least one field, e.g. {username}");
    const unknown = fields.find((f) => !FIELDS[f]);
    if (unknown) throw _err(`There is no field {${unknown}} — use ${Object.keys(FIELDS).map((f) => `{${f}}`).join(", ")}`);
    if (/[^A-Za-z0-9._-]/.test(t.replace(FIELD, ""))) throw _err('Outside the {fields}, a repo name can only have letters, digits, ".", "_" and "-"');
    if (t.length > 200) throw _err("The template is too long");
    return t;
};

/** → { name } or { missing: [field] } */
const render = (template, values) => {
    const missing = [];
    const raw = template.replace(FIELD, (_, f) => {
        const v = part(values[f]);
        if (!v) missing.push(f);
        return v;
    });
    if (missing.length) return { missing };
    const name = fitLength(tidy(raw));
    return name ? { name } : { missing: [] };
};

const missingText = (missing) =>
    missing.length ? `${missing.map((f) => FIELDS[f]).join(" and ")} ${missing.length > 1 ? "are" : "is"} not known yet` : "the template gives an empty name";

/** A repo name typed by the owner. */
const checkName = (input) => {
    const n = String(input || "").trim();
    if (!REPO_NAME.test(n) || /^\.+$/.test(n) || /\.git$/i.test(n)) {
        throw _err('A repo name is up to 100 letters, digits, ".", "_" and "-", and does not end in .git');
    }
    return n;
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `name` is what the template gives, or that plus "-<n>". */
const fits = (name, wanted) => new RegExp(`^${escapeRe(wanted)}(-\\d+)?$`, "i").test(name);
function* candidates(wanted) {
    yield wanted;
    for (let n = 2; n < 100; n++) yield fitLength(wanted, `-${n}`);
}

// ── Stored state ─────────────────────────────────────────────────────────────

const naming = async () => (await db.get(NAMING)) || {};
const templateOf = (n) => n.template || DEFAULT_TEMPLATE;

/**
 * One record per repo the panel made or names, by GitHub's repo id (it stays
 * through renames): { repoId, buyerID, botUserId, label, buyerName, botName,
 * customName, createdBy: panel | adopted | owner, createdAt, usedAt,
 * pendingOrigins: [project _id] }.
 */
const records = async () => (await db.get(RECORDS)) || {};

// Every writer goes through here: the weekly check spends minutes on GitHub
// and the nodes, and New repo / a name of its own must not interleave with it.
let chain = Promise.resolve();
const locked = (fn) => {
    const run = chain.then(() => fn());
    chain = run.catch(() => {});
    return run;
};

// ── Discord ──────────────────────────────────────────────────────────────────

/** { id, username, globalName, bot }, or undefined while the bus is down. */
const lookup = async (id) => {
    try {
        return await discordBus.fetchUser(id);
    } catch (err) {
        if (err.code === 10013) throw _err(`Discord has no user with the ID ${id}`, 404, { unknown: true });
        throw _err(`Discord did not answer (${err.message})`, 502);
    }
};
const botNameOf = (u) => u.globalName || u.username;

// ── Planning ─────────────────────────────────────────────────────────────────

const projectValues = (bot, rec) => {
    const c = bot.customer || {};
    // No bot (a website, a service): the name given at New repo, else the project's.
    return { username: c.buyerName, botname: c.botUserId ? c.botName : rec?.label || bot.name, botid: c.botUserId, customerid: bot.buyerID };
};
const recordValues = (rec) => ({ username: rec.buyerName, botname: rec.botUserId ? rec.botName : rec.label, botid: rec.botUserId, customerid: rec.buyerID });

/**
 * How each repo of the org is named:
 * [{ repo, users, rec, managed, custom, wanted, note, problem }] — `wanted` is
 * what the template gives; `note` says why a repo keeps its name, `problem`
 * why one cannot be named.
 */
const plan = (state, recs, template) =>
    state.repos.map((r) => {
        const key = r.full_name.toLowerCase();
        const users = state.users.get(key) || [];
        const customers = users.filter((b) => b.customer?.enabled);
        const rec = recs[r.id] || null;
        const item = { repo: r, users, rec, managed: false, custom: false, wanted: null, note: null, problem: null };
        if (rec?.customName) return { ...item, managed: true, custom: true, note: "Has a name of its own" };
        if (customers.length > 1) return { ...item, problem: `Used by ${customers.length} customer projects — give it a name of its own` };
        let values;
        if (customers.length === 1) values = projectValues(customers[0], rec);
        else if (rec?.createdBy === "panel" && !rec.usedAt && !users.length && !state.retiredBy.has(key)) values = recordValues(rec);
        else if (rec && users.length) return { ...item, note: "Used by a project that is not a customer's — it keeps its name" };
        else if (rec?.usedAt || state.retiredBy.has(key)) return { ...item, note: "No project uses it any more — it keeps its name" };
        else return item; // not a customer's repo
        if (r.archived) return { ...item, managed: true, note: "Archived — GitHub does not rename an archived repo" };
        const x = render(template, values);
        if (!x.name) return { ...item, managed: true, problem: `Not named yet: ${missingText(x.missing)}` };
        return { ...item, managed: true, wanted: x.name };
    });

/** The name for one repo: its own while it fits, else the first free one (null: none). */
const nameFor = async (item, taken, isFree) => {
    if (fits(item.repo.name, item.wanted)) return item.repo.name;
    for (const c of candidates(item.wanted)) {
        if (taken.has(c.toLowerCase())) continue;
        if (await isFree(c, item.repo)) return c;
    }
    return null;
};

/**
 * `next` for every repo the template names — the ones keeping their name
 * first, then the rest oldest first. The dry run (the Repos page) only knows
 * the org's current names; a real check also asks GitHub, which knows the old
 * names it still redirects.
 */
const assign = async (items, isFree) => {
    const taken = new Set(items.map((i) => i.repo.name.toLowerCase()));
    const order = (i) => (fits(i.repo.name, i.wanted) ? 0 : 1);
    const named = items.filter((i) => i.wanted).sort((a, b) => order(a) - order(b) || a.repo.id - b.repo.id);
    for (const i of named) {
        i.next = await nameFor(i, taken, isFree);
        if (i.next) taken.add(i.next.toLowerCase());
        else i.problem = "No free name left for it";
    }
    return items;
};

/** Free on GitHub: no repo by that name and no redirect from it — or it leads to `repo` itself. */
const freeOnGitHub = (org) => async (name, repo) => {
    const r = await repos.resolve(org, name);
    return !r || (!!repo && r.id === repo.id);
};

// ── Renaming ─────────────────────────────────────────────────────────────────

/**
 * Point a project's checkout at `repo` (as GitHub has it now) if it still
 * pulls an older name of it. → null, or the problem.
 */
const fixOrigin = async (bot, repo) => {
    const info = await executor.gitInfo(bot); // nulls when the node does not answer
    if (!info.repoUrl) return `"${bot.name}": its checkout could not be read (node offline?) — GitHub's redirect keeps it working; tried again at the next check`;
    const p = githubUrl.parse(info.repoUrl);
    if (!p) return null; // not on GitHub — nothing of the org's
    if (githubUrl.key(p.owner, p.name) === repo.full_name.toLowerCase()) return null;
    const now = await repos.resolve(p.owner, p.name).catch(() => null);
    if (!now || now.id !== repo.id) return `"${bot.name}": its checkout pulls ${p.owner}/${p.name}, not this repo — left as it is`;
    try {
        await executor.setGitRemote(bot, `${p.owner}/${p.name}`, repo.full_name);
        return null;
    } catch (err) {
        return `"${bot.name}": its checkout still pulls the old name (${err.message}) — tried again at the next check`;
    }
};

/** Rename on GitHub, then every project using it: its record's URL and its checkout. */
const rename = async (r, to, users, { who, why }) => {
    const updated = await repos.gh("patch", `/repos/${r.full_name}`, { data: { name: to } });
    panelLog.add(who, `Renamed the customer repo ${r.full_name} → ${updated.full_name} (${why})`);
    const problems = [];
    const pending = [];
    for (const b of users) {
        // The record first: Move and Rebuild from git clone bot.repoUrl.
        const url = githubUrl.rewrite(b.repoUrl, updated.owner.login, updated.name);
        if (url && url !== b.repoUrl) await db.findOneAndUpdate("bots", { _id: b._id }, { repoUrl: url });
        const p = await fixOrigin({ ...b, repoUrl: url || b.repoUrl }, updated);
        if (p) {
            problems.push(p);
            pending.push(b._id);
        }
    }
    return { repo: updated, problems, pending };
};

const addPending = (rec, ids) => (ids.length ? { ...rec, pendingOrigins: [...new Set([...(rec.pendingOrigins || []), ...ids])] } : rec);

// ── The weekly check ─────────────────────────────────────────────────────────

const runCheck = async (who) => {
    const state = await repos.collect();
    if (!state.configured) return { skipped: "GitHub is not set up" };
    const template = templateOf(await naming());
    const recs = await records();
    const now = Date.now();
    const keyOf = (r) => r.full_name.toLowerCase();

    // Records of repos gone from the org (deleted, transferred out) go too.
    const ids = new Set(state.repos.map((r) => String(r.id)));
    for (const id of Object.keys(recs)) if (!ids.has(id)) delete recs[id];

    for (const r of state.repos) {
        const users = state.users.get(keyOf(r)) || [];
        const customers = users.filter((b) => b.customer?.enabled);
        const rec = recs[r.id];
        if (customers.length === 1) {
            // A customer project uses it: its names come from that project.
            const b = customers[0];
            recs[r.id] = {
                ...(rec || { repoId: r.id, createdBy: "adopted", createdAt: now }),
                buyerID: b.buyerID,
                botUserId: b.customer.botUserId || null,
                buyerName: b.customer.buyerName || null,
                botName: b.customer.botName || null,
                usedAt: rec?.usedAt || now,
            };
        } else if (rec?.createdBy === "panel" && !rec.usedAt && !rec.customName && !users.length) {
            // Made by the panel, waiting for its first project: who it is for, as Discord has it now.
            // Names only move forward — a failed lookup keeps the last good one.
            try {
                const u = await lookup(rec.buyerID);
                if (u && !/^deleted_user_/i.test(u.username)) rec.buyerName = u.username;
                const b = rec.botUserId ? await lookup(rec.botUserId) : null;
                if (b?.bot) rec.botName = botNameOf(b);
            } catch {
                /* kept */
            }
        }
    }
    await db.set(RECORDS, recs);

    const items = await assign(plan(state, recs, template), freeOnGitHub(state.org));
    const renamed = [];
    const problems = [];
    const tried = new Set();
    for (const i of items) {
        if (i.problem) problems.push({ repo: i.repo.name, text: i.problem });
        if (!i.next || i.next === i.repo.name) continue;
        try {
            const out = await rename(i.repo, i.next, i.users, { who, why: who === "owner" ? "name check" : "weekly name check" });
            renamed.push({ id: i.repo.id, from: i.repo.name, to: out.repo.name });
            problems.push(...out.problems.map((text) => ({ repo: out.repo.name, text })));
            recs[i.repo.id] = addPending(recs[i.repo.id], out.pending);
            tried.add(String(i.repo.id));
        } catch (err) {
            problems.push({ repo: i.repo.name, text: `Could not rename it to ${i.next}: ${err.message}` });
        }
    }

    // Checkouts an earlier rename could not reach.
    for (const [id, rec] of Object.entries(recs)) {
        if (!rec.pendingOrigins?.length || tried.has(id)) continue;
        const repo = state.repos.find((r) => String(r.id) === id);
        const left = [];
        for (const botId of rec.pendingOrigins) {
            const bot = await db.findOne("bots", { _id: botId });
            if (!bot || !repo) continue;
            const p = await fixOrigin(bot, repo);
            if (p) {
                left.push(botId);
                problems.push({ repo: repo.name, text: p });
            }
        }
        recs[id] = { ...rec, pendingOrigins: left };
    }
    await db.set(RECORDS, recs);

    const lastCheck = { at: Date.now(), by: who, managed: items.filter((i) => i.managed).length, renamed, problems };
    await db.set(NAMING, { ...(await naming()), lastCheck });
    console.log(`[CustomerRepos] Name check: ${lastCheck.managed} named repos, ${renamed.length} renamed, ${problems.length} problems`);
    return lastCheck;
};

let checking = null;
/** One check; a second call joins the running one. */
const check = ({ who = "system" } = {}) => {
    if (checking) return checking;
    checking = locked(() => runCheck(who)).finally(() => {
        checking = null;
    });
    return checking;
};

// ── Settings ─────────────────────────────────────────────────────────────────

const getNaming = async () => {
    const n = await naming();
    return { template: templateOf(n), defaultTemplate: DEFAULT_TEMPLATE, fields: FIELDS, schedule: SCHEDULE, lastCheck: n.lastCheck || null, running: !!checking };
};

/** { template } — empty or null goes back to the default. Repos follow at the next check. */
const setNaming = async ({ template } = {}) => {
    if (template === undefined) return getNaming();
    const t = template === null || String(template).trim() === "" ? DEFAULT_TEMPLATE : checkTemplate(template);
    await locked(async () => {
        await db.set(NAMING, { ...(await naming()), template: t === DEFAULT_TEMPLATE ? null : t });
    });
    panelLog.add("owner", `Owner set the customer repo name template to ${t}`);
    return getNaming();
};

// ── The Repos page ───────────────────────────────────────────────────────────

/** The Repos page: customerRepos' list, each repo with how it is named and what the next check would call it. */
const overview = async () => {
    const state = await repos.collect();
    const base = repos.overviewOf(state);
    if (!state.configured) return base;
    const n = await naming();
    const info = { template: templateOf(n), schedule: SCHEDULE, lastCheck: n.lastCheck || null, running: !!checking };
    const items = await assign(plan(state, await records(), info.template), async () => true);
    const byId = new Map(items.map((i) => [i.repo.id, i]));
    return {
        ...base,
        naming: info,
        repos: base.repos.map((r) => {
            const i = byId.get(r.id);
            return {
                ...r,
                naming: {
                    managed: !!i?.managed,
                    custom: !!i?.custom,
                    next: i?.next && i.next !== r.name ? i.next : null,
                    note: i?.note || null,
                    problem: i?.problem || null,
                    pendingOrigins: i?.rec?.pendingOrigins?.length || 0,
                },
            };
        }),
    };
};

// ── New repo ─────────────────────────────────────────────────────────────────

const createRepo = async ({ buyerID, botUserId, label, name } = {}, dryRun) => {
    const org = await repos.needOrg();
    const buyer = String(buyerID || "").trim();
    if (!SNOWFLAKE.test(buyer)) throw _err("Enter the customer's Discord ID (a number)");
    const botId = String(botUserId || "").trim() || null;
    if (botId && !SNOWFLAKE.test(botId)) throw _err("The bot ID is the bot's numeric Discord ID");
    const lbl = String(label || "").trim().slice(0, 100) || null;
    const custom = String(name || "").trim() ? checkName(name) : null;

    const u = await lookup(buyer);
    if (u?.bot) throw _err(`${u.username} is a bot — enter the customer's own ID`);
    const b = botId ? await lookup(botId) : null;
    if (b && !b.bot) throw _err(`${b.username} is a person, not a bot — enter the bot's ID`);
    const values = { username: u?.username, botname: botId ? b && botNameOf(b) : lbl, botid: botId, customerid: buyer };

    const isFree = freeOnGitHub(org);
    let final;
    if (custom) {
        if (!(await isFree(custom))) throw _err(`${custom} is taken in ${org} (a repo, or an old name GitHub still redirects) — pick another`, 409);
        final = custom;
    } else {
        const x = render(templateOf(await naming()), values);
        if (!x.name) {
            const bus = u === undefined || b === undefined ? " — the panel's Discord bot is not connected, so names cannot be looked up; try again, or type a name" : "";
            throw _err(`No name yet: ${missingText(x.missing)}${bus}`);
        }
        final = await nameFor({ repo: { name: "", id: null }, wanted: x.name }, new Set(), isFree);
        if (!final) throw _err("No free name left for it — type a name", 409);
    }
    const who = { username: u?.username || null, botName: values.botname || null };
    if (dryRun) return { org, name: final, custom: !!custom, ...who };

    const description = [values.botname, `customer ${u ? `@${u.username} (${buyer})` : buyer}`].filter(Boolean).join(" · ");
    let r;
    try {
        r = await repos.gh("post", `/orgs/${org}/repos`, { data: { name: final, private: true, description } });
    } catch (err) {
        // GitHub answers a token that may not make repos with 403 or a bare 404.
        if (err.gh === 403 || err.gh === 404) {
            throw _err(`GitHub did not let the token make a repo in ${org} — it needs access to all the org's repositories and Administration: read and write`, 403);
        }
        throw err;
    }
    const recs = await records();
    recs[r.id] = {
        repoId: r.id,
        buyerID: buyer,
        botUserId: botId,
        label: lbl,
        buyerName: u?.username || null,
        botName: b ? botNameOf(b) : null,
        customName: custom ? r.name : null,
        createdBy: "panel",
        createdAt: Date.now(),
    };
    await db.set(RECORDS, recs);
    panelLog.add("owner", `Owner made the repo ${r.full_name} for ${u ? `@${u.username}` : buyer}`);
    return { org, name: r.name, fullName: r.full_name, url: r.html_url, sshUrl: r.ssh_url, cloneUrl: r.clone_url, private: !!r.private, ...who };
};

/** The name New repo would give — nothing is made. */
const preview = (input) => createRepo(input, true);
/** New repo: an empty private repo in the org. */
const create = (input) => locked(() => createRepo(input, false));

// ── A name of its own ────────────────────────────────────────────────────────

/** { customName } — a name of its own (never renamed by itself), or null: back to the template, now. */
const setName = (repoName, { customName } = {}) =>
    locked(async () => {
        const state = await repos.collect();
        if (!state.configured) throw _err("GitHub is not set up — add the org and a token in Panel Settings → Integrations", 409);
        const { org } = state;
        const r = state.repos.find((x) => x.name.toLowerCase() === String(repoName || "").toLowerCase());
        if (!r) throw _err(`There is no repo "${repoName}" in ${org}`, 404);
        if (r.archived) throw _err("The repo is archived — unarchive it first", 409);
        const recs = await records();
        const users = state.users.get(r.full_name.toLowerCase()) || [];
        const custom = customName === null || customName === undefined || String(customName).trim() === "" ? null : checkName(customName);
        const now = Date.now();

        let to;
        if (custom) {
            if (custom.toLowerCase() !== r.name.toLowerCase() && !(await freeOnGitHub(org)(custom, r))) {
                throw _err(`${custom} is taken in ${org} (a repo, or an old name GitHub still redirects) — pick another`, 409);
            }
            to = custom;
            recs[r.id] = { ...(recs[r.id] || { repoId: r.id, createdBy: "owner", createdAt: now }), customName: custom };
        } else {
            const next = recs[r.id] ? { ...recs, [r.id]: { ...recs[r.id], customName: null } } : recs;
            const item = plan(state, next, templateOf(await naming())).find((i) => i.repo.id === r.id);
            if (!item.wanted) throw _err(item.problem || item.note || "No customer project uses this repo — there is no name to follow", 409);
            to = await nameFor(item, new Set(state.repos.map((x) => x.name.toLowerCase())), freeOnGitHub(org));
            if (!to) throw _err("No free name left for it", 409);
            if (next[r.id]) recs[r.id] = next[r.id];
        }

        let result = { name: r.name, problems: [] };
        if (to !== r.name) {
            const out = await rename(r, to, users, { who: "owner", why: custom ? "a name of its own" : "back to the template" });
            if (out.pending.length) recs[r.id] = addPending(recs[r.id] || { repoId: r.id, createdBy: "adopted", createdAt: now }, out.pending);
            result = { name: out.repo.name, problems: out.problems };
        } else {
            panelLog.add("owner", custom ? `Owner kept ${r.full_name} as a name of its own` : `Owner put ${r.full_name} back on the name template`);
        }
        await db.set(RECORDS, recs);
        return result;
    });

// ── Schedule ─────────────────────────────────────────────────────────────────

let task = null;
const start = () => {
    if (task) return;
    task = cron.schedule(
        CHECK_AT,
        lifecycle.guard(() => {
            check().catch((err) => console.error("[CustomerRepos] Weekly name check failed:", err.message));
        }),
        { timezone: TIMEZONE },
    );
    console.log(`[CustomerRepos] Name check scheduled — Monday 04:30 ${TIMEZONE}`);
};

module.exports = {
    DEFAULT_TEMPLATE,
    FIELDS,
    part,
    render,
    checkTemplate,
    getNaming,
    setNaming,
    overview,
    preview,
    create,
    setName,
    check,
    start,
};
