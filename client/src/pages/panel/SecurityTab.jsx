// ─────────────────────────────────────────────────────────────────────────────
//  Panel Settings → Security: the IPs the owner account works from.
//
//  The owner's username + password work only from approved IPs. From any other
//  IP the panel's bot asks in the panel log channel on Discord (Allow / Deny):
//  Allow remembers the IP, Deny keeps that IP from asking again for a day, and
//  an IP unused for 30 days is forgotten. ADMIN_ALLOWED_IPS in .env always
//  works — the way back in when Discord is down. The server checks the IP on
//  every request (server/services/ownerAccess.js, middleware/auth.js).
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from "react";
import api from "../../api/client";
import ConfirmModal from "../../components/ConfirmModal";
import { DataTable, EmptyState, Icon, Notice, StatusBadge } from "../../components/ui";
import Section from "./Section";

const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "—");

function DiscordStatus({ discord }) {
    return (
        <Section
            icon="shieldCheck"
            title="Approvals on Discord"
            hint="Where a sign-in from a new IP is allowed or denied"
            actions={<StatusBadge tone={discord.ok ? "success" : "danger"}>{discord.ok ? "Ready" : "Not working"}</StatusBadge>}
        >
            {discord.ok ? (
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                    {discord.botTag || "The panel's bot"} posts them in <strong>#{discord.channel}</strong>
                    {discord.guild ? <> ({discord.guild})</> : null}, the panel log channel.
                </p>
            ) : (
                <Notice tone="warning">
                    Approvals cannot be posted: {discord.error}. Until this is fixed only the IPs below get in. Invite the panel&apos;s bot to the
                    server of the approval channel with View Channel, Send Messages, Embed Links and Mention @everyone.
                </Notice>
            )}
        </Section>
    );
}

export default function SecurityTab() {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [confirm, setConfirm] = useState(null);

    const load = useCallback(async () => {
        try {
            const { data: d } = await api.get("/owner-ips");
            setData(d);
            setError("");
        } catch (err) {
            setError(errMsg(err, "Could not load the owner IPs"));
        }
    }, []);

    useEffect(() => { load(); }, [load]);
    // Waiting sign-ins and last-used times change on their own.
    useEffect(() => {
        const t = setInterval(load, 15_000);
        return () => clearInterval(t);
    }, [load]);

    const act = async (path, ip, fallback) => {
        try {
            await api.post(`/owner-ips/${path}`, { ip });
            load();
        } catch (err) {
            setError(errMsg(err, fallback));
        } finally { setConfirm(null); }
    };

    if (!data) {
        return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>{error || "Loading…"}</div>;
    }
    const { ips, env, blocked, pending, discord, currentIp, limits } = data;
    const here = <StatusBadge tone="success">This device</StatusBadge>;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {confirm && <ConfirmModal {...confirm} onCancel={() => setConfirm(null)} />}

            <DiscordStatus discord={discord} />

            {error && <Notice tone="danger">{error}</Notice>}

            <Section
                icon="lock"
                title="Owner IPs"
                hint={`The owner account works only from these. Unused for ${limits.forgetDays} days = forgotten.${currentIp ? ` You are on ${currentIp}.` : ""}`}
                flush
            >
                {ips.length === 0 && env.length === 0 ? (
                    <EmptyState compact icon="lock" title="No IP yet" description="The first sign-in from each IP is allowed on Discord." />
                ) : (
                    <DataTable flush columns={["IP", "Approved", "Last used", "Forgotten on", ""]} minWidth={640}>
                        {env.map((e) => (
                            <tr key={`env-${e.ip}`}>
                                <td>
                                    <span className="mono" style={{ whiteSpace: "nowrap" }}>{e.ip}</span> {e.current && here}
                                </td>
                                <td className="nowrap">
                                    ADMIN_ALLOWED_IPS
                                    <div className="cell-sub">in .env</div>
                                </td>
                                <td className="muted">—</td>
                                <td className="muted">Never</td>
                                <td className="actions" />
                            </tr>
                        ))}
                        {ips.map((e) => (
                            <tr key={e.ip}>
                                <td>
                                    <span className="mono" style={{ whiteSpace: "nowrap" }}>{e.ip}</span> {e.current && here}
                                    {e.ua && (
                                        <div className="cell-sub" title={e.ua} style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            {e.ua}
                                        </div>
                                    )}
                                </td>
                                <td className="nowrap">
                                    {fmtDate(e.approvedAt)}
                                    {e.approvedBy && <div className="cell-sub">by {e.approvedBy}</div>}
                                </td>
                                <td className="nowrap muted">{fmtDate(e.lastSeenAt)}</td>
                                <td className="nowrap muted">{fmtDate(e.forgetAt)}</td>
                                <td className="actions">
                                    <button
                                        className="btn-ghost btn-sm"
                                        title="The owner account stops working from this IP"
                                        onClick={() => setConfirm({
                                            title: `Remove ${e.ip}?`,
                                            message: e.current
                                                ? "This is the IP you are using now: you are signed out at once, and getting back in needs Allow on Discord."
                                                : "The owner account stops working from this IP. Signing in from it again needs Allow on Discord.",
                                            confirmText: "Remove",
                                            onConfirm: () => act("remove", e.ip, "Could not remove the IP"),
                                        })}
                                    >
                                        <Icon name="trash" />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </DataTable>
                )}
            </Section>

            {pending.length > 0 && (
                <Section icon="hourglass" title="Waiting for approval" hint={`Answer on Discord — each request expires after ${limits.waitMinutes} minutes`} flush>
                    <DataTable flush columns={["IP", "Browser", "Asked", "Expires"]} minWidth={560}>
                        {pending.map((p) => (
                            <tr key={p.id}>
                                <td className="mono nowrap">{p.ip}</td>
                                <td className="muted" style={{ fontSize: 12, maxWidth: 320, overflowWrap: "anywhere" }}>{p.ua || "—"}</td>
                                <td className="nowrap">{fmtDate(p.createdAt)}</td>
                                <td className="nowrap muted">{fmtDate(p.expiresAt)}</td>
                            </tr>
                        ))}
                    </DataTable>
                </Section>
            )}

            {blocked.length > 0 && (
                <Section icon="xCircle" title="Denied" hint={`These IPs cannot ask again until the time shown (${limits.denyHours} hours after Deny)`} flush>
                    <DataTable flush columns={["IP", "Denied by", "Until", ""]} minWidth={520}>
                        {blocked.map((b) => (
                            <tr key={b.ip}>
                                <td className="mono nowrap">{b.ip}</td>
                                <td className="nowrap">{b.by || "—"}</td>
                                <td className="nowrap muted">{fmtDate(b.until)}</td>
                                <td className="actions">
                                    <button className="btn-ghost btn-sm" onClick={() => act("unblock", b.ip, "Could not unblock the IP")}>Unblock</button>
                                </td>
                            </tr>
                        ))}
                    </DataTable>
                </Section>
            )}

            <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0, lineHeight: 1.5 }}>
                A right password from an IP not on this list is not enough: the panel&apos;s bot asks on Discord first. {limits.failLimit} wrong passwords
                from one IP make it wait 15 minutes. Locked out with Discord down? Add your IP to ADMIN_ALLOWED_IPS in the panel&apos;s .env over SSH,
                then restart the panel.
            </p>
        </div>
    );
}
