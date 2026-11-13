const axios = require("axios");
const db = require("../db");
const agentCrypto = require("./agentCrypto");
const panelLog = require("./panelLog");
const customerRetire = require("./customerRetire");
const githubUrl = require("../utils/githubUrl");

// ─────────────────────────────────────────────────────────────────────────────
//  Customer projects, phase 4 — the customers' repos in one GitHub org
//  (user, 2026-11-13).
//
//  Customer bots used to live on the owner's own GitHub account next to
//  personal repos, so nothing said which repo was whose or which could go.
//  With the customers' repos moved into an org, the panel lists that org and
//  matches every repo to the project using it (bot.repoUrl): in use, expired,
//  retired (Bots → Retired) or used by nothing. Personal repos stay on the
//  owner's account and never show up here.
//
//  The panel only ever touches repos IN that org. Archive (undone with
//  Unarchive) and Delete are the owner's buttons — Delete needs the repo's name
//  typed back and is refused while a project still uses the repo. Repos are
//  never renamed (user, 2026-11-13); the one thing done by itself is the
//  description, kept to the project's current name in the daily sync (who the
//  customer is goes in only on a private repo).
//
//  A repo transferred into the org keeps working from its old URL (GitHub
//  redirects), so "Update repo URL" only rewrites the project's record, in the
//  same form and SSH host alias it had.
//
//  The token (fine-grained, for the org: Metadata read + Administration read
//  and write) is stored encrypted with JWT_SECRET, never sent back to the
//  browser, never logged.
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS = "customer_github_settings";
const ORG_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^[\w.-]{1,100}$/;
let API = "https://api.github.com";

function _err(message, status = 400, extra = {}) {
    const e = new Error(message);
    e.status = status;
    Object.assign(e, extra);
    return e;
}

const secret = () => {
    if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set");
    return process.env.JWT_SECRET;
};

const raw = async () => (await db.get(SETTINGS)) || {};
const tokenOf = (s) => (s.tokenEnc ? agentCrypto.decrypt(s.tokenEnc, secret()) : null);
const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

/**
 * One GitHub API call. Errors are the panel's own English sentences — never
 * axios' (its error carries the request, token included).
 */
const gh = async (method, path, { data, params, token } = {}) => {
    const t = token || tokenOf(await raw());
    if (!t) throw _err("GitHub is not set up — add the org and a token in Panel Settings → Integrations", 409);
    try {
        const res = await axios({
            method,
            url: API + path,
            data,
            params,
            timeout: 20_000,
            headers: { Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "bot-panel" },
        });
        return res.data;
    } catch (err) {
        const st = err.response?.status || 0;
        const msg = typeof err.response?.data?.message === "string" ? err.response.data.message : null;
        if (st === 401) throw _err("GitHub refused the token (invalid or expired) — set a new one in Panel Settings → Integrations", 502, { gh: st });
        if (st === 403) throw _err(`GitHub did not allow this${msg ? ` (${msg})` : ""} — the token needs Administration: read and write on the org's repositories`, 403, { gh: st });
        if (st === 404) throw _err("Not found on GitHub", 404, { gh: st });
        throw _err(`GitHub did not answer (${msg || (st ? `HTTP ${st}` : "no response")})`, 502, { gh: st });
    }
};

// ── Settings ─────────────────────────────────────────────────────────────────

const getSettings = async () => {
    const s = await raw();
    return { org: s.org || "", hasToken: !!s.tokenEnc, configured: !!(s.org && s.tokenEnc), check: s.check || null };
};

/**
 * The org's login from what the owner typed: the login itself, or its page
 * pasted whole (https://github.com/<login>, github.com/orgs/<login>/…). The
 * display name shown on GitHub ("ArnTo Shop") is not it — the first try on
 * the live panel was exactly that (2026-11-13), so it gets its own answer.
 */
const orgLogin = (input) => {
    let o = String(input || "").trim();
    const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?:orgs\/)?([^/?#\s]+)/i.exec(o);
    if (url) o = url[1];
    if (!o || ORG_NAME.test(o)) return o;
    if (/\s/.test(o)) {
        throw _err(`"${o}" is the organization's display name — enter the name from its address instead (github.com/<name>, no spaces), or paste the org's link`);
    }
    throw _err(`"${o}" is not a GitHub organization name — enter the name from its address (github.com/<name>), or paste the org's link`);
};

/** { org?, token? } — an empty token keeps the stored one. Checked against GitHub before saving. */
const setSettings = async ({ org, token } = {}) => {
    const next = { ...(await raw()) };
    if (org !== undefined) next.org = orgLogin(org);
    if (token !== undefined && String(token).trim()) next.tokenEnc = agentCrypto.encrypt(String(token).trim(), secret());
    if (next.org && next.tokenEnc) {
        const t = tokenOf(next);
        let info;
        try {
            info = await gh("get", `/orgs/${next.org}`, { token: t });
        } catch (err) {
            if (err.gh === 404) throw _err(`GitHub has no organization "${next.org}"`, 400);
            throw err;
        }
        await gh("get", `/orgs/${next.org}/repos`, { token: t, params: { per_page: 1, type: "all" } });
        next.org = info.login; // GitHub's own spelling
        next.check = { at: Date.now(), ok: true };
    }
    await db.set(SETTINGS, next);
    panelLog.add("owner", `Owner set the GitHub org for customer repos to ${next.org || "nothing"}`);
    return getSettings();
};

const needOrg = async () => {
    const s = await raw();
    if (!s.org || !s.tokenEnc) throw _err("GitHub is not set up — add the org and a token in Panel Settings → Integrations", 409);
    return s.org;
};

// ── Repos ────────────────────────────────────────────────────────────────────

const listOrgRepos = async (org) => {
    const out = [];
    for (let page = 1; page <= 30; page++) {
        const batch = await gh("get", `/orgs/${org}/repos`, { params: { per_page: 100, page, type: "all", sort: "full_name" } });
        out.push(...batch);
        if (batch.length < 100) break;
    }
    return out;
};

/** The repo an owner/name points to now (GitHub follows renames and transfers), or null. */
const resolve = async (owner, name) => {
    try {
        return await gh("get", `/repos/${owner}/${name}`);
    } catch (err) {
        if (err.gh === 404) return null;
        throw err;
    }
};

const repoOf = (bot) => {
    const p = githubUrl.parse(bot.repoUrl);
    return p ? { ...p, key: githubUrl.key(p.owner, p.name) } : null;
};

/**
 * The org's repos, each with who uses it, and the customer projects whose repo
 * is not (or not yet, by its URL) in the org.
 */
const overview = async () => {
    const s = await raw();
    if (!s.org || !s.tokenEnc) return { configured: false, repos: [], notInOrg: [] };
    const org = s.org;
    const [repos, bots, retired] = await Promise.all([listOrgRepos(org), db.find("bots"), customerRetire.entries()]);
    const byKey = new Map(repos.map((r) => [r.full_name.toLowerCase(), r]));
    const users = new Map(); // repo key → projects
    const use = (k, b) => users.set(k, [...(users.get(k) || []), b]);

    const notInOrg = [];
    for (const b of bots) {
        const p = repoOf(b);
        if (!p) continue;
        if (byKey.has(p.key)) {
            use(p.key, b);
            continue;
        }
        if (!b.customer?.enabled) continue; // personal / team repos are not this page's business
        const now = await resolve(p.owner, p.name).catch(() => null);
        const inOrg = now && same(now.owner?.login, org);
        if (inOrg) use(now.full_name.toLowerCase(), b);
        notInOrg.push({
            _id: b._id,
            name: b.name,
            repoUrl: b.repoUrl,
            state: inOrg ? "moved" : now ? "outside" : "unknown",
            movedTo: inOrg ? now.full_name : null,
        });
    }

    const retiredBy = new Map();
    for (const e of retired) {
        if (e.repo?.status !== "pending") continue;
        const p = githubUrl.parse(e.repo.url);
        if (p) retiredBy.set(githubUrl.key(p.owner, p.name), e);
    }

    const now = Date.now();
    const list = repos.map((r) => {
        const k = r.full_name.toLowerCase();
        const used = users.get(k) || [];
        const ret = retiredBy.get(k);
        const state = used.length
            ? used.every((b) => b.expiresAt && b.expiresAt <= now) ? "expired" : "in-use"
            : ret ? "retired" : "unused";
        return {
            id: r.id,
            name: r.name,
            fullName: r.full_name,
            url: r.html_url,
            private: !!r.private,
            archived: !!r.archived,
            pushedAt: Date.parse(r.pushed_at) || null,
            description: r.description || "",
            state,
            projects: used.map((b) => ({ _id: b._id, name: b.name, projectType: b.projectType || "discord", customer: !!b.customer?.enabled })),
            retired: ret ? { _id: ret._id, name: ret.name, retiredAt: ret.retiredAt } : null,
        };
    });
    return { configured: true, org, repos: list, notInOrg };
};

/** A repo of the org by name, as GitHub has it now. Nothing outside the org is ever touched. */
const orgRepo = async (name) => {
    const org = await needOrg();
    if (!REPO_NAME.test(String(name || ""))) throw _err("Invalid repo name");
    const r = await resolve(org, name);
    if (!r || !same(r.owner?.login, org)) throw _err(`There is no repo "${name}" in ${org}`, 404);
    return r;
};

/** Projects that still use repo `r` — by URL, or through a rename / transfer. */
const usersOf = async (r) => {
    const out = [];
    for (const b of await db.find("bots")) {
        const p = repoOf(b);
        if (!p) continue;
        if (p.key === r.full_name.toLowerCase()) {
            out.push(b);
            continue;
        }
        const now = await resolve(p.owner, p.name).catch(() => null);
        if (now?.id === r.id) out.push(b);
    }
    return out;
};

const setArchived = async (r, archived, who) => {
    if (!!r.archived === !!archived) return r;
    const out = await gh("patch", `/repos/${r.full_name}`, { data: { archived: !!archived } });
    panelLog.add("owner", `Owner ${archived ? "archived" : "unarchived"} the repo ${r.full_name}${who ? ` (${who})` : ""}`);
    return out;
};

const deleteRepo = async (r, confirm, who) => {
    if (String(confirm || "") !== r.name) throw _err(`Type the repo's name (${r.name}) to delete it`);
    const users = await usersOf(r);
    if (users.length) throw _err(`${r.full_name} is still used by ${users.map((b) => `"${b.name}"`).join(", ")} — delete the project first`, 409);
    await gh("delete", `/repos/${r.full_name}`);
    panelLog.add("owner", `Owner deleted the repo ${r.full_name}${who ? ` (${who})` : ""} on GitHub`);
};

/** Repos page: Archive / Unarchive. */
const archive = async (name, archived = true) => {
    const r = await orgRepo(name);
    await setArchived(r, archived);
    if (archived) await customerRetire.markRepoByKey(r.full_name.toLowerCase(), "archived");
    return { ok: true };
};

/** Repos page: Delete (the name typed back as `confirm`). */
const remove = async (name, confirm) => {
    const r = await orgRepo(name);
    await deleteRepo(r, confirm);
    await customerRetire.markRepoByKey(r.full_name.toLowerCase(), "deleted");
    return { ok: true };
};

/** The org repo a retired project's URL leads to, or a 409 saying why the panel will not touch it. */
const retiredRepo = async (rid) => {
    const org = await needOrg();
    const e = await customerRetire.get(rid);
    const p = githubUrl.parse(e.repo?.url);
    if (!p) throw _err("This project's repo is not on GitHub", 409);
    const r = await resolve(p.owner, p.name);
    if (!r) throw _err(`The repo ${p.owner}/${p.name} was not found — it may be gone already; mark it handled`, 409);
    if (!same(r.owner?.login, org)) throw _err(`The repo is in ${r.owner?.login}, not in ${org} — the panel only touches the org's repos; handle it on GitHub, then mark it handled`, 409);
    return { e, r };
};

/** Bots → Retired: archive the repo; the line is done. */
const archiveRetired = async (rid) => {
    const { e, r } = await retiredRepo(rid);
    await setArchived(r, true, `retired project "${e.name}"`);
    return customerRetire.setRepoResult(rid, "archived");
};

/** Bots → Retired: delete the repo (its name typed back); the line is done. */
const deleteRetired = async (rid, confirm) => {
    const { e, r } = await retiredRepo(rid);
    await deleteRepo(r, confirm, `retired project "${e.name}"`);
    return customerRetire.setRepoResult(rid, "deleted");
};

/** A project whose repo moved into the org: rewrite its URL (same form, same SSH host alias). */
const updateProjectUrl = async (botId) => {
    const org = await needOrg();
    const bot = await db.findOne("bots", { _id: botId });
    if (!bot) throw _err("Project not found", 404);
    const p = repoOf(bot);
    if (!p) throw _err("This project's repo is not on GitHub");
    const r = await resolve(p.owner, p.name);
    if (!r) throw _err(`${p.owner}/${p.name} was not found on GitHub`, 404);
    if (!same(r.owner?.login, org)) throw _err(`The repo is still in ${r.owner?.login}, not in ${org} — transfer it on GitHub first`, 409);
    if (same(r.full_name, `${p.owner}/${p.name}`)) throw _err("The URL already points to the repo in the org", 409);
    const repoUrl = githubUrl.rewrite(bot.repoUrl, r.owner.login, r.name);
    const updated = await db.findOneAndUpdate("bots", { _id: bot._id }, { repoUrl });
    panelLog.add("owner", `Owner pointed "${bot.name}" at ${r.full_name} (moved on GitHub)`);
    return { bot: updated };
};

// ── Daily sync ───────────────────────────────────────────────────────────────

const descriptionOf = (bot, { projectName, buyerName }, isPrivate) => {
    const who = buyerName ? `@${buyerName} (${bot.buyerID})` : String(bot.buyerID);
    return (isPrivate ? `${projectName} · customer ${who}` : projectName).slice(0, 350);
};

/**
 * Keep the description of a customer project's org repo to the project's
 * current name. → null, or the problem to show on the project. Repos outside
 * the org (or not set up) are left alone; an archived repo is read-only.
 */
const syncDescription = async (bot, names) => {
    const s = await raw();
    if (!s.org || !s.tokenEnc) return null;
    const p = repoOf(bot);
    if (!p || !same(p.owner, s.org)) return null;
    try {
        const r = await resolve(s.org, p.name);
        if (!r) return `The repo ${p.owner}/${p.name} was not found in ${s.org}`;
        if (!same(r.owner?.login, s.org) || r.archived) return null;
        const want = descriptionOf(bot, names, r.private);
        if ((r.description || "") !== want) await gh("patch", `/repos/${r.full_name}`, { data: { description: want } });
        return null;
    } catch (err) {
        return err.message;
    }
};

module.exports = {
    getSettings,
    setSettings,
    overview,
    archive,
    remove,
    archiveRetired,
    deleteRetired,
    updateProjectUrl,
    syncDescription,
    _setApiBase: (url) => {
        API = url;
    },
};
