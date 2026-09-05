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

const getPanelStatus = () => call("get", "/self/panel-status", { timeout: 15_000 });

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
    readEnv,
    writeEnv,
    logrotateStatus,
    logrotateInstall,
    logrotateSet,
    writePanelVhost,
    enablePanelSSL,
};
