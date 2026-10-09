const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const db = require("../db");
const nodeService = require("./nodeService");
const nodeSetup = require("./nodeSetup");
const agentCrypto = require("./agentCrypto");

// ─────────────────────────────────────────────────────────────────────────────
//  Adding a node with one command.
//
//  The Systems page creates an invite for a name + the new VPS's public IP and
//  shows one command. Run as root on that VPS, it downloads agent/setup-agent.sh
//  from this panel with everything filled in (panel IP, repo, the panel's own
//  commit, where to call back) — the script installs the agent, then POSTs the
//  agent key, encrypted with the token, to /api/join/<token>. The panel checks
//  the agent at the invite's IP with that key, saves the node, answers, and
//  provisions it in the background (nodeSetup); the script follows the steps
//  through GET /api/join/<token> and prints them.
//
//  Why a stolen token is worth little:
//    - single use, 30 minutes, stored only as sha256
//    - bound to the IP typed into the invite: the panel itself calls the agent
//      there, so a token cannot register any other machine — and only a machine
//      that proves it holds the key receives the panel's SSH keys
//    - a failed attempt (firewall, agent not up) keeps the invite usable until
//      it expires, so fixing the cause and running the command again works
//
//  Record under "node_join_invites":
//    { id, tokenHash, name, ip, port, baseUrl, createdAt, expiresAt,
//      status: pending|joining|provisioning|done|revoked, error, nodeId, steps }
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "node_join_invites";
const TTL_MS = 30 * 60_000;
const KEEP_MS = 24 * 3600_000; // finished invites stay visible for a day
const REPO_ROOT = path.join(__dirname, "../..");
const SETUP_SCRIPT = path.join(REPO_ROOT, "agent", "setup-agent.sh");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const httpError = (status, message) => Object.assign(new Error(message), { status });
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
/** Single-quote for bash. */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const oneLine = (s) => String(s).replace(/[\x00-\x1f\x7f]/g, " ");

// ── Storage ──────────────────────────────────────────────────────────────────

const load = async () => ((await db.get(KEY)) || []).filter((i) => Date.now() - i.createdAt < KEEP_MS);

// Every change is read-modify-write of one array: run them one at a time, or a
// progress save during a join could drop an invite created meanwhile.
let chain = Promise.resolve();
const mutate = (fn) => {
    const run = chain.then(async () => {
        const rows = await load();
        const out = await fn(rows);
        await db.set(KEY, rows);
        return out;
    });
    chain = run.catch(() => {});
    return run;
};

const patch = (id, changes) =>
    mutate((rows) => {
        const row = rows.find((r) => r.id === id);
        if (row) Object.assign(row, changes);
        return row ? { ...row } : null;
    });

const isExpired = (i) => (i.status === "pending" || i.status === "joining") && Date.now() > i.expiresAt;
const statusOf = (i) => (isExpired(i) ? "expired" : i.status);
const toPublic = (i) => {
    const { tokenHash: _hidden, ...rest } = i;
    return { ...rest, status: statusOf(i) };
};

/** The invite a token belongs to, if it can still be used — else a 404/409/410 that says why. */
const usable = (rows, token) => {
    const inv = typeof token === "string" && token.length >= 20 ? rows.find((r) => r.tokenHash === sha256(token)) : null;
    if (!inv) throw httpError(404, "Unknown join command — create a new one on the panel's Systems page");
    const status = statusOf(inv);
    if (status === "pending") return inv;
    if (status === "joining") throw httpError(409, "This command is already running on the new VPS");
    if (status === "expired") throw httpError(410, "This join command has expired — create a new one on the panel's Systems page");
    if (status === "revoked") throw httpError(410, "This join command was revoked — create a new one on the panel's Systems page");
    throw httpError(410, "This join command has already been used");
};

// ── What the script is told ──────────────────────────────────────────────────

/**
 * Where the new VPS reaches this panel. The panel's own address when it is
 * HTTPS; otherwise the address the admin is using right now (it works for them),
 * unless that is a loopback dev URL.
 */
const baseUrlFor = async (origin) => {
    const current = await require("./panelDomains").currentUrl().catch(() => null);
    if (current?.startsWith("https://")) return current.replace(/\/+$/, "");
    try {
        const u = new URL(origin);
        if ((u.protocol === "https:" || u.protocol === "http:") && !LOOPBACK.has(u.hostname)) return u.origin;
    } catch { /* no usable origin */ }
    if (current) return current.replace(/\/+$/, "");
    throw httpError(503, "The panel does not know its own address — add a domain under Panel Settings, or open the panel by its public address");
};

/** git@host:owner/repo(.git) or ssh://git@host/owner/repo → https://host/owner/repo.git; credentials dropped. */
const toPublicRepoUrl = (url) => {
    const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url) || /^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    if (ssh) return `https://${ssh[1]}/${ssh[2]}.git`;
    try {
        const u = new URL(url);
        if (u.protocol !== "https:" && u.protocol !== "http:") return null;
        u.username = "";
        u.password = "";
        return u.href;
    } catch {
        return null;
    }
};

/**
 * The repo the new node clones: NODE_JOIN_REPO_URL, else this checkout's origin
 * as a public https URL (a fresh VPS has no SSH key yet), else the script's default.
 */
const repoUrl = () => {
    if (process.env.NODE_JOIN_REPO_URL) return process.env.NODE_JOIN_REPO_URL;
    try {
        const cfg = fs.readFileSync(path.join(REPO_ROOT, ".git", "config"), "utf8");
        const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(cfg);
        return m ? toPublicRepoUrl(m[1]) : null;
    } catch {
        return null;
    }
};

const scriptUrl = (baseUrl, token) => `${baseUrl}/api/join/${token}/install.sh`;

/**
 * What the admin pastes. No `curl -f`: an expired or used command gets a small
 * script back that says so, instead of a bare "error 410". `sudo` on bash, not
 * curl: only the setup needs root, and it works the same from a root shell.
 */
const commandFor = (baseUrl, token) => `curl -sSL ${shq(scriptUrl(baseUrl, token))} -o join-node.sh && sudo bash join-node.sh`;

// ── API ──────────────────────────────────────────────────────────────────────

const list = async () => (await load()).map(toPublic).sort((a, b) => b.createdAt - a.createdAt);

const get = async (id) => {
    const inv = (await load()).find((i) => i.id === id);
    if (!inv) throw httpError(404, "Invite not found");
    return toPublic(inv);
};

/**
 * New invite → { invite, token, command, secure }. The token is returned this
 * once and never stored; an older pending invite for the same address is revoked.
 */
const create = async ({ name, ip, port = 4200, origin } = {}) => {
    name = String(name || "").trim();
    ip = String(ip || "").trim();
    if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw httpError(400, "A name (up to 64 characters) is required");
    if (!net.isIP(ip)) throw httpError(400, "The new VPS's public IP address is required");
    const p = parseInt(port, 10);
    if (isNaN(p) || p < 1 || p > 65535) throw httpError(400, "Invalid agent port");

    const existing = await db.findOne("nodes", { host: ip, port: p });
    if (existing) throw httpError(409, `A node at ${ip}:${p} already exists ("${existing.name}")`);

    // The new node's firewall admits the agent port from this IP only.
    const panelNode = await nodeService.getNode(nodeService.panelNodeId());
    if (!net.isIP(panelNode.host)) {
        throw httpError(400, `The panel's node "${panelNode.name}" has host "${panelNode.host}", not an IP address — the new node's firewall needs the panel's IP`);
    }

    const baseUrl = await baseUrlFor(origin);
    const token = crypto.randomBytes(24).toString("base64url");
    const now = Date.now();
    const invite = {
        id: crypto.randomUUID(),
        tokenHash: sha256(token),
        name,
        ip,
        port: p,
        baseUrl,
        createdAt: now,
        expiresAt: now + TTL_MS,
        status: "pending",
        error: null,
        nodeId: null,
        steps: [],
    };
    await mutate((rows) => {
        for (const r of rows) if (r.ip === ip && r.port === p && r.status === "pending") r.status = "revoked";
        rows.push(invite);
    });
    return { invite: toPublic(invite), token, command: commandFor(baseUrl, token), secure: baseUrl.startsWith("https://") };
};

const revoke = (id) =>
    mutate((rows) => {
        const inv = rows.find((r) => r.id === id);
        if (!inv) throw httpError(404, "Invite not found");
        if (statusOf(inv) !== "pending") throw httpError(409, `The invite is ${statusOf(inv)}, not pending`);
        inv.status = "revoked";
        return toPublic(inv);
    });

/** agent/setup-agent.sh with this invite's settings in front of it. */
const script = async (token) => {
    const inv = usable(await load(), token);
    const panelNode = await nodeService.getNode(nodeService.panelNodeId());

    let git = {};
    try {
        git = (await require("./panelService").getPanelStatus()).git || {};
    } catch { /* unknown — the node takes the branch tip */ }
    const branch = git.branch && git.branch !== "HEAD" ? git.branch : "";
    const commit = /^[0-9a-f]{40}$/.test(git.commitHash || "") ? git.commitHash : "";
    const repo = repoUrl();

    // LF whatever the checkout has (a Windows clone with autocrlf gives CRLF,
    // which bash would read as part of every command).
    const body = fs.readFileSync(SETUP_SCRIPT, "utf8").replace(/\r\n/g, "\n").replace(/^#!.*\n/, "");
    const header = [
        "#!/bin/bash",
        `# bot-panel: joins ${oneLine(inv.name)} (${inv.ip}) to the panel at ${inv.baseUrl}`,
        `# Single use, valid until ${new Date(inv.expiresAt).toISOString()}. Below the settings: agent/setup-agent.sh.`,
        `export JOIN_URL=${shq(`${inv.baseUrl}/api/join/${token}`)}`,
        `export JOIN_TOKEN=${shq(token)}`,
        `export REPO_BRANCH=${shq(branch)}`,
        `export REPO_COMMIT=${shq(commit)}`,
        `set -- ${shq(panelNode.host)} ${shq(inv.port)}${repo ? ` ${shq(repo)}` : ""}`,
        "",
    ].join("\n");
    return header + body;
};

/** A script that only prints why the command cannot run (served instead of the real one). */
const errorScript = (message) => `#!/bin/bash\necho ${shq(`✗ ${oneLine(message)}`)} >&2\nexit 1\n`;

/**
 * The callback from setup-agent.sh: { apiKey: <encrypted with the token>, agentPort }.
 * Registers the node at the invite's IP and answers { node } right away;
 * provisioning goes on in the background (a Lavalink download can outlast a
 * proxy's timeout) and the script follows it through status().
 */
const join = async (token, body = {}) => {
    const inv = await mutate((rows) => {
        const row = usable(rows, token);
        row.status = "joining";
        row.error = null;
        return { ...row };
    });

    let node;
    try {
        let apiKey;
        try {
            apiKey = agentCrypto.decrypt(body.apiKey, token);
        } catch {
            throw httpError(400, "The agent key could not be decrypted with this join token");
        }
        // The script reports the port its .env really uses (an existing .env is kept).
        const port = Number.isInteger(body.agentPort) && body.agentPort > 0 && body.agentPort < 65536 ? body.agentPort : inv.port;
        // The agent was started seconds ago — give it half a minute to answer.
        node = await nodeSetup.register({ name: inv.name, host: inv.ip, port, apiKey }, { healthAttempts: 10 });
    } catch (err) {
        // Nothing was saved: the command stays usable until it expires.
        await patch(inv.id, { status: "pending", error: err.message });
        throw err;
    }

    await patch(inv.id, { status: "provisioning", nodeId: node._id, joinedAt: Date.now() });
    const provisioned = nodeSetup
        .provision(node, { onStep: (s) => patch(inv.id, { steps: s }) })
        .then((steps) => patch(inv.id, { status: "done", steps, finishedAt: Date.now() }))
        .catch((err) => patch(inv.id, { status: "done", error: err.message, finishedAt: Date.now() }))
        .catch((err) => console.error(`[Join] ${inv.name}:`, err.message));

    return { node: { _id: node._id, name: node.name, host: node.host, port: node.port }, provisioned };
};

/**
 * Progress for the script that ran the command, by its token (the invite id is
 * not known there). Works after the invite is used — that is when it matters.
 */
const status = async (token) => {
    const inv = typeof token === "string" && token.length >= 20 ? (await load()).find((r) => r.tokenHash === sha256(token)) : null;
    if (!inv) throw httpError(404, "Unknown join command");
    const { status: st, steps, error, nodeId } = toPublic(inv);
    return { status: st, steps, error, nodeId };
};

module.exports = { list, get, create, revoke, script, errorScript, join, status, baseUrlFor, TTL_MS, _internal: { toPublicRepoUrl, shq, commandFor } };
