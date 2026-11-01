import { useState, useEffect, useCallback, useRef } from "react";
import api from "../api/client";
import PeriodPicker, { thisMonth, periodName } from "../components/PeriodPicker";
import { DataTable, EmptyState, Icon, Modal, Notice, PageHeader, SearchInput, StatCard, StatusBadge } from "../components/ui";
import { fmtNum, money } from "../utils/format";

// Every buyer of ArnTo-Shop and a ranking for any period, from the orders on the
// panel (server/services/buyerService.js). Amounts and the ranking by spend come
// only with the "See revenue" grant of Orders; without it the server ranks by
// completed orders and sends no amount (`money: false`).

const STATUS = {
    pending:   { label: "Pending",   tone: "warning" },
    completed: { label: "Completed", tone: "success" },
    cancelled: { label: "Cancelled", tone: "danger" },
};
const st = (s) => STATUS[s] || { label: s || "—", tone: "neutral" };

// What the ranking can go by (server: buyerService SORTS); `money` ones need "See revenue".
const SORTS = [
    { key: "spent", label: "Spent", money: true },
    { key: "completed", label: "Completed orders" },
    { key: "orders", label: "All orders" },
    { key: "average", label: "Average per order", money: true },
    { key: "recent", label: "Latest order" },
];
const SELLERS = [
    { id: "all", label: "All sellers" },
    { id: "871329074046435338", label: "KhaiDev" },
    { id: "427399742906040333", label: "ArnTo" },
];
const SOURCES = [
    { key: "all", label: "All kinds" },
    { key: "ticket", label: "Ticket orders" },
    { key: "autoQuest", label: "Auto Quest" },
    { key: "autoQuestMonthly", label: "Auto Quest monthly" },
    { key: "autoBadge", label: "Auto Badge" },
    { key: "decoGift", label: "Deco Gift" },
];
const day = (ts) => (ts ? new Date(ts).toLocaleDateString("en-GB") : "—");
const plural = (n, word) => `${fmtNum(n)} ${word}${n === 1 ? "" : "s"}`;

function BuyerName({ tag, id, reseller }) {
    return (
        <>
            {tag || <span className="mono" style={{ color: "var(--text-dim)", fontSize: 11 }}>{id}</span>}
            {reseller && (
                <span style={{ marginLeft: 6 }}>
                    <StatusBadge tone="accent" title="An active reseller (CTV)">Reseller</StatusBadge>
                </span>
            )}
        </>
    );
}

function Figure({ label, value, tone }) {
    return (
        <div>
            <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                {tone && <span className="status-dot" style={{ width: 6, height: 6, background: `var(--${tone})` }} />}
                {label}
            </p>
            <p style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", margin: "2px 0 0" }}>{value}</p>
        </div>
    );
}

/** One buyer, all time — what /me shows on Discord, and every order they placed. */
function BuyerModal({ buyerId, onClose }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");

    useEffect(() => {
        let live = true;
        api.get(`/buyers/${buyerId}`)
            .then(({ data }) => live && setData(data))
            .catch((err) => live && setError(err.response?.data?.error || "Could not load this buyer"));
        return () => {
            live = false;
        };
    }, [buyerId]);

    const sellers = data ? Object.values(data.bySeller || {}) : [];
    return (
        <Modal title={data?.tag || buyerId} onClose={onClose} width={640}>
            {error && <Notice tone="danger">{error}</Notice>}
            {!data && !error && <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>}
            {data && (
                <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, color: "var(--text-dim)" }}>
                        <span className="mono">{data.buyerId}</span>
                        {data.reseller && <StatusBadge tone="accent" title="An active reseller (CTV)">Reseller</StatusBadge>}
                        <span>·</span>
                        <span>All-time rank #{fmtNum(data.rank)}{data.money ? "" : " by completed orders"}</span>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 14 }}>
                        <Figure label="Total orders" value={fmtNum(data.total)} />
                        {data.money && <Figure label="Spent" value={money(data.spent)} />}
                        <Figure label="Pending" value={fmtNum(data.pending)} tone="warning" />
                        <Figure label="Completed" value={fmtNum(data.completed)} tone="success" />
                        <Figure label="Cancelled" value={fmtNum(data.cancelled)} tone="danger" />
                    </div>

                    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 13 }}>
                        <span><span style={{ color: "var(--text-dim)" }}>First order</span> {day(data.firstOrder)}</span>
                        <span><span style={{ color: "var(--text-dim)" }}>Last order</span> {day(data.lastOrder)}</span>
                        {sellers.map((s) => (
                            <span key={s.name}>
                                <span style={{ color: "var(--text-dim)" }}>{s.name}</span> {plural(s.completed, "completed order")}
                                {data.money && ` · ${money(s.spent)}`}
                            </span>
                        ))}
                    </div>

                    <div>
                        <p className="section-title" style={{ margin: "0 0 10px" }}>Purchase history</p>
                        <div style={{ maxHeight: 360, overflow: "auto" }}>
                            <DataTable
                                minWidth={520}
                                columns={["Order", "Item", ...(data.money ? [{ label: "Price", align: "right" }] : []), "Status", "Date"]}
                            >
                                {data.history.map((o) => {
                                    const s = st(o.status);
                                    return (
                                        <tr key={o.orderId}>
                                            <td className="mono nowrap">{o.orderId}</td>
                                            <td style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.name}>{o.name}</td>
                                            {data.money && <td className="mono num">{money(o.price)}</td>}
                                            <td><StatusBadge tone={s.tone}>{s.label}</StatusBadge></td>
                                            <td className="muted nowrap">{day(o.orderDate)}</td>
                                        </tr>
                                    );
                                })}
                            </DataTable>
                        </div>
                    </div>
                </div>
            )}
        </Modal>
    );
}

export default function BuyersPage() {
    const [period, setPeriod] = useState("all"); // "all" | "2026" | "2026-10" | "2026-10-05_2026-10-20"
    // Ranking: { sort, seller, source, resellers }. sort null = the server's default
    // (spend with "See revenue", completed orders without).
    const [view, setView] = useState({ sort: null, seller: "all", source: "all", resellers: false });
    const query = useRef({ period, ...view });
    const seq = useRef(0);
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(50);
    const [openId, setOpenId] = useState(null);

    const load = useCallback(async () => {
        const mine = ++seq.current;
        const { period, sort, seller, source, resellers } = query.current;
        try {
            const params = { period, seller, source, ...(sort ? { sort } : {}), ...(resellers ? { resellers: 1 } : {}) };
            const { data } = await api.get("/buyers", { params });
            // An answer to anything but the last request is dropped.
            if (mine !== seq.current) return;
            setData(data);
            setError("");
        } catch (err) {
            if (mine === seq.current) setError(err.response?.data?.error || "Could not load the buyers");
        } finally {
            if (mine === seq.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
        const int = setInterval(load, 60_000);
        return () => clearInterval(int);
    }, [load]);

    const pickPeriod = (p) => {
        query.current = { ...query.current, period: p };
        setPeriod(p);
        load();
    };
    const pickView = (patch) => {
        const next = { ...view, ...patch };
        query.current = { ...query.current, ...next };
        setView(next);
        load();
    };

    const buyers = data?.buyers || [];
    const q = search.trim().toLowerCase();
    const visible = q ? buyers.filter((b) => b.buyerId.includes(q) || b.tag?.toLowerCase().includes(q)) : buyers;
    useEffect(() => { setPage(1); }, [search, pageSize, period, view]);
    const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
    const safePage = Math.min(page, totalPages);
    const paged = visible.slice((safePage - 1) * pageSize, safePage * pageSize);
    // The figures on screen answer an earlier choice until the new answer comes.
    const stale =
        data &&
        (data.period !== period ||
            (view.sort && data.sort !== view.sort) ||
            (data.seller || "all") !== view.seller ||
            (data.source || "all") !== view.source ||
            !!data.resellers !== view.resellers);
    const showMoney = !!data?.money;
    const sorts = SORTS.filter((s) => showMoney || !s.money);
    const sortKey = view.sort || data?.sort || (showMoney ? "spent" : "completed");
    const filtered = view.seller !== "all" || view.source !== "all" || view.resellers;

    return (
        <div className="fade-in page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 20 }}>
            <PageHeader
                title="Buyers"
                description="Everyone who ordered from ArnTo-Shop — what /me shows on Discord — ranked for any period. An order counts in the period it was placed in."
            />

            {error && <Notice tone="danger">{error}</Notice>}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{periodName(period)}</h2>
                <PeriodPicker period={period} months={data?.months || [thisMonth()]} onChange={pickPeriod} allowRange />
            </div>

            {data && (
                <div className="stat-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", opacity: stale ? 0.55 : 1, transition: "opacity .15s" }}>
                    <StatCard label="Buyers" value={fmtNum(data.totals.buyers)} />
                    <StatCard label="Orders" value={fmtNum(data.totals.orders)} hint={`${fmtNum(data.totals.pending)} pending · ${fmtNum(data.totals.cancelled)} cancelled`} />
                    <StatCard label="Completed" value={fmtNum(data.totals.completed)} tone="success" />
                    {showMoney && (
                        <div style={{ gridColumn: "span 2", display: "grid" }}>
                            <StatCard label="Revenue" value={money(data.totals.revenue)} hint="Completed orders" />
                        </div>
                    )}
                </div>
            )}

            {/* The ranking: what it goes by, and which orders count. Seller and kind
                change the numbers themselves, not just the order of the rows. */}
            <div className="toolbar">
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-dim)" }}>
                    Rank by
                    <select className="input" style={{ width: "auto" }} value={sortKey} onChange={(e) => pickView({ sort: e.target.value })} aria-label="Rank by">
                        {sorts.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                </label>
                <select className="input" style={{ width: "auto" }} value={view.seller} onChange={(e) => pickView({ seller: e.target.value })} aria-label="Seller">
                    {SELLERS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
                <select className="input" style={{ width: "auto" }} value={view.source} onChange={(e) => pickView({ source: e.target.value })} aria-label="Kind of order">
                    {SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                <button type="button" className={`chip ${view.resellers ? "active" : ""}`} aria-pressed={view.resellers} onClick={() => pickView({ resellers: !view.resellers })}>
                    Resellers only
                </button>
            </div>
            <div className="toolbar">
                <SearchInput value={search} onChange={setSearch} placeholder="Search buyer or Discord ID…" style={{ flex: "1 1 220px", maxWidth: 340 }} />
                <span className="toolbar-count">
                    {visible.length} / {buyers.length} · ranked by {(SORTS.find((s) => s.key === (data?.sort || sortKey))?.label || "").toLowerCase()}
                </span>
            </div>

            {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : visible.length === 0 ? (
                <EmptyState
                    icon="users"
                    title={buyers.length ? "No buyer matches" : filtered ? "No buyers with these filters" : "No buyers in this period"}
                    description={buyers.length ? "Try another name or ID." : filtered ? "Try another seller, kind of order or period." : "Pick another month, year or range."}
                />
            ) : (
                <div className="card" style={{ padding: 0, overflow: "hidden", opacity: stale ? 0.55 : 1, transition: "opacity .15s" }}>
                    <DataTable
                        flush
                        minWidth={720}
                        columns={[
                            { label: "#", width: 56 },
                            "Buyer",
                            { label: "Orders", align: "right" },
                            { label: "Pending", align: "right" },
                            { label: "Completed", align: "right" },
                            { label: "Cancelled", align: "right" },
                            ...(showMoney ? [{ label: "Spent", align: "right" }, { label: "Avg / order", align: "right" }] : []),
                            "Last order",
                            "",
                        ]}
                    >
                        {paged.map((b) => (
                            <tr key={b.buyerId} style={{ cursor: "pointer" }} onClick={() => setOpenId(b.buyerId)}>
                                <td className="mono" style={{ fontWeight: b.rank <= 3 ? 700 : 400, color: b.rank <= 3 ? "var(--accent-hover)" : undefined }}>
                                    {b.rank}
                                </td>
                                <td className="nowrap"><BuyerName tag={b.tag} id={b.buyerId} reseller={b.reseller} /></td>
                                <td className="mono num">{fmtNum(b.total)}</td>
                                <td className="mono num">{fmtNum(b.pending)}</td>
                                <td className="mono num">{fmtNum(b.completed)}</td>
                                <td className="mono num">{fmtNum(b.cancelled)}</td>
                                {showMoney && <td className="mono num">{money(b.spent)}</td>}
                                {showMoney && <td className="mono num">{b.completed ? money(b.average) : "—"}</td>}
                                <td className="muted nowrap">{day(b.lastOrder)}</td>
                                <td className="actions">
                                    <button
                                        className="btn-ghost btn-icon btn-sm"
                                        title="Buyer details"
                                        aria-label={`Details of ${b.tag || b.buyerId}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setOpenId(b.buyerId);
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
                            {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, visible.length)} of {visible.length}
                        </span>
                        <select className="input" style={{ width: "auto", padding: "4px 8px", fontSize: 12 }} value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                            {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} per page</option>)}
                        </select>
                        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
                            <button className="btn-ghost btn-icon btn-sm" title="First page" disabled={safePage <= 1} onClick={() => setPage(1)}><Icon name="chevronsLeft" /></button>
                            <button className="btn-ghost btn-icon btn-sm" title="Previous page" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}><Icon name="chevronLeft" /></button>
                            <span style={{ fontSize: 12, color: "var(--text-muted)", minWidth: 90, textAlign: "center" }}>Page {safePage} of {totalPages}</span>
                            <button className="btn-ghost btn-icon btn-sm" title="Next page" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}><Icon name="chevronRight" /></button>
                            <button className="btn-ghost btn-icon btn-sm" title="Last page" disabled={safePage >= totalPages} onClick={() => setPage(totalPages)}><Icon name="chevronsRight" /></button>
                        </div>
                    </div>
                </div>
            )}

            {openId && <BuyerModal buyerId={openId} onClose={() => setOpenId(null)} />}
        </div>
    );
}
