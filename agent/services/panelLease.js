const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
//  Panel lease — which panel this agent takes orders from.
//
//  The panel can move to another node. Afterwards the OLD panel must never
//  drive this agent again: a panel restored from a stale PM2 dump, or a VPS
//  that comes back after the panel was moved off it, would otherwise keep
//  running expiry/quests against the same nodes as the new one.
//
//  Every panel carries an epoch (a counter bumped on each move). It sends it in
//  the x-panel-epoch header; the agent remembers the highest epoch it has been
//  told to follow and answers 409 PANEL_SUPERSEDED to anything lower. That 409
//  is how an old panel learns it has been replaced and stops itself.
//
//  Requests WITHOUT the header pass: older panels, and the few read-only probes
//  a panel deliberately sends unfenced (reading /lease itself).
//
//  A claim also carries panelUrl — where the panel answers as seen from THIS
//  machine (127.0.0.1 on its own node, its WireGuard IP elsewhere). The panel
//  gateway (services/panelGateway.js) forwards local projects' calls there.
// ─────────────────────────────────────────────────────────────────────────────

// PANEL_LEASE_PATH lets the test suite use a throwaway file; production never sets it.
const LEASE_PATH = process.env.PANEL_LEASE_PATH || path.join(__dirname, "..", ".panel-lease.json");
const EPOCH_HEADER = "x-panel-epoch";
const SUPERSEDED = "PANEL_SUPERSEDED";

let cache = null;

/** The lease on disk. { epoch: 0 } means no panel has claimed this agent yet. */
const read = () => {
    if (cache) return cache;
    try {
        const raw = JSON.parse(fs.readFileSync(LEASE_PATH, "utf8"));
        cache = {
            epoch: Number.isInteger(raw.epoch) ? raw.epoch : 0,
            panelNodeId: raw.panelNodeId || null,
            panelUrl: raw.panelUrl || null,
            updatedAt: raw.updatedAt || null,
        };
    } catch {
        cache = { epoch: 0, panelNodeId: null, panelUrl: null, updatedAt: null };
    }
    return cache;
};

/** http(s)://host[:port] and nothing else — the gateway puts the request path after it. */
const validPanelUrl = (url) => {
    if (typeof url !== "string" || !/^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(url)) return false;
    try {
        const u = new URL(url);
        return !u.username && !u.password && u.pathname === "/" && !u.search;
    } catch {
        return false;
    }
};

/** Atomic write: a half-written lease would reset the epoch to 0 on the next read. */
const write = (lease) => {
    const tmp = `${LEASE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(lease, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, LEASE_PATH);
    cache = lease;
};

/**
 * Follow the panel at `epoch`. Claims at or above the current epoch win (the
 * same panel re-claims on every boot, and every few minutes to keep panelUrl
 * fresh); a lower one is refused. A claim without panelUrl (an older panel)
 * keeps the known one only for the same epoch — a new epoch is a new panel.
 */
const claim = (epoch, panelNodeId, panelUrl) => {
    if (!Number.isInteger(epoch) || epoch < 1) {
        const err = new Error("epoch must be a positive integer");
        err.status = 400;
        throw err;
    }
    if (panelUrl != null && !validPanelUrl(panelUrl)) {
        const err = new Error("panelUrl must look like http://host:port");
        err.status = 400;
        throw err;
    }
    const current = read();
    if (epoch < current.epoch) return { ok: false, lease: current };
    const url = panelUrl ?? (epoch === current.epoch ? current.panelUrl : null);
    if (epoch === current.epoch && (panelNodeId || null) === current.panelNodeId && url === current.panelUrl) {
        return { ok: true, lease: current }; // a periodic re-claim: nothing to write
    }
    const next = { epoch, panelNodeId: panelNodeId || null, panelUrl: url, updatedAt: Date.now() };
    write(next);
    return { ok: true, lease: next };
};

/** Express middleware — mounted after the agent-key check. */
const middleware = (req, res, next) => {
    const raw = req.headers[EPOCH_HEADER];
    if (raw === undefined) return next();

    const epoch = Number(raw);
    const current = read();
    if (Number.isInteger(epoch) && epoch >= current.epoch) return next();

    res.status(409).json({
        error: `This node now follows the panel on another server (epoch ${current.epoch})`,
        code: SUPERSEDED,
        lease: current,
    });
};

module.exports = { read, claim, middleware, EPOCH_HEADER, SUPERSEDED, LEASE_PATH };
