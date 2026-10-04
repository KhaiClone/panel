import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";
import { ActiveFieldContext, insertAtCaret } from "../components/embeds/Field";
import MessageEditor from "../components/embeds/MessageEditor";
import CardEditor from "../components/embeds/CardEditor";
import VariablePanel from "../components/embeds/VariablePanel";
import { MessagePreview, CardPreview } from "../components/embeds/DiscordPreview";
import {
    buildSample,
    buildSlotSample,
    checkCard,
    checkMessage,
    interpolate,
    mergeCard,
    mergeSelects,
    parseColor,
    parseEmoji,
    renderMessage,
    validateMessage,
} from "../lib/uiTemplate";
import "../components/embeds/embeds.css";

// Embeds — every message the bots send (services/uiTemplateService.js): pick a
// template, edit it Discohook-style with live preview, save; the bot picks the
// change up within ~15 s. Plus the {custom.*} variables and the panels each bot
// posted (re-render them after a change).

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const STYLE_NUM = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };

const errText = (err) => err.response?.data?.errors?.join("\n") || err.response?.data?.error || err.message;

function Msg({ type, children }) {
    if (!children) return null;
    return <div className={`emb-msg ${type}`} style={{ whiteSpace: "pre-line" }}>{children}</div>;
}

// ── Preview of the draft ─────────────────────────────────────────────────────

function usePreview(tpl, draft, sample) {
    return useMemo(() => {
        if (!tpl || !draft) return null;
        const { def, types, globals, custom } = tpl;
        try {
            if (def.kind === "card") {
                const errors = checkCard(draft);
                if (errors.length) return { errors, warnings: [] };
                const merged = mergeCard(def.default, draft);
                const slotScope = (slot) => ({ ...buildSlotSample(def, types, custom, globals, slot), ...sample });
                const parts = Object.entries(merged.texts).map(([slot, txt]) => ({ slot, text: interpolate(txt, slotScope(slot)) }));
                const buttons = Object.entries(merged.buttons).map(([slot, b]) => ({
                    slot,
                    label: interpolate(b.label || "", sample),
                    emoji: parseEmoji(interpolate(b.emoji || "", sample)),
                    style: STYLE_NUM[String(b.style || "secondary").toLowerCase()] || 2,
                }));
                const selects = Object.entries(merged.selects).map(([slot, s]) => ({
                    slot,
                    placeholder: interpolate(s.placeholder || "", slotScope(slot)),
                    option: s.label ? { label: interpolate(s.label, slotScope(slot)), description: s.description ? interpolate(s.description, slotScope(slot)) : "" } : null,
                }));
                const colorSrc = merged.color;
                const color = parseColor(typeof colorSrc === "string" ? interpolate(colorSrc, sample) : colorSrc);
                return { card: { color, parts, buttons, selects }, errors: [], warnings: [] };
            }
            const errors = checkMessage(draft);
            if (errors.length) return { errors, warnings: [] };
            const present = {};
            for (const [slot, d] of Object.entries(def.slots || {})) present[slot] = d.style === "Link" ? { url: "https://discord.com/channels/…" } : { customId: `preview:${slot}` };
            const msg = renderMessage(draft, sample, { slots: def.slots || {}, present });
            const selects = Object.entries(mergeSelects(def.selects, draft.selects)).map(([slot, s]) => ({
                placeholder: interpolate(s.placeholder || "", { ...buildSlotSample(def, types, custom, globals, slot), ...sample }),
            }));
            const warnings = validateMessage(msg, { allowEmpty: !!def.allowEmpty || selects.length > 0 });
            return { msg, selects, errors: [], warnings };
        } catch (e) {
            return { errors: [e.message], warnings: [] };
        }
    }, [tpl, draft, sample]);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function CustomVars({ custom, onSaved }) {
    const [rows, setRows] = useState(() => Object.entries(custom || {}).map(([k, v]) => ({ k, v })));
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);
    const save = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const vars = Object.fromEntries(rows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));
            const { data } = await api.put("/ui/custom", { vars });
            onSaved(data.custom);
            setMsg({ type: "ok", text: "Đã lưu — các bot nhận trong khoảng 15 giây." });
        } catch (err) {
            setMsg({ type: "err", text: errText(err) });
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12, maxWidth: 900 }}>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
                Biến dùng được trong <b>mọi</b> mẫu của mọi bot: <code>{"{custom.ten}"}</code>. Hợp để đặt một chỗ rồi dùng khắp nơi — logo, màu chủ đạo, link
                kênh, câu chào… Ví dụ màu: đặt <code>mau</code> = <code>#ff66aa</code>, rồi ghi màu embed là <code>{"{custom.mau}"}</code>.
            </p>
            {rows.map((r, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <div style={{ width: 200 }}>
                        <input className="input" placeholder="ten_bien" value={r.k} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <textarea className="input" rows={1} style={{ resize: "vertical" }} placeholder="Giá trị" value={r.v} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
                    </div>
                    <button type="button" className="btn-ghost emb-mini" style={{ color: "var(--danger)" }} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                        ✕
                    </button>
                </div>
            ))}
            <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn-ghost" onClick={() => setRows([...rows, { k: "", v: "" }])}>+ Thêm biến</button>
                <button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? "Đang lưu…" : "Lưu"}</button>
            </div>
            {msg && <Msg type={msg.type}>{msg.text}</Msg>}
        </div>
    );
}

function Posted({ data, refresh, adopt }) {
    const [busy, setBusy] = useState(null);
    const [result, setResult] = useState(null);
    const [adoptKey, setAdoptKey] = useState("");
    const [link, setLink] = useState("");
    const labels = {};
    const refreshableKeys = [];
    for (const p of data.projects) for (const [k, d] of Object.entries(p.templates)) {
        labels[k] = `${p.name} · ${d.label}`;
        if (d.refreshable) refreshableKeys.push(k);
    }
    const run = async (id, fn) => {
        setBusy(id);
        setResult(null);
        try {
            setResult({ type: "ok", text: await fn() });
        } catch (err) {
            setResult({ type: "err", text: errText(err) });
        } finally {
            setBusy(null);
        }
    };
    const describe = (res) =>
        res.results
            .map((r) => {
                const name = data.projects.find((p) => p.botId === r.botId)?.name || r.botId;
                if (r.error) return `${name}: lỗi — ${r.error}`;
                return `${name}: cập nhật ${r.updated}, bỏ ${r.removed} tin đã bị xoá${r.failed?.length ? `, lỗi ${r.failed.length}: ${r.failed.map((f) => f.error).join("; ")}` : ""}`;
            })
            .join("\n") || "Không có tin nào.";
    const entries = Object.entries(data.posted || {}).flatMap(([botId, list]) => list.map((p) => ({ ...p, botId })));
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1000 }}>
            <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
                        Các panel bot đã gửi vào kênh (ticket, Deco Gift…). Sửa mẫu xong bấm cập nhật để tin cũ đổi theo.
                    </p>
                    <button type="button" className="btn-primary" disabled={!!busy} onClick={() => run("all", async () => describe(await refresh({})))}>
                        {busy === "all" ? "Đang cập nhật…" : "Cập nhật tất cả"}
                    </button>
                </div>
                {!entries.length && <div style={{ fontSize: 13, color: "var(--text-dim)" }}>Chưa có tin nào được theo dõi. Gửi lại panel bằng lệnh setup, hoặc thêm tin cũ bằng link ở dưới.</div>}
                {entries.map((p) => (
                    <div key={p.messageId} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, borderTop: "1px solid var(--border-light)", paddingTop: 8, flexWrap: "wrap" }}>
                        <span style={{ flex: "1 1 260px" }}>{labels[p.key] || p.key}</span>
                        <a href={`https://discord.com/channels/${p.guildId || "@me"}/${p.channelId}/${p.messageId}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent-hover)" }}>
                            Mở tin ↗
                        </a>
                        <button type="button" className="btn-ghost emb-mini" disabled={!!busy} onClick={() => run(p.messageId, async () => describe(await refresh({ botId: p.botId, keys: [p.key] })))}>
                            {busy === p.messageId ? "…" : "Cập nhật"}
                        </button>
                    </div>
                ))}
            </div>
            <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
                <span className="emb-section-title">Thêm panel đã gửi trước đây</span>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <select className="input" style={{ width: "auto", minWidth: 240 }} value={adoptKey} onChange={(e) => setAdoptKey(e.target.value)}>
                        <option value="">Chọn loại panel…</option>
                        {refreshableKeys.map((k) => <option key={k} value={k}>{labels[k]}</option>)}
                    </select>
                    <input className="input" style={{ flex: "1 1 280px" }} placeholder="Link tin nhắn (chuột phải → Copy Message Link)" value={link} onChange={(e) => setLink(e.target.value)} />
                    <button
                        type="button"
                        className="btn-primary"
                        disabled={!adoptKey || !link || !!busy}
                        onClick={() => run("adopt", async () => {
                            await adopt({ key: adoptKey, link });
                            setLink("");
                            return "Đã thêm và cập nhật tin theo mẫu hiện tại.";
                        })}
                    >
                        {busy === "adopt" ? "…" : "Thêm"}
                    </button>
                </div>
            </div>
            {result && <Msg type={result.type}>{result.text}</Msg>}
        </div>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function EmbedsPage() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [tab, setTab] = useState("templates");
    const [botFilter, setBotFilter] = useState("all");
    const [search, setSearch] = useState("");
    const [key, setKey] = useState(null);
    const [draft, setDraft] = useState(null);
    const [saved, setSaved] = useState(null);
    const [jsonMode, setJsonMode] = useState(false);
    const [jsonText, setJsonText] = useState("");
    const [jsonError, setJsonError] = useState(null);
    const [sampleText, setSampleText] = useState("");
    const [sampleError, setSampleError] = useState(null);
    const [showSample, setShowSample] = useState(false);
    const [active, setActive] = useState(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(null);
    const [confirmReset, setConfirmReset] = useState(false);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get("/ui");
            setData(data);
            setError(null);
        } catch (err) {
            setError(errText(err));
        }
    }, []);
    useEffect(() => {
        load();
    }, [load]);

    const all = useMemo(() => {
        if (!data) return [];
        const out = [];
        for (const p of data.projects) {
            for (const [k, def] of Object.entries(p.templates)) out.push({ key: k, botId: p.botId, botName: p.name, def, types: p.types, globals: p.globals, custom: data.custom });
        }
        return out.sort((a, b) => a.botName.localeCompare(b.botName) || a.def.group.localeCompare(b.def.group) || a.def.label.localeCompare(b.def.label));
    }, [data]);

    const tpl = all.find((t) => t.key === key) || null;
    const dirty = draft && saved !== undefined && JSON.stringify(draft) !== JSON.stringify(saved);

    const open = (t) => {
        if (dirty && !window.confirm("Bỏ các thay đổi chưa lưu?")) return;
        const over = data.overrides[t.key]?.value;
        const start = over ? clone(over) : t.def.kind === "card" ? {} : clone(t.def.default) || {};
        setKey(t.key);
        setDraft(start);
        setSaved(clone(start));
        setJsonMode(false);
        setJsonError(null);
        setNotice(null);
        setActive(null);
        setSampleText(JSON.stringify(buildSample(t.def, t.types, data.custom, t.globals), null, 2));
        setSampleError(null);
    };

    const sample = useMemo(() => {
        try {
            const s = sampleText ? JSON.parse(sampleText) : {};
            return s;
        } catch {
            return tpl ? buildSample(tpl.def, tpl.types, data?.custom, tpl.globals) : {};
        }
    }, [sampleText, tpl, data]);
    const preview = usePreview(tpl, draft, sample);

    const save = async () => {
        setBusy(true);
        setNotice(null);
        try {
            const { data: res } = await api.put(`/ui/templates/${encodeURIComponent(key)}`, { value: draft });
            setData((d) => ({ ...d, version: res.version, overrides: { ...d.overrides, [key]: { value: clone(draft), updatedAt: Date.now() } } }));
            setSaved(clone(draft));
            setNotice({ type: res.warnings?.length ? "warn" : "ok", text: `Đã lưu — bot nhận trong khoảng 15 giây.${res.warnings?.length ? `\nVới dữ liệu xem trước: ${res.warnings.join("; ")}` : ""}` });
        } catch (err) {
            setNotice({ type: "err", text: errText(err) });
        } finally {
            setBusy(false);
        }
    };

    const reset = async () => {
        setConfirmReset(false);
        setBusy(true);
        try {
            await api.delete(`/ui/templates/${encodeURIComponent(key)}`);
            const overrides = { ...data.overrides };
            delete overrides[key];
            setData((d) => ({ ...d, overrides }));
            const start = tpl.def.kind === "card" ? {} : clone(tpl.def.default) || {};
            setDraft(start);
            setSaved(clone(start));
            setNotice({ type: "ok", text: "Đã về mặc định của bot." });
        } catch (err) {
            setNotice({ type: "err", text: errText(err) });
        } finally {
            setBusy(false);
        }
    };

    const refreshPosted = async (body) => (await api.post("/ui/posted/refresh", body)).data;
    const adopt = async (body) => {
        const res = (await api.post("/ui/posted/adopt", body)).data;
        load();
        return res;
    };

    const setJson = (text) => {
        setJsonText(text);
        try {
            const v = JSON.parse(text);
            if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Phải là một object JSON");
            setDraft(v);
            setJsonError(null);
        } catch (e) {
            setJsonError(e.message);
        }
    };

    if (error) return <div className="page"><Msg type="err">{error}</Msg></div>;
    if (!data) return <div className="page" style={{ color: "var(--text-muted)", fontSize: 13 }}>Đang tải…</div>;

    const q = search.trim().toLowerCase();
    const visible = all.filter((t) => (botFilter === "all" || t.botId === botFilter) && (!q || `${t.key} ${t.def.label} ${t.def.group} ${t.def.description}`.toLowerCase().includes(q)));
    const groups = [];
    for (const t of visible) {
        const g = `${t.botName} · ${t.def.group}`;
        if (!groups.length || groups[groups.length - 1].name !== g) groups.push({ name: g, items: [] });
        groups[groups.length - 1].items.push(t);
    }

    return (
        <ActiveFieldContext.Provider value={{ setActive }}>
            <div className="fade-in page" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                    <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Embeds</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>
                        Mọi tin nhắn các bot gửi — sửa như Discohook, có biến thay thế, xem trước trực tiếp. Lưu xong bot dùng ngay (khoảng 15 giây).
                    </p>
                </div>
                <div className="tab-bar" style={{ alignSelf: "flex-start" }}>
                    {[
                        ["templates", `Mẫu tin nhắn (${all.length})`],
                        ["custom", `Biến tùy chỉnh (${Object.keys(data.custom || {}).length})`],
                        ["posted", `Panel đã gửi (${Object.values(data.posted || {}).flat().length})`],
                    ].map(([id, label]) => (
                        <button key={id} className={`tab-item ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                            {label}
                        </button>
                    ))}
                </div>

                {tab === "custom" && <CustomVars custom={data.custom} onSaved={(custom) => setData((d) => ({ ...d, custom }))} />}
                {tab === "posted" && <Posted data={data} refresh={refreshPosted} adopt={adopt} />}

                {tab === "templates" && !all.length && (
                    <div className="card" style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 14 }}>
                        Chưa có bot nào gửi danh sách mẫu. Cập nhật bot (thư viện MessageTemplates) rồi khởi động lại.
                    </div>
                )}

                {tab === "templates" && all.length > 0 && (
                    <div className="emb-layout">
                        {/* List */}
                        <div className="card emb-sticky" style={{ padding: 10 }}>
                            <input className="input" placeholder="Tìm mẫu…" value={search} onChange={(e) => setSearch(e.target.value)} />
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                {[["all", "Tất cả"], ...data.projects.map((p) => [p.botId, p.name])].map(([id, name]) => (
                                    <button key={id} type="button" className={`tab-item ${botFilter === id ? "active" : ""}`} style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => setBotFilter(id)}>
                                        {name}
                                    </button>
                                ))}
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 2, overflow: "auto" }}>
                                {groups.map((g) => (
                                    <div key={g.name}>
                                        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", margin: "10px 6px 4px" }}>{g.name}</div>
                                        {g.items.map((t) => (
                                            <div key={t.key} className={`emb-list-item ${t.key === key ? "active" : ""}`} onClick={() => open(t)} title={t.key}>
                                                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.def.label}</span>
                                                {t.def.kind === "card" && <span className="badge" style={{ fontSize: 9 }}>V2</span>}
                                                {data.overrides[t.key] && <span className="emb-dot" title="Đã sửa" />}
                                            </div>
                                        ))}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Editor */}
                        <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
                            {!tpl && <div style={{ color: "var(--text-dim)", fontSize: 14, padding: 24, textAlign: "center" }}>Chọn một mẫu bên trái để sửa.</div>}
                            {tpl && (
                                <>
                                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                                        <div style={{ minWidth: 0 }}>
                                            <h2 style={{ margin: 0, fontSize: 17 }}>{tpl.def.label}</h2>
                                            <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>{tpl.key} · {tpl.botName}{data.overrides[tpl.key] ? " · đã sửa" : " · mặc định"}</div>
                                            {tpl.def.description && <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{tpl.def.description}</p>}
                                        </div>
                                        <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
                                            <button
                                                type="button"
                                                className="btn-ghost emb-mini"
                                                onClick={() => {
                                                    if (!jsonMode) setJsonText(JSON.stringify(draft, null, 2));
                                                    setJsonMode(!jsonMode);
                                                    setJsonError(null);
                                                }}
                                            >
                                                {jsonMode ? "Trình sửa" : "JSON"}
                                            </button>
                                            {dirty && <button type="button" className="btn-ghost emb-mini" onClick={() => setDraft(clone(saved))}>Hoàn tác</button>}
                                            {data.overrides[tpl.key] && <button type="button" className="btn-ghost emb-mini" style={{ color: "var(--danger)" }} onClick={() => setConfirmReset(true)}>Về mặc định</button>}
                                            <button type="button" className="btn-primary" disabled={busy || !dirty || !!preview?.errors?.length || !!jsonError} onClick={save}>
                                                {busy ? "Đang lưu…" : "Lưu"}
                                            </button>
                                        </div>
                                    </div>
                                    {tpl.def.refreshable && (
                                        <Msg type="warn">
                                            Đây là panel gửi vào kênh — tin đã gửi không tự đổi. Lưu xong vào tab "Panel đã gửi" bấm Cập nhật.
                                        </Msg>
                                    )}
                                    {notice && <Msg type={notice.type}>{notice.text}</Msg>}
                                    {jsonMode ? (
                                        <>
                                            <textarea className="input mono" rows={28} style={{ fontSize: 12, resize: "vertical" }} value={jsonText} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
                                            {jsonError && <Msg type="err">JSON lỗi: {jsonError}</Msg>}
                                        </>
                                    ) : tpl.def.kind === "card" ? (
                                        <CardEditor value={draft} def={tpl.def} onChange={setDraft} />
                                    ) : (
                                        <MessageEditor value={draft} def={tpl.def} onChange={setDraft} />
                                    )}
                                </>
                            )}
                        </div>

                        {/* Preview + variables */}
                        <div className="emb-sticky">
                            {tpl && preview && (
                                <>
                                    {preview.errors.length > 0 && <Msg type="err">{preview.errors.join("\n")}</Msg>}
                                    {preview.warnings.length > 0 && <Msg type="warn">{preview.warnings.join("\n")}</Msg>}
                                    {preview.msg && <MessagePreview msg={preview.msg} selects={preview.selects} bot={sample.bot} />}
                                    {preview.card && <CardPreview {...preview.card} bot={sample.bot} />}
                                    <div className="card" style={{ padding: 10 }}>
                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setShowSample(!showSample)}>
                                            <span className="emb-section-title">{showSample ? "▾" : "▸"} Dữ liệu xem trước</span>
                                            {showSample && (
                                                <button
                                                    type="button"
                                                    className="btn-ghost emb-mini"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setSampleText(JSON.stringify(buildSample(tpl.def, tpl.types, data.custom, tpl.globals), null, 2));
                                                        setSampleError(null);
                                                    }}
                                                >
                                                    Mặc định
                                                </button>
                                            )}
                                        </div>
                                        {showSample && (
                                            <>
                                                <textarea
                                                    className="input mono"
                                                    rows={12}
                                                    style={{ fontSize: 11, marginTop: 8, resize: "vertical" }}
                                                    value={sampleText}
                                                    spellCheck={false}
                                                    onChange={(e) => {
                                                        setSampleText(e.target.value);
                                                        try {
                                                            JSON.parse(e.target.value);
                                                            setSampleError(null);
                                                        } catch (err) {
                                                            setSampleError(err.message);
                                                        }
                                                    }}
                                                />
                                                {sampleError && <Msg type="err">{sampleError}</Msg>}
                                            </>
                                        )}
                                    </div>
                                </>
                            )}
                            {tpl && (
                                <VariablePanel
                                    def={tpl.def}
                                    types={tpl.types}
                                    custom={data.custom}
                                    globals={tpl.globals}
                                    active={active}
                                    onInsert={(token) => insertAtCaret(active, token)}
                                />
                            )}
                        </div>
                    </div>
                )}
                {confirmReset && (
                    <ConfirmModal
                        title="Về mặc định?"
                        message={`"${tpl?.def.label}" sẽ dùng lại nội dung mặc định trong code của bot. Bản đã sửa bị xoá.`}
                        confirmText="Về mặc định"
                        onConfirm={reset}
                        onCancel={() => setConfirmReset(false)}
                    />
                )}
            </div>
        </ActiveFieldContext.Provider>
    );
}
