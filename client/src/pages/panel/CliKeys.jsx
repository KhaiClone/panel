// ─────────────────────────────────────────────────────────────────────────────
//  Panel Settings → Security: CLI access keys (server/services/cliAccess.js).
//
//  A command-line client (scripts/panel-cli.js) asks for a key from its own
//  machine; the panel's bot posts Allow / Deny on Discord with the same code
//  the client prints. A key is the owner's access — every page and a shell on
//  every node — without an approved device. Its writes and every shell command
//  it runs go to the panel log. Here the owner sees the keys, revokes them,
//  and can stop new requests altogether.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from "react";
import api from "../../api/client";
import ConfirmModal from "../../components/ConfirmModal";
import { DataTable, EmptyState, Icon, Notice, StatusBadge, Toggle } from "../../components/ui";
import Section from "./Section";

const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "—");

export default function CliKeys() {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [confirm, setConfirm] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            const { data: d } = await api.get("/cli-access");
            setData(d);
            setError("");
        } catch (err) {
            setError(errMsg(err, "Could not load the CLI keys"));
        }
    }, []);

    useEffect(() => { load(); }, [load]);
    // Waiting requests and last-used times change on their own.
    useEffect(() => {
        const t = setInterval(load, 15_000);
        return () => clearInterval(t);
    }, [load]);

    const act = async (path, body, fallback) => {
        setBusy(true);
        try {
            await api.post(`/cli-access/${path}`, body);
            await load();
        } catch (err) {
            setError(errMsg(err, fallback));
        } finally {
            setBusy(false);
            setConfirm(null);
        }
    };

    if (!data) {
        return (
            <Section icon="terminal" title="CLI access keys">
                <div style={{ textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>{error || "Loading…"}</div>
            </Section>
        );
    }
    const { keys, pending, blocked, accepting, limits } = data;

    return (
        <>
            {confirm && <ConfirmModal {...confirm} onCancel={() => setConfirm(null)} />}

            <Section
                icon="terminal"
                title="CLI access keys"
                hint="Full owner access for scripts/panel-cli.js, without an approved device"
                actions={
                    <>
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Accept new requests</span>
                        <Toggle
                            checked={accepting}
                            disabled={busy}
                            title={accepting ? "Clients may ask for a key (Allow / Deny on Discord)" : "Asking for a key is turned off"}
                            onChange={(on) => act("accepting", { on }, "Could not change the setting")}
                        />
                    </>
                }
                flush
            >
                {error && <div style={{ padding: 12 }}><Notice tone="danger">{error}</Notice></div>}
                {keys.length === 0 ? (
                    <EmptyState
                        compact
                        icon="terminal"
                        title="No key yet"
                        description="Ask for one on the machine that needs it: node scripts/panel-cli.js login <panel address>"
                    />
                ) : (
                    <DataTable flush columns={["Machine", "Allowed", "Expires", "Last used", ""]} minWidth={680}>
                        {keys.map((k) => (
                            <tr key={k.id}>
                                <td>
                                    <span style={{ whiteSpace: "nowrap" }}>{k.name}</span>
                                    {k.askedIp && <div className="cell-sub mono">asked from {k.askedIp}</div>}
                                </td>
                                <td className="nowrap">
                                    {fmtDate(k.approvedAt)}
                                    {k.approvedBy && <div className="cell-sub">by {k.approvedBy}</div>}
                                </td>
                                <td className="nowrap">{k.expiresAt ? fmtDate(k.expiresAt) : <StatusBadge tone="warning">Never</StatusBadge>}</td>
                                <td className="nowrap">
                                    {k.lastUsedAt ? fmtDate(k.lastUsedAt) : <span className="muted">Not used yet</span>}
                                    {k.lastIp && <div className="cell-sub mono">{k.lastIp}</div>}
                                </td>
                                <td className="actions">
                                    <button
                                        className="btn-ghost btn-sm"
                                        title="The key stops working at once"
                                        disabled={busy}
                                        onClick={() => setConfirm({
                                            title: `Revoke the key of ${k.name}?`,
                                            message: "The key stops working at once. That machine has to ask for a new one, and Allow it on Discord.",
                                            confirmText: "Revoke",
                                            onConfirm: () => act("revoke", { id: k.id }, "Could not revoke the key"),
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
                <Section icon="hourglass" title="Key requests waiting" hint={`Answer on Discord — Allow only if the code matches your terminal. Each expires after ${limits.waitMinutes} minutes.`} flush>
                    <DataTable flush columns={["Machine", "IP", "Code", "Asked", "Expires"]} minWidth={600}>
                        {pending.map((p) => (
                            <tr key={p.id}>
                                <td className="nowrap">{p.name}</td>
                                <td className="mono nowrap">{p.ip || "—"}</td>
                                <td className="mono nowrap">{p.code}</td>
                                <td className="nowrap">{fmtDate(p.createdAt)}</td>
                                <td className="nowrap muted">{fmtDate(p.expiresAt)}</td>
                            </tr>
                        ))}
                    </DataTable>
                </Section>
            )}

            {blocked.length > 0 && (
                <Section icon="xCircle" title="Denied key requests" hint={`These IPs cannot ask for a key until the time shown (${limits.denyHours} hours after Deny)`} flush>
                    <DataTable flush columns={["IP", "Denied by", "Until", ""]} minWidth={520}>
                        {blocked.map((b) => (
                            <tr key={b.ip}>
                                <td className="mono nowrap">{b.ip}</td>
                                <td className="nowrap">{b.by || "—"}</td>
                                <td className="nowrap muted">{fmtDate(b.until)}</td>
                                <td className="actions">
                                    <button className="btn-ghost btn-sm" disabled={busy} onClick={() => act("unblock", { ip: b.ip }, "Could not unblock the IP")}>Unblock</button>
                                </td>
                            </tr>
                        ))}
                    </DataTable>
                </Section>
            )}

            <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0, lineHeight: 1.5 }}>
                A key is asked for from the machine that will use it: <span className="mono">node scripts/panel-cli.js login &lt;panel address&gt;</span>.
                The client makes the key and keeps it; the panel stores only its hash. The panel&apos;s bot posts the request on Discord with a code —
                Allow only if it matches the one in your terminal, and pick how long the key lasts there. A key can do everything the owner can,
                every page and a shell on every node; every change it makes and every command it runs goes to the panel log. Anyone can ask, so
                requests are limited to {limits.askLimit} per IP every {limits.askWindowMinutes} minutes, and Deny keeps an IP from asking again for{" "}
                {limits.denyHours} hours. Turn off &quot;Accept new requests&quot; when no machine needs a new key.
            </p>
        </>
    );
}
