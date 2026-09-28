const fs = require("fs");
const os = require("os");
const net = require("net");
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
const cloudflare = require("./cloudflareService");

// ─────────────────────────────────────────────────────────────────────────────
//  Moving the panel to another node.
//
//  The panel running NOW drives the whole move, so the Panel page can show every
//  step live:
//
//    preflight   read-only checks; run as often as you like
//    prepare     firewall access for the new host on every agent, then on the
//                target: git pull, deps, client build, nginx site. Nothing is
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
const PANEL_DOMAINS_KEY = "panel_domains";
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

/**
 * Set (or drop, with null) one KEY=value line in .env text, keeping every other
 * line where it was. Same rules as agent/utils/envFile.js.
 */
const setEnvKey = (text, key, value) => {
    const out = [];
    let done = false;
    for (const line of String(text || "").split("\n")) {
        const idx = line.indexOf("=");
        const isKey = idx > 0 && !line.trim().startsWith("#") && line.slice(0, idx).trim() === key;
        if (!isKey) {
            out.push(line);
            continue;
        }
        if (!done && value !== null) out.push(`${key}=${value}`);
        done = true;
    }
    if (!done && value !== null) {
        while (out.length && out[out.length - 1] === "") out.pop();
        out.push(`${key}=${value}`, "");
    }
    return out.join("\n");
};

/** Consistent copy of a live SQLite file (online backup API — safe while it is open). */
const backupSqlite = async (src, dest) => {
    const conn = new Database(src, { fileMustExist: true });
    try {
        await conn.backup(dest);
    } finally {
        conn.close();
    }
};

const panelDomains = async () => ((await db.get(PANEL_DOMAINS_KEY)) || []).map((d) => d.domain);

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

const assertIdle = () => {
    if (job?.status === "running") throw httpError(409, `A ${job.kind} to ${job.targetName} is already running`);
    if (!lifecycle.isActive()) throw httpError(409, `The panel is ${lifecycle.get().state}`);
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

    ctx.domains = await panelDomains();
    if (ctx.domains.length && !status.nginx) {
        add("error", "nginx", `nginx is not installed on ${target.name} — ${ctx.domains.join(", ")} could not be served`);
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

    // Integrations, as the NEW panel will resolve them.
    const integrationTargets = [];
    for (const name of Object.keys(integrations.DEFS)) {
        const label = integrations.DEFS[name].label;
        let r;
        try {
            r = await integrations.resolve(name, { fromNodeId: target._id });
        } catch (err) {
            add("error", `integration:${name}`, err.message);
            continue;
        }
        if (r.source === "env" && integrations.isLoopbackUrl(r.url)) {
            add(
                "error",
                `integration:${name}`,
                `${label} uses ${integrations.DEFS[name].env}=${r.url} — after the move that address is ${target.name} itself. Link it to its project under Integrations first.`,
            );
        } else if (r.source === "project" && !r.local) {
            integrationTargets.push({ name, label, ...r });
        } else if (r.source === "project") {
            add("ok", `integration:${name}`, `${label} → ${r.botName} on the same node (127.0.0.1:${r.port})`);
        }
    }

    const probeTargets = [
        ...others.map((n) => ({ host: n.host, port: n.port })),
        ...integrationTargets.map((t) => ({ host: t.host, port: t.port })),
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
    for (const t of integrationTargets) {
        const p = reachable(t.host, t.port);
        if (p?.ok) add("ok", `integration:${t.name}`, `${t.label} → ${t.botName} at ${t.url}`);
        else {
            const node = await nodeService.getNode(t.nodeId).catch(() => null);
            const from = target.wgOverlayIp || target.host;
            add(
                "error",
                `integration:${t.name}`,
                `${target.name} cannot reach ${t.label} at ${t.url}${p?.error ? ` (${p.error})` : ""}. ` +
                    `On ${node?.name || "that node"}: sudo ufw allow in on wg0 from ${from} to any port ${t.port} proto tcp`,
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

    // ── DNS ──────────────────────────────────────────────────────────────────
    if (!ctx.domains.length) {
        add("info", "dns", `No panel domain — after the move the panel answers on ${target.name}'s address`);
    } else if (cloudflare.configured()) {
        try {
            const zone = await cloudflare.verify();
            const outside = ctx.domains.filter((d) => d !== zone.name && !d.endsWith(`.${zone.name}`));
            if (outside.length) add("warn", "dns", `Not in the Cloudflare zone ${zone.name}: ${outside.join(", ")} — change those by hand`);
            if (!net.isIPv4(target.host)) add("warn", "dns", `${target.host} is not an IPv4 address — the A record cannot be set automatically`);
            else add("ok", "dns", `DNS: ${ctx.domains.join(", ")} → ${target.host} via Cloudflare (${zone.name})`);
        } catch (err) {
            add("warn", "dns", `${err.message} — DNS would have to be changed by hand`);
        }
    } else {
        add("warn", "dns", `DNS is not automated (CF_API_TOKEN / CF_ZONE_ID unset) — after the move, point ${ctx.domains.join(", ")} to ${target.host}`);
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
    assertIdle();
    const pf = await preflight(targetNodeId);
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
                await runStep(`nginx site for ${domains.join(", ")} on ${target.name}`, async (step) => {
                    await nodeService.agentRequest(target, "post", "/nginx/panel-config", {
                        data: { domains, port: panelPort() },
                        timeout: 60_000,
                    });
                    step.detail = "HTTP only for now — HTTPS is issued once the domain points there";
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
    assertIdle();
    const pf = await preflight(targetNodeId);
    if (!pf.canMove) {
        const first = pf.checks.find((c) => c.level === "error");
        throw httpError(400, `Preflight failed: ${first?.message || "no checks ran"}`);
    }
    const { target, domains } = pf.ctx;
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
                step.detail = `PANEL_NODE_ID → ${target._id}`;
                return setEnvKey(raw, "PANEL_NODE_ID", target._id);
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

            finish("done", null, {
                target: { _id: target._id, name: target.name, host: target.host },
                domains,
                dnsAutomated: cloudflare.configured(),
                port: panelPort(),
            });
            lifecycle.fence({ reason: "moved", to: target.name, byNodeId: target._id });
        } catch (err) {
            if (!committed) committed = await leaseClaimedAnywhere(newEpoch).catch(() => false);
            if (committed) {
                finish("failed", `${err.message}. The panel on ${target.name} has already taken control — do not retry; check it there.`);
                lifecycle.fence({ reason: "moved", to: target.name, byNodeId: target._id });
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
    if (marker.epoch > panelLease.current()) await panelLease.set(marker.epoch, here);

    const from = await db.findOne("nodes", { _id: marker.fromNodeId });
    if (from && LOOPBACK.has(from.controlHost)) {
        await db.findOneAndUpdate("nodes", { _id: from._id }, { controlHost: null });
    }
    await db.findOneAndUpdate("nodes", { _id: here }, { controlHost: "127.0.0.1" });

    fs.renameSync(MARKER, path.join(DATA_DIR, `migration-in.done-${Date.now()}.json`));
    return marker;
};

/**
 * After the new panel is active: stop the old one, point DNS here, re-issue
 * HTTPS, and leave a notification that says what happened and what is left.
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

    const domains = (await db.get(PANEL_DOMAINS_KEY)) || [];
    if (domains.length) {
        if (cloudflare.configured() && net.isIPv4(here.host)) {
            for (const d of domains) {
                try {
                    const r = await cloudflare.pointARecord(d.domain, here.host);
                    notes.push(`DNS ${d.domain} → ${here.host} (${r.action}${r.proxied ? ", proxied" : ""})`);
                } catch (err) {
                    notes.push(`DNS ${d.domain}: ${err.message}`);
                }
            }
        } else {
            notes.push(`Point ${domains.map((d) => d.domain).join(", ")} to ${here.host} — DNS is not automated`);
        }

        // certbot can only succeed once the name resolves here.
        const secured = domains.filter((d) => d.sslEnabled);
        if (secured.length) {
            await sleep(20_000);
            const still = [];
            for (const d of secured) {
                try {
                    await panelService.enablePanelSSL(d.domain);
                    notes.push(`HTTPS re-issued for ${d.domain}`);
                } catch (err) {
                    still.push(d.domain);
                    notes.push(`HTTPS for ${d.domain} not set up yet (${err.message.split("\n")[0]}) — use its SSL button once DNS points here`);
                }
            }
            if (still.length) {
                await db.set(PANEL_DOMAINS_KEY, domains.map((d) => (still.includes(d.domain) ? { ...d, sslEnabled: false } : d)));
            }
        }
    }

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
