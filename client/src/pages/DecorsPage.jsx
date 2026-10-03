import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";
import DecorPrices from "../components/DecorPrices";
import DecorPreview from "../components/decor/DecorPreview";
import "./DecorsPage.css";

// ─────────────────────────────────────────────────────────────────────────────
//  Decors — the decor site's catalogue (grouped by theme, same previews), with
//  the shop owner's controls on top: per decor, which ways it is sold —
//  Login with Nitro, Login without Nitro, Gift — each switched on/off from the
//  card, the detail window, or a whole theme / filter at once.
//
//  A switch is a flag on the decor's record (absent = sold): the decor site
//  and the assistant's /decor-find stop offering that way; /decor-load keeps
//  the flags. `tierPrices` (this page only) is what each way costs from the
//  price table, whatever the switches say.
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_INFO = {
    0: { label: "Avatar Deco", color: "avatar" },
    1: { label: "Profile Effect", color: "profile" },
    2: { label: "Nameplate", color: "nameplate" },
    3: { label: "Frame", color: "frame" },
    1000: { label: "Bundle", color: "bundle" },
};
const TYPE_FILTERS = [["all", "Tất cả"], ...Object.entries(TYPE_INFO).map(([k, t]) => [k, t.label])];

const WAYS = [
    { key: "loginWithNitro", flag: "noLoginWithNitro", label: "Login (Có Nitro)", short: "Nitro", icon: "🔵" },
    { key: "loginWithoutNitro", flag: "noLoginWithoutNitro", label: "Login (Không Nitro)", short: "Không Nitro", icon: "⚪" },
    { key: "gift", flag: "noGift", label: "Gift", short: "Gift", icon: "🎁" },
];

const SALE_FILTERS = [
    ["all", "Mọi trạng thái bán"],
    ["full", "Đang bán đủ 3 loại"],
    ["partial", "Tắt một phần"],
    ["off", "Ngừng bán hẳn"],
    ...WAYS.map((w) => [w.flag, `Đang tắt ${w.label}`]),
    ["missing", "Đang bán nhưng thiếu mốc giá"],
];

const SECTIONS_PER_PAGE = 8;
const ITEMS_PER_PAGE = 24;

const money = (n) => (typeof n === "number" ? n.toLocaleString("vi-VN") + "đ" : "—");
const errText = (err, fallback) => err.response?.data?.error || err.response?.data?.message || fallback;

const sells = (d, w) => !d[w.flag];
const wayLabel = (d, w) => (w.key === "gift" && d.type === 1000 ? "Gift Bundle" : w.label);
/** What this way costs from the price table (0 = no tier yet), whatever the switch. */
const tierPrice = (d, w) => (w.key === "gift" && d.type === 1000 ? d.tierPrices?.giftBundle : d.tierPrices?.[w.key]) || 0;
/** The Discord price it is based on; a gift bundle's is a sum, not shown. */
const originalOf = (d, w) => (w.key === "loginWithoutNitro" ? d.prices?.withoutNitro : w.key === "gift" && d.type === 1000 ? null : d.prices?.withNitro);

/**
 * `from` = the card's "Từ" price, the decor site's rule: Login with Nitro while
 * it is sold, else the cheapest way still sold (0 = none of them has a price).
 */
const saleState = (d) => {
    const on = WAYS.filter((w) => sells(d, w));
    const priced = on.map((w) => tierPrice(d, w)).filter(Boolean);
    const nitro = sells(d, WAYS[0]) ? tierPrice(d, WAYS[0]) : 0;
    return { on: on.length, missing: on.some((w) => !tierPrice(d, w)), from: nitro || (priced.length ? Math.min(...priced) : 0) };
};

const matchesSale = (d, filter) => {
    if (filter === "all") return true;
    const { on, missing } = saleState(d);
    if (filter === "full") return on === WAYS.length;
    if (filter === "partial") return on > 0 && on < WAYS.length;
    if (filter === "off") return on === 0;
    if (filter === "missing") return missing;
    return !!d[filter];
};

// Snowflake sku → release order; BigInt because 19 digits overflow Number.
const skuOrder = (d) => {
    try {
        return BigInt(d.sku_id);
    } catch {
        return 0n;
    }
};

const copyText = async (text) => {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;top:-9999px;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
    }
};

// ── Small pieces ─────────────────────────────────────────────────────────────

function TypeBadge({ type, small }) {
    const t = TYPE_INFO[type] || { label: String(type), color: "avatar" };
    return <span className={`dc-badge dc-badge-${t.color}${small ? " dc-badge-sm" : ""}`}>{t.label}</span>;
}

function CardPrice({ decor }) {
    const { on, from } = saleState(decor);
    if (!on) return <div className="dc-card-price"><span className="dc-off">Ngừng bán</span></div>;
    if (!from) return <div className="dc-card-price"><span className="dc-missing">Chưa có mốc giá</span></div>;
    return <div className="dc-card-price">Từ <b>{money(from)}</b></div>;
}

/** The three ways as chips on a card: green = sold, struck = off, red = sold without a price. */
function WayChips({ decor, saving, onToggle }) {
    return (
        <div className="dc-ways">
            {WAYS.map((w) => {
                const on = sells(decor, w);
                const nopr = on && !tierPrice(decor, w);
                return (
                    <button
                        key={w.key}
                        type="button"
                        className={`dc-way${on ? "" : " off"}${nopr ? " nopr" : ""}`}
                        disabled={saving}
                        title={`${wayLabel(decor, w)}: ${on ? (nopr ? "đang bán nhưng chưa có mốc giá" : `đang bán ${money(tierPrice(decor, w))}`) : "đang tắt"} — bấm để ${on ? "tắt" : "bật"}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggle(decor, w);
                        }}
                    >
                        {w.short}
                    </button>
                );
            })}
        </div>
    );
}

function DecorCard({ decor, saving, onOpen, onToggle }) {
    const { on } = saleState(decor);
    return (
        <div className={`dc-card${on ? "" : " off"}`} onClick={() => onOpen(decor.sku_id)}>
            <div className="dc-card-media">
                <DecorPreview decor={decor} card />
            </div>
            <div className="dc-card-tags">
                <TypeBadge type={decor.type} />
                {decor.decorFrom === "importedDecors" && <span className="dc-badge dc-badge-limited">⚡ Giới hạn</span>}
            </div>
            <div className="dc-card-info">
                <h3 className="dc-card-name">{decor.name}</h3>
                <CardPrice decor={decor} />
                <WayChips decor={decor} saving={saving} onToggle={onToggle} />
            </div>
        </div>
    );
}

/** "Hàng loạt…" — switch one way (or all three) for every decor in `items`. */
function BulkSelect({ items, label, onRun }) {
    return (
        <select
            className="input dc-bulk"
            value=""
            disabled={!items.length}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => e.target.value && onRun(e.target.value, items)}
            title={`Áp dụng cho ${items.length} decor`}
        >
            <option value="">{label}</option>
            <optgroup label="Tắt">
                {WAYS.map((w) => <option key={w.flag} value={`off:${w.flag}`}>Tắt {w.label}</option>)}
                <option value="off:all">Tắt cả 3 (ngừng bán)</option>
            </optgroup>
            <optgroup label="Bật">
                {WAYS.map((w) => <option key={w.flag} value={`on:${w.flag}`}>Bật {w.label}</option>)}
                <option value="on:all">Bật cả 3</option>
            </optgroup>
        </select>
    );
}

function Pagination({ page, pages, onPage }) {
    if (pages <= 1) return null;
    const set = new Set([1, pages]);
    for (let i = Math.max(1, page - 2); i <= Math.min(pages, page + 2); i++) set.add(i);
    const nums = [...set].sort((a, b) => a - b);
    const out = [];
    nums.forEach((n, i) => {
        if (i && n - nums[i - 1] > 1) out.push(<span key={`gap${n}`} style={{ color: "var(--text-dim)" }}>···</span>);
        out.push(<button key={n} type="button" className={`dc-page${n === page ? " active" : ""}`} onClick={() => onPage(n)}>{n}</button>);
    });
    return (
        <div className="dc-pages">
            <button type="button" className="dc-page" disabled={page === 1} onClick={() => onPage(page - 1)}>←</button>
            {out}
            <button type="button" className="dc-page" disabled={page === pages} onClick={() => onPage(page + 1)}>→</button>
        </div>
    );
}

// ── Detail window ────────────────────────────────────────────────────────────

function DecorModal({ decor, categories, saving, onClose, onToggle, onTheme, onDelete, onOpen }) {
    const [replay, setReplay] = useState(0);
    const [copied, setCopied] = useState("");
    const imported = decor.decorFrom === "importedDecors";

    useEffect(() => {
        const onKey = (e) => e.key === "Escape" && onClose();
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    const copy = async (what, text) => {
        await copyText(text);
        setCopied(what);
        setTimeout(() => setCopied(""), 1500);
    };

    return createPortal(
        <div className="modal-overlay" onClick={onClose}>
            <div className="card dc-modal decor-page fade-in" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="dc-modal-close" onClick={onClose} aria-label="Đóng">✕</button>
                <div className="dc-modal-layout">
                    <div className="dc-modal-media">
                        <div className="dc-modal-frame">
                            <DecorPreview decor={decor} replay={replay} />
                        </div>
                        {decor.type === 1 && decor.effects?.length > 0 && (
                            <button type="button" className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setReplay((n) => n + 1)}>▶ Phát lại hiệu ứng</button>
                        )}
                        {imported && <span className="dc-badge dc-badge-limited" style={{ padding: "4px 10px" }}>⚡ Decor Giới Hạn</span>}
                    </div>

                    <div style={{ minWidth: 0 }}>
                        <TypeBadge type={decor.type} />
                        <h2 className="dc-modal-title">{decor.name}</h2>
                        {decor.label && <p className="dc-modal-label">{decor.label}</p>}
                        {decor.summary && <p className="dc-modal-summary">{decor.summary}</p>}
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10, fontSize: 11 }}>
                            <span className="mono" style={{ color: "var(--text-dim)" }}>{decor.sku_id}</span>
                            <button type="button" className="btn-ghost" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => copy("sku", decor.sku_id)}>{copied === "sku" ? "Đã chép ✓" : "Chép sku"}</button>
                        </div>

                        <div className="dc-section-label">Giá &amp; trạng thái bán</div>
                        <div className="dc-price-rows">
                            {WAYS.map((w) => {
                                const on = sells(decor, w);
                                const price = tierPrice(decor, w);
                                const orig = originalOf(decor, w);
                                return (
                                    <div key={w.key} className={`dc-price-row${on ? "" : " off"}`}>
                                        <button
                                            type="button"
                                            className={`dc-switch${on ? " on" : ""}`}
                                            disabled={saving}
                                            onClick={() => onToggle(decor, w)}
                                            aria-pressed={on}
                                            title={on ? "Đang bán — bấm để tắt" : "Đang tắt — bấm để bật"}
                                        />
                                        <span className="dc-price-row-label">{w.icon} {wayLabel(decor, w)}</span>
                                        <div className="dc-price-row-vals">
                                            {orig != null && <><span className="dc-price-orig">{money(orig)}</span><span style={{ color: "var(--text-dim)" }}>→</span></>}
                                            {!on ? (
                                                <span className="dc-price-note">Không bán{price ? ` (${money(price)})` : ""}</span>
                                            ) : price ? (
                                                <span className="dc-price-sell">{money(price)}</span>
                                            ) : (
                                                <span className="dc-price-missing">Chưa có mốc giá</span>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "6px 0 0" }}>
                            Loại đang tắt hiện “Không bán” trên site decor và trong /decor-find của bot.
                        </p>

                        {decor.type === 1000 && decor.items?.length > 0 && (
                            <>
                                <div className="dc-section-label">Bao gồm</div>
                                <div className="dc-members">
                                    {decor.items.map((m) => (
                                        <button key={m.sku_id} type="button" className="dc-member" onClick={() => onOpen(m.sku_id)}>
                                            <TypeBadge type={m.type} small />
                                            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                                            <span style={{ color: "var(--text-dim)", fontSize: 11 }}>›</span>
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}

                        {imported && (
                            <>
                                <div className="dc-section-label">Decor đã import</div>
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                    <select
                                        className="input"
                                        style={{ flex: "1 1 200px", minWidth: 0, padding: "6px 10px", fontSize: 12 }}
                                        title="Theme (mục hiển thị trên site)"
                                        value={decor.category_sku_id ?? ""}
                                        disabled={saving}
                                        onChange={(e) => onTheme(decor, e.target.value || null)}
                                    >
                                        <option value="">— Khác —</option>
                                        {categories.map((c) => <option key={c.sku_id} value={c.sku_id}>{c.name}</option>)}
                                    </select>
                                    <button type="button" className="btn-ghost" style={{ padding: "6px 12px", fontSize: 12, color: "var(--danger)" }} onClick={() => onDelete(decor)}>Xóa</button>
                                </div>
                            </>
                        )}

                        <div style={{ marginTop: 20 }}>
                            <button type="button" className="btn-ghost" style={{ padding: "8px 14px", fontSize: 12 }} onClick={() => copy("shop", `https://discord.com/shop#itemSkuId=${decor.sku_id}`)}>
                                {copied === "shop" ? "Đã sao chép ✓" : "Sao chép link Discord Shop"}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
}

// ── Import ───────────────────────────────────────────────────────────────────

function ImportForm({ onImported }) {
    const [deco, setDeco] = useState("");
    const [preview, setPreview] = useState(null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null); // { ok, text }

    const doPreview = async () => {
        if (!deco.trim()) return;
        setBusy(true); setMsg(null); setPreview(null);
        try {
            const { data } = await api.post("/decors/preview", { deco: deco.trim() }, { timeout: 60_000 });
            setPreview(data.decor);
        } catch (err) {
            setMsg({ ok: false, text: errText(err, "Preview failed") });
        } finally { setBusy(false); }
    };

    const doImport = async () => {
        if (!deco.trim()) return;
        setBusy(true); setMsg(null);
        try {
            const { data } = await api.post("/decors/import", { deco: deco.trim() }, { timeout: 75_000 });
            const parts = [`Đã import "${data.decor?.name}" (${data.decor?.sku_id})`];
            if (data.importedMembers?.length) parts.push(`+${data.importedMembers.length} decor trong bundle`);
            if (data.failedMembers?.length) parts.push(`⚠ ${data.failedMembers.length} decor trong bundle không lấy được`);
            setMsg({ ok: true, text: parts.join(" · ") });
            setDeco(""); setPreview(null);
            onImported();
        } catch (err) {
            setMsg({ ok: false, text: errText(err, "Import failed") });
        } finally { setBusy(false); }
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                Dán SKU ID hoặc link shop — bot tự lấy đủ dữ liệu theo loại decor, giống <code>/decor-load</code>.
            </p>
            <input
                className="input mono"
                value={deco}
                onChange={(e) => setDeco(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doPreview()}
                placeholder="1491907428344795276 hoặc https://discord.com/shop#itemSkuId=…"
                autoFocus
            />
            {msg && (
                <div style={{ padding: "10px 14px", borderRadius: 8, fontSize: 13, background: msg.ok ? "var(--success-bg)" : "var(--danger-bg)", color: msg.ok ? "var(--success)" : "var(--danger)", border: `1px solid ${msg.ok ? "var(--success-border)" : "var(--danger-border)"}` }}>
                    {msg.text}
                </div>
            )}
            {preview && (
                <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                    <div className="decor-page" style={{ width: 120, flexShrink: 0, borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)" }}>
                        <DecorPreview decor={preview} card />
                    </div>
                    <div style={{ minWidth: 0 }}>
                        <TypeBadge type={preview.type} />
                        <p style={{ fontSize: 14, fontWeight: 700, margin: "6px 0 2px" }}>{preview.name}</p>
                        <p className="mono" style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
                            {money(preview.prices?.withNitro)} (Nitro) · {money(preview.prices?.withoutNitro)}
                        </p>
                        <details style={{ marginTop: 6 }}>
                            <summary style={{ fontSize: 11, color: "var(--text-dim)", cursor: "pointer" }}>Dữ liệu thô</summary>
                            <pre className="mono" style={{ margin: "6px 0 0", padding: 10, background: "var(--bg-input)", borderRadius: 8, fontSize: 11, maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                                {JSON.stringify(preview, null, 2)}
                            </pre>
                        </details>
                    </div>
                </div>
            )}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button type="button" className="btn-ghost" disabled={busy || !deco.trim()} onClick={doPreview}>Xem trước</button>
                <button type="button" className="btn-primary" disabled={busy || !deco.trim()} onClick={doImport}>{busy ? "Đang xử lý…" : "Import"}</button>
            </div>
        </div>
    );
}

function ImportModal({ onClose, onImported }) {
    useEffect(() => {
        const onKey = (e) => e.key === "Escape" && onClose();
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);
    return createPortal(
        <div className="modal-overlay" onClick={onClose}>
            <div className="card fade-in modal-card-mobile" style={{ width: "100%", maxWidth: 560, position: "relative" }} onClick={(e) => e.stopPropagation()}>
                <button type="button" className="dc-modal-close decor-page" onClick={onClose} aria-label="Đóng">✕</button>
                <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 12px" }}>Import decor</h3>
                <ImportForm onImported={onImported} />
            </div>
        </div>,
        document.body,
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DecorsPage() {
    const [tab, setTab] = useState("decors");
    const [decors, setDecors] = useState([]);
    const [categories, setCategories] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [search, setSearch] = useState("");
    const [type, setType] = useState("all");
    const [source, setSource] = useState("all");
    const [sale, setSale] = useState("all");
    const [page, setPage] = useState(1);
    const [openSku, setOpenSku] = useState(null);
    const [saving, setSaving] = useState(() => new Set());
    const [confirm, setConfirm] = useState(null);
    const [importing, setImporting] = useState(false);
    const [toast, setToast] = useState(null); // { ok, text }

    const notify = useCallback((ok, text) => {
        setToast({ ok, text });
        setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 4000);
    }, []);

    const fetchDecors = useCallback(async () => {
        try {
            const { data } = await api.get("/decors", { timeout: 60_000 });
            const list = Array.isArray(data) ? data : [];
            list.sort((a, b) => {
                const x = skuOrder(a), y = skuOrder(b);
                return x > y ? -1 : x < y ? 1 : 0;
            });
            setDecors(list);
            setError("");
        } catch (err) {
            setError(errText(err, "Không tải được dữ liệu decor"));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchDecors(); }, [fetchDecors]);
    useEffect(() => {
        api.get("/decors/categories").then(({ data }) => setCategories(Array.isArray(data) ? data : [])).catch(() => setCategories([]));
    }, []);
    useEffect(() => { setPage(1); }, [search, type, source, sale]);

    const bySku = useMemo(() => new Map(decors.map((d) => [d.sku_id, d])), [decors]);
    // First occurrence wins, in the server's order (category position).
    const sectionCats = useMemo(() => {
        const seen = new Set();
        return categories.filter((c) => (seen.has(c.sku_id) ? false : seen.add(c.sku_id)));
    }, [categories]);
    const themeOptions = useMemo(() => [...sectionCats].sort((a, b) => (a.name || "").localeCompare(b.name || "", "vi")), [sectionCats]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return decors.filter((d) =>
            (type === "all" || d.type === Number(type)) &&
            (source === "all" || d.decorFrom === source) &&
            matchesSale(d, sale) &&
            (!q || d.name?.toLowerCase().includes(q) || d.sku_id?.includes(q)),
        );
    }, [decors, search, type, source, sale]);

    const sections = useMemo(() => {
        if (!sectionCats.length) return null;
        const groups = new Map();
        for (const d of filtered) {
            const k = d.category_sku_id || "__other";
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(d);
        }
        const out = [];
        for (const cat of sectionCats) {
            const items = groups.get(cat.sku_id);
            if (items?.length) out.push({ key: cat.sku_id, cat, items });
            groups.delete(cat.sku_id);
        }
        const rest = [...groups.values()].flat();
        if (rest.length) out.push({ key: "__other", cat: { name: "Khác" }, items: rest });
        return out;
    }, [filtered, sectionCats]);

    const stats = useMemo(() => {
        let missing = 0, partial = 0, off = 0, imported = 0;
        for (const d of decors) {
            const s = saleState(d);
            if (s.missing) missing++;
            if (!s.on) off++;
            else if (s.on < WAYS.length) partial++;
            if (d.decorFrom === "importedDecors") imported++;
        }
        return { missing, partial, off, imported };
    }, [decors]);

    const pages = sections ? Math.ceil(sections.length / SECTIONS_PER_PAGE) : Math.ceil(filtered.length / ITEMS_PER_PAGE);
    const shownSections = sections ? sections.slice((page - 1) * SECTIONS_PER_PAGE, page * SECTIONS_PER_PAGE) : null;
    const shownItems = sections ? null : filtered.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);

    const setFlags = (skus, patch) => {
        const ids = new Set(skus);
        setDecors((list) => list.map((d) => (ids.has(d.sku_id) ? { ...d, ...patch } : d)));
    };
    const markSaving = (sku, on) =>
        setSaving((s) => {
            const next = new Set(s);
            if (on) next.add(sku);
            else next.delete(sku);
            return next;
        });

    // Optimistic: the switch flips at once and flips back if the panel refuses.
    const toggle = async (decor, w) => {
        const patch = { [w.flag]: sells(decor, w) };
        const undo = { [w.flag]: !!decor[w.flag] };
        setFlags([decor.sku_id], patch);
        markSaving(decor.sku_id, true);
        try {
            await api.patch(`/decors/${decor.sku_id}`, patch);
        } catch (err) {
            setFlags([decor.sku_id], undo);
            notify(false, errText(err, "Không lưu được"));
        } finally {
            markSaving(decor.sku_id, false);
        }
    };

    const runBulk = (action, items) => {
        const [mode, which] = action.split(":");
        const flags = which === "all" ? WAYS.map((w) => w.flag) : [which];
        const patch = Object.fromEntries(flags.map((f) => [f, mode === "off"]));
        const what = which === "all" ? "cả 3 loại" : WAYS.find((w) => w.flag === which).label;
        const changing = items.filter((d) => flags.some((f) => !!d[f] !== (mode === "off")));
        if (!changing.length) return notify(true, `Cả ${items.length} decor đều đã ${mode === "off" ? "tắt" : "bật"} ${what}.`);
        setConfirm({
            title: `${mode === "off" ? "Tắt" : "Bật"} ${what} cho ${changing.length} decor?`,
            message: `${changing.length} trên ${items.length} decor đang chọn sẽ ${mode === "off" ? "ngừng bán" : "được bán"} ${what} — trên site decor và trong /decor-find.`,
            confirmText: mode === "off" ? "Tắt" : "Bật",
            danger: mode === "off",
            onConfirm: async () => {
                setConfirm(null);
                const skus = changing.map((d) => d.sku_id);
                try {
                    const { data } = await api.patch("/decors", { sku_ids: skus, ...patch });
                    setFlags(skus, patch);
                    notify(true, data.message || `Đã cập nhật ${skus.length} decor`);
                } catch (err) {
                    notify(false, errText(err, "Không lưu được"));
                }
            },
        });
    };

    const setTheme = async (decor, category) => {
        markSaving(decor.sku_id, true);
        try {
            await api.patch(`/decors/${decor.sku_id}`, { category_sku_id: category });
            setFlags([decor.sku_id], { category_sku_id: category });
        } catch (err) {
            notify(false, errText(err, "Không đổi được theme"));
        } finally {
            markSaving(decor.sku_id, false);
        }
    };

    const askDelete = (decor) =>
        setConfirm({
            title: `Xóa decor "${decor.name}"?`,
            message: "Chỉ xóa khỏi importedDecors (decor import tay). Decor load từ shop không bị ảnh hưởng.",
            confirmText: "Xóa",
            danger: true,
            onConfirm: async () => {
                setConfirm(null);
                try {
                    await api.delete(`/decors/import/${decor.sku_id}`);
                    setOpenSku(null);
                    notify(true, `Đã xóa "${decor.name}"`);
                    fetchDecors();
                } catch (err) {
                    notify(false, errText(err, "Xóa thất bại"));
                }
            },
        });

    const openDecor = openSku ? bySku.get(openSku) : null;
    const card = (d) => <DecorCard key={d.sku_id} decor={d} saving={saving.has(d.sku_id)} onOpen={setOpenSku} onToggle={toggle} />;
    const onPage = (n) => {
        setPage(n);
        document.querySelector(".decor-page")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    return (
        <div className="fade-in page decor-page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 18 }}>
            <div className="dc-head">
                <div>
                    <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Decor</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>
                        Như site decor, kèm công tắc bán từng loại: Login có Nitro, Login không Nitro, Gift.
                    </p>
                </div>
                <button type="button" className="btn-primary" onClick={() => setImporting(true)}>＋ Import decor</button>
            </div>

            <div className="dc-tabs">
                <button type="button" className={`dc-tab${tab === "decors" ? " active" : ""}`} onClick={() => setTab("decors")}>Decor ({decors.length})</button>
                <button type="button" className={`dc-tab${tab === "prices" ? " active" : ""}`} onClick={() => setTab("prices")}>Bảng giá</button>
            </div>

            {error && <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger-border)", fontSize: 13 }}>{error}</div>}

            {tab === "prices" ? (
                <DecorPrices onChange={fetchDecors} />
            ) : (
                <>
                    <div className="dc-toolbar">
                        <div className="dc-toolbar-row">
                            <input className="input" style={{ flex: "1 1 220px", minWidth: 0, padding: "7px 12px", fontSize: 13 }} placeholder="Tìm tên hoặc sku_id…" value={search} onChange={(e) => setSearch(e.target.value)} />
                            <select className="input" style={{ width: "auto", padding: "7px 10px", fontSize: 12 }} value={source} onChange={(e) => setSource(e.target.value)}>
                                <option value="all">Mọi nguồn</option>
                                <option value="decors">Shop (/decor-load)</option>
                                <option value="importedDecors">Giới hạn (import tay)</option>
                            </select>
                            <select className="input" style={{ width: "auto", padding: "7px 10px", fontSize: 12 }} value={sale} onChange={(e) => setSale(e.target.value)}>
                                {SALE_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                        </div>
                        <div className="dc-filter-pills">
                            {TYPE_FILTERS.map(([v, l]) => (
                                <button key={v} type="button" className={`dc-pill${type === v ? " active" : ""}`} onClick={() => setType(v)}>
                                    {v !== "all" && <span className="dc-dot" style={{ background: `var(--dc-${TYPE_INFO[v].color})` }} />}
                                    {l}
                                </button>
                            ))}
                        </div>
                        <div className="dc-toolbar-row">
                            <div className="dc-stats">
                                <span>{filtered.length} / {decors.length} decor · {stats.imported} giới hạn</span>
                                {stats.missing > 0 && <button type="button" className="dc-stat dc-stat--danger" onClick={() => setSale("missing")}>Thiếu mốc giá: {stats.missing}</button>}
                                {stats.partial > 0 && <button type="button" className="dc-stat dc-stat--warn" onClick={() => setSale("partial")}>Tắt một phần: {stats.partial}</button>}
                                {stats.off > 0 && <button type="button" className="dc-stat" onClick={() => setSale("off")}>Ngừng bán: {stats.off}</button>}
                                {(search || type !== "all" || source !== "all" || sale !== "all") && (
                                    <button type="button" className="dc-stat" onClick={() => { setSearch(""); setType("all"); setSource("all"); setSale("all"); }}>✕ Bỏ lọc</button>
                                )}
                            </div>
                            <BulkSelect items={filtered} label={`Hàng loạt cho ${filtered.length} decor đang lọc…`} onRun={runBulk} />
                        </div>
                    </div>

                    {loading ? (
                        <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Đang tải decor…</div>
                    ) : filtered.length === 0 ? (
                        <div style={{ padding: 40, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>{decors.length ? "Không có decor nào khớp bộ lọc." : "Chưa có decor."}</div>
                    ) : shownSections ? (
                        <div className="dc-sections">
                            {shownSections.map(({ key, cat, items }) => (
                                <section key={key}>
                                    {cat.banner ? (
                                        <div className="dc-banner">
                                            <picture>
                                                {cat.mobileBanner && <source media="(max-width: 640px)" srcSet={cat.mobileBanner} />}
                                                <img src={cat.banner} alt={cat.name} loading="lazy" />
                                            </picture>
                                        </div>
                                    ) : (
                                        <div className="dc-section-title"><h2>{cat.name}</h2></div>
                                    )}
                                    <div className="dc-section-bar">
                                        <strong>{cat.name}</strong>
                                        <span>{items.length} decor</span>
                                        {WAYS.map((w) => {
                                            const n = items.filter((d) => sells(d, w)).length;
                                            return <span key={w.key} style={{ color: n === items.length ? "var(--text-dim)" : "var(--warning)" }}>· {w.short} {n}/{items.length}</span>;
                                        })}
                                        <BulkSelect items={items} label="Hàng loạt cho mục này…" onRun={runBulk} />
                                    </div>
                                    <div className="dc-grid">{items.map(card)}</div>
                                </section>
                            ))}
                        </div>
                    ) : (
                        <div className="dc-grid">{shownItems.map(card)}</div>
                    )}

                    <Pagination page={page} pages={pages} onPage={onPage} />
                </>
            )}

            {openDecor && (
                <DecorModal
                    decor={openDecor}
                    categories={themeOptions}
                    saving={saving.has(openDecor.sku_id)}
                    onClose={() => setOpenSku(null)}
                    onToggle={toggle}
                    onTheme={setTheme}
                    onDelete={askDelete}
                    onOpen={(sku) => bySku.has(sku) && setOpenSku(sku)}
                />
            )}
            {importing && <ImportModal onClose={() => setImporting(false)} onImported={fetchDecors} />}
            {confirm && (
                <ConfirmModal
                    title={confirm.title}
                    message={confirm.message}
                    confirmText={confirm.confirmText}
                    danger={confirm.danger}
                    onConfirm={confirm.onConfirm}
                    onCancel={() => setConfirm(null)}
                />
            )}
            {toast && (
                <div className="dc-toast" style={{ background: "#111827", color: toast.ok ? "var(--success)" : "var(--danger)", border: `1px solid ${toast.ok ? "var(--success-border)" : "var(--danger-border)"}` }}>
                    {toast.text}
                </div>
            )}
        </div>
    );
}
