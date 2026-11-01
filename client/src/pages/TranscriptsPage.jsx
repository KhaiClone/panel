import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import PeriodPicker, { thisMonth, periodName } from "../components/PeriodPicker";
import { DataTable, EmptyState, Icon, Notice, PageHeader, SearchInput, StatusBadge } from "../components/ui";
import { fmtNum } from "../utils/format";

// The shop's closed tickets (server/services/transcriptService.js): the list of
// its transcript channel, sent by the shop bot, searched here. Opening one
// (TranscriptView) fetches its files from Discord through the bot — no chat is
// kept on the panel.

const KINDS = { ticket: "Tickets", ctv: "Reseller tickets" }; // the filter
const BADGES = { ctv: "Reseller" }; // on a row
const kindName = (k) => KINDS[k] || `${k.charAt(0).toUpperCase()}${k.slice(1)}`;
const when = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");
const fmtSize = (n) => (!n ? "—" : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ORDER_TONE = { pending: "warning", completed: "success", cancelled: "danger" };

export default function TranscriptsPage() {
    const navigate = useNavigate();
    const [period, setPeriod] = useState("all");
    const [kind, setKind] = useState("all");
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(50);
    const query = useRef({ period, kind, q: "", page, pageSize });
    const seq = useRef(0);
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        const mine = ++seq.current;
        try {
            const { data } = await api.get("/transcripts", { params: query.current });
            // An answer to anything but the last request is dropped.
            if (mine !== seq.current) return;
            setData(data);
            setError("");
        } catch (err) {
            if (mine === seq.current) setError(err.response?.data?.error || "Could not load the transcripts");
        } finally {
            if (mine === seq.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        const int = setInterval(load, 60_000);
        return () => clearInterval(int);
    }, [load]);

    // Every change asks the server again; typing waits until it pauses.
    useEffect(() => {
        const q = search.trim();
        const typed = q !== query.current.q;
        query.current = { period, kind, q, page, pageSize };
        const t = setTimeout(load, typed ? 300 : 0);
        return () => clearTimeout(t);
    }, [period, kind, search, page, pageSize, load]);

    const pick = (set) => (v) => {
        set(v);
        setPage(1);
    };

    const src = data?.source;
    const bot = src?.ownerName || "The shop bot";
    const items = data?.items || [];
    const kinds = Object.entries(data?.kinds || {}).sort((a, b) => b[1] - a[1]);
    const filtered = !!search.trim() || kind !== "all" || period !== "all";
    const open = (t) => navigate(`/transcripts/${t.id}`, { state: { transcript: t } });

    return (
        <div className="fade-in page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 20 }}>
            <PageHeader
                title="Transcripts"
                description="Every closed ticket saved in the shop's transcript channel. Opening one fetches its files from Discord; no chat is kept on the panel."
            />

            {error && <Notice tone="danger">{error}</Notice>}
            {data && !src?.owner && (
                <Notice tone="info">
                    No list yet. The shop bot sends the list of its transcript channel when it starts — it needs the version with transcript support.
                </Notice>
            )}
            {src?.owner && !src.canOpen && (
                <Notice tone="warning">
                    {bot} has not announced transcript.get yet, so transcripts are listed but cannot be opened. Update it and restart it.
                </Notice>
            )}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{periodName(period)}</h2>
                <PeriodPicker period={period} months={data?.months?.length ? data.months : [thisMonth()]} onChange={pick(setPeriod)} allowRange />
            </div>

            <div className="toolbar">
                <SearchInput value={search} onChange={pick(setSearch)} placeholder="Ticket number, buyer, reason or order ID…" style={{ flex: "1 1 260px", maxWidth: 380 }} />
                <select className="input" style={{ width: "auto" }} value={kind} onChange={(e) => pick(setKind)(e.target.value)} aria-label="Kind of ticket">
                    <option value="all">All tickets</option>
                    {kinds.map(([k, n]) => (
                        <option key={k} value={k}>{kindName(k)} ({fmtNum(n)})</option>
                    ))}
                </select>
                <span className="toolbar-count">
                    {data ? `${fmtNum(data.matched)} / ${fmtNum(data.total)}` : ""}
                    {src?.checkedAt ? ` · last sync from ${bot} ${when(src.checkedAt)}` : ""}
                </span>
            </div>

            {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : items.length === 0 ? (
                <EmptyState
                    icon="archive"
                    title={data?.total ? "No transcript matches" : "No transcripts yet"}
                    description={data?.total ? (filtered ? "Try another number, name, kind or period." : "") : "They appear once the shop bot sends its list."}
                />
            ) : (
                <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                    <DataTable
                        flush
                        minWidth={900}
                        columns={["Ticket", "Buyer", "Reason", "Orders", "Opened", "Closed", { label: "Size", align: "right" }, ""]}
                    >
                        {items.map((t) => (
                            <tr key={t.id} style={{ cursor: "pointer", opacity: t.missing ? 0.55 : 1 }} onClick={() => open(t)}>
                                <td className="nowrap">
                                    <span className="mono">{t.name}</span>
                                    {t.kind !== "ticket" && (
                                        <span style={{ marginLeft: 6 }}><StatusBadge tone="accent">{BADGES[t.kind] || kindName(t.kind)}</StatusBadge></span>
                                    )}
                                    {t.missing && (
                                        <span style={{ marginLeft: 6 }}><StatusBadge tone="danger" title="Its message was deleted from Discord">Gone</StatusBadge></span>
                                    )}
                                </td>
                                <td className="nowrap">
                                    {t.ownerTag || <span className="mono" style={{ color: "var(--text-dim)", fontSize: 11 }}>{t.ownerId || "—"}</span>}
                                    {t.ownerTag && t.ownerId && <div className="cell-sub mono">{t.ownerId}</div>}
                                </td>
                                <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.reason || ""}>
                                    {t.reason || <span className="muted">—</span>}
                                </td>
                                <td className="nowrap">
                                    {t.orders.length ? (
                                        t.orders.map((o) => (
                                            <div key={o.orderId} title={o.name || ""} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                                <span className="status-dot" style={{ width: 6, height: 6, background: `var(--${ORDER_TONE[o.status] || "text-dim"})` }} />
                                                <span className="mono" style={{ fontSize: 12 }}>{o.orderId}</span>
                                            </div>
                                        ))
                                    ) : (
                                        <span className="muted">—</span>
                                    )}
                                </td>
                                <td className="muted nowrap">{when(t.createdAt)}</td>
                                <td className="muted nowrap">{when(t.closedAt)}</td>
                                <td className="mono num" title={t.legacy ? "One HTML file (an older transcript)" : `${t.parts} compressed part${t.parts === 1 ? "" : "s"} on Discord`}>
                                    {fmtSize(t.size)}
                                </td>
                                <td className="actions">
                                    <button
                                        className="btn-ghost btn-icon btn-sm"
                                        title="Open the transcript"
                                        aria-label={`Open ${t.name}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            open(t);
                                        }}
                                    >
                                        <Icon name="eye" size={14} />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </DataTable>

                    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                            {fmtNum((data.page - 1) * data.pageSize + 1)}–{fmtNum(Math.min(data.page * data.pageSize, data.matched))} of {fmtNum(data.matched)}
                        </span>
                        <select className="input" style={{ width: "auto", padding: "4px 8px", fontSize: 12 }} value={pageSize} onChange={(e) => pick(setPageSize)(Number(e.target.value))}>
                            {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} per page</option>)}
                        </select>
                        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
                            <button className="btn-ghost btn-icon btn-sm" title="First page" disabled={data.page <= 1} onClick={() => setPage(1)}><Icon name="chevronsLeft" /></button>
                            <button className="btn-ghost btn-icon btn-sm" title="Previous page" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}><Icon name="chevronLeft" /></button>
                            <span style={{ fontSize: 12, color: "var(--text-muted)", minWidth: 90, textAlign: "center" }}>Page {data.page} of {data.pages}</span>
                            <button className="btn-ghost btn-icon btn-sm" title="Next page" disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}><Icon name="chevronRight" /></button>
                            <button className="btn-ghost btn-icon btn-sm" title="Last page" disabled={data.page >= data.pages} onClick={() => setPage(data.pages)}><Icon name="chevronsRight" /></button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
