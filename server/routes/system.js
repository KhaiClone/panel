const express = require("express");
const si = require("systeminformation");
const nodeService = require("../services/nodeService");
const sampleStore = require("../services/sampleStore");
const router = express.Router();

const RANGE_MS = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
};

let cachedStats = null;
let lastFetch = 0;
const CACHE_TTL = 2000;

// Remote-view stats cache — own 2s TTL per node (nodeService.getNodeStats's
// 10s cache is too coarse for the System page's 5s poll).
const remoteCache = new Map(); // nodeId → { at, stats }

/**
 * GET /api/system/stats
 * Returns CPU, RAM, disk, and network I/O.
 * Honors the X-Panel-Node remote-view context: proxies to the node's agent.
 */
router.get("/stats", async (req, res, next) => {
    try {
        const now = Date.now();

        if (req.node) {
            const cached = remoteCache.get(req.nodeId);
            if (cached && now - cached.at < CACHE_TTL) return res.json(cached.stats);
            const stats = await nodeService.agentRequest(req.node, "get", "/stats", { timeout: 8000 });
            remoteCache.set(req.nodeId, { at: Date.now(), stats });
            return res.json(stats);
        }

        if (cachedStats && now - lastFetch < CACHE_TTL) {
            return res.json(cachedStats);
        }

        const [cpuLoad, mem, fsData, temp, cpuInfo, netStats] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.fsSize().catch(() => []),
            si.cpuTemperature().catch(() => ({ main: null })),
            si.cpu().catch(() => ({ brand: null, manufacturer: null })),
            si.networkStats().catch(() => []),
        ]);

        const mainFs =
            fsData.find((f) => f.mount === "/") ||
            fsData.sort((a, b) => b.size - a.size)[0] ||
            null;

        // Pick the first non-loopback interface
        const iface = netStats.find((n) => n.iface && !n.iface.startsWith("lo")) || netStats[0] || null;

        const response = {
            cpu: {
                usagePercent: parseFloat(cpuLoad.currentLoad.toFixed(2)),
                temperature: temp.main ?? null,
                model: cpuInfo.brand
                    ? `${cpuInfo.manufacturer} ${cpuInfo.brand}`.trim()
                    : null,
            },
            memory: {
                totalBytes: mem.total,
                usedBytes: mem.active,
                freeBytes: mem.available,
                usedPercent: parseFloat(((mem.active / mem.total) * 100).toFixed(2)),
            },
            disk: mainFs
                ? {
                      totalBytes: mainFs.size,
                      usedBytes: mainFs.used,
                      freeBytes: mainFs.size - mainFs.used,
                      usedPercent: parseFloat(((mainFs.used / mainFs.size) * 100).toFixed(2)),
                      mount: mainFs.mount,
                      fs: mainFs.type,
                  }
                : null,
            network: iface
                ? {
                      rxBytesPerSec: iface.rx_sec ?? 0,
                      txBytesPerSec: iface.tx_sec ?? 0,
                      iface: iface.iface,
                  }
                : null,
        };

        cachedStats = response;
        lastFetch = Date.now();
        res.json(response);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/system/history?node=<id|local>&range=1h|6h|24h|7d
 * Persistent resource history recorded by samplerService, down-sampled to
 * ~720 points so charts stay light. node defaults to the remote-view context.
 */
router.get("/history", (req, res, next) => {
    try {
        const nodeId = req.query.node || req.nodeId || nodeService.LOCAL_NODE_ID;
        const rangeMs = RANGE_MS[req.query.range] || RANGE_MS["6h"];
        const rows = sampleStore.query(nodeId, Date.now() - rangeMs);

        const TARGET = 720;
        if (rows.length <= TARGET) return res.json(rows);

        // Bucket-average down to ~TARGET points
        const bucket = Math.ceil(rows.length / TARGET);
        const out = [];
        for (let i = 0; i < rows.length; i += bucket) {
            const slice = rows.slice(i, i + bucket);
            const avg = (k) => {
                const vals = slice.map((r) => r[k]).filter((v) => v != null);
                return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
            };
            out.push({
                ts: slice[slice.length - 1].ts,
                cpu: avg("cpu"), ram: avg("ram"), disk: avg("disk"), rx: avg("rx"), tx: avg("tx"),
            });
        }
        res.json(out);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
