const path = require("path");
const fs = require("fs");

const pm2Service = require("./pm2Service");
const gitService = require("./gitService");
const nodeService = require("./nodeService");

// ─────────────────────────────────────────────────────────────────────────────
//  Executor — routes every bot operation to the right VPS.
//
//  bot.nodeId === "local" (or missing) → call local services, exactly as the
//  panel always has. Any other nodeId → forward to that node's agent over HTTP.
//
//  Remote placement is only supported for plain PM2 projects (Discord bots).
//  Websites/services depend on nginx/UFW/DNS on the panel VPS and stay local —
//  the scheduler enforces that; the executor just trusts bot.nodeId.
// ─────────────────────────────────────────────────────────────────────────────

const isRemote = (bot) => !!bot.nodeId && bot.nodeId !== nodeService.LOCAL_NODE_ID;

// Remote bots are always git-cloned to {root}/{buyerID}/{botID} on their node
const relDir = (bot) => `${bot.buyerID}/${bot.botID}`;
const rootOf = (bot) => (bot.projectType === "website" ? "sites" : "bots");

/** Local working directory — same rules as routes/bots.js botDir(). */
const localBotDir = (bot) => {
    if (bot.source === "local" && bot.localPath) return bot.localPath;
    const root = bot.projectType === "website"
        ? (process.env.SITES_ROOT_DIR || process.env.BOTS_ROOT_DIR)
        : process.env.BOTS_ROOT_DIR;
    return path.join(root, bot.buyerID, bot.botID);
};

const agentCall = async (bot, method, urlPath, opts = {}) => {
    const node = await nodeService.getNode(bot.nodeId);
    return nodeService.agentRequest(node, method, urlPath, opts);
};

// ─────────────────────────────────────────────────────────────────────────────
//  PM2 control
// ─────────────────────────────────────────────────────────────────────────────

const startBot = async (bot, proxyConf = null) => {
    if (!isRemote(bot)) {
        return pm2Service.startBot(bot.pm2Name, localBotDir(bot), bot.startScript, bot.maxMemory || null, proxyConf);
    }
    const data = await agentCall(bot, "post", "/pm2/start", {
        data: {
            pm2Name: bot.pm2Name,
            root: rootOf(bot),
            dir: relDir(bot),
            startCommand: bot.startScript,
            maxMemory: bot.maxMemory || null,
            proxyConf,
        },
        timeout: 60_000,
    });
    return data.output;
};

const stopBot = async (bot) => {
    if (!isRemote(bot)) return pm2Service.stopBot(bot.pm2Name);
    const data = await agentCall(bot, "post", "/pm2/stop", { data: { pm2Name: bot.pm2Name }, timeout: 60_000 });
    return data.output;
};

const restartBot = async (bot) => {
    if (!isRemote(bot)) return pm2Service.restartBot(bot.pm2Name);
    const data = await agentCall(bot, "post", "/pm2/restart", { data: { pm2Name: bot.pm2Name }, timeout: 60_000 });
    return data.output;
};

const deleteBot = async (bot) => {
    if (!isRemote(bot)) return pm2Service.deleteBot(bot.pm2Name);
    const data = await agentCall(bot, "post", "/pm2/delete", { data: { pm2Name: bot.pm2Name }, timeout: 60_000 });
    return data.output;
};

const setMemoryLimit = async (bot, maxMemory) => {
    if (!isRemote(bot)) return pm2Service.setMemoryLimit(bot.pm2Name, maxMemory);
    const data = await agentCall(bot, "post", "/pm2/memory-limit", {
        data: { pm2Name: bot.pm2Name, maxMemory },
        timeout: 60_000,
    });
    return data.output;
};

const getBotStatus = async (bot, cachedList = null) => {
    if (!isRemote(bot)) return pm2Service.getBotStatus(bot.pm2Name, cachedList);
    if (cachedList) {
        // Reuse a pre-fetched list for this node (see getStatusResolver)
        const proc = cachedList.find((p) => p.name === bot.pm2Name);
        if (!proc) return { status: "stopped", cpu: 0, memory: 0, restarts: 0, uptime: null };
        return {
            status: proc.pm2_env.status,
            cpu: proc.monit?.cpu ?? 0,
            memory: proc.monit?.memory ?? 0,
            restarts: proc.pm2_env.restart_time ?? 0,
            uptime: proc.pm2_env.pm_uptime ?? null,
        };
    }
    try {
        return await agentCall(bot, "get", `/pm2/status/${encodeURIComponent(bot.pm2Name)}`, { timeout: 10_000 });
    } catch {
        // Node unreachable — report as such instead of failing the whole request
        return { status: "node-offline", cpu: 0, memory: 0, restarts: 0, uptime: null };
    }
};

/**
 * Fetch the PM2 process list of every node referenced by `bots` (one request
 * per node) and return a lookup: botId → cached list for that bot's node.
 * Unreachable nodes yield null (getBotStatus then reports "node-offline").
 */
const getStatusResolver = async (bots) => {
    const localList = await pm2Service.getProcessList();
    const remoteNodeIds = [...new Set(bots.filter(isRemote).map((b) => b.nodeId))];

    const remoteLists = new Map();
    await Promise.all(
        remoteNodeIds.map(async (nodeId) => {
            try {
                const node = await nodeService.getNode(nodeId);
                const data = await nodeService.agentRequest(node, "get", "/pm2/list", { timeout: 10_000 });
                remoteLists.set(nodeId, data.processes || []);
            } catch {
                remoteLists.set(nodeId, null);
            }
        }),
    );

    return {
        localList,
        listFor: (bot) => (isRemote(bot) ? remoteLists.get(bot.nodeId) ?? null : localList),
        statusFor: async (bot) => {
            const list = isRemote(bot) ? remoteLists.get(bot.nodeId) : localList;
            if (isRemote(bot) && list === null) {
                return { status: "node-offline", cpu: 0, memory: 0, restarts: 0, uptime: null };
            }
            return getBotStatus(bot, list);
        },
    };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Git / install
// ─────────────────────────────────────────────────────────────────────────────

/** Clone on the target node. Remote params come from the not-yet-created record. */
const cloneRepo = async ({ nodeId, buyerID, botID, projectType }, repoUrl, branch) => {
    const fakeBot = { nodeId, buyerID, botID, projectType };
    if (!isRemote(fakeBot)) {
        throw new Error("cloneRepo via executor is remote-only — local create keeps its own flow");
    }
    const data = await agentCall(fakeBot, "post", "/git/clone", {
        data: { repoUrl, branch, root: rootOf(fakeBot), dir: relDir(fakeBot) },
        timeout: 130_000,
    });
    return data.output;
};

const pullRepo = async (bot) => {
    if (!isRemote(bot)) return gitService.pullRepo(localBotDir(bot));
    const data = await agentCall(bot, "post", "/git/pull", {
        data: { root: rootOf(bot), dir: relDir(bot) },
        timeout: 130_000,
    });
    return data.output;
};

const installDeps = async (bot, installCommand) => {
    if (!isRemote(bot)) return gitService.installDeps(localBotDir(bot), installCommand);
    const data = await agentCall(bot, "post", "/git/install", {
        data: { root: rootOf(bot), dir: relDir(bot), installCommand },
        timeout: 610_000,
    });
    return data.output;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Files (remote relays — local fs stays inline in routes/bots.js)
// ─────────────────────────────────────────────────────────────────────────────

const fsParams = (bot, sub) => ({ root: rootOf(bot), dir: relDir(bot), path: sub || "" });

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
    agentCall(bot, "put", "/fs/rename", { data: { root: rootOf(bot), dir: relDir(bot), from, to } });

/** Returns an axios stream response for piping a remote download to the client. */
const fsDownloadStream = async (bot, sub) => {
    const node = await nodeService.getNode(bot.nodeId);
    const axios = require("axios");
    return axios({
        method: "get",
        url: `http://${node.host}:${node.port}/fs/download`,
        params: fsParams(bot, sub),
        headers: { "x-agent-key": node.apiKey },
        responseType: "stream",
        timeout: 120_000,
    });
};

const fsUpload = async (bot, sub, fileBuffer, fileName) => {
    const FormData = require("form-data");
    const form = new FormData();
    form.append("root", rootOf(bot));
    form.append("dir", relDir(bot));
    form.append("path", sub || "");
    form.append("file", fileBuffer, { filename: fileName });

    const node = await nodeService.getNode(bot.nodeId);
    const axios = require("axios");
    const res = await axios.post(`http://${node.host}:${node.port}/fs/upload`, form, {
        headers: { ...form.getHeaders(), "x-agent-key": node.apiKey },
        timeout: 120_000,
        maxContentLength: 200 * 1024 * 1024,
        maxBodyLength: 200 * 1024 * 1024,
    });
    return res.data;
};

/** Delete the bot's whole folder on its node (remote equivalent of rmSync(botDir)). */
const removeBotFiles = async (bot) => {
    if (!isRemote(bot)) {
        const dir = localBotDir(bot);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        return;
    }
    await fsDelete(bot, "");
};

// ─────────────────────────────────────────────────────────────────────────────
//  Logs
// ─────────────────────────────────────────────────────────────────────────────

const getBotLogs = async (bot, lines = 100) => {
    if (!isRemote(bot)) return pm2Service.getBotLogs(bot.pm2Name, lines);
    const data = await agentCall(bot, "get", `/logs/${encodeURIComponent(bot.pm2Name)}`, {
        params: { lines },
        timeout: 30_000,
    });
    return data.logs;
};

/**
 * Open a live log stream for a remote bot. Returns the axios response whose
 * `.data` is a readable stream of the agent's SSE bytes — already in SSE
 * format, so the route can pipe it straight through to the browser.
 */
const streamRemoteLogs = async (bot, lines = 50) => {
    const node = await nodeService.getNode(bot.nodeId);
    const axios = require("axios");
    return axios({
        method: "get",
        url: `http://${node.host}:${node.port}/logs/${encodeURIComponent(bot.pm2Name)}/stream`,
        params: { lines },
        headers: { "x-agent-key": node.apiKey },
        responseType: "stream",
        // No timeout — SSE stays open until either side closes
        timeout: 0,
    });
};

const flushBotLogs = async (bot) => {
    if (!isRemote(bot)) return pm2Service.flushBotLogs(bot.pm2Name);
    await agentCall(bot, "delete", `/logs/${encodeURIComponent(bot.pm2Name)}`, { timeout: 30_000 });
};

module.exports = {
    isRemote,
    relDir,
    rootOf,
    localBotDir,
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
    fsList,
    fsRead,
    fsWrite,
    fsCreate,
    fsDelete,
    fsRename,
    fsDownloadStream,
    fsUpload,
    removeBotFiles,
    getBotLogs,
    streamRemoteLogs,
    flushBotLogs,
};
