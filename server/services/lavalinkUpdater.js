const cron = require("node-cron");

const store = require("./lavalinkStore");
const lavalink = require("./lavalinkService");
const discord = require("./discordService");

// ─────────────────────────────────────────────────────────────────────────────
//  Daily Lavalink release check — 02:00 Asia/Ho_Chi_Minh by default.
//
//  Nodes are updated ONE AT A TIME on purpose. Restarting Lavalink drops every
//  voice session on that node, and the agent proves the new jar answers
//  /version before moving on; a bad release therefore costs one node, not the
//  whole fleet. The agent rolls itself back, so a failure leaves that node on
//  the old version rather than down.
//
//  Quiet by design: a check that finds nothing new sends no Discord message.
//  Only a real update — or a failure during one — is worth a ping.
// ─────────────────────────────────────────────────────────────────────────────

const SCHEDULE = "0 2 * * *";

let task = null;
let running = false;

/** Numeric tag compare: "4.2.10" > "4.2.9". Unparseable parts sort as 0. */
const cmpVersion = (a, b) => {
    const parts = (v) => String(v || "").replace(/^v/, "").split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
    const A = parts(a);
    const B = parts(b);
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
        if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
    }
    return 0;
};

/** States that cannot take an update — reported, never retried into a failure. */
const SKIP_STATES = new Set(["node-offline", "agent-outdated", "java-missing", "java-too-old"]);

/**
 * One full pass: resolve the latest release, then bring every node up to it.
 *
 * @param {Object} opts
 * @param {boolean} opts.manual - true when a human pressed "Check now"; makes
 *   the result verbose even when there is nothing to do.
 */
const run = async ({ manual = false } = {}) => {
    if (running) return { skipped: "A Lavalink update run is already in progress" };
    running = true;

    try {
        const settings = await store.get();
        if (!settings.enabled) {
            return { skipped: "Lavalink is disabled in the panel settings" };
        }

        let release;
        try {
            release = await lavalink.latestRelease({ force: true });
        } catch (err) {
            const message = `Could not read the latest Lavalink release from GitHub: ${err.message}`;
            await store.setMeta({ lastCheckAt: Date.now(), lastError: message });
            console.error(`[Lavalink] ${message}`);
            if (manual) throw err;
            return { ok: false, error: message };
        }

        await store.setMeta({
            latestVersion: release.version,
            latestPublishedAt: release.publishedAt,
            lastCheckAt: Date.now(),
            lastError: null,
        });

        const { nodes } = await lavalink.statusAll();

        // A release that already failed on a node is not retried by the daily
        // job — it would re-download 100MB and restart that node every night for
        // a jar known not to work there. The per-node Update button ignores this.
        const failedBefore = (n) => settings.nodes?.[n.nodeId]?.failedVersion === release.version;

        const outdated = nodes.filter(
            (n) =>
                !SKIP_STATES.has(n.state) &&
                !failedBefore(n) &&
                (!n.version || cmpVersion(n.version, release.version) < 0),
        );
        const skipped = [
            ...nodes.filter((n) => SKIP_STATES.has(n.state)),
            ...nodes.filter((n) => !SKIP_STATES.has(n.state) && failedBefore(n)).map((n) => ({ ...n, state: "update-failed-before" })),
        ];

        if (outdated.length === 0) {
            // Record the fleet version when at least one node actually confirmed
            // it — offline, java-less and previously-failed nodes are no evidence.
            if (nodes.some((n) => !SKIP_STATES.has(n.state) && !failedBefore(n))) {
                await store.setMeta({ installedVersion: release.version });
            }
            console.log(`[Lavalink] Every node is on ${release.version} — nothing to do`);
            return { ok: true, release, upToDate: true, nodes, skipped };
        }

        // autoUpdate off: report the new version and let a human press the button.
        if (!settings.autoUpdate) {
            await discord.sendLavalinkReport({
                title: "🎵 Lavalink có bản mới",
                color: 0x5865f2,
                version: release.version,
                url: release.url,
                description:
                    `Tự động cập nhật đang **tắt** — ${outdated.length} node vẫn ở bản cũ. ` +
                    "Vào trang Lavalink của panel để cập nhật tay.",
                results: outdated.map((n) => ({ nodeName: n.nodeName, ok: null, version: n.version })),
                skipped,
            });
            return { ok: true, release, autoUpdate: false, outdated, skipped };
        }

        console.log(`[Lavalink] Updating ${outdated.length} node(s) to ${release.version}`);

        const records = await lavalink.managedNodes();
        const results = [];
        for (const entry of outdated) {
            const node = records.find((n) => n._id === entry.nodeId);
            if (!node) continue;
            const from = entry.version;
            const result = await lavalink.updateNode(node, release);
            results.push({ ...result, from });
            console.log(
                `[Lavalink] ${node.name}: ${from || "unknown"} → ${release.version} — ` +
                    (result.ok ? "ok" : `FAILED (${result.error})`),
            );
        }

        const allOk = results.every((r) => r.ok);
        await store.setMeta({
            lastUpdateAt: Date.now(),
            // installedVersion is the fleet's version, so it only moves when the
            // whole fleet moved. A partial run leaves it on the old tag.
            ...(allOk ? { installedVersion: release.version } : {}),
        });

        await discord.sendLavalinkReport({
            title: allOk ? "🎵 Lavalink đã cập nhật" : "⚠️ Lavalink cập nhật chưa trọn vẹn",
            color: allOk ? 0x57f287 : 0xff8c00,
            version: release.version,
            url: release.url,
            description: allOk
                ? `Đã cập nhật ${results.length} node lên **${release.version}** và restart xong.`
                : `${results.filter((r) => r.ok).length}/${results.length} node lên được **${release.version}**. ` +
                  "Node lỗi đã được rollback về bản cũ và vẫn đang chạy.",
            results,
            skipped,
        });

        for (const r of results.filter((x) => !x.ok)) {
            try {
                const { createNotification } = require("../routes/notifications");
                await createNotification(
                    `Lavalink update to ${release.version} failed on "${r.nodeName}": ${r.error}`,
                    "error",
                );
            } catch { /* best-effort */ }
        }

        return { ok: allOk, release, results, skipped };
    } finally {
        running = false;
    }
};

/** (Re)arm the daily job. Called at boot and whenever the timezone changes. */
const start = async () => {
    if (task) {
        task.stop();
        task = null;
    }
    let timezone = "Asia/Ho_Chi_Minh";
    try {
        timezone = (await store.get()).timezone || timezone;
    } catch (err) {
        console.warn(`[Lavalink] Could not read settings, using ${timezone}:`, err.message);
    }

    task = cron.schedule(SCHEDULE, () => {
        run().catch((err) => console.error("[Lavalink] Scheduled run failed:", err.message));
    }, { timezone });

    console.log(`[Lavalink] Release check scheduled — 02:00 ${timezone}`);
};

module.exports = { start, run, cmpVersion, SCHEDULE };
