const express = require("express");
const si = require("systeminformation");
const router = express.Router();

let cachedStats = null;
let lastFetch = 0;
const CACHE_TTL = 2000;

/**
 * GET /api/system/stats
 * Returns CPU, RAM, disk, and network I/O.
 */
router.get("/stats", async (req, res, next) => {
    try {
        const now = Date.now();
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

module.exports = router;
