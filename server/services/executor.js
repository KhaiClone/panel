const fs = require("fs");

const nodeService = require("./nodeService");

// ─────────────────────────────────────────────────────────────────────────────
//  Executor — every bot operation, on every node, through one code path.
//
//  The panel is a control plane: it runs no pm2, no git, no nginx, no shell.
//  Each project lives on a node, and the node's agent does the work — including
//  the node the panel itself runs on, which is an ordinary node like any other.
//
//  A project is addressed one of two ways, decided solely by its record:
//    source === "local" with a localPath → { absPath }   (agent checks EXTRA_ROOTS)
//    anything else                       → { root, dir }  ({root}/{buyerID}/{botID})
//  `target(bot)` is the single place that decision is made.
// ─────────────────────────────────────────────────────────────────────────────

// Git-cloned projects live at {root}/{buyerID}/{botID} on their node
const relDir = (bot) => `${bot.buyerID}/${bot.botID}`;
const rootOf = (bot) => (bot.projectType === "website" ? "sites" : "bots");

/**
 * How the agent should locate this project. Spread into any agent call that
 * addresses a directory — the two conventions are interchangeable to callers.
 */
const target = (bot) =>
    bot.source === "local" && bot.localPath
        ? { absPath: bot.localPath }
        : { root: rootOf(bot), dir: relDir(bot) };

const agentCall = async (bot, method, urlPath, opts = {}) => {
    const node = await nodeService.getNode(bot.nodeId);
    return nodeService.agentRequest(node, method, urlPath, opts);
};

/** Base URL for the raw-stream calls below, honouring controlHost like agentRequest. */
const agentUrl = (node, urlPath) =>
    `http://${node.controlHost || node.host}:${node.port}${urlPath}`;

// ─────────────────────────────────────────────────────────────────────────────
//  PM2 control
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Egress proxy: route a bot's outbound traffic through its assigned VPS
 * (bot.egressNodeId) via that node's agent CONNECT proxy, so the bot's public IP
 * follows the chosen VPS no matter which node runs the process. null = egress from
 * the run host directly (native IP). proxychains4 on the run host applies it.
 *
 * Uses node.host, never controlHost: the tunnel is opened from the RUN host, so
 * it needs the egress node's address as seen from another machine.
 */
const buildEgressProxyConf = async (bot) => {
    const egressId = bot.egressNodeId;
    if (!egressId) return null;
    try {
        // Egress node == the node the bot already runs on → native IP, no tunnel needed.
        if (nodeService.resolveNodeId(egressId) === nodeService.resolveNodeId(bot.nodeId)) return null;
        const node = await nodeService.getNode(egressId);
        if (!node) return null;
        return {
            type: "http",
            host: node.host,
            port: node.port,
            username: "proxy",
            password: node.apiKey,
        };
    } catch (err) {
        console.warn(`[Egress] bot ${bot.pm2Name} node ${egressId}: ${err.message}`);
        return null;
    }
};

const startBot = async (bot) => {
    const proxyConf = await buildEgressProxyConf(bot);
    const data = await agentCall(bot, "post", "/pm2/start", {
        data: {
            pm2Name: bot.pm2Name,
            ...target(bot),
            startCommand: bot.startScript,
            maxMemory: bot.maxMemory || null,
            proxyConf,
        },
        timeout: 60_000,
    });
    return data.output;
};

const stopBot = async (bot) => {
    const data = await agentCall(bot, "post", "/pm2/stop", { data: { pm2Name: bot.pm2Name }, timeout: 60_000 });
    return data.output;
};

const restartBot = async (bot) => {
    const data = await agentCall(bot, "post", "/pm2/restart", { data: { pm2Name: bot.pm2Name }, timeout: 60_000 });
    return data.output;
};

const deleteBot = async (bot) => {
    const data = await agentCall(bot, "post", "/pm2/delete", { data: { pm2Name: bot.pm2Name }, timeout: 60_000 });
    return data.output;
};

const setMemoryLimit = async (bot, maxMemory) => {
    const data = await agentCall(bot, "post", "/pm2/memory-limit", {
        data: { pm2Name: bot.pm2Name, maxMemory },
        timeout: 60_000,
    });
    return data.output;
};

const OFFLINE_STATUS = { status: "node-offline", cpu: 0, memory: 0, restarts: 0, uptime: null };
const STOPPED_STATUS = { status: "stopped", cpu: 0, memory: 0, restarts: 0, uptime: null };

const statusFromList = (list, pm2Name) => {
    const proc = list.find((p) => p.name === pm2Name);
    if (!proc) return { ...STOPPED_STATUS };
    return {
        status: proc.pm2_env.status,
        cpu: proc.monit?.cpu ?? 0,
        memory: proc.monit?.memory ?? 0,
        restarts: proc.pm2_env.restart_time ?? 0,
        uptime: proc.pm2_env.pm_uptime ?? null,
    };
};

const getBotStatus = async (bot, cachedList = null) => {
    // Reuse a pre-fetched list for this node (see getStatusResolver)
    if (cachedList) return statusFromList(cachedList, bot.pm2Name);
    try {
        return await agentCall(bot, "get", `/pm2/status/${encodeURIComponent(bot.pm2Name)}`, { timeout: 10_000 });
    } catch {
        // Node unreachable — report as such instead of failing the whole request
        return { ...OFFLINE_STATUS };
    }
};

/**
 * Fetch the PM2 process list of every node referenced by `bots` (one request
 * per node) and return a lookup: bot → cached list for that bot's node.
 * Unreachable nodes yield null (getBotStatus then reports "node-offline").
 */
const getStatusResolver = async (bots) => {
    const idOf = (bot) => {
        try {
            return nodeService.resolveNodeId(bot.nodeId);
        } catch {
            return null; // PANEL_NODE_ID unset — surfaces as node-offline
        }
    };

    const nodeIds = [...new Set(bots.map(idOf).filter(Boolean))];

    // static+domain websites are "online" when their nginx config exists — batch
    // that lookup too (one /nginx/list per node that actually hosts one)
    const isNginxStatusBot = (b) =>
        b.projectType === "website" && b.websiteConfig?.mode === "static" && b.websiteConfig?.domain;
    const nginxNodeIds = new Set(bots.filter(isNginxStatusBot).map(idOf).filter(Boolean));

    const pm2Lists = new Map();
    const nginxLists = new Map();
    await Promise.all(
        nodeIds.map(async (nodeId) => {
            try {
                const node = await nodeService.getNode(nodeId);
                const [pm2Data, nginxData] = await Promise.all([
                    nodeService.agentRequest(node, "get", "/pm2/list", { timeout: 10_000 }),
                    nginxNodeIds.has(nodeId)
                        ? nodeService.agentRequest(node, "get", "/nginx/list", { timeout: 10_000 }).catch(() => null)
                        : Promise.resolve(null),
                ]);
                pm2Lists.set(nodeId, pm2Data.processes || []);
                nginxLists.set(nodeId, nginxData ? nginxData.configs || [] : null);
            } catch {
                pm2Lists.set(nodeId, null);
                nginxLists.set(nodeId, null);
            }
        }),
    );

    return {
        listFor: (bot) => pm2Lists.get(idOf(bot)) ?? null,
        nginxListFor: (bot) => nginxLists.get(idOf(bot)) ?? null,
        statusFor: async (bot) => {
            const list = pm2Lists.get(idOf(bot));
            if (!list) return { ...OFFLINE_STATUS };
            return statusFromList(list, bot.pm2Name);
        },
    };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Git / install
// ─────────────────────────────────────────────────────────────────────────────

/** Clone on the target node. Params come from the not-yet-created record. */
const cloneRepo = async (ref, repoUrl, branch) => {
    const data = await agentCall(ref, "post", "/git/clone", {
        data: { repoUrl, branch, root: rootOf(ref), dir: relDir(ref) },
        timeout: 130_000,
    });
    return data.output;
};

const pullRepo = async (bot) => {
    const data = await agentCall(bot, "post", "/git/pull", {
        data: { ...target(bot) },
        timeout: 130_000,
    });
    return data.output;
};

/** origin URL + branch of the project's checkout (nulls when not a repo). */
const gitInfo = async (bot) => {
    try {
        return await agentCall(bot, "get", "/git/info", { params: target(bot), timeout: 30_000 });
    } catch {
        return { repoUrl: null, branch: null };
    }
};

const installDeps = async (bot, installCommand) => {
    const data = await agentCall(bot, "post", "/git/install", {
        data: { ...target(bot), installCommand },
        timeout: 610_000,
    });
    return data.output;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Files
// ─────────────────────────────────────────────────────────────────────────────

const fsParams = (bot, sub) => ({ ...target(bot), path: sub || "" });

const fsList = async (bot, sub) =>
    agentCall(bot, "get", "/fs/list", { params: fsParams(bot, sub) });

const fsRead = async (bot, sub, binary = false) =>
    agentCall(bot, "get", "/fs/read", { params: { ...fsParams(bot, sub), binary: binary ? "true" : "false" } });

const fsWrite = async (bot, sub, content, binary = false) =>
    agentCall(bot, "put", "/fs/write", { data: { ...fsParams(bot, sub), content, binary } });

const fsCreate = async (bot, sub, isDir) =>
    agentCall(bot, "post", "/fs/create", { data: { ...fsParams(bot, sub), isDir } });

const fsDelete = async (bot, sub) =>
    agentCall(bot, "delete", "/fs/delete", { params: fsParams(bot, sub) });

const fsRename = async (bot, from, to) =>
    agentCall(bot, "put", "/fs/rename", { data: { ...target(bot), from, to } });

const fsExists = async (bot) => {
    const data = await agentCall(bot, "get", "/fs/exists", { params: target(bot) });
    return data.exists === true;
};

/** Returns an axios stream response for piping a download to the client. */
const fsDownloadStream = async (bot, sub) => {
    const node = await nodeService.getNode(bot.nodeId);
    const axios = require("axios");
    return axios({
        method: "get",
        url: agentUrl(node, "/fs/download"),
        params: fsParams(bot, sub),
        headers: { "x-agent-key": node.apiKey },
        responseType: "stream",
        timeout: 120_000,
    });
};

const fsUpload = async (bot, sub, fileBuffer, fileName) => {
    const FormData = require("form-data");
    const form = new FormData();
    for (const [k, v] of Object.entries(target(bot))) form.append(k, v);
    form.append("path", sub || "");
    form.append("file", fileBuffer, { filename: fileName });

    const node = await nodeService.getNode(bot.nodeId);
    const axios = require("axios");
    const res = await axios.post(agentUrl(node, "/fs/upload"), form, {
        headers: { ...form.getHeaders(), "x-agent-key": node.apiKey },
        timeout: 120_000,
        maxContentLength: 200 * 1024 * 1024,
        maxBodyLength: 200 * 1024 * 1024,
    });
    return res.data;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Migration — archive a project's working dir on one node, restore on another.
//  The panel is the hub: archive → temp file on panel → extract. Archives folder
//  CONTENTS (name-independent), so source and target dirs may differ in name.
// ─────────────────────────────────────────────────────────────────────────────

// Environment dirs that the install step recreates on the target — carrying
// them across machines wastes bandwidth and (for venv) bakes in stale absolute
// paths that break the interpreter. Always safe to drop when we reinstall.
const REBUILDABLE_DIRS = ["node_modules", "venv", ".venv", "__pycache__"];

/** Stream the project's working dir into `tmpPath` as tar.gz. */
const archiveToFile = async (ref, tmpPath, { excludeNodeModules = true } = {}) => {
    const excludes = excludeNodeModules ? [...REBUILDABLE_DIRS, ".pm2"] : [".pm2"];

    const node = await nodeService.getNode(ref.nodeId);
    const axios = require("axios");
    const res = await axios({
        method: "get",
        url: agentUrl(node, "/fs/archive"),
        params: { ...target(ref), exclude: excludes.join(",") },
        headers: { "x-agent-key": node.apiKey },
        responseType: "stream",
        timeout: 0,
    });
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmpPath);
        res.data.pipe(out);
        res.data.on("error", reject);
        out.on("error", reject);
        out.on("finish", resolve);
    });
};

/** Restore a tar.gz temp file into the project's working dir on `ref`'s node. */
const extractFromFile = async (ref, tmpPath, { clear = true } = {}) => {
    const node = await nodeService.getNode(ref.nodeId);
    const axios = require("axios");
    await axios({
        method: "post",
        url: agentUrl(node, "/fs/extract"),
        params: { ...target(ref), clear: clear ? "true" : "false" },
        headers: { "x-agent-key": node.apiKey, "Content-Type": "application/gzip" },
        data: fs.createReadStream(tmpPath),
        timeout: 0,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });
};

/** Delete the project's whole folder on its node. */
const removeBotFiles = async (bot) => {
    await fsDelete(bot, "");
};

// ─────────────────────────────────────────────────────────────────────────────
//  Website infra — nginx + UFW on whichever node the project lives.
//
//  distFolder is always passed in its stored (relative) form: the agent
//  resolves it inside the project dir, so panel-side absolute paths never
//  reach the node.
// ─────────────────────────────────────────────────────────────────────────────

const nginxWriteConfig = async (bot, { mode, port, apiPort, distFolder, domain, extraConfig }) => {
    await agentCall(bot, "post", "/nginx/config", {
        data: {
            pm2Name: bot.pm2Name,
            ...target(bot),
            mode, port, apiPort, domain, extraConfig,
            distFolder: distFolder || "",
        },
        timeout: 30_000,
    });
};

const nginxRemoveConfig = async (bot) => {
    await agentCall(bot, "delete", `/nginx/config/${encodeURIComponent(bot.pm2Name)}`, { timeout: 30_000 })
        .catch(() => { /* best-effort — a missing config is not an error */ });
};

/**
 * Does the bot's nginx config exist on its node?
 * Returns null when the node is unreachable (callers report "node-offline").
 * `cachedConfigList` comes from getStatusResolver().nginxListFor(bot).
 */
const nginxConfigExists = async (bot, cachedConfigList) => {
    if (Array.isArray(cachedConfigList)) return cachedConfigList.includes(bot.pm2Name);
    if (cachedConfigList === null) return null; // node was unreachable during batch fetch
    try {
        const data = await agentCall(bot, "get", `/nginx/config/${encodeURIComponent(bot.pm2Name)}/exists`, { timeout: 10_000 });
        return data.exists === true;
    } catch {
        return null;
    }
};

const nginxEnableSSL = async (bot, domain, email = null) => {
    await agentCall(bot, "post", "/nginx/ssl", { data: { domain, email }, timeout: 130_000 });
};

const ufwOpenPort = async (bot, port) => {
    await agentCall(bot, "post", "/ufw/open", { data: { port }, timeout: 20_000 });
};

const ufwClosePort = async (bot, port) => {
    await agentCall(bot, "post", "/ufw/close", { data: { port }, timeout: 20_000 })
        .catch(() => { /* rule may not exist / node offline — same silence as before */ });
};

/** Find a free port on a node — called at create time, before a record exists. */
const findFreePortOn = async (nodeId, start = 3000, end = 9000) => {
    const node = await nodeService.getNode(nodeId);
    const data = await nodeService.agentRequest(node, "get", "/ufw/free-port", {
        params: { start, end },
        timeout: 20_000,
    });
    return data.port;
};

/** Serve a static site with http-server (PM2) on the bot's node. */
const startHttpServer = async (bot, distFolder, port) => {
    const data = await agentCall(bot, "post", "/pm2/start-static", {
        data: {
            pm2Name: bot.pm2Name,
            ...target(bot),
            distFolder: distFolder || "",
            port,
        },
        timeout: 60_000,
    });
    return data.output;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Logs
// ─────────────────────────────────────────────────────────────────────────────

const getBotLogs = async (bot, lines = 100) => {
    const data = await agentCall(bot, "get", `/logs/${encodeURIComponent(bot.pm2Name)}`, {
        params: { lines },
        timeout: 30_000,
    });
    return data.logs;
};

/**
 * Open a live log stream for a bot. Returns the axios response whose `.data` is
 * a readable stream of the agent's SSE bytes — already in SSE format, so the
 * route can pipe it straight through to the browser.
 */
const streamBotLogs = async (bot, lines = 50) => {
    const node = await nodeService.getNode(bot.nodeId);
    const axios = require("axios");
    return axios({
        method: "get",
        url: agentUrl(node, `/logs/${encodeURIComponent(bot.pm2Name)}/stream`),
        params: { lines },
        headers: { "x-agent-key": node.apiKey },
        responseType: "stream",
        // No timeout — SSE stays open until either side closes
        timeout: 0,
    });
};

const flushBotLogs = async (bot) => {
    await agentCall(bot, "delete", `/logs/${encodeURIComponent(bot.pm2Name)}`, { timeout: 30_000 });
};

/** Flush every process's logs on a node (used when a project is removed). */
const flushAllLogsOn = async (nodeId) => {
    const node = await nodeService.getNode(nodeId);
    await nodeService.agentRequest(node, "post", "/pm2/flush", { timeout: 30_000 }).catch(() => {});
};

module.exports = {
    relDir,
    rootOf,
    target,
    buildEgressProxyConf,
    startBot,
    stopBot,
    restartBot,
    deleteBot,
    setMemoryLimit,
    getBotStatus,
    getStatusResolver,
    cloneRepo,
    pullRepo,
    installDeps,
    gitInfo,
    fsList,
    fsRead,
    fsWrite,
    fsCreate,
    fsDelete,
    fsRename,
    fsExists,
    fsDownloadStream,
    fsUpload,
    archiveToFile,
    extractFromFile,
    removeBotFiles,
    nginxWriteConfig,
    nginxRemoveConfig,
    nginxConfigExists,
    nginxEnableSSL,
    ufwOpenPort,
    ufwClosePort,
    findFreePortOn,
    startHttpServer,
    getBotLogs,
    streamBotLogs,
    streamRemoteLogs: streamBotLogs, // legacy alias — routes/logs.js still uses it
    flushBotLogs,
    flushAllLogsOn,
    REBUILDABLE_DIRS,
};
