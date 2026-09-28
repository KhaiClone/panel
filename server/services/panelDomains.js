const db = require("../db");
const nodeService = require("./nodeService");

// ─────────────────────────────────────────────────────────────────────────────
//  The panel's own domains — one or more per NODE, never moved between them.
//
//  Every VPS that may host the panel gets its own name (panel.example.com on
//  one, panel-b.example.com on another …) whose DNS points at it for good. A
//  move changes no DNS: on the node running the panel its domains proxy to the
//  panel; on every other node they redirect to it (agent nginx.writePanelSites).
//  Prepare issues the target's certificates ahead of time, so HTTPS is there
//  the moment the panel arrives.
//
//  Record: { domain, nodeId, sslEnabled, addedAt } under "panel_domains".
//  sslEnabled mirrors what the node reports (a certificate on its disk).
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "panel_domains";

const panelPort = () => parseInt(process.env.PORT, 10) || 3000;
const httpError = (status, message) => Object.assign(new Error(message), { status });

const list = async () => (await db.get(KEY)) || [];

/**
 * Give records from before per-node domains an owner — once, in one write.
 * `nodeId` is the node the panel ran on when they were added.
 */
const normalize = async (nodeId) => {
    const rows = await list();
    if (!nodeId || rows.every((d) => d.nodeId)) return 0;
    const n = rows.filter((d) => !d.nodeId).length;
    await db.set(KEY, rows.map((d) => (d.nodeId ? d : { ...d, nodeId })));
    return n;
};

/** Oldest first, so "the first domain of a node" is stable. */
const ofNode = (rows, nodeId) =>
    rows.filter((d) => d.nodeId === nodeId).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));

/**
 * Where people open the panel: the first domain of the node it runs on
 * (https once it has a certificate), else http://host:port.
 */
const publicUrl = (rows, panelNode) => {
    if (!panelNode) return null;
    const d = ofNode(rows, panelNode._id)[0];
    if (d) return `${d.sslEnabled ? "https" : "http"}://${d.domain}`;
    return `http://${panelNode.host}:${panelPort()}`;
};

/**
 * Pure: what each node's vhost holds → Map(nodeId → sites). The panel's node
 * proxies, every other node redirects to publicUrl.
 */
const planSites = (rows, panelNode) => {
    const url = publicUrl(rows, panelNode);
    const plan = new Map();
    for (const d of rows) {
        if (!plan.has(d.nodeId)) plan.set(d.nodeId, []);
        plan.get(d.nodeId).push(
            d.nodeId === panelNode?._id
                ? { domain: d.domain, mode: "proxy", port: panelPort() }
                : { domain: d.domain, mode: "redirect", to: url },
        );
    }
    return plan;
};

const panelNode = async () => nodeService.getNode(nodeService.panelNodeId()).catch(() => null);

/** Record which of `nodeId`'s domains have a certificate there (agent's answer). */
const recordCerts = async (nodeId, certs) => {
    const have = new Set(certs || []);
    const rows = await list();
    let changed = false;
    const next = rows.map((d) => {
        if (d.nodeId !== nodeId || !!d.sslEnabled === have.has(d.domain)) return d;
        changed = true;
        return { ...d, sslEnabled: have.has(d.domain) };
    });
    if (changed) await db.set(KEY, next);
};

/** Write one node's vhost. `nodeIds` absent = every node that has a domain. */
const sync = async ({ nodeIds } = {}) => {
    const rows = await list();
    const here = await panelNode();
    const plan = planSites(rows, here);
    const targets = nodeIds || [...plan.keys()];
    const results = [];
    for (const nodeId of targets) {
        const node = await nodeService.getNode(nodeId).catch(() => null);
        if (!node) {
            results.push({ nodeId, ok: false, error: "node no longer exists" });
            continue;
        }
        try {
            const r = await nodeService.agentRequest(node, "post", "/nginx/panel-sites", {
                data: { sites: plan.get(nodeId) || [] },
                timeout: 60_000,
            });
            await recordCerts(nodeId, r.certs);
            results.push({ nodeId, name: node.name, ok: true, sites: (plan.get(nodeId) || []).length });
        } catch (err) {
            results.push({ nodeId, name: node.name, ok: false, error: err.message });
        }
    }
    return results;
};

/** Add a domain on `nodeId` (default: the panel's node) and write that node's vhost. */
const add = async ({ domain, nodeId }) => {
    const clean = String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!clean || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) throw httpError(400, "Invalid domain name");
    const node = await nodeService.getNode(nodeId || nodeService.panelNodeId()).catch(() => null);
    if (!node) throw httpError(404, "Node not found");
    const rows = await list();
    if (rows.some((d) => d.domain === clean)) throw httpError(409, "Domain already added");
    // Say what is missing instead of failing deep inside the vhost write.
    const status = await nodeService.agentRequest(node, "get", "/panel-host/status", { timeout: 20_000 }).catch(() => null);
    if (status && status.nginx === false) {
        throw httpError(
            400,
            `nginx is not installed on ${node.name}. On that VPS run: sudo apt install -y nginx certbot python3-certbot-nginx ` +
                `— and allow ports 80 and 443 in its firewall (sudo ufw allow 80,443/tcp) — then add the domain again.`,
        );
    }
    const entry = { domain: clean, nodeId: node._id, sslEnabled: false, addedAt: Date.now() };
    await db.set(KEY, [...rows, entry]);
    const [r] = await sync({ nodeIds: [node._id] });
    if (!r.ok) {
        await db.set(KEY, (await list()).filter((d) => d.domain !== clean));
        throw httpError(502, `nginx on ${node.name}: ${r.error}`);
    }
    return entry;
};

/** Remove a domain and rewrite its node's vhost without it. */
const remove = async (domain) => {
    const rows = await list();
    const entry = rows.find((d) => d.domain === domain);
    if (!entry) throw httpError(404, "Domain not found");
    await db.set(KEY, rows.filter((d) => d.domain !== domain));
    const [r] = await sync({ nodeIds: [entry.nodeId] });
    if (!r.ok) console.warn(`[Domains] ${domain} removed, but nginx on its node was not updated: ${r.error}`);
};

/**
 * HTTPS for one domain, issued on ITS node (DNS must point there): certbot
 * certonly, then the vhost is rewritten with the 443 block. If this domain's
 * node is where the panel runs, the other nodes' redirects switch to https.
 */
const issueCert = async (domain, email = null) => {
    const entry = (await list()).find((d) => d.domain === domain);
    if (!entry) throw httpError(404, "Domain not found");
    const node = await nodeService.getNode(entry.nodeId);
    await nodeService.agentRequest(node, "post", "/nginx/panel-cert", { data: { domain, email }, timeout: 150_000 });
    const [r] = await sync({ nodeIds: [node._id] });
    if (!r.ok) throw httpError(502, `Certificate issued, but nginx on ${node.name} was not updated: ${r.error}`);
    if (node._id === nodeService.panelNodeId()) await sync();
    return (await list()).find((d) => d.domain === domain);
};

module.exports = { KEY, list, normalize, ofNode, publicUrl, planSites, sync, add, remove, issueCert };
