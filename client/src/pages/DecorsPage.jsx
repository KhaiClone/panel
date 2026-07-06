import { useState, useEffect, useCallback } from "react";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

const TYPES = [
    { value: 0, label: "Avatar (0)" },
    { value: 1, label: "Profile Effect (1)" },
    { value: 2, label: "Nameplate (2)" },
    { value: 1000, label: "Bundle (1000)" },
];
const TYPE_LABEL = { 0: "Avatar", 1: "Profile", 2: "Nameplate", 1000: "Bundle" };

const SUMMARY_PRESET = {
    0: "Tạo diện mạo mới cho ảnh đại diện của bạn.",
    1: "Hiển thị hiệu ứng này khi người khác xem hồ sơ của bạn.",
    2: "Để tên của bạn trở nên nổi bật trên máy chủ và cuộc trò chuyện.",
};

const money = (n) => (typeof n === "number" ? n.toLocaleString("vi-VN") + "đ" : "—");

const emptyForm = {
    type: 0,
    sku_id: "", name: "", withoutNitro: "", withNitro: "",
    summary: SUMMARY_PRESET[0], label: "",
    asset: "", assetURL: "", staticURL: "", effects: "",
    items: "", imageFg: "", imageBg: "",
};

function Field({ label, hint, children }) {
    return (
        <div>
            <label className="label">{label}</label>
            {children}
            {hint && <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{hint}</p>}
        </div>
    );
}

function ImportForm({ onImported }) {
    const [form, setForm] = useState(emptyForm);
    const [preview, setPreview] = useState(null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null); // { ok, text }

    const set = (f) => (e) => setForm((s) => ({ ...s, [f]: e.target.value }));
    const setType = (t) => setForm((s) => ({ ...s, type: t, summary: SUMMARY_PRESET[t] ?? s.summary }));

    const isBundle = form.type === 1000;
    const isProfile = form.type === 1;
    const usesAsset = form.type === 0 || form.type === 2;

    const payload = () => ({
        ...form,
        type: Number(form.type),
        withoutNitro: Number(form.withoutNitro),
        withNitro: Number(form.withNitro),
    });

    const doPreview = async () => {
        setBusy(true); setMsg(null); setPreview(null);
        try {
            const { data } = await api.post("/decors/preview", payload());
            setPreview(data.decor);
        } catch (err) {
            setMsg({ ok: false, text: err.response?.data?.error || err.response?.data?.message || "Lỗi xem trước" });
        } finally { setBusy(false); }
    };

    const doImport = async () => {
        setBusy(true); setMsg(null);
        try {
            const { data } = await api.post("/decors/import", payload());
            setMsg({ ok: true, text: `Đã import "${data.decor?.name}" (${data.decor?.sku_id})` });
            setForm({ ...emptyForm, type: form.type, summary: SUMMARY_PRESET[form.type] ?? "" });
            setPreview(null);
            onImported();
        } catch (err) {
            setMsg({ ok: false, text: err.response?.data?.error || err.response?.data?.message || "Lỗi import" });
        } finally { setBusy(false); }
    };

    return (
        <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Import decor</h3>

            <Field label="Loại decor">
                <div className="tab-bar">
                    {TYPES.map((t) => (
                        <button key={t.value} type="button" className={`tab-item ${form.type === t.value ? "active" : ""}`} onClick={() => setType(t.value)}>
                            {t.label}
                        </button>
                    ))}
                </div>
            </Field>

            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <Field label="SKU ID *"><input className="input mono" value={form.sku_id} onChange={set("sku_id")} /></Field>
                <Field label="Tên *"><input className="input" value={form.name} onChange={set("name")} /></Field>
            </div>

            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <Field label="Giá gốc (không Nitro) *"><input className="input mono" type="number" value={form.withoutNitro} onChange={set("withoutNitro")} /></Field>
                <Field label="Giá gốc (có Nitro) *"><input className="input mono" type="number" value={form.withNitro} onChange={set("withNitro")} /></Field>
            </div>

            {!isBundle && (
                <>
                    <Field label="Summary *" hint="Tự điền theo loại, sửa được.">
                        <input className="input" value={form.summary} onChange={set("summary")} />
                    </Field>
                    <Field label="Label *"><input className="input" value={form.label} onChange={set("label")} /></Field>
                </>
            )}

            {usesAsset && (
                <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                    <Field label="Asset hash" hint={form.type === 0 ? "→ avatar-decoration-presets/{hash}.png" : "→ assets/collectibles/{hash}asset.webm"}>
                        <input className="input mono" value={form.asset} onChange={set("asset")} placeholder="vd: a1b2c3…" />
                    </Field>
                    <Field label="assetURL (ghi đè)" hint="Điền nếu không có asset hash — dùng URL này trực tiếp.">
                        <input className="input mono" value={form.assetURL} onChange={set("assetURL")} placeholder="https://…" />
                    </Field>
                </div>
            )}

            {isProfile && (
                <>
                    <Field label="staticURL (ảnh tĩnh/staticFrameSrc) *">
                        <input className="input mono" value={form.staticURL} onChange={set("staticURL")} placeholder="https://…" />
                    </Field>
                    <Field label="effects (JSON, tùy chọn)" hint='Mảng effects nếu có, vd [{"type":1}]'>
                        <textarea className="input mono" style={{ height: 70, resize: "vertical", fontSize: 12 }} value={form.effects} onChange={set("effects")} />
                    </Field>
                </>
            )}

            {usesAsset && (
                <Field label="staticURL (ghi đè, tùy chọn)" hint="Bỏ trống để tự dựng từ sku_id.">
                    <input className="input mono" value={form.staticURL} onChange={set("staticURL")} placeholder="https://…" />
                </Field>
            )}

            {isBundle && (
                <>
                    <Field label="Items (sku_id, phân cách bằng dấu phẩy) *">
                        <input className="input mono" value={form.items} onChange={set("items")} placeholder="111, 222, 333" />
                    </Field>
                    <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                        <Field label="Image foreground *"><input className="input mono" value={form.imageFg} onChange={set("imageFg")} placeholder="https://…" /></Field>
                        <Field label="Image background *"><input className="input mono" value={form.imageBg} onChange={set("imageBg")} placeholder="https://…" /></Field>
                    </div>
                </>
            )}

            {msg && (
                <div style={{ padding: "10px 14px", borderRadius: 8, fontSize: 13, background: msg.ok ? "var(--success-bg)" : "var(--danger-bg)", color: msg.ok ? "var(--success)" : "var(--danger)", border: `1px solid ${msg.ok ? "var(--success-border)" : "var(--danger-border)"}` }}>
                    {msg.text}
                </div>
            )}

            {preview && (
                <div>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", margin: "0 0 6px" }}>Xem trước (đã chuẩn hóa)</p>
                    <pre className="mono" style={{ margin: 0, padding: 12, background: "var(--bg-input)", borderRadius: 8, fontSize: 11, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                        {JSON.stringify(preview, null, 2)}
                    </pre>
                </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button type="button" className="btn-ghost" disabled={busy} onClick={doPreview}>Xem trước</button>
                <button type="button" className="btn-primary" disabled={busy} onClick={doImport}>{busy ? "Đang xử lý…" : "Import"}</button>
            </div>
        </div>
    );
}

export default function DecorsPage() {
    const [decors, setDecors] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [search, setSearch] = useState("");
    const [sourceFilter, setSourceFilter] = useState("all");
    const [confirmDel, setConfirmDel] = useState(null);

    const fetchDecors = useCallback(async () => {
        try {
            const { data } = await api.get("/decors");
            setDecors(Array.isArray(data) ? data : []);
            setError("");
        } catch (err) {
            setError(err.response?.data?.error || err.response?.data?.message || "Không kết nối được ArnTo-assistant");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchDecors(); }, [fetchDecors]);

    const handleDelete = async () => {
        const sku = confirmDel;
        setConfirmDel(null);
        try {
            await api.delete(`/decors/import/${sku}`);
            fetchDecors();
        } catch (err) {
            alert(err.response?.data?.error || err.response?.data?.message || "Không xóa được");
        }
    };

    const visible = decors.filter((d) => {
        const mSrc = sourceFilter === "all" || d.decorFrom === sourceFilter;
        const q = search.trim().toLowerCase();
        const mQ = !q || d.sku_id?.toLowerCase().includes(q) || d.name?.toLowerCase().includes(q);
        return mSrc && mQ;
    });
    const importedCount = decors.filter((d) => d.decorFrom === "importedDecors").length;

    return (
        <div className="fade-in page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
                <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Decor (ArnTo-assistant)</h1>
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>Import decor với dữ liệu chuẩn hóa giống <code>/decor-load</code>, và quản lý decor đã import.</p>
            </div>

            {error && <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger-border)", fontSize: 13 }}>{error}</div>}

            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "minmax(0, 420px) 1fr", gap: 20, alignItems: "start" }}>
                <ImportForm onImported={fetchDecors} />

                <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                    <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-light)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                        <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Danh sách ({decors.length})</h3>
                        <span className="badge" style={{ background: "rgba(6,182,212,0.12)", color: "#22d3ee", fontSize: 10 }}>{importedCount} imported</span>
                        <input className="input" style={{ flex: "1 1 160px", maxWidth: 220, padding: "6px 10px", fontSize: 12 }} placeholder="Tìm sku_id / tên…" value={search} onChange={(e) => setSearch(e.target.value)} />
                        <select className="input" style={{ width: "auto", padding: "6px 10px", fontSize: 12 }} value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
                            <option value="all">Tất cả nguồn</option>
                            <option value="decors">Loaded</option>
                            <option value="importedDecors">Imported</option>
                        </select>
                    </div>
                    <div style={{ maxHeight: 620, overflowY: "auto" }}>
                        {loading ? (
                            <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Đang tải…</div>
                        ) : visible.length === 0 ? (
                            <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Không có decor nào.</div>
                        ) : (
                            visible.map((d) => {
                                const img = d.type === 1000 ? (d.assetURL?.[0]) : (d.staticURL || d.assetURL);
                                const imported = d.decorFrom === "importedDecors";
                                return (
                                    <div key={d.sku_id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border-light)" }}>
                                        <div style={{ width: 40, height: 40, borderRadius: 8, background: "var(--bg-input)", flexShrink: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                            {img ? <img src={img} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { e.target.style.display = "none"; }} /> : <span style={{ fontSize: 16 }}>🎁</span>}
                                        </div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{d.name}</span>
                                                <span className="badge" style={{ fontSize: 9, background: "var(--bg-input)", color: "var(--text-muted)" }}>{TYPE_LABEL[d.type] || d.type}</span>
                                                <span className="badge" style={{ fontSize: 9, background: imported ? "rgba(6,182,212,0.12)" : "rgba(99,102,241,0.12)", color: imported ? "#22d3ee" : "var(--accent-hover)" }}>{imported ? "imported" : "loaded"}</span>
                                            </div>
                                            <p className="mono" style={{ fontSize: 10, color: "var(--text-dim)", margin: "2px 0 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.sku_id}</p>
                                        </div>
                                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                                            <p className="mono" style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>{money(d.prices?.withNitro)}</p>
                                        </div>
                                        {imported && (
                                            <button className="btn-ghost" style={{ padding: "4px 8px", fontSize: 12, color: "var(--danger)", flexShrink: 0 }} onClick={() => setConfirmDel(d.sku_id)}>Xóa</button>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            </div>

            {confirmDel && (
                <ConfirmModal
                    title={`Xóa decor "${confirmDel}"?`}
                    message="Chỉ xóa khỏi importedDecors (decor import thủ công). Không ảnh hưởng tới decor load từ shop."
                    confirmText="Xóa"
                    onConfirm={handleDelete}
                    onCancel={() => setConfirmDel(null)}
                />
            )}
        </div>
    );
}
