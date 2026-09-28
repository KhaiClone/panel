const fs = require("fs");
const os = require("os");
const net = require("net");
const dns = require("dns").promises;
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const db = require("../db");
const nodeService = require("./nodeService");
const panelService = require("./panelService");
const lifecycle = require("./lifecycle");
const panelLease = require("./panelLease");
const agentCrypto = require("./agentCrypto");
const integrations = require("./integrationService");
const callbacks = require("./callbackService");
const domainsSvc = require("./panelDomains");
const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");
const { setEnvKey, envValue } = require("../utils/envText");

// ─────────────────────────────────────────────────────────────────────────────
//  Moving the panel to another node.
//
//  The panel running NOW drives the whole move, so the Panel page can show every
//  step live:
//
//    preflight   read-only checks; run as often as you like
//    prepare     firewall access for the new host on every agent, then on the
//                target: git pull, deps, client build, HTTPS for its own
//                domains. Nothing is
//                paused — the panel keeps working.
//    move        maintenance (background work paused, writes refused) →
//                snapshot panel.sqlite / samples.sqlite → .env with the new
//                PANEL_NODE_ID → import on the target → start it there → wait
//                until it reports active at epoch + 1.
//
//  COMMIT POINT: the new panel boots, finds data/migration-in.json and claims
//  every agent at epoch + 1 (finalizeIncoming). From then on this process is
//  fenced — every agent refuses it — and the new one retires it (pm2 delete).
//  Before that point any failure rolls back: the target is cleaned up and this
//  panel leaves maintenance as if nothing happened. After it, nothing is rolled
//  back: two panels must never both believe they are in charge.
// ─────────────────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, "../../data");
const PANEL_DB = path.join(DATA_DIR, "panel.sqlite");
const SAMPLES_DB = process.env.SAMPLES_DB_PATH || path.join(DATA_DIR, "samples.sqlite");
const MARKER = path.join(DATA_DIR, "migration-in.json");
const LOG_KEY = "panel_migrations";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

const MB = 1024 * 1024;
const GB = 1024 * MB;
// Checks that make even Prepare pointless.
const PREPARE_BLOCKERS = new Set(["target", "online", "agent"]);

const panelPort = () => parseInt(process.env.PORT) || 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (commit) => (commit ? String(commit).slice(0, 7) : "?");
const fmtSize = (bytes) => (bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`);
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const sha256File = (file) =>
    new Promise((resolve, reject) => {
        const h = crypto.createHash("sha256");
        fs.createReadStream(file)
            .on("data", (c) => h.update(c))
            .on("end", () => resolve(h.digest("hex")))
            .on("error", reject);
    });

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** The address a panel on ANOTHER node uses to reach `node` (overlay first, like integrations). */
const nodeAddress = (node) => (node ? node.wgOverlayIp || node.host : null);

/** The ufw command that lets `target` reach `port` on `node` (overlay when both have one). */
const ufwHint = (node, target, port) =>
    node?.wgOverlayIp && target.wgOverlayIp
        ? `sudo ufw allow in on wg0 from ${target.wgOverlayIp} to any port ${port} proto tcp`
        : `sudo ufw allow from ${target.host} to any port ${port} proto tcp`;

/** Consistent copy of a live SQLite file (online backup API — safe while it is open). */
const backupSqlite = async (src, dest) => {
    const conn = new Database(src, { fileMustExist: true });
    try {
        await conn.backup(dest);
    } finally {
        conn.close();
    }
};

// ── Move log (travels with the DB, so the new panel can close the entry) ──────

const appendLog = async (entry) => {
    const log = ((await db.get(LOG_KEY)) || []).slice(-19);
    log.push(entry);
    await db.set(LOG_KEY, log);
};

const updateLog = async (id, patch) => {
    const log = (await db.get(LOG_KEY)) || [];
    await db.set(LOG_KEY, log.map((e) => (e.id === id ? { ...e, ...patch } : e)));
};

// ── Job state (one prepare or move at a time, polled by the Panel page) ──────

let job = null;

const publicJob = () => (job ? JSON.parse(JSON.stringify(job)) : null);

const newJob = (kind, target) => {
    job = {
        id: crypto.randomUUID(),
        kind,
        targetNodeId: target._id,
        targetName: target.name,
        status: "running",
        steps: [],
        error: null,
        result: null,
        startedAt: Date.now(),
        finishedAt: null,
    };
    return job;
};

const finish = (status, error = null, result = null) => {
    job.status = status;
    job.error = error;
    job.result = result;
    job.finishedAt = Date.now();
};

/**
 * Run one visible step. `fn(step)` may set step.detail, and step.warn = true
 * for "done, but look at this". Its return value is passed through.
 */
const runStep = async (label, fn) => {
    const step = { label, status: "running", detail: null, startedAt: Date.now(), finishedAt: null };
    job.steps.push(step);
    try {
        const out = await fn(step);
        step.status = step.warn ? "warn" : "ok";
        return out;
    } catch (err) {
        step.status = "error";
        step.detail = err.output ? `${err.message}\n\n${err.output}` : err.message;
        throw err;
    } finally {
        delete step.warn;
        step.finishedAt = Date.now();
    }
};

// Set from the click until its job exists: the preflight before a job takes
// seconds, and a second click in that gap must not start a second job.
let starting = null;

const assertIdle = () => {
    if (job?.status === "running") throw httpError(409, `A ${job.kind} to ${job.targetName} is already running`);
    if (starting) throw httpError(409, `A ${starting} is already starting`);
    if (!lifecycle.isActive()) throw httpError(409, `The panel is ${lifecycle.get().state}`);
};

/**
 * assertIdle + preflight, holding the slot meanwhile. The caller must create
 * its job without awaiting anything in between — that is what keeps it single.
 */
const preflightExclusive = async (kind, targetNodeId) => {
    assertIdle();
    starting = kind;
    try {
        return await preflight(targetNodeId);
    } finally {
        starting = null;
    }
};

// ── Transport ────────────────────────────────────────────────────────────────

/**
 * The address to send the panel's data through: the node's WireGuard IP when
 * its agent answers there (encrypted tunnel), otherwise the normal address —
 * the payload is still AES-GCM-encrypted with the node's agent key.
 */
const transferLink = async (node) => {
    if (node.wgOverlayIp) {
        const via = { ...node, controlHost: node.wgOverlayIp };
        try {
            await nodeService.agentRequest(via, "get", "/health", { timeout: 4000 });
            return { node: via, overlay: true };
        } catch { /* tunnel down or firewalled — fall back */ }
    }
    return { node, overlay: false };
};

/** TCP connect test from THIS machine → { ok, error } (error is e.g. "ECONNREFUSED" or "timeout"). */
const tcpCheck = (host, port, timeout = 4000) =>
    new Promise((resolve) => {
        const sock = net.connect({ host, port });
        const done = (ok, error = null) => {
            sock.destroy();
            resolve({ ok, error });
        };
        sock.setTimeout(timeout, () => done(false, "timeout"));
        sock.once("connect", () => done(true));
        sock.once("error", (e) => done(false, e.code || e.message));
    });

/** Has any node accepted a panel at `epoch` or later? (read without our epoch header) */
const leaseClaimedAnywhere = async (epoch) => {
    const nodes = (await nodeService.getNodes()).filter((n) => n.enabled !== false);
    const seen = await Promise.all(
        nodes.map((n) =>
            nodeService
                .agentRequest(n, "get", "/lease", { noEpoch: true, timeout: 5000 })
                .then((l) => l.epoch >= epoch)
                .catch(() => false),
        ),
    );
    return seen.some(Boolean);
};

// ─────────────────────────────────────────────────────────────────────────────
//  Preflight
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read-only checks for moving the panel to `targetNodeId`.
 * Every check is { level: "ok" | "info" | "warn" | "error", key, message }; any
 * "error" blocks the move, and the ones in PREPARE_BLOCKERS block Prepare too.
 * Returns { target, checks, canPrepare, canMove, ctx } — ctx is internal.
 */
const preflight = async (targetNodeId) => {
    const checks = [];
    const add = (level, key, message) => checks.push({ level, key, message });
    const ctx = { target: null, status: null, panelCommit: null, domains: [] };
    const done = () => ({
        target: ctx.target ? { _id: ctx.target._id, name: ctx.target.name, host: ctx.target.host } : null,
        checks,
        canPrepare: !checks.some((c) => c.level === "error" && PREPARE_BLOCKERS.has(c.key)),
        canMove: checks.length > 0 && !checks.some((c) => c.level === "error"),
        ctx,
    });

    const currentId = nodeService.panelNodeId();
    const target = await db.findOne("nodes", { _id: targetNodeId });
    if (!target) {
        add("error", "target", "Target node not found");
        return done();
    }
    ctx.target = target;
    if (target._id === currentId) add("error", "target", "The panel already runs on this node");
    if (target.enabled === false) add("error", "target", `${target.name} is disabled`);
    if (!(await nodeService.checkNodeHealth(target))) {
        add("error", "online", `${target.name} is not answering`);
        return done();
    }

    let status;
    try {
        status = await nodeService.agentRequest(target, "get", "/panel-host/status", {
            params: { port: panelPort() },
            timeout: 20_000,
        });
    } catch (err) {
        add(
            "error",
            "agent",
            err.status === 404
                ? `The agent on ${target.name} is too old to host the panel — run "Rebuild & Restart" (it updates every agent) first`
                : err.message,
        );
        return done();
    }
    ctx.status = status;

    // shared.sqlite (the bots' shared data) can only be received by agent ≥ 1.9.0.
    if (fs.existsSync(sharedStore.DB_PATH())) {
        const h = await nodeService.agentRequest(target, "get", "/health", { timeout: 8000 }).catch(() => null);
        const [maj, min] = String(h?.version || "0.0").split(".").map(Number);
        if (maj < 1 || (maj === 1 && min < 9)) {
            add("error", "agent", `The agent on ${target.name} (${h?.version || "?"}) cannot receive the shared data — update it to 1.9.0 ("Rebuild & Restart") first`);
        }
    }

    // ── The target itself ────────────────────────────────────────────────────
    const panelStatus = await panelService.getPanelStatus().catch(() => null);
    ctx.panelCommit = panelStatus?.git?.commitHash || null;
    if (!ctx.panelCommit) add("error", "commit", "Could not read the panel's own git commit");
    else if (status.commit !== ctx.panelCommit) {
        add("error", "commit", `${target.name} is at ${short(status.commit)}, the panel at ${short(ctx.panelCommit)} — Prepare pulls it forward`);
    } else add("ok", "commit", `Same commit on both (${short(ctx.panelCommit)})`);

    if (status.depsInstalled && status.clientBuilt) add("ok", "prepared", "Dependencies installed, client built");
    else add("error", "prepared", `${target.name} is not prepared — run Prepare (installs dependencies, builds the client)`);

    if (status.panelProcess === "online") add("error", "process", `A panel is already running on ${target.name}`);
    else if (status.portFree === false) add("error", "port", `Port ${panelPort()} is already in use on ${target.name}`);
    else add("ok", "port", `Port ${panelPort()} is free`);

    if (status.diskFreeBytes !== null && status.diskFreeBytes < 2 * GB) {
        add("error", "disk", `Only ${fmtSize(status.diskFreeBytes)} free on ${target.name}`);
    }
    if (status.memAvailableBytes < 512 * MB) {
        add("warn", "memory", `Only ${fmtSize(status.memAvailableBytes)} of memory available on ${target.name}`);
    }
    add("info", "user", `The panel will run as "${status.user}" from ${status.dir}`);

    // Domains never move between nodes — only the target's own ones matter.
    ctx.domains = domainsSvc.ofNode(await domainsSvc.list(), target._id).map((d) => d.domain);
    if (ctx.domains.length && !status.nginx) {
        add(
            "error",
            "nginx",
            `nginx is not installed on ${target.name} — ${ctx.domains.join(", ")} could not be served. ` +
                `On ${target.name}: sudo apt install -y nginx certbot python3-certbot-nginx`,
        );
    }

    // Probed from THIS machine: a firewall that drops the port shows up as a
    // timeout, while "refused" means open with nothing listening yet (nginx
    // comes with Prepare, the panel with the move). A firewall that admits only
    // some addresses also times out from here — hence a warning, not an error.
    const publicPorts = ctx.domains.length ? [80, 443] : [panelPort()];
    const blocked = [];
    for (const port of publicPorts) {
        const r = await tcpCheck(target.host, port);
        if (!r.ok && r.error !== "ECONNREFUSED") blocked.push(`${port} (${r.error})`);
    }
    if (blocked.length) {
        add(
            "warn",
            "public",
            `${target.name} does not answer on port ${blocked.join(", ")} from here. Unless its firewall deliberately admits only some addresses, ` +
                `the panel would be unreachable after the move. On ${target.name}: sudo ufw allow ${publicPorts.join(",")}/tcp`,
        );
    } else {
        add("ok", "public", `Port ${publicPorts.join(", ")} open on ${target.name}`);
    }

    // ── Every other node: online, and reachable from the new host ─────────────
    const others = (await nodeService.getNodes()).filter((n) => n.enabled !== false && n._id !== target._id);
    const offline = [];
    const tooOld = [];
    for (const n of others) {
        if (!(await nodeService.checkNodeHealth(n))) {
            offline.push(n.name);
            continue;
        }
        // An agent without /lease cannot lock the old panel out after the move.
        const lease = await nodeService.agentRequest(n, "get", "/lease", { noEpoch: true, timeout: 8000 }).catch((err) => err);
        if (lease instanceof Error && lease.status === 404) tooOld.push(n.name);
    }
    if (offline.length) {
        add("error", "nodes", `Offline: ${offline.join(", ")} — they would keep following this panel. Bring them back or disable them first.`);
    }
    if (tooOld.length) {
        add("error", "agents", `The agent on ${tooOld.join(", ")} is too old to take part in a move — run "Rebuild & Restart" (it updates every agent) first`);
    }

    // Callback URLs saying "localhost" (callbackService). Owned ones whose
    // project runs the Discord bus are delivered there — no address involved;
    // other owned ones follow their project, so check the target can reach it;
    // orphans are rewritten to this node by the move (finalizeIncoming).
    const fromNode = await nodeService.getNode(currentId).catch(() => null);
    const fromAddr = nodeAddress(fromNode);
    const callbackTargets = [];
    const addCallbackTarget = (t) => {
        if (!callbackTargets.some((x) => x.host === t.host && x.port === t.port)) callbackTargets.push(t);
    };
    const groups = await callbacks.audit();
    const caps = discordBus.capabilities();
    for (const g of groups.filter((x) => x.ownerBotId)) {
        const port = callbacks.portOf(g.url);
        const onBus = ["quest.event", "badge.event"].some((c) => caps[g.ownerBotId]?.commands?.includes(c));
        if (onBus && discordBus.configured()) {
            add("ok", `callback:${g.ownerBotId}`, `Callbacks of ${g.ownerName} (${g.sources.join(", ")}) go over the Discord bus — no address needed`);
            continue;
        }
        try {
            const owner = await db.findOne("bots", { _id: g.ownerBotId });
            const addr = await integrations.addressFor(owner, port, target._id);
            if (addr.local) {
                add("ok", `callback:${g.ownerBotId}`, `Callbacks of ${g.ownerName} (${g.sources.join(", ")}) → 127.0.0.1:${port}, same node as the new panel`);
            } else {
                addCallbackTarget({ host: addr.host, port, url: addr.url, node: await nodeService.getNode(addr.nodeId), label: g.ownerName });
            }
        } catch (err) {
            add("error", `callback:${g.ownerBotId}`, `Callbacks of ${g.ownerName}: ${err.message}`);
        }
    }
    const orphans = groups.filter((x) => !x.ownerBotId);
    if (orphans.length && !fromAddr) {
        add("error", "callbacks", "Some callback URLs point at localhost with no known project, and this panel's own node record has no address to rewrite them to");
    } else if (orphans.length) {
        add(
            "warn",
            "callbacks",
            `Callback URLs saying "localhost" with no known project (meaning ${fromNode.name}): ` +
                orphans.map((c) => `${c.url} — ${c.sources.join(", ")}`).join("; ") +
                `. The move pins them to ${fromAddr}. Give the project that registers them its own API key and the ` +
                `Discord bus library, and they follow the project instead.`,
        );
        for (const c of orphans) {
            const u = new URL(callbacks.relocateUrl(c.url, fromAddr));
            addCallbackTarget({ host: u.hostname, port: callbacks.portOf(u.href), url: `${u.protocol}//${u.host}`, node: fromNode, label: "orphan callbacks" });
        }
    }

    const probeTargets = [
        ...others.map((n) => ({ host: n.host, port: n.port })),
        ...callbackTargets.map((t) => ({ host: t.host, port: t.port })),
    ];
    let probe = [];
    if (probeTargets.length) {
        probe = await nodeService
            .agentRequest(target, "post", "/panel-host/probe", { data: { targets: probeTargets }, timeout: 30_000 })
            .then((r) => r.results || [])
            .catch(() => []);
    }
    const reachable = (host, port) => probe.find((p) => p.host === host && p.port === port);

    for (const n of others) {
        const p = reachable(n.host, n.port);
        if (p?.ok) add("ok", `reach:${n._id}`, `${target.name} can reach the agent on ${n.name}`);
        else {
            add(
                "error",
                `reach:${n._id}`,
                `${target.name} cannot reach the agent on ${n.name} (${n.host}:${n.port}${p?.error ? `, ${p.error}` : ""}) — Prepare adds a firewall rule for it on ${n.name}`,
            );
        }
    }
    for (const t of callbackTargets) {
        const p = reachable(t.host, t.port);
        if (p?.ok) add("ok", `callback:${t.host}:${t.port}`, `${target.name} can reach the callbacks of ${t.label} at ${t.url}`);
        else {
            add(
                "error",
                `callback:${t.host}:${t.port}`,
                `${target.name} cannot reach the callbacks of ${t.label} at ${t.url}${p?.error ? ` (${p.error})` : ""}. ` +
                    `On ${t.node?.name || "that node"}: ${ufwHint(t.node, target, t.port)}`,
            );
        }
    }

    // ── SSH keys (the new host's ~/.ssh becomes the source of truth) ─────────
    try {
        const sync = (await require("./keySyncService").getSyncStatus()).find((s) => s.nodeId === target._id);
        if (sync?.inSync) add("ok", "keys", `SSH keys and git config are in sync on ${target.name}`);
        else {
            add("warn", "keys", `SSH keys / git config are not fully synced to ${target.name} — the new panel manages keys from there. Sync them on the GitHub Keys section first.`);
        }
    } catch { /* informational only */ }

    // ── How the data travels ─────────────────────────────────────────────────
    const link = await transferLink(target);
    if (link.overlay) add("ok", "transfer", "The data goes through the WireGuard tunnel");
    else add("warn", "transfer", `The WireGuard tunnel to ${target.name} is not reachable — the data (encrypted with its agent key) goes over the public network`);

    // ── Domains: each node has its own, pointing at it for good ──────────────
    if (!ctx.domains.length) {
        add(
            "info",
            "dns",
            `${target.name} has no panel domain — after the move the panel answers at http://${target.host}:${panelPort()}. ` +
                `Add one under Custom Domains (node ${target.name}) for a name and HTTPS.`,
        );
    }
    for (const d of ctx.domains) {
        const ips = await dns.resolve4(d).catch((err) => err);
        if (ips instanceof Error) add("warn", `dns:${d}`, `${d} does not resolve (${ips.code || ips.message}) — point its A record at ${target.host}`);
        else if (ips.includes(target.host)) add("ok", `dns:${d}`, `${d} → ${target.host}`);
        else add("warn", `dns:${d}`, `${d} resolves to ${ips.join(", ")}, not ${target.host} — HTTPS cannot be issued for it there`);
    }

    // ── Panel gateways: every node's 127.0.0.1:4201 will forward to the target ──
    // Probed from each node: "refused" is fine (open, the panel is not there yet).
    const targetAddr = nodeAddress(target);
    const gatewayFrom = others.filter((n) => !offline.includes(n.name));
    const gatewayProbes = await Promise.all(
        gatewayFrom.map((n) =>
            nodeService
                .agentRequest(n, "post", "/panel-host/probe", { data: { targets: [{ host: targetAddr, port: panelPort() }] }, timeout: 15_000 })
                .then((r) => ({ n, r: r.results?.[0] }))
                .catch((err) => ({ n, r: { ok: false, error: err.message } })),
        ),
    );
    for (const { n, r } of gatewayProbes) {
        if (r?.ok || r?.error === "ECONNREFUSED") {
            add("ok", `gateway:${n._id}`, `${n.name} can reach ${targetAddr}:${panelPort()} — its panel gateway will follow the move`);
        } else {
            add(
                "error",
                `gateway:${n._id}`,
                `${n.name} cannot reach ${targetAddr}:${panelPort()} (${r?.error || "no answer"}) — projects there calling 127.0.0.1:4201 would lose the panel. ` +
                    `On ${target.name}: ${ufwHint(target, n, panelPort())}`,
            );
        }
    }

    // ── What gets paused ─────────────────────────────────────────────────────
    const quests = require("./questService").runningCount();
    const monthly = require("./questMonthly").busy();
    const badges = require("./badgeService").runningCount();
    add(
        "info",
        "work",
        `${quests} quest account(s) running${monthly.run ? ", monthly batch in progress" : ""}${badges ? `, ${badges} badge order(s) sending` : ""} — paused for the move and resumed by the new panel. Bots are not affected.`,
    );
    if (fs.existsSync(SAMPLES_DB)) {
        add("info", "history", `Resource history (${fmtSize(fs.statSync(SAMPLES_DB).size)}) is copied too`);
    }

    return done();
};

const stripCtx = (pf) => {
    const { ctx, ...rest } = pf;
    return ctx ? rest : pf;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Prepare
// ─────────────────────────────────────────────────────────────────────────────

const startPrepare = async (targetNodeId) => {
    const pf = await preflightExclusive("prepare", targetNodeId);
    if (!pf.canPrepare) {
        throw httpError(400, pf.checks.find((c) => c.level === "error" && PREPARE_BLOCKERS.has(c.key)).message);
    }
    const { target, panelCommit, domains } = pf.ctx;
    newJob("prepare", target);

    (async () => {
        try {
            await runStep(`Let ${target.name} reach every agent`, async (step) => {
                if (!net.isIP(target.host)) {
                    step.warn = true;
                    step.detail = `${target.host} is not an IP address — add firewall rules by hand if the agents restrict their port`;
                    return;
                }
                const others = (await nodeService.getNodes()).filter((n) => n.enabled !== false && n._id !== target._id);
                const results = await Promise.all(
                    others.map((n) =>
                        nodeService
                            .agentRequest(n, "post", "/ufw/allow-from", { data: { ip: target.host, port: n.port }, timeout: 30_000 })
                            .then(() => `${n.name}: allowed ${target.host} → port ${n.port}`)
                            .catch((err) => {
                                step.warn = true;
                                return `${n.name}: ${err.message}`;
                            }),
                    ),
                );
                step.detail = results.join("\n") || "No other nodes";
            });

            await runStep(`Install and build on ${target.name}`, async (step) => {
                const r = await nodeService.agentRequest(target, "post", "/panel-host/prepare", {
                    data: { commit: panelCommit },
                    // Above the agent's own budget (pull 2m + deps 10m + build 5m)
                    // so its error, with the build log, is what surfaces.
                    timeout: 1_080_000,
                });
                step.detail = `Checkout at ${short(r.commit)}, dependencies installed, client built`;
            });

            if (domains.length) {
                await runStep(`HTTPS for ${domains.join(", ")} on ${target.name}`, async (step) => {
                    const [w] = await domainsSvc.sync({ nodeIds: [target._id] });
                    if (!w.ok) throw new Error(`nginx on ${target.name}: ${w.error}`);
                    const lines = [];
                    for (const d of domainsSvc.ofNode(await domainsSvc.list(), target._id)) {
                        if (d.sslEnabled) {
                            lines.push(`${d.domain}: certificate already there`);
                            continue;
                        }
                        try {
                            await domainsSvc.issueCert(d.domain);
                            lines.push(`${d.domain}: certificate issued`);
                        } catch (err) {
                            step.warn = true;
                            lines.push(`${d.domain}: no certificate (${err.message.split("\n")[0]}) — does its DNS point at ${target.host}?`);
                        }
                    }
                    step.detail = `${lines.join("\n")}\nUntil the move they redirect to the current panel.`;
                });
            }

            finish("done", null, { preflight: stripCtx(await preflight(targetNodeId)) });
        } catch (err) {
            finish("failed", err.message);
        }
    })();

    return publicJob();
};

// ─────────────────────────────────────────────────────────────────────────────
//  Move
// ─────────────────────────────────────────────────────────────────────────────

const startMove = async (targetNodeId, { confirmName } = {}) => {
    const pf = await preflightExclusive("move", targetNodeId);
    if (!pf.canMove) {
        const first = pf.checks.find((c) => c.level === "error");
        throw httpError(400, `Preflight failed: ${first?.message || "no checks ran"}`);
    }
    const { target } = pf.ctx;
    if (confirmName !== target.name) throw httpError(400, `Type "${target.name}" to confirm`);

    newJob("move", target);
    const fromNodeId = nodeService.panelNodeId();
    const newEpoch = panelLease.current() + 1;

    (async () => {
        let tmpDir = null;
        let committed = false;
        try {
            const link = await transferLink(target);

            await runStep("Pause background work", async (step) => {
                const r = await lifecycle.enterMaintenance({ reason: "moving", to: target.name });
                step.detail =
                    `${r.questsSuspended} quest loop(s) paused` +
                    (r.monthlyAborted ? ", monthly batch stopped" : "") +
                    (r.badgeOrdersStillRunning ? `, ${r.badgeOrdersStillRunning} badge order(s) still sending` : "");
                if (r.badgeOrdersStillRunning) step.warn = true;
            });

            // Written BEFORE the snapshot so the entry travels and the new panel closes it.
            await appendLog({ id: job.id, fromNodeId, toNodeId: target._id, epoch: newEpoch, status: "in-progress", startedAt: job.startedAt });

            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-move-"));
            const dbCopy = path.join(tmpDir, "panel.sqlite");
            const samplesCopy = path.join(tmpDir, "samples.sqlite");
            const hasSamples = fs.existsSync(SAMPLES_DB);

            await runStep("Snapshot the databases", async (step) => {
                await backupSqlite(PANEL_DB, dbCopy);
                if (hasSamples) await backupSqlite(SAMPLES_DB, samplesCopy);
                step.detail = `panel.sqlite ${fmtSize(fs.statSync(dbCopy).size)}` + (hasSamples ? `, samples.sqlite ${fmtSize(fs.statSync(samplesCopy).size)}` : "");
            });

            const envText = await runStep("Read the panel's .env", async (step) => {
                const raw = await panelService.readEnv();
                if (!/^\s*JWT_SECRET\s*=/m.test(raw)) throw new Error("The .env read back has no JWT_SECRET — refusing to move a broken config");
                let text = setEnvKey(raw, "PANEL_NODE_ID", target._id);
                const changes = [`PANEL_NODE_ID → ${target._id}`];
                // Same rule as the stored orphan callbacks: localhost meant the old node.
                const fromAddr = nodeAddress(await nodeService.getNode(fromNodeId).catch(() => null));
                for (const key of callbacks.CALLBACK_ENV) {
                    const current = envValue(raw, key);
                    const url = callbacks.relocateUrl(current, fromAddr);
                    if (url && !(await callbacks.ownerOf(current, null))) {
                        text = setEnvKey(text, key, url);
                        changes.push(`${key} → ${url}`);
                    }
                }
                step.detail = changes.join("\n");
                return text;
            });

            await runStep(`Send the data to ${target.name}`, async (step) => {
                const dbBuf = fs.readFileSync(dbCopy);
                const marker = JSON.stringify(
                    { migrationId: job.id, epoch: newEpoch, fromNodeId, toNodeId: target._id, at: Date.now() },
                    null,
                    2,
                );
                const key = target.apiKey;
                await nodeService.agentRequest(link.node, "post", "/panel-host/import", {
                    data: {
                        files: {
                            env: agentCrypto.encrypt(envText, key),
                            db: agentCrypto.encrypt(dbBuf.toString("base64"), key),
                            marker: agentCrypto.encrypt(marker, key),
                        },
                        sha256: { env: sha256(Buffer.from(envText)), db: sha256(dbBuf), marker: sha256(Buffer.from(marker)) },
                    },
                    timeout: 120_000,
                });
                step.detail = `.env + panel.sqlite${link.overlay ? " through the WireGuard tunnel" : " over the public network (encrypted)"}`;
            });

            // The bots' shared data: mandatory (a failure rolls the move back), and
            // encrypted with the target agent's key — it holds customer orders.
            if (fs.existsSync(sharedStore.DB_PATH())) {
                await runStep("Copy the shared data", async (step) => {
                    const copy = path.join(tmpDir, "shared.sqlite");
                    await sharedStore.backupTo(copy);
                    const plain = fs.readFileSync(copy);
                    const iv = crypto.randomBytes(12);
                    const cipher = crypto.createCipheriv("aes-256-gcm", crypto.createHash("sha256").update(String(target.apiKey)).digest(), iv);
                    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
                    await nodeService.agentRequest(link.node, "put", "/panel-host/shared", {
                        data: enc,
                        headers: {
                            "content-type": "application/octet-stream",
                            "x-sha256": sha256(plain),
                            "x-iv": iv.toString("base64"),
                            "x-tag": cipher.getAuthTag().toString("base64"),
                        },
                        maxBodyLength: Infinity,
                        timeout: 300_000,
                    });
                    step.detail = `shared.sqlite ${fmtSize(plain.length)} (encrypted)`;
                });
            }

            if (hasSamples) {
                await runStep("Copy resource history", async (step) => {
                    try {
                        await nodeService.agentRequest(link.node, "put", "/panel-host/samples", {
                            data: fs.createReadStream(samplesCopy),
                            headers: { "content-type": "application/octet-stream", "x-sha256": await sha256File(samplesCopy) },
                            maxBodyLength: Infinity,
                            timeout: 900_000,
                        });
                        step.detail = fmtSize(fs.statSync(samplesCopy).size);
                    } catch (err) {
                        // History is nice to have — never a reason to abort the move.
                        step.warn = true;
                        step.detail = `Skipped (${err.message}) — the new panel starts with empty history`;
                    }
                });
            }

            await runStep(`Start the panel on ${target.name}`, async () => {
                await nodeService.agentRequest(target, "post", "/panel-host/start", { timeout: 90_000 });
            });

            await runStep("Wait for the new panel to take over", async (step) => {
                const deadline = Date.now() + 150_000;
                while (Date.now() < deadline) {
                    await sleep(3000);
                    const h = await nodeService
                        .agentRequest(target, "get", "/panel-host/health", { params: { port: panelPort() }, noEpoch: true, timeout: 10_000 })
                        .catch(() => null);
                    if (h?.body?.state === "active" && h.body.epoch === newEpoch) {
                        committed = true;
                        step.detail = "Running, and in control of every node";
                        return;
                    }
                    if (!committed) committed = await leaseClaimedAnywhere(newEpoch);
                }
                throw new Error(
                    committed
                        ? "The new panel took control of the nodes but has not reported healthy"
                        : "The new panel did not come up in time",
                );
            });

            const url = domainsSvc.publicUrl(await domainsSvc.list(), target);
            finish("done", null, {
                target: { _id: target._id, name: target.name, host: target.host },
                url,
                port: panelPort(),
            });
            lifecycle.fence({ reason: "moved", to: target.name, byNodeId: target._id, url });
        } catch (err) {
            if (!committed) committed = await leaseClaimedAnywhere(newEpoch).catch(() => false);
            if (committed) {
                finish("failed", `${err.message}. The panel on ${target.name} has already taken control — do not retry; check it there.`);
                const url = domainsSvc.publicUrl(await domainsSvc.list().catch(() => []), target);
                lifecycle.fence({ reason: "moved", to: target.name, byNodeId: target._id, url });
            } else {
                // Undo whatever reached the target (retire also sets its imported .env aside).
                await nodeService.agentRequest(target, "post", "/panel-host/retire", { timeout: 30_000 }).catch(() => {});
                await lifecycle.exitMaintenance();
                await updateLog(job.id, { status: "rolled-back", finishedAt: Date.now(), error: err.message }).catch(() => {});
                finish("failed", `${err.message}. Rolled back — the panel keeps running here.`);
            }
        } finally {
            if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    })();

    return publicJob();
};

// ─────────────────────────────────────────────────────────────────────────────
//  The receiving side — runs in the NEW panel at boot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * If this boot is the first one after a move, take over: adopt the new epoch
 * and fix the node records BEFORE the boot-time lease claim (the old host's
 * controlHost may be 127.0.0.1, which from here would be the wrong machine).
 * Returns the marker, for followUp(), or null.
 */
const finalizeIncoming = async () => {
    if (!fs.existsSync(MARKER)) return null;
    let marker;
    try {
        marker = JSON.parse(fs.readFileSync(MARKER, "utf8"));
    } catch (err) {
        console.error("[Move] data/migration-in.json is unreadable — ignoring it:", err.message);
        return null;
    }
    const here = process.env.PANEL_NODE_ID;
    if (marker.toNodeId !== here) {
        console.error(`[Move] migration-in.json is for node ${marker.toNodeId}, this panel is ${here} — ignoring it`);
        fs.renameSync(MARKER, `${MARKER}.ignored-${Date.now()}`);
        return null;
    }

    console.log(`[Move] Taking over from node ${marker.fromNodeId} at epoch ${marker.epoch}`);
    // Domains from before per-node domains belonged to the node the panel left.
    await domainsSvc.normalize(marker.fromNodeId);
    if (marker.epoch > panelLease.current()) await panelLease.set(marker.epoch, here);

    const from = await db.findOne("nodes", { _id: marker.fromNodeId });
    if (from && LOOPBACK.has(from.controlHost)) {
        await db.findOneAndUpdate("nodes", { _id: from._id }, { controlHost: null });
    }
    await db.findOneAndUpdate("nodes", { _id: here }, { controlHost: "127.0.0.1" });

    // Before quests/badges resume and start calling them back. Owned callbacks
    // need nothing: they follow their project.
    const fromAddr = nodeAddress(from);
    if (fromAddr) {
        const n = await callbacks.relocateOrphans(fromAddr);
        if (n) console.log(`[Move] ${n} orphan callback URL(s) that said localhost now point at ${fromAddr} (${from.name})`);
    }

    fs.renameSync(MARKER, path.join(DATA_DIR, `migration-in.done-${Date.now()}.json`));
    return marker;
};

/**
 * After the new panel is active: stop the old one, flip the domain vhosts
 * (proxy here, redirect everywhere else), and leave a notification that says
 * what happened and what is left.
 */
const followUp = async (marker) => {
    const notes = [];
    const here = await nodeService.getNode(marker.toNodeId);
    const from = await db.findOne("nodes", { _id: marker.fromNodeId });

    if (from) {
        for (let attempt = 1; attempt <= 10; attempt++) {
            try {
                const r = await nodeService.agentRequest(from, "post", "/panel-host/retire", { timeout: 30_000 });
                notes.push(`Old panel on ${from.name} stopped${r.retiredEnv ? ` (its .env kept as ${path.basename(r.retiredEnv)})` : ""}`);
                break;
            } catch (err) {
                if (attempt === 10) {
                    notes.push(`Could not stop the old panel on ${from.name} (${err.message}) — run "pm2 delete bot-panel && pm2 save" there`);
                } else {
                    await sleep(30_000);
                }
            }
        }
    }

    // Domains never move and DNS never changes: flip the vhosts instead — this
    // node's domains now serve the panel, every other node's redirect here.
    for (const r of await domainsSvc.sync()) {
        notes.push(
            r.ok
                ? `nginx on ${r.name}: ${r.nodeId === here._id ? "serving the panel" : "redirecting here"}`
                : `nginx on ${r.name || r.nodeId} not updated: ${r.error}`,
        );
    }
    for (const d of domainsSvc.ofNode(await domainsSvc.list(), here._id).filter((x) => !x.sslEnabled)) {
        try {
            await domainsSvc.issueCert(d.domain);
            notes.push(`HTTPS issued for ${d.domain}`);
        } catch (err) {
            notes.push(`HTTPS for ${d.domain} not set up (${err.message.split("\n")[0]}) — use its SSL button`);
        }
    }
    notes.push(`Open the panel at ${domainsSvc.publicUrl(await domainsSvc.list(), here)}`);

    await updateLog(marker.migrationId, { status: "done", finishedAt: Date.now(), notes }).catch(() => {});
    try {
        const { createNotification } = require("../routes/notifications");
        await createNotification(`Panel moved from ${from?.name || marker.fromNodeId} to ${here.name}. ${notes.join(" · ")}`, "info");
    } catch (err) {
        console.error("[Move] notification failed:", err.message);
    }
    console.log(`[Move] Done. ${notes.join(" | ")}`);
};

/** What the Panel page's move section renders — DB only, safe even when fenced. */
const overview = async () => {
    const panelId = process.env.PANEL_NODE_ID || null;
    const nodes = await nodeService.getNodes();
    return {
        lifecycle: lifecycle.get(),
        epoch: panelLease.current(),
        panelNodeId: panelId,
        job: publicJob(),
        history: ((await db.get(LOG_KEY)) || []).slice(-5).reverse(),
        nodes: nodes.map((n) => ({
            _id: n._id,
            name: n.name,
            host: n.host,
            enabled: n.enabled !== false,
            isPanelNode: n._id === panelId,
            online: nodeService.isNodeOnline(n._id),
        })),
    };
};

const runPreflight = async (targetNodeId) => stripCtx(await preflight(targetNodeId));

module.exports = {
    overview,
    runPreflight,
    startPrepare,
    startMove,
    finalizeIncoming,
    followUp,
    setEnvKey,
};
