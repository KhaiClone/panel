const crypto = require("crypto");
const net = require("net");
const db = require("../db");
const nodeService = require("./nodeService");

// ─────────────────────────────────────────────────────────────────────────────
//  Removing a node — the way back from nodeJoin.
//
//  Two modes:
//    panel   the panel forgets the node; nothing on the machine changes.
//    vps     the VPS is cleaned up too: the agent starts agent/uninstall-agent.sh
//            detached (agent services/uninstall.js). The agent itself is the
//            first thing that goes, so the script reports its output to
//            /api/node-removal/<token> (routes/nodeRemoval.js) instead.
//            What is always removed: the agent, Lavalink, WireGuard, the
//            panel's firewall rules, nginx site and certificates. `parts` adds:
//              ssh        the SSH keys and git identity the panel copied
//              firewall   UFW as it was before (80/443 rules, on/off)
//              packages   the packages the setup installed
//            All three = everything the setup did.
//
//  If the VPS cannot be cleaned up (agent offline, too old, the script refuses),
//  nothing happens and the error carries the command to run there by hand.
//
//  Either way the panel then forgets the node and what it kept for it: the
//  Egress Proxy pins of projects routed through it, its stale copies, Lavalink
//  state, its panel domains, the "panel access" rules other nodes hold for its
//  addresses, its WireGuard peer on every other node.
//
//  Record under "node_removals" (kept a day):
//    { id, nodeId, name, host, mode, parts, createdAt, done,
//      staleCopies, egressBots,                            // as impact() saw them
//      steps: [{ label, status, detail }],                 // the panel's side
//      vps: null | { tokenHash, detail, status: running|done|failed, log,
//                    startedAt, updatedAt, finishedAt } }  // the VPS's side
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "node_removals";
const KEEP_MS = 24 * 3600_000;
const LOST_MS = 30 * 60_000; // no word from the VPS for this long: say so
const LOG_MAX = 64 * 1024;
const PARTS = ["ssh", "firewall", "packages"];

const httpError = (status, message) => Object.assign(new Error(message), { status });
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// ── Storage — one read-modify-write at a time, as in nodeJoin ────────────────

const load = async () => ((await db.get(KEY)) || []).filter((r) => Date.now() - r.createdAt < KEEP_MS);

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

const vpsStatus = (v) => (v.status === "running" && Date.now() - v.updatedAt > LOST_MS ? "lost" : v.status);
const toPublic = (r) => {
    if (!r.vps) return { ...r };
    const { tokenHash: _hidden, ...vps } = r.vps;
    return { ...r, vps: { ...vps, status: vpsStatus(r.vps) } };
};

/**
 * What to run on the VPS by hand. "$USER" because it is meant to be run as the
 * account the agent ran as; --keep-packages first, as a script from before the
 * other flags reads only that one, in that place.
 */
const manualCommand = (parts = []) => {
    const keep = [["packages", "--keep-packages"], ["ssh", "--keep-ssh-keys"], ["firewall", "--keep-firewall"]]
        .filter(([p]) => !parts.includes(p))
        .map(([, flag]) => ` ${flag}`)
        .join("");
    return `sudo bash ~/panel/agent/uninstall-agent.sh "$USER"${keep}`;
};

// ── The panel's side ─────────────────────────────────────────────────────────

/** Remove the panel's "panel access" rules for the node's addresses from every other node. */
const dropAccessRules = async (node) => {
    const ips = [...new Set([node.host, node.wgOverlayIp].filter((ip) => net.isIP(ip || "")))];
    if (!ips.length) return { detail: "The node had no IP address to look for" };
    const others = (await nodeService.getNodes()).filter((n) => n.enabled !== false);
    const lines = [];
    let warn = false;
    for (const other of others) {
        try {
            const r = await nodeService.agentRequest(other, "post", "/ufw/remove-from", { data: { ips }, timeout: 30_000 });
            if (r.removed) lines.push(`${other.name}: ${r.removed} rule(s) removed`);
        } catch (err) {
            warn = true;
            lines.push(err.agentStatus === 404
                ? `${other.name}: its agent is too old to look (update it) — rules from ${ips.join(", ")} may be left`
                : `${other.name}: ${err.message}`);
        }
    }
    return { warn, detail: lines.join("\n") || `None of the ${others.length} other node(s) had one` };
};

const dropFromMesh = async () => {
    const results = await require("./wgService").syncMesh();
    const failed = results.filter((r) => !r.ok);
    const ok = results.length - failed.length;
    if (!failed.length) return { detail: `${ok} node(s) updated` };
    return {
        warn: true,
        detail: `${ok} node(s) updated; not: ${failed.map((f) => `${f.node} (${f.error})`).join(", ")} — they drop the peer on the next sync`,
    };
};

/** Run one step of the panel's side and record it on the removal. */
const step = async (id, label, fn) => {
    let s;
    try {
        const r = (await fn()) || {};
        s = { label, status: r.warn ? "warn" : "ok", detail: r.detail || null };
    } catch (err) {
        s = { label, status: "error", detail: err.message };
    }
    await mutate((rows) => {
        const row = rows.find((r) => r.id === id);
        if (row) row.steps.push(s);
    });
    if (s.status !== "ok") console.warn(`[Nodes] Removal — ${label}: ${s.status}${s.detail ? ` (${s.detail})` : ""}`);
};

const forget = async (node, domains, id) => {
    await require("./lavalinkStore")
        .forgetNode(node._id)
        .catch((err) => console.error("[Lavalink] Could not clear node state:", err.message));
    await step(id, "Panel domains", async () => {
        const gone = await require("./panelDomains").forgetNode(node._id);
        return { detail: gone.length ? `Dropped ${gone.join(", ")}` : domains.length ? "Already gone" : "The node had none" };
    });
    await step(id, "Firewall rules on the other nodes", () => dropAccessRules(node));
    await step(id, "WireGuard mesh", dropFromMesh);
    await mutate((rows) => {
        const row = rows.find((r) => r.id === id);
        if (row) row.done = true;
    });
};

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * What removing a node would touch — the Remove dialog shows it first.
 *   bots        projects whose record names this node (they block the removal)
 *   staleCopies projects force-moved off it while it was down, still in its
 *               PM2 list (services/staleCopies.js); once the node is gone
 *               nothing can stop them
 *   egressBots  projects on other nodes whose outbound traffic goes through it
 */
const impact = async (node) => {
    const bots = await db.find("bots");
    const on = (nodeId) => {
        try { return nodeService.resolveNodeId(nodeId) === node._id; } catch { return false; }
    };
    const brief = (b) => ({ _id: b._id, name: b.name, projectType: b.projectType || "discord", pm2Name: b.pm2Name });
    return {
        isPanelNode: node._id === process.env.PANEL_NODE_ID,
        bots: bots.filter((b) => on(b.nodeId)).map((b) => ({ ...brief(b), canRebuild: !!b.repoUrl })),
        staleCopies: (await require("./staleCopies").forNode(node._id))
            .map((s) => ({ name: s.name, pm2Name: s.pm2Name, createdAt: s.createdAt })),
        egressBots: bots.filter((b) => b.egressNodeId && on(b.egressNodeId) && !on(b.nodeId)).map(brief),
    };
};

const list = async () => (await load()).map(toPublic).sort((a, b) => b.createdAt - a.createdAt);

const get = async (id) => {
    const row = (await load()).find((r) => r.id === id);
    if (!row) throw httpError(404, "Removal not found");
    return toPublic(row);
};

/**
 * Remove a node → the removal record. `mode` "panel" or "vps"; `parts` what the
 * VPS loses beyond the agent (PARTS); `origin` the address the admin's browser
 * uses, for the script's report URL when the panel has no HTTPS address.
 * Refused for the panel's own node and while projects live on the node.
 */
const remove = async (nodeId, { mode = "panel", parts = [], origin } = {}) => {
    if (mode !== "panel" && mode !== "vps") throw httpError(400, 'mode must be "panel" or "vps"');
    parts = [...new Set((Array.isArray(parts) ? parts : []).filter((p) => PARTS.includes(p)))];

    const node = await db.findOne("nodes", { _id: nodeId });
    if (!node) throw httpError(404, "Node not found");
    const touched = await impact(node);
    if (touched.isPanelNode) {
        throw httpError(400, `"${node.name}" runs the panel — move the panel to another node first (Panel Settings → Move Panel)`);
    }
    const { bots, staleCopies, egressBots } = touched;
    if (bots.length) {
        const names = bots.slice(0, 5).map((b) => b.name).join(", ") + (bots.length > 5 ? ", …" : "");
        throw httpError(400, `Cannot remove node "${node.name}" — ${bots.length} project(s) still run on it (${names}). Delete or migrate them first.`);
    }

    const domains = (await require("./panelDomains").list()).filter((d) => d.nodeId === node._id);
    const record = {
        id: crypto.randomUUID(),
        nodeId: node._id,
        name: node.name,
        host: node.host,
        mode,
        parts: mode === "vps" ? parts : [],
        createdAt: Date.now(),
        done: false,
        steps: [],
        staleCopies,
        egressBots,
        vps: null,
    };

    if (mode === "vps") {
        const token = crypto.randomBytes(24).toString("base64url");
        const baseUrl = await require("./nodeJoin").baseUrlFor(origin);
        let started;
        try {
            started = await nodeService.agentRequest(node, "post", "/self/uninstall", {
                data: { parts, reportUrl: `${baseUrl}/api/node-removal/${token}`, certs: domains.map((d) => d.domain) },
                timeout: 90_000,
            });
        } catch (err) {
            const byHand = `Remove it from the panel only, then run on the VPS:\n${manualCommand(parts)}`;
            if (err.agentStatus === 404) {
                throw httpError(409, `The agent on ${node.name} is too old to remove itself — press "Update Agent" first. Or: ${byHand}`);
            }
            // Not the agent's 401 as is: the browser would take it for its own session.
            throw httpError(err.status === 400 || err.status === 409 ? err.status : 502, `${err.message}\nThe node was not removed. ${byHand}`);
        }
        const now = Date.now();
        record.vps = { tokenHash: sha256(token), detail: started.detail || null, status: "running", log: "", startedAt: now, updatedAt: now, finishedAt: null };
    }

    // Before the node record goes: an egress pin through it could only fail
    // from now on, and nothing can reach its stale copies anymore.
    if (egressBots.length) {
        await db.updateMany("bots", { _id: egressBots.map((b) => b._id) }, { egressNodeId: "" });
    }
    await require("./staleCopies").forgetNode(node._id);
    await db.findOneAndDelete("nodes", { _id: node._id });
    record.steps.push({
        label: "Removed from the panel",
        status: "ok",
        detail: mode === "vps" ? `The agent is removing itself from ${node.host}` : `Nothing on ${node.host} was touched`,
    });
    if (egressBots.length) {
        record.steps.push({
            label: "Egress Proxy",
            status: "warn",
            detail: `Cleared the pin of ${egressBots.map((b) => b.name).join(", ")} — restart them to use their own node's IP`,
        });
    }
    if (staleCopies.length) {
        record.steps.push({
            label: "Old copies left in its PM2 list",
            status: "warn",
            detail: `If ${node.host} boots again they run alongside their new copies — stop them there:\n` +
                staleCopies.map((s) => `${s.name}: pm2 delete ${s.pm2Name} && pm2 save`).join("\n"),
        });
    }
    await mutate((rows) => {
        rows.push(record);
    });

    // What the panel kept for the node — a node offline costs a timeout or two,
    // so in the background; the page follows the steps.
    forget(node, domains, record.id).catch((err) => console.error(`[Nodes] Cleaning up after "${node.name}" failed:`, err.message));
    return toPublic(record);
};

/**
 * The script's report: its output so far, and running / done / failed. Only
 * while it is running — a finished removal takes no more.
 */
const report = (token, { status, log }) =>
    mutate((rows) => {
        const row = typeof token === "string" && token.length >= 20 ? rows.find((r) => r.vps?.tokenHash === sha256(token)) : null;
        if (!row) throw httpError(404, "Unknown removal");
        if (row.vps.status !== "running") throw httpError(409, `This removal is already ${row.vps.status}`);
        row.vps.log = String(log || "").slice(-LOG_MAX);
        row.vps.updatedAt = Date.now();
        if (status === "done" || status === "failed") {
            row.vps.status = status;
            row.vps.finishedAt = Date.now();
        }
        return { ok: true };
    });

module.exports = { impact, list, get, remove, report, manualCommand, PARTS, LOST_MS };
