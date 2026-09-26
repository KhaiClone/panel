const nodeService = require("./nodeService");

// ─────────────────────────────────────────────────────────────────────────────
//  Panel self-management — a thin client over the agent on the panel's own node.
//
//  The panel runs no shell. Everything it needs done to itself (read its .env,
//  restart, rebuild, rotate logs, publish its own vhost) is asked of the agent
//  living on the same machine, through the very same API used for every other
//  node. That agent must have PANEL_DIR set; without it these endpoints answer
//  503 and say so.
//
//  A side benefit over the old in-process version: the panel no longer has to
//  `pm2 restart` the process it is itself running in.
// ─────────────────────────────────────────────────────────────────────────────

/** The node record for the machine this panel runs on. */
const panelNode = () => nodeService.getNode(nodeService.panelNodeId());

const call = async (method, urlPath, opts = {}) =>
    nodeService.agentRequest(await panelNode(), method, urlPath, opts);

/** PM2 name of the panel, as the agent reports it. */
const getPanelPM2Name = async () => {
    const data = await call("get", "/self/panel-status", { timeout: 15_000 });
    return data.pm2Name;
};

/**
 * Panel status in the shape the Panel page has always consumed:
 * { env, git, pm2 }. The agent reports flat fields, so the reshaping happens
 * here rather than in the route — the API contract must not shift just because
 * the work moved from an exec to an HTTP call.
 */
const getPanelStatus = async () => {
    const d = await call("get", "/self/panel-status", { timeout: 15_000 });
    return {
        env: {
            version: d.version || "?",
            // NODE_ENV belongs to this process, not to the agent's.
            isDev: process.env.NODE_ENV === "development",
        },
        git: { commitHash: d.commit || null, branch: d.branch || null },
        pm2: {
            name: d.pm2Name,
            status: d.status || "unknown",
            monit: { cpu: d.cpu ?? 0, memory: d.memory ?? 0 },
            pm_uptime: d.uptime ?? null,
            restarts: d.restarts ?? 0,
            pm_id: null,
        },
        panelDir: d.panelDir,
    };
};

const getPanelLogs = async (lines = 100) => {
    const data = await call("get", "/self/panel-logs", { params: { lines }, timeout: 30_000 });
    return data.logs;
};

const restartPanel = () => call("post", "/self/panel-restart", { timeout: 15_000 });

/**
 * git pull → deps → client build → dependency check → restart.
 * The agent only restarts when every step succeeded, so a failed build leaves
 * the running panel untouched. Generous timeout: a vite build takes minutes.
 */
const rebuildPanel = async () => {
    try {
        return await call("post", "/self/rebuild-app", { timeout: 600_000 });
    } catch (err) {
        // The agent answers 500 with the build output on failure — surface that
        // rather than a bare transport error, the output is what's useful.
        if (err.status === 409 || err.status === 500) {
            return { success: false, buildOutput: "", message: err.message };
        }
        throw err;
    }
};

// ── Every node's agent — the first half of a panel update ───────────────────

const AGENT_BACK_TIMEOUT_MS = 90_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve true once the node's agent answers from a process started after
 * `since`. Plain health is not enough: /self/update restarts the agent 500ms
 * AFTER answering, so the old process is still there to say "ok".
 */
const waitForAgentRestart = async (node, since) => {
    const deadline = Date.now() + AGENT_BACK_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await sleep(2000);
        try {
            const h = await nodeService.agentRequest(node, "get", "/health", { timeout: 5000 });
            if (h?.ok && h.uptime * 1000 < Date.now() - since) return true;
        } catch { /* mid-restart */ }
    }
    return false;
};

/** One node: pull + install + restart through /self/update, then wait for it. */
const updateAgent = async (node, isPanelNode) => {
    const base = { nodeId: node._id, name: node.name, isPanelNode };
    // An unreachable node would hold the whole update until the 400s timeout.
    if (!(await nodeService.checkNodeHealth(node))) {
        return { ...base, ok: false, message: "Offline — skipped" };
    }

    const since = Date.now();
    let result;
    try {
        result = await nodeService.agentRequest(node, "post", "/self/update", { timeout: 400_000 });
    } catch (err) {
        return { ...base, ok: false, message: err.message };
    }

    // The panel's node shares its checkout with the panel, so a previous panel
    // Rebuild may have pulled agent code this process never loaded — "already
    // up to date" does not mean it runs the current code. Restart it anyway.
    const pulled = !!result.restarting;
    if (!pulled && isPanelNode) {
        try {
            await nodeService.agentRequest(node, "post", "/self/restart", { timeout: 15_000 });
        } catch (err) {
            return { ...base, ok: false, message: err.message };
        }
    }
    if (!pulled && !isPanelNode) return { ...base, ok: true, message: "Already up to date" };

    if (!(await waitForAgentRestart(node, since))) {
        return { ...base, ok: false, message: `Restarted but did not answer within ${AGENT_BACK_TIMEOUT_MS / 1000}s` };
    }
    return { ...base, ok: true, message: pulled ? "Updated and restarted" : "Up to date — restarted to load the current code" };
};

let _agentsUpdating = false;

/**
 * Update the agent on every node, all at once. Uses only the long-standing
 * /self/update, /self/restart and /health, so it works whatever agent version
 * a node is running. Must finish before the panel is rebuilt: a newer panel
 * can call endpoints an older agent does not have.
 */
const updateAgents = async () => {
    if (_agentsUpdating) {
        const err = new Error("Agents are already being updated — wait for it to finish.");
        err.status = 409;
        throw err;
    }
    _agentsUpdating = true;
    try {
        const panelId = nodeService.panelNodeId();
        const nodes = await nodeService.getNodes();
        return await Promise.all(nodes.map((node) => updateAgent(node, node._id === panelId)));
    } finally {
        _agentsUpdating = false;
    }
};

// ── The panel's own .env, read and written through the agent ─────────────────

const readEnv = async () => {
    const data = await call("get", "/self/env", { timeout: 15_000 });
    return data.content || "";
};

/** Returns { backup } — the agent keeps the previous file as .env.bak-<ts>. */
const writeEnv = (content) => call("put", "/self/env", { data: { content }, timeout: 15_000 });

// ── pm2-logrotate on the panel's node ───────────────────────────────────────

const logrotateStatus = () => call("get", "/logrotate", { timeout: 20_000 });
const logrotateInstall = () => call("post", "/logrotate/install", { timeout: 200_000 });
const logrotateSet = (settings) => call("put", "/logrotate", { data: settings, timeout: 60_000 });

// ── The panel's own nginx vhost ─────────────────────────────────────────────

const writePanelVhost = (domains, port) =>
    call("post", "/nginx/panel-config", { data: { domains, port }, timeout: 60_000 });

const enablePanelSSL = (domain, email = null) =>
    call("post", "/nginx/ssl", { data: { domain, email }, timeout: 130_000 });

module.exports = {
    getPanelPM2Name,
    getPanelStatus,
    getPanelLogs,
    restartPanel,
    rebuildPanel,
    updateAgents,
    readEnv,
    writeEnv,
    logrotateStatus,
    logrotateInstall,
    logrotateSet,
    writePanelVhost,
    enablePanelSSL,
};
