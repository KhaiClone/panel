const net = require("net");
const db = require("../db");
const nodeService = require("./nodeService");
const panelLease = require("./panelLease");

// ─────────────────────────────────────────────────────────────────────────────
//  Registering a node and bringing it into the fleet.
//
//    register()   validate, check the agent answers with this key, save.
//    provision()  what a new node needs from the panel, in order:
//                   SSH keys + git config → WireGuard mesh → lease claim →
//                   the panel reachable for its gateway → Lavalink.
//
//  provision() never throws: each step reports ok / warn / error on its own, so
//  one missing piece (no Java, GitHub briefly down) does not undo the others.
//  Both ways of adding a node use it — the form runs it in the background, the
//  one-command join (nodeJoin) awaits it so the script can print the outcome.
// ─────────────────────────────────────────────────────────────────────────────

const httpError = (status, message) => Object.assign(new Error(message), { status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const panelPort = () => parseInt(process.env.PORT, 10) || 3000;

/**
 * Save a node after checking its agent answers with this key.
 * `healthAttempts` > 1 waits for an agent that is still starting (join).
 */
const register = async ({ name, host, port, apiKey, controlHost }, { healthAttempts = 1, healthDelayMs = 3000 } = {}) => {
    if (!name || !host || !port || !apiKey) throw httpError(400, "name, host, port, and apiKey are required");

    const parsedPort = parseInt(port, 10);
    if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) throw httpError(400, "Invalid port");

    const existing = await db.findOne("nodes", { host, port: parsedPort });
    if (existing) throw httpError(409, `A node at ${host}:${parsedPort} already exists ("${existing.name}")`);

    // controlHost is included so the health check uses the very address the
    // panel will actually call — testing the public IP and then talking to
    // loopback would validate the wrong path.
    const candidate = { name, host, port: parsedPort, apiKey, controlHost: controlHost || undefined };
    let healthy = false;
    for (let i = 0; i < healthAttempts && !healthy; i++) {
        if (i) await sleep(healthDelayMs);
        healthy = await nodeService.checkNodeHealth(candidate);
    }
    if (!healthy) {
        throw httpError(
            400,
            `Cannot reach the agent at ${host}:${parsedPort} — check that the agent is running, the API key matches, and the firewall allows this panel's IP`,
        );
    }

    const node = await db.create("nodes", {
        name,
        host,
        port: parsedPort,
        apiKey,
        // Optional: address for panel → agent traffic only. host stays the
        // public address (WireGuard endpoint + egress proxy use it).
        ...(controlHost ? { controlHost } : {}),
        enabled: true,
        createdAt: Date.now(),
    });

    // Online right away, so key sync targets it without waiting for the poll.
    nodeService.markOnline(node._id);
    return node;
};

// ── Steps ────────────────────────────────────────────────────────────────────
// Each returns { detail, warn? } or throws; provision() turns that into a step.

const syncKeys = async (node) => {
    const r = await require("./keySyncService").syncAllToNode(node);
    const lines = [r.pushed.length ? `${r.pushed.length} key(s) copied: ${r.pushed.join(", ")}` : "No SSH keys on the panel to copy"];
    for (const f of r.failed) lines.push(`${f.name}: ${f.error}`);
    lines.push(r.gitConfig ? "git config copied" : `git config: ${r.gitConfigError}`);
    return { warn: r.failed.length > 0 || !r.gitConfig, detail: lines.join("\n") };
};

const joinMesh = async (node) => {
    const results = await require("./wgService").syncMesh();
    const mine = results.find((r) => r.nodeId === node._id);
    if (!mine?.ok) {
        const why = mine ? `${mine.stage}: ${mine.error}` : "this node got no WireGuard identity";
        throw new Error(`${why} — is wireguard-tools installed on ${node.name}? Then press "Sync WireGuard" on the Systems page`);
    }
    const others = results.filter((r) => r.nodeId !== node._id && !r.ok);
    const lines = [`Overlay IP ${mine.overlayIp}`];
    if (others.length) {
        lines.push(`Not updated: ${others.map((o) => `${o.node} (${o.error})`).join(", ")} — they learn the new peer on the next sync`);
    }
    return { warn: others.length > 0, detail: lines.join("\n") };
};

const claimLease = async (node) => {
    const r = await panelLease.claim(node);
    if (!r.ok) throw new Error(r.error);
    return { detail: `Epoch ${panelLease.current()}; its panel gateway (127.0.0.1:4201) forwards to ${r.panelUrl || "—"}` };
};

/**
 * Projects on the new node reach the panel through their gateway, which calls
 * the panel over WireGuard (panelLease.panelUrlFor). Let that address through
 * the firewall of the panel's node, then check from the new node.
 */
const openGateway = async (node) => {
    const fresh = (await db.findOne("nodes", { _id: node._id })) || node;
    const panelNode = await nodeService.getNode(nodeService.panelNodeId());
    if (panelNode._id === fresh._id) return { detail: "This node runs the panel — its gateway uses 127.0.0.1" };

    const viaWg = !!(fresh.wgOverlayIp && panelNode.wgOverlayIp);
    const source = viaWg ? fresh.wgOverlayIp : fresh.host;
    const target = { host: viaWg ? panelNode.wgOverlayIp : panelNode.host, port: panelPort() };
    if (!net.isIP(source)) {
        return { warn: true, detail: `${source} is not an IP address — on ${panelNode.name}, allow it to port ${target.port} by hand` };
    }

    const r = await nodeService.agentRequest(panelNode, "post", "/ufw/allow-from", {
        data: { ip: source, port: target.port, ...(viaWg ? { iface: "wg0" } : {}) },
        timeout: 30_000,
    });

    // A fresh WireGuard peer needs a moment for its first handshake.
    let probe = null;
    for (let i = 0; i < 5 && !probe?.ok; i++) {
        if (i) await sleep(3000);
        probe = await nodeService
            .agentRequest(fresh, "post", "/panel-host/probe", { data: { targets: [target] }, timeout: 15_000 })
            .then((p) => p.results?.[0] || { ok: false, error: "no result" })
            .catch((err) => ({ ok: false, error: err.message }));
    }
    const rule = `${panelNode.name}: ${r.message}`;
    if (!probe.ok) {
        return { warn: true, detail: `${rule}\nBut ${fresh.name} cannot reach ${target.host}:${target.port} yet (${probe.error || "no answer"})` };
    }
    return { detail: `${rule}\n${fresh.name} reaches the panel at ${target.host}:${target.port}` };
};

const installLavalink = async (node) => {
    const settings = await require("./lavalinkStore").get();
    if (!settings.enabled) return { detail: "Lavalink is disabled in the panel settings — skipped" };
    if (!settings.autoInstallOnNewNode) return { detail: "Auto-install on new nodes is off — install it from the Lavalink page" };
    const r = await require("./lavalinkService").installOnNode(node);
    if (!r.ok) return { warn: true, detail: `${r.error || r.skipped || "Not installed"} — the Lavalink page offers Install` };
    return { detail: `Lavalink ${r.version} ${r.started ? "running" : "installed"}` };
};

const STEPS = [
    ["SSH keys and git config", syncKeys],
    ["WireGuard mesh", joinMesh],
    ["Follow this panel (lease)", claimLease],
    ["Panel reachable for the panel gateway", openGateway],
    ["Lavalink", installLavalink],
];

/**
 * Run every step against a freshly registered node. `onStep(steps)` is called
 * (and awaited) whenever a step starts or ends — the join flow saves progress
 * there for the page that is watching. Returns [{ label, status, detail }].
 */
const provision = async (node, { onStep = async () => {} } = {}) => {
    const steps = [];
    // Progress is a courtesy to the watcher; failing to record it must not stop the work.
    const report = () => Promise.resolve().then(() => onStep(steps)).catch((err) => console.warn("[Nodes] progress:", err.message));
    for (const [label, fn] of STEPS) {
        const s = { label, status: "running", detail: null };
        steps.push(s);
        await report();
        try {
            const r = (await fn(node)) || {};
            s.status = r.warn ? "warn" : "ok";
            s.detail = r.detail || null;
        } catch (err) {
            s.status = "error";
            s.detail = err.message;
        }
        await report();
    }
    return steps;
};

module.exports = { register, provision };
