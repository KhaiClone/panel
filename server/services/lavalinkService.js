const axios = require("axios");

const nodeService = require("./nodeService");
const store = require("./lavalinkStore");
const { renderYaml, sha256 } = require("./lavalinkConfig");

// ─────────────────────────────────────────────────────────────────────────────
//  Lavalink orchestration.
//
//  The panel never downloads a jar itself: it resolves the release on GitHub
//  and hands each agent the URL. Every node already reaches GitHub (that is how
//  git pull works), and pushing 100MB through the panel to three machines would
//  triple the transfer for no benefit.
//
//  Every call goes through nodeService.agentRequest, exactly like executor.js —
//  including the node the panel itself runs on.
// ─────────────────────────────────────────────────────────────────────────────

const RELEASE_URL = "https://api.github.com/repos/lavalink-devs/Lavalink/releases/latest";

// Downloading ~100MB, restarting the JVM and waiting out the health check.
const LONG_TIMEOUT = 600_000;
const STATUS_TIMEOUT = 25_000;

let _releaseCache = null; // { at, release }
const RELEASE_TTL = 10 * 60 * 1000;

/**
 * The latest stable Lavalink release.
 * Unauthenticated GitHub allows 60 requests/hour/IP; the daily job plus the
 * page's own lookups stay far below that, and the cache keeps it that way.
 */
const latestRelease = async ({ force = false } = {}) => {
    if (!force && _releaseCache && Date.now() - _releaseCache.at < RELEASE_TTL) {
        return _releaseCache.release;
    }

    const { data } = await axios.get(RELEASE_URL, {
        timeout: 15_000,
        headers: { "User-Agent": "bot-panel", Accept: "application/vnd.github+json" },
    });

    const asset = (name) => {
        const a = (data.assets || []).find((x) => x.name === name);
        return a ? { url: a.browser_download_url, size: a.size } : null;
    };

    const release = {
        version: data.tag_name,
        publishedAt: data.published_at,
        prerelease: Boolean(data.prerelease),
        url: data.html_url,
        assets: { glibc: asset("Lavalink.jar"), musl: asset("Lavalink-musl.jar") },
    };

    if (!release.assets.glibc) throw new Error("The latest Lavalink release has no Lavalink.jar asset");

    _releaseCache = { at: Date.now(), release };
    return release;
};

/** Alpine nodes need the musl build; everything else takes the normal jar. */
const assetFor = (release, libc) =>
    (libc === "musl" && release.assets.musl) || release.assets.glibc;

// ─────────────────────────────────────────────────────────────────────────────
//  Status
// ─────────────────────────────────────────────────────────────────────────────

/** Nodes the panel should manage Lavalink on — every enabled node. */
const managedNodes = async () => (await nodeService.getNodes()).filter((n) => n.enabled !== false);

/**
 * Turn one agent's raw /lavalink/status into the state the UI shows.
 * The order matters: a node with no Java can never run, so that beats
 * "not installed", which in turn beats whatever pm2 says.
 */
const _stateOf = (raw, inSync) => {
    if (!raw.java?.present) return "java-missing";
    if (raw.java.major !== null && raw.java.major < 17) return "java-too-old";
    if (!raw.installed) return "not-installed";
    if (raw.live?.status === "online") return inSync ? "running" : "config-drift";
    if (raw.live?.status === "errored" || raw.live?.status === "stopping") return "errored";
    return "stopped";
};

const statusOfNode = async (node, desiredSha) => {
    const base = { nodeId: node._id, nodeName: node.name, host: node.host };
    try {
        const raw = await nodeService.agentRequest(node, "get", "/lavalink/status", { timeout: STATUS_TIMEOUT });
        const inSync = Boolean(desiredSha) && raw.configSha === desiredSha;
        return { ...base, online: true, state: _stateOf(raw, inSync), inSync, ...raw };
    } catch (err) {
        // 404 means the agent predates this feature — say so instead of "offline".
        if (err.status === 404) {
            return { ...base, online: true, state: "agent-outdated", error: "This node's agent is too old — update it first" };
        }
        return { ...base, online: false, state: "node-offline", error: err.message };
    }
};

/** Every managed node's Lavalink status, plus the config the panel wants them to have. */
const statusAll = async () => {
    const settings = await store.get();
    const yaml = renderYaml(settings);
    const desiredSha = sha256(yaml);
    const nodes = await managedNodes();

    const results = await Promise.all(nodes.map((n) => statusOfNode(n, desiredSha)));

    // Cache what we learned so the Discord report can name versions even when a
    // node is unreachable at the time the report is built.
    for (const r of results) {
        if (r.online && r.state !== "agent-outdated") {
            await store.setNodeState(r.nodeId, { state: r.state, version: r.version ?? null, configSha: r.configSha ?? null });
        }
    }

    return { desiredSha, nodes: results };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Config sync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Push application.yml to one node. `restart` only matters for a node that is
 * already running: Lavalink reads its config at boot, so a config change is not
 * live until it restarts — and restarting one that is stopped would start it
 * behind the operator's back.
 */
const syncNode = async (node, { settings, yaml, restart = true } = {}) => {
    const s = settings || (await store.get());
    const content = yaml || renderYaml(s);
    try {
        const result = await nodeService.agentRequest(node, "put", "/lavalink/config", {
            data: { content, restart, port: s.port, password: s.password, address: s.address, heap: s.heap },
            timeout: 120_000,
        });
        await store.setNodeState(node._id, { configSha: result.sha, lastSyncAt: Date.now(), error: null });
        return { nodeId: node._id, nodeName: node.name, ok: true, ...result };
    } catch (err) {
        await store.setNodeState(node._id, { error: err.message });
        return { nodeId: node._id, nodeName: node.name, ok: false, error: err.message };
    }
};

const syncAll = async ({ restart = true } = {}) => {
    const settings = await store.get();
    const yaml = renderYaml(settings);
    const nodes = await managedNodes();
    const results = [];
    for (const node of nodes) results.push(await syncNode(node, { settings, yaml, restart }));
    return { sha: sha256(yaml), results };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Install / update
// ─────────────────────────────────────────────────────────────────────────────

/**
 * First-time setup on one node: config + jar + start + health, in a single
 * agent call. Safe to re-run — it reinstalls the jar and restarts.
 *
 * `start: false` leaves the node prepared but not running — for a rollout where
 * the operator wants to inspect every node before any audio server goes live.
 */
const installOnNode = async (node, { release = null, start = true } = {}) => {
    const settings = await store.get();
    if (!settings.enabled) return { nodeId: node._id, nodeName: node.name, ok: false, skipped: "Lavalink is disabled in the panel settings" };

    const rel = release || (await latestRelease());

    // Ask the node which jar it needs before choosing one.
    let libc = "glibc";
    try {
        const raw = await nodeService.agentRequest(node, "get", "/lavalink/status", { timeout: STATUS_TIMEOUT });
        libc = raw.libc || "glibc";
    } catch (err) {
        if (err.status === 404) {
            const msg = `Node "${node.name}" runs an agent without Lavalink support — update the agent first`;
            await store.setNodeState(node._id, { state: "agent-outdated", error: msg });
            return { nodeId: node._id, nodeName: node.name, ok: false, error: msg };
        }
        // Offline or unreachable — let the install call below produce the real error.
    }

    const asset = assetFor(rel, libc);
    try {
        const result = await nodeService.agentRequest(node, "post", "/lavalink/install", {
            data: {
                content: renderYaml(settings),
                jarUrl: asset.url,
                expectedSize: asset.size,
                version: rel.version,
                port: settings.port,
                password: settings.password,
                address: settings.address,
                heap: settings.heap,
                start,
            },
            timeout: LONG_TIMEOUT,
        });
        // Not started on purpose is a success; started-but-silent is not.
        const ok = start ? result.health?.ok !== false : true;
        await store.setNodeState(node._id, {
            state: !start ? "stopped" : ok ? "running" : "errored",
            version: rel.version,
            configSha: result.status?.configSha ?? null,
            lastSyncAt: Date.now(),
            error: ok ? null : `Installed but did not answer /version: ${result.health?.error}`,
        });
        return { nodeId: node._id, nodeName: node.name, ok, started: start, version: rel.version, health: result.health };
    } catch (err) {
        await store.setNodeState(node._id, { error: err.message });
        return { nodeId: node._id, nodeName: node.name, ok: false, error: err.message };
    }
};

/**
 * Swap one node's jar for `release`. The agent health-checks the new jar and
 * rolls back on its own if it fails — so a failure here means the node is still
 * serving the OLD version, not that it is down.
 */
const updateNode = async (node, release) => {
    const settings = await store.get();

    let libc = "glibc";
    let installed = null;
    try {
        const raw = await nodeService.agentRequest(node, "get", "/lavalink/status", { timeout: STATUS_TIMEOUT });
        libc = raw.libc || "glibc";
        installed = raw.installed;
    } catch (err) {
        const msg = err.status === 404 ? `agent is too old for Lavalink — update the agent` : err.message;
        await store.setNodeState(node._id, { error: msg });
        return { nodeId: node._id, nodeName: node.name, ok: false, error: msg };
    }

    // Nothing to update — install it properly instead of dropping a jar next to
    // a config that was never written.
    if (!installed) return installOnNode(node, { release });

    const asset = assetFor(release, libc);
    try {
        const result = await nodeService.agentRequest(node, "post", "/lavalink/update", {
            data: {
                jarUrl: asset.url,
                expectedSize: asset.size,
                version: release.version,
                port: settings.port,
                password: settings.password,
                address: settings.address,
                heap: settings.heap,
            },
            timeout: LONG_TIMEOUT,
        });
        await store.setNodeState(node._id, { state: "running", version: release.version, error: null, failedVersion: null });
        return { nodeId: node._id, nodeName: node.name, ok: true, version: release.version, health: result.health };
    } catch (err) {
        // agentRequest flattens the agent's error body to a message, and the
        // agent says "rolled back to the previous jar" when it restored the old one.
        const rolledBack = /rolled back/i.test(err.message);
        // Remember WHICH release failed here. Without this the daily job would
        // re-download and re-restart this node every night for a release that is
        // already known not to work on it.
        await store.setNodeState(node._id, { error: err.message, failedVersion: release.version });
        return { nodeId: node._id, nodeName: node.name, ok: false, rolledBack, error: err.message };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Single-node controls (buttons on the page)
// ─────────────────────────────────────────────────────────────────────────────

const control = async (node, action) => {
    const settings = await store.get();
    const data = action === "stop" ? {} : { port: settings.port, password: settings.password, address: settings.address, heap: settings.heap };
    return nodeService.agentRequest(node, "post", `/lavalink/${action}`, { timeout: 180_000, data });
};

const logs = async (node, lines = 100) =>
    nodeService.agentRequest(node, "get", "/lavalink/logs", { params: { lines }, timeout: 30_000 });

module.exports = {
    latestRelease,
    assetFor,
    managedNodes,
    statusOfNode,
    statusAll,
    syncNode,
    syncAll,
    installOnNode,
    updateNode,
    control,
    logs,
};
