// The panel's own Discord messages — editable on the Embeds page like any bot's
// (services/panelTemplates.js registers this catalog under the project "__panel").
// Same format as a bot's templates/*.js (bot-lib/MessageTemplates.js).

const field = (name, value, inline = true, more = {}) => ({ name, value, inline, ...more });
const notice = (group, label, embed, vars, extra = {}) => ({ group, label, vars, ...extra, message: { ...(extra.message || {}), embeds: [embed] } });

const G = {
    expiry: "Panel · bot hết hạn (webhook cảnh báo + DM khách)",
    lavalink: "Panel · Lavalink",
    backup: "Panel · backup",
};
const EXTEND = field("🔗 Extend This Bot", "<#1480431381808152586> or create ticket at <#1246028759597846650> for a support.", false);
const WHERE = { type: "string", label: "alert (webhook DISCORD_ALERT_WEBHOOK) / dm (tin riêng cho khách)", example: "alert" };
const PING = '{#if where == "alert"}<@{customerBot.buyerID}>{/if}';

module.exports = {
    types: {
        hostedBot: {
            label: "Bot của khách",
            text: "name",
            fields: {
                id: { label: "ID trên panel", example: "66f0c0ffee" },
                name: { label: "Tên bot", example: "MusicBot" },
                botID: { label: "Bot ID", example: "1234567890123456789" },
                buyerID: { type: "id", label: "ID khách" },
                expiresAt: { type: "time", label: "Hết hạn lúc" },
                maxMemory: { label: "RAM tối đa", example: "128M" },
            },
        },
        lavalinkResult: {
            label: "Kết quả một node",
            text: "nodeName",
            fields: {
                nodeName: { label: "Tên node", example: "VPS sangs" },
                state: { label: "pending (chưa cập nhật) / ok / failed", example: "ok" },
                from: { label: "Bản đang chạy trước đó", example: "4.0.8" },
                started: { type: "boolean", label: "Đã chạy lại (false = node vốn đang tắt)", example: true },
                error: { label: "Lỗi (failed)", example: "" },
                rolledBack: { type: "boolean", label: "Đã rollback về bản cũ", example: false },
            },
        },
        lavalinkSkip: {
            label: "Node bị bỏ qua",
            text: "nodeName",
            fields: {
                nodeName: { label: "Tên node", example: "VPS dio" },
                state: { label: "Trạng thái", example: "offline" },
            },
        },
        backupDb: {
            label: "Một database trong backup",
            text: "kind",
            fields: {
                kind: { label: "panel / shared", example: "panel" },
                size: { label: "Kích thước", example: "12.4 MB" },
                gz: { label: "Sau khi nén", example: "3.1 MB" },
                chunks: { type: "number", label: "Số mảnh", example: 1 },
                hash8: { label: "SHA-256 (8 ký tự đầu)", example: "a1b2c3d4" },
            },
        },
    },
    globals: {},

    templates: {
        // ── Bot hết hạn ──────────────────────────────────────────────────────
        "panel.expiry.warning": notice(
            G.expiry,
            "Sắp hết hạn",
            {
                title: "⚠️ Bot Expiry Warning",
                color: "{#if hoursLeft <= 24}#ff4444{#elseif hoursLeft <= 72}#ff8c00{#else}#ffd700{/if}",
                description: "**Bot is expiring soon!**",
                fields: [
                    field("🤖 Bot Name", "{customerBot.name}"),
                    field("🆔 Bot ID", "`{customerBot.botID}`"),
                    field("⏳ Time Left", "**{hoursLeft}** hour(s)"),
                    field("📅 Expires At", "{customerBot.expiresAt|time:F}"),
                    EXTEND,
                ],
                timestamp: true,
            },
            { customerBot: "hostedBot", hoursLeft: { type: "number", label: "Số giờ còn lại", example: 48 }, where: WHERE },
            { description: "Gửi vào webhook cảnh báo (where = alert, kèm ping khách) và DM khách (where = dm).", message: { content: PING } },
        ),
        "panel.expiry.suspended": notice(
            G.expiry,
            "Đã hết hạn — tạm dừng",
            {
                title: "🛑 Bot Expired & Suspended",
                color: "#ff0000",
                description: "**Your bot has expired and has been stopped.** Please extend the expiry within 7 days to avoid permanent deletion.",
                fields: [field("🤖 Bot Name", "{customerBot.name}"), field("🆔 Bot ID", "`{customerBot.botID}`"), field("📅 Expired At", "{customerBot.expiresAt|time:F}"), EXTEND],
                timestamp: true,
            },
            { customerBot: "hostedBot", where: WHERE },
            { message: { content: PING } },
        ),
        "panel.expiry.removed": notice(
            G.expiry,
            "Đã hết hạn — xoá hẳn",
            {
                title: "🗑️ Bot Expired & Auto-Removed",
                color: "#ff0000",
                fields: [
                    field("🤖 Bot Name", "{customerBot.name}"),
                    field("🆔 Bot ID", "{customerBot.botID}"),
                    field("👤 Buyer ID", "`{customerBot.buyerID}`"),
                    field("📅 Expired At", "{customerBot.expiresAt|time:F}", false),
                ],
                footer: { text: "Bot folder has been deleted from the server." },
                timestamp: true,
            },
            { customerBot: "hostedBot", where: WHERE },
        ),

        // ── Lavalink ─────────────────────────────────────────────────────────
        "panel.lavalink.report": notice(
            G.lavalink,
            "Báo cáo kiểm tra / cập nhật",
            {
                title: '{#if kind == "available"}🎵 Lavalink có bản mới{#elseif kind == "updated"}🎵 Lavalink đã cập nhật{#else}⚠️ Lavalink cập nhật chưa trọn vẹn{/if}',
                url: "{url}",
                color: '{#if kind == "available"}#5865f2{#elseif kind == "updated"}#57f287{#else}#ff8c00{/if}',
                description:
                    '{#if kind == "available"}Tự động cập nhật đang **tắt** — {outdatedCount} node vẫn ở bản cũ. Vào trang Lavalink của panel để cập nhật tay.{#elseif kind == "updated"}Đã cập nhật {total} node lên **{version}** và restart xong.{#else}{okCount}/{total} node lên được **{version}**. Node lỗi đã được rollback về bản cũ và vẫn đang chạy.{/if}',
                fields: [
                    {
                        ...field(
                            "Node",
                            '{#each results}{#if state == "pending"}• ⏳ **{nodeName}** — đang ở `{from|default:"?"}`{#elseif state == "ok"}• ✅ **{nodeName}** — `{from|default:"?"}` → `{version}`{#if !started} _(vẫn đang tắt)_{/if}{#else}• ❌ **{nodeName}** — {#if rolledBack}đã rollback về bản cũ{#else}thất bại{/if}: {error}{/if}{#if !@last}\n{/if}{/each}',
                            false,
                        ),
                        if: "results",
                    },
                    { ...field("Bỏ qua", "{#each skipped}• {nodeName} — `{state}`{#if !@last}\n{/if}{/each}", false), if: "skipped" },
                ],
                footer: { text: "Lavalink {version}" },
                timestamp: true,
            },
            {
                kind: { type: "string", label: "available (có bản mới, tự cập nhật tắt) / updated / partial", example: "updated" },
                version: { type: "string", label: "Bản mới", example: "4.1.1" },
                url: "url",
                results: "lavalinkResult[]",
                skipped: "lavalinkSkip[]",
                total: { type: "number", label: "Số node đã thử", example: 3 },
                okCount: { type: "number", label: "Số node thành công", example: 3 },
                outdatedCount: { type: "number", label: "Số node còn bản cũ", example: 2 },
            },
            { description: "Gửi vào DISCORD_LAVALINK_WEBHOOK (không có thì DISCORD_ALERT_WEBHOOK)." },
        ),

        // ── Backup ───────────────────────────────────────────────────────────
        "panel.backup.message": {
            group: G.backup,
            label: "Tin backup (kèm file)",
            description: "Nội dung tin đính kèm các file backup. Rollback đọc file đính kèm, không đọc chữ — sửa thoải mái.",
            vars: {
                ts: { type: "string", label: "Thời điểm backup", example: "04/10/2026 13:00" },
                dbs: "backupDb[]",
                env: { type: "boolean", label: "Có kèm .env", example: true },
            },
            message: {
                content:
                    "Backup • {ts}\n{#each dbs}{kind}.sqlite {size} → {gz} ({chunks} mảnh) · SHA-256 {hash8}…\n{/each}{#if env}+ .env{#else}(không có .env){/if}\nRollback: Copy Message Link → Panel Settings → Backup & Rollback",
            },
        },
    },
};
