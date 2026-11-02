// ─────────────────────────────────────────────────────────────────────────────
//  Panel Settings → Security: the devices the owner account works on.
//
//  The owner's username + password work only on approved devices (browsers,
//  known by a cookie the panel gave them). On any other device the panel's bot
//  asks on Discord (Allow / Deny): Allow remembers the device, Deny keeps its
//  IP from asking again for a day, and a device unused for 30 days is
//  forgotten. ADMIN_ALLOWED_IPS in .env let any device in from those IPs —
//  the way back in when Discord is down. The server checks the device on every
//  request (server/services/ownerAccess.js, middleware/auth.js).
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from "react";
import api from "../../api/client";
import ConfirmModal from "../../components/ConfirmModal";
import { DataTable, EmptyState, Icon, Notice, StatusBadge } from "../../components/ui";
import Section from "./Section";

const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "—");
const UA_CELL = { maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function DiscordStatus({ discord }) {
    return (
        <Section
            icon="shieldCheck"
            title="Approvals on Discord"
            hint="Where a sign-in on a new device is allowed or denied"
            actions={<StatusBadge tone={discord.ok ? "success" : "danger"}>{discord.ok ? "Ready" : "Not working"}</StatusBadge>}
        >
            {discord.ok ? (
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                    {discord.botTag || "The panel's bot"} posts them in <strong>#{discord.channel}</strong>
                    {discord.guild ? <> ({discord.guild})</> : null} and pings @everyone.
                </p>
            ) : (
                <Notice tone="warning">
                    Approvals cannot be posted: {discord.error}. Until this is fixed only the devices below (and ADMIN_ALLOWED_IPS) get in. Invite
                    the panel&apos;s bot to the server of the approval channel with View Channel, Send Messages, Embed Links and Mention @everyone.
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
            const { data: d } = await api.get("/owner-access");
            setData(d);
            setError("");
        } catch (err) {
            setError(errMsg(err, "Could not load the owner devices"));
        }
    }, []);

    useEffect(() => { load(); }, [load]);
    // Waiting sign-ins and last-used times change on their own.
    useEffect(() => {
        const t = setInterval(load, 15_000);
        return () => clearInterval(t);
    }, [load]);

    const act = async (path, body, fallback) => {
        try {
            await api.post(`/owner-access/${path}`, body);
            load();
        } catch (err) {
            setError(errMsg(err, fallback));
        } finally { setConfirm(null); }
    };

    if (!data) {
        return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>{error || "Loading…"}</div>;
    }
    const { devices, env, blocked, pending, discord, currentIp, limits } = data;
    const here = <StatusBadge tone="success">This device</StatusBadge>;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {confirm && <ConfirmModal {...confirm} onCancel={() => setConfirm(null)} />}

            <DiscordStatus discord={discord} />

            {error && <Notice tone="danger">{error}</Notice>}

            <Section
                icon="lock"
                title="Owner devices"
                hint={`The owner account works only on these. Unused for ${limits.forgetDays} days = forgotten.`}
                flush
            >
                {devices.length === 0 ? (
                    <EmptyState compact icon="lock" title="No device yet" description="The first sign-in on each device is allowed on Discord." />
                ) : (
                    <DataTable flush columns={["Device", "Approved", "Last used", "Forgotten on", ""]} minWidth={680}>
                        {devices.map((d) => (
                            <tr key={d.id}>
                                <td>
                                    <span style={{ whiteSpace: "nowrap" }}>{d.name}</span> {d.current && here}
                                    {d.ua && <div className="cell-sub" title={d.ua} style={UA_CELL}>{d.ua}</div>}
                                </td>
                                <td className="nowrap">
                                    {fmtDate(d.approvedAt)}
                                    {d.approvedBy && <div className="cell-sub">by {d.approvedBy}</div>}
                                </td>
                                <td className="nowrap">
                                    {fmtDate(d.lastSeenAt)}
                                    {d.lastIp && <div className="cell-sub mono">{d.lastIp}</div>}
                                </td>
                                <td className="nowrap muted">{fmtDate(d.forgetAt)}</td>
                                <td className="actions">
                                    <button
                                        className="btn-ghost btn-sm"
                                        title="The owner account stops working on this device"
                                        onClick={() => setConfirm({
                                            title: `Remove ${d.name}?`,
                                            message: d.current
                                                ? "This is the device you are using now: you are signed out at once, and getting back in needs Allow on Discord."
                                                : "The owner account stops working on this device. Signing in on it again needs Allow on Discord.",
                                            confirmText: "Remove",
                                            onConfirm: () => act("remove", { id: d.id }, "Could not remove the device"),
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

            <Section
                icon="globe"
                title="Always allowed IPs"
                hint={`ADMIN_ALLOWED_IPS in .env: any device gets in from these with the password alone.${currentIp ? ` You are on ${currentIp}.` : ""}`}
            >
                {env.length === 0 ? (
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>None set.</p>
                ) : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                        {env.map((e) => (
                            <span key={e.ip} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                <span className="mono" style={{ fontSize: 13 }}>{e.ip}</span>
                                {e.current && <StatusBadge tone="success">You</StatusBadge>}
                            </span>
                        ))}
                    </div>
                )}
            </Section>

            {pending.length > 0 && (
                <Section icon="hourglass" title="Waiting for approval" hint={`Answer on Discord — each request expires after ${limits.waitMinutes} minutes`} flush>
                    <DataTable flush columns={["Device", "IP", "Asked", "Expires"]} minWidth={560}>
                        {pending.map((p) => (
                            <tr key={p.id}>
                                <td>
                                    <span style={{ whiteSpace: "nowrap" }}>{p.name}</span>
                                    {p.ua && <div className="cell-sub" title={p.ua} style={UA_CELL}>{p.ua}</div>}
                                </td>
                                <td className="mono nowrap">{p.ip || "—"}</td>
                                <td className="nowrap">{fmtDate(p.createdAt)}</td>
                                <td className="nowrap muted">{fmtDate(p.expiresAt)}</td>
                            </tr>
                        ))}
                    </DataTable>
                </Section>
            )}

            {blocked.length > 0 && (
                <Section icon="xCircle" title="Denied IPs" hint={`Sign-ins from these cannot ask again until the time shown (${limits.denyHours} hours after Deny)`} flush>
                    <DataTable flush columns={["IP", "Denied by", "Until", ""]} minWidth={520}>
                        {blocked.map((b) => (
                            <tr key={b.ip}>
                                <td className="mono nowrap">{b.ip}</td>
                                <td className="nowrap">{b.by || "—"}</td>
                                <td className="nowrap muted">{fmtDate(b.until)}</td>
                                <td className="actions">
                                    <button className="btn-ghost btn-sm" onClick={() => act("unblock", { ip: b.ip }, "Could not unblock the IP")}>Unblock</button>
                                </td>
                            </tr>
                        ))}
                    </DataTable>
                </Section>
            )}

            <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0, lineHeight: 1.5 }}>
                A right password on a device not on this list is not enough: the panel&apos;s bot asks on Discord first. A device is one browser
                on one panel address: clearing its data, a private window, another browser, or a panel move to another domain makes it new
                again. {limits.failLimit} wrong passwords from one IP make it wait 15 minutes. Locked out with Discord down? Add your IP to
                ADMIN_ALLOWED_IPS in the panel&apos;s .env over SSH, then restart the panel.
            </p>
        </div>
    );
}
