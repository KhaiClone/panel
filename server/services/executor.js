const path = require("path");
const fs = require("fs");

const pm2Service = require("./pm2Service");
const gitService = require("./gitService");
const nodeService = require("./nodeService");
const nginxService = require("./nginxService");
const ufwService = require("./ufwService");

// ─────────────────────────────────────────────────────────────────────────────
//  Executor — routes every bot operation to the right VPS.
//
//  bot.nodeId === "local" (or missing) → call local services, exactly as the
//  panel always has. Any other nodeId → forward to that node's agent over HTTP.
//
//  Websites/services work on remote nodes too (agent ≥ 1.1.0 exposes
//  nginx/UFW); auto-placement still prefers local — see schedulerService.
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

    // static+domain websites are "online" when their nginx config exists — batch
    // that lookup too (one /nginx/list per node that actually hosts one)
    const isNginxStatusBot = (b) =>
        b.projectType === "website" && b.websiteConfig?.mode === "static" && b.websiteConfig?.domain;
    const nginxNodeIds = new Set(bots.filter((b) => isRemote(b) && isNginxStatusBot(b)).map((b) => b.nodeId));

    const remoteLists = new Map();
    const nginxLists = new Map();
    await Promise.all(
        remoteNodeIds.map(async (nodeId) => {
            try {
                const node = await nodeService.getNode(nodeId);
                const [pm2Data, nginxData] = await Promise.all([
                    nodeService.agentRequest(node, "get", "/pm2/list", { timeout: 10_000 }),
                    nginxNodeIds.has(nodeId)
                        ? nodeService.agentRequest(node, "get", "/nginx/list", { timeout: 10_000 }).catch(() => null)
                        : Promise.resolve(null),
                ]);
                remoteLists.set(nodeId, pm2Data.processes || []);
                nginxLists.set(nodeId, nginxData ? nginxData.configs || [] : null);
            } catch {
                remoteLists.set(nodeId, null);
                nginxLists.set(nodeId, null);
            }
        }),
    );

    return {
        localList,
        listFor: (bot) => (isRemote(bot) ? remoteLists.get(bot.nodeId) ?? null : localList),
        nginxListFor: (bot) => (isRemote(bot) ? nginxLists.get(bot.nodeId) ?? null : undefined),
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

// ─────────────────────────────────────────────────────────────────────────────
//  Migration — archive a project's working dir on one node, restore on another.
//  The panel is the hub: archive → temp file on panel → extract. Works for any
//  local↔remote combination. Archives folder CONTENTS (name-independent).
// ─────────────────────────────────────────────────────────────────────────────

// Environment dirs that the install step recreates on the target — carrying
// them across machines wastes bandwidth and (for venv) bakes in stale absolute
// paths that break the interpreter. Always safe to drop when we reinstall.
const REBUILDABLE_DIRS = ["node_modules", "venv", ".venv", "__pycache__"];

/** Stream the project's working dir into `tmpPath` as tar.gz. */
const archiveToFile = async (ref, tmpPath, { excludeNodeModules = true } = {}) => {
    const excludes = excludeNodeModules ? [...REBUILDABLE_DIRS, ".pm2"] : [".pm2"];

    if (!isRemote(ref)) {
        const { spawn } = require("child_process");
        const dir = localBotDir(ref);
        if (!fs.existsSync(dir)) throw new Error(`Source directory not found: ${dir}`);
        const args = ["czf", tmpPath, "-C", dir, ...excludes.map((e) => `--exclude=./${e}`), "."];
        await new Promise((resolve, reject) => {
            const tar = require("child_process").spawn("tar", args);
            let err = "";
            tar.stderr.on("data", (d) => { err += d.toString(); });
            tar.on("error", reject);
            tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar archive failed: ${err.trim().slice(0, 200)}`))));
        });
        return;
    }

    const node = await nodeService.getNode(ref.nodeId);
    const axios = require("axios");
    const res = await axios({
        method: "get",
        url: `http://${node.host}:${node.port}/fs/archive`,
        params: { root: rootOf(ref), dir: relDir(ref), exclude: excludes.join(",") },
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
    if (!isRemote(ref)) {
        const dir = localBotDir(ref);
        if (clear && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        const args = ["xzf", tmpPath, "-C", dir];
        await new Promise((resolve, reject) => {
            const tar = require("child_process").spawn("tar", args);
            let err = "";
            tar.stderr.on("data", (d) => { err += d.toString(); });
            tar.on("error", reject);
            tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar extract failed: ${err.trim().slice(0, 200)}`))));
        });
        return;
    }

    const node = await nodeService.getNode(ref.nodeId);
    const axios = require("axios");
    await axios({
        method: "post",
        url: `http://${node.host}:${node.port}/fs/extract`,
        params: { root: rootOf(ref), dir: relDir(ref), clear: clear ? "true" : "false" },
        headers: { "x-agent-key": node.apiKey, "Content-Type": "application/gzip" },
        data: fs.createReadStream(tmpPath),
        timeout: 0,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });
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
//  Website infra — nginx + UFW on whichever node the project lives.
//
//  distFolder is passed around in its stored (usually relative) form: the
//  local branch resolves it against the bot's local dir, the remote branch
//  sends it as-is so the agent resolves it inside its own roots.
// ─────────────────────────────────────────────────────────────────────────────

const localDistAbs = (bot, distFolder) =>
    path.isAbsolute(distFolder || "") ? distFolder : path.join(localBotDir(bot), distFolder || "");

const nginxWriteConfig = async (bot, { mode, port, apiPort, distFolder, domain, extraConfig }) => {
    if (!isRemote(bot)) {
        return nginxService.writeConfig(bot.pm2Name, {
            mode, port, apiPort, domain, extraConfig,
            distFolder: localDistAbs(bot, distFolder),
        });
    }
    await agentCall(bot, "post", "/nginx/config", {
        data: {
            pm2Name: bot.pm2Name,
            root: rootOf(bot),
            dir: relDir(bot),
            mode, port, apiPort, domain, extraConfig,
            distFolder: distFolder || "",
        },
        timeout: 30_000,
    });
};

const nginxRemoveConfig = async (bot) => {
    if (!isRemote(bot)) return nginxService.removeConfig(bot.pm2Name);
    await agentCall(bot, "delete", `/nginx/config/${encodeURIComponent(bot.pm2Name)}`, { timeout: 30_000 })
        .catch(() => { /* best-effort, like the local variant */ });
};

/**
 * Does the bot's nginx config exist on its node?
 * Returns null when the node is unreachable (callers report "node-offline").
 * `cachedConfigList` comes from getStatusResolver().nginxListFor(bot).
 */
const nginxConfigExists = async (bot, cachedConfigList) => {
    if (!isRemote(bot)) return nginxService.configExists(bot.pm2Name);
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
    if (!isRemote(bot)) return nginxService.enableSSL(domain, email);
    await agentCall(bot, "post", "/nginx/ssl", { data: { domain, email }, timeout: 130_000 });
};

const ufwOpenPort = async (bot, port) => {
    if (!isRemote(bot)) return ufwService.openPort(port);
    await agentCall(bot, "post", "/ufw/open", { data: { port }, timeout: 20_000 });
};

const ufwClosePort = async (bot, port) => {
    if (!isRemote(bot)) return ufwService.closePort(port);
    await agentCall(bot, "post", "/ufw/close", { data: { port }, timeout: 20_000 })
        .catch(() => { /* rule may not exist / node offline — same silence as local */ });
};

/** Find a free port on a node — called at create time, before a record exists. */
const findFreePortOn = async (nodeId, start = 3000, end = 9000) => {
    if (!nodeId || nodeId === nodeService.LOCAL_NODE_ID) return ufwService.findFreePort(start, end);
    const node = await nodeService.getNode(nodeId);
    const data = await nodeService.agentRequest(node, "get", "/ufw/free-port", {
        params: { start, end },
        timeout: 20_000,
    });
    return data.port;
};

/** Serve a static site with http-server (PM2) on the bot's node. */
const startHttpServer = async (bot, distFolder, port) => {
    if (!isRemote(bot)) {
        return pm2Service.startHttpServer(bot.pm2Name, localDistAbs(bot, distFolder), port);
    }
    const data = await agentCall(bot, "post", "/pm2/start-static", {
        data: {
            pm2Name: bot.pm2Name,
            root: rootOf(bot),
            dir: relDir(bot),
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
    streamRemoteLogs,
    flushBotLogs,
};
