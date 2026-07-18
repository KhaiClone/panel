const express = require("express");
const os = require("os");
const si = require("systeminformation");
const router = express.Router();
const { getProcessList } = require("../services/pm2");

const AGENT_VERSION = require("../package.json").version;

/**
 * GET /health
 * Cheap liveness probe — the panel polls this to mark nodes online/offline.
 */
router.get("/health", (req, res) => {
    res.json({ ok: true, version: AGENT_VERSION, uptime: process.uptime() });
});

let cachedStats = null;
let lastFetch = 0;
const CACHE_TTL = 2000;

/**
 * GET /stats
 * Same response shape as the panel's /api/system/stats, plus the PM2 process
 * count — this is what the scheduler scores nodes with.
 */
router.get("/stats", async (req, res, next) => {
    try {
        const now = Date.now();
        if (cachedStats && now - lastFetch < CACHE_TTL) {
            return res.json(cachedStats);
        }

        const [cpuLoad, mem, fsData, temp, cpuInfo, netStats, pm2List] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.fsSize().catch(() => []),
            si.cpuTemperature().catch(() => ({ main: null })),
            si.cpu().catch(() => ({ brand: null, manufacturer: null })),
            si.networkStats().catch(() => []),
            getProcessList(),
        ]);

        const mainFs =
            fsData.find((f) => f.mount === "/") ||
            fsData.sort((a, b) => b.size - a.size)[0] ||
            null;

        const iface = netStats.find((n) => n.iface && !n.iface.startsWith("lo")) || netStats[0] || null;

        const response = {
            cpu: {
                usagePercent: parseFloat(cpuLoad.currentLoad.toFixed(2)),
                temperature: temp.main ?? null,
                // Fall back to Node's os.cpus() — some VMs leave si.cpu().brand empty
                model: cpuInfo.brand
                    ? `${cpuInfo.manufacturer} ${cpuInfo.brand}`.trim()
                    : (os.cpus()[0]?.model || null),
                cores: cpuLoad.cpus?.length ?? null,
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
            uptime: os.uptime(),
            processCount: pm2List.length,
        };

        cachedStats = response;
        lastFetch = Date.now();
        res.json(response);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
