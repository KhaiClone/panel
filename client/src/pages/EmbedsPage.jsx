import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";
import { ActiveFieldContext, insertAtCaret } from "../components/embeds/Field";
import MessageEditor from "../components/embeds/MessageEditor";
import CardEditor from "../components/embeds/CardEditor";
import TemplateList from "../components/embeds/TemplateList";
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
//
// Built for a lot of templates: the list is a searchable bot → group tree that
// can be hidden, the open template lives in the URL (?t=key), the editor's
// header (with Save) stays on screen, Ctrl+K jumps to the search and Ctrl+S saves.

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const STYLE_NUM = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };
const LIST_HIDDEN_KEY = "emb.list.hidden";

const errText = (err) => err.response?.data?.errors?.join("\n") || err.response?.data?.error || err.message;

/** The answer of POST /ui/posted/refresh, one line per bot. */
const describeRefresh = (res, projects) =>
    res.results
        .map((r) => {
            const name = projects.find((p) => p.botId === r.botId)?.name || r.botId;
            if (r.error) return `${name}: lỗi — ${r.error}`;
            return `${name}: cập nhật ${r.updated}, bỏ ${r.removed} tin đã bị xoá${r.failed?.length ? `, lỗi ${r.failed.length}: ${r.failed.map((f) => f.error).join("; ")}` : ""}`;
        })
        .join("\n") || "Không có tin nào.";

function Msg({ type, children, onClose }) {
    if (!children) return null;
    return (
        <div className={`emb-msg ${type}`} style={{ whiteSpace: "pre-line", display: "flex", gap: 8, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
            {onClose && (
                <button type="button" className="emb-link" style={{ color: "inherit" }} onClick={onClose} title="Đóng">
                    ✕
                </button>
            )}
        </div>
    );
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

// The posted panels, one row per (bot, template) — a refresh re-renders every
// message of that template anyway — folded open to the messages themselves.
function Posted({ data, refresh, adopt }) {
    const [busy, setBusy] = useState(null);
    const [result, setResult] = useState(null);
    const [adoptKey, setAdoptKey] = useState("");
    const [link, setLink] = useState("");
    const [search, setSearch] = useState("");
    const [open, setOpen] = useState(() => new Set());
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
            setResult({ id, type: "ok", text: await fn() });
        } catch (err) {
            setResult({ id, type: "err", text: errText(err) });
        } finally {
            setBusy(null);
        }
    };
    const groups = new Map();
    for (const [botId, list] of Object.entries(data.posted || {})) {
        for (const p of list) {
            const id = `${botId}::${p.key}`;
            if (!groups.has(id)) groups.set(id, { id, botId, key: p.key, label: labels[p.key] || p.key, items: [] });
            groups.get(id).items.push(p);
        }
    }
    const all = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
    const total = all.reduce((n, g) => n + g.items.length, 0);
    const q = search.trim().toLowerCase();
    const shown = q ? all.filter((g) => `${g.label} ${g.key}`.toLowerCase().includes(q) || g.items.some((p) => p.channelId.includes(q) || p.messageId.includes(q))) : all;
    const toggle = (id) => {
        const next = new Set(open);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setOpen(next);
    };
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1000 }}>
            <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", flex: "1 1 300px" }}>
                        Các panel bot đã gửi vào kênh (ticket, Deco Gift…) — {total} tin, {all.length} mẫu. Sửa mẫu xong bấm cập nhật để tin cũ đổi theo (trong trình sửa mẫu cũng có nút này).
                    </p>
                    <button type="button" className="btn-primary" disabled={!!busy || !total} onClick={() => run("all", async () => describeRefresh(await refresh({}), data.projects))}>
                        {busy === "all" ? "Đang cập nhật…" : "Cập nhật tất cả"}
                    </button>
                </div>
                {result && result.id !== "adopt" && <Msg type={result.type} onClose={() => setResult(null)}>{result.text}</Msg>}
                {all.length > 4 && <input className="input" placeholder="Tìm theo mẫu, key, ID kênh / tin…" value={search} onChange={(e) => setSearch(e.target.value)} />}
                {!all.length && <div style={{ fontSize: 13, color: "var(--text-dim)" }}>Chưa có tin nào được theo dõi. Gửi lại panel bằng lệnh setup, hoặc thêm tin cũ bằng link ở dưới.</div>}
                {all.length > 0 && !shown.length && <div style={{ fontSize: 13, color: "var(--text-dim)" }}>Không có mẫu nào khớp.</div>}
                <div style={{ display: "flex", flexDirection: "column" }}>
                    {shown.map((g) => {
                        const isOpen = open.has(g.id) || (!!q && g.items.some((p) => p.channelId.includes(q) || p.messageId.includes(q)));
                        return (
                            <div key={g.id} className="emb-posted">
                                <div className="emb-posted-head" onClick={() => toggle(g.id)}>
                                    <span className="emb-caret">{isOpen ? "▾" : "▸"}</span>
                                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={g.key}>{g.label}</span>
                                    <span className="emb-count">{g.items.length} tin</span>
                                    <button
                                        type="button"
                                        className="btn-ghost emb-mini"
                                        disabled={!!busy}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            run(g.id, async () => describeRefresh(await refresh({ botId: g.botId, keys: [g.key] }), data.projects));
                                        }}
                                    >
                                        {busy === g.id ? "…" : "Cập nhật"}
                                    </button>
                                </div>
                                {isOpen && (
                                    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "2px 0 8px 22px" }}>
                                        {g.items.map((p) => (
                                            <div key={p.messageId} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, flexWrap: "wrap" }}>
                                                <span className="mono" style={{ color: "var(--text-dim)", flex: "1 1 200px" }}>
                                                    kênh {p.channelId} · tin {p.messageId}
                                                </span>
                                                {p.at && <span style={{ color: "var(--text-dim)" }}>{new Date(p.at).toLocaleDateString("vi-VN")}</span>}
                                                <a href={`https://discord.com/channels/${p.guildId || "@me"}/${p.channelId}/${p.messageId}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent-hover)" }}>
                                                    Mở tin ↗
                                                </a>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
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
                {result?.id === "adopt" && <Msg type={result.type} onClose={() => setResult(null)}>{result.text}</Msg>}
            </div>
        </div>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function EmbedsPage() {
    const [params, setParams] = useSearchParams();
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
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
    const [refreshing, setRefreshing] = useState(false);
    const [notice, setNotice] = useState(null);
    const [confirmReset, setConfirmReset] = useState(false);
    // Narrow screens show the editor or the preview, not both.
    const [pane, setPane] = useState("edit");
    const [listOpen, setListOpenState] = useState(() => {
        try {
            return localStorage.getItem(LIST_HIDDEN_KEY) !== "1";
        } catch {
            return true;
        }
    });
    const searchRef = useRef(null);
    const wanted = useRef(params.get("t"));
    // Columns by the width the page really has (the sidebar may be open or not):
    // 3 = list | editor | preview, 2 = list | editor or preview, 1 = stacked.
    const [width, setWidth] = useState(0);
    const observer = useRef(null);
    const wrapRef = useCallback((el) => {
        observer.current?.disconnect();
        if (!el) return;
        observer.current = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
        observer.current.observe(el);
    }, []);
    const cols = !width ? 3 : width < 640 ? 1 : width < (listOpen ? 1000 : 760) ? 2 : 3;

    const setParam = useCallback(
        (name, value) =>
            setParams(
                (p) => {
                    const n = new URLSearchParams(p);
                    if (value) n.set(name, value);
                    else n.delete(name);
                    return n;
                },
                { replace: true },
            ),
        [setParams],
    );
    const tab = params.get("tab") || "templates";
    const setTab = (id) => setParam("tab", id === "templates" ? null : id);
    const setListOpen = (v, remember = true) => {
        setListOpenState(v);
        if (remember) {
            try {
                localStorage.setItem(LIST_HIDDEN_KEY, v ? "0" : "1");
            } catch {
                /* storage disabled */
            }
        }
    };

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
        // One column: the list sits above the editor, get it out of the way.
        const done = () => cols === 1 && setListOpen(false, false);
        if (t.key === key) return done();
        if (dirty && !window.confirm("Bỏ các thay đổi chưa lưu?")) return;
        const over = data.overrides[t.key]?.value;
        const start = over ? clone(over) : t.def.kind === "card" ? {} : clone(t.def.default) || {};
        setKey(t.key);
        setParam("t", t.key);
        setDraft(start);
        setSaved(clone(start));
        setJsonMode(false);
        setJsonError(null);
        setNotice(null);
        setActive(null);
        setSampleText(JSON.stringify(buildSample(t.def, t.types, data.custom, t.globals), null, 2));
        setSampleError(null);
        done();
    };

    // ?t=key — reopen the template after a reload or from a shared link.
    useEffect(() => {
        if (!data || !wanted.current) return;
        const t = all.find((x) => x.key === wanted.current);
        wanted.current = null;
        if (t) open(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data, all]);

    const sample = useMemo(() => {
        try {
            const s = sampleText ? JSON.parse(sampleText) : {};
            return s;
        } catch {
            return tpl ? buildSample(tpl.def, tpl.types, data?.custom, tpl.globals) : {};
        }
    }, [sampleText, tpl, data]);
    const preview = usePreview(tpl, draft, sample);
    const canSave = !!tpl && !busy && dirty && !preview?.errors?.length && !jsonError;

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
    const postedHere = tpl ? (data.posted?.[tpl.botId] || []).filter((p) => p.key === tpl.key).length : 0;
    const refreshHere = async () => {
        setRefreshing(true);
        setNotice(null);
        try {
            const res = await refreshPosted({ botId: tpl.botId, keys: [tpl.key] });
            setNotice({ type: res.results.some((r) => r.error) ? "err" : "ok", text: describeRefresh(res, data.projects) });
        } catch (err) {
            setNotice({ type: "err", text: errText(err) });
        } finally {
            setRefreshing(false);
        }
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

    // Ctrl+S saves, Ctrl+K finds a template. A ref so the listener sees this render.
    const hotkeys = useRef({});
    hotkeys.current = {
        save: tab === "templates" ? () => canSave && save() : null,
        find:
            tab === "templates"
                ? () => {
                      setListOpen(true, false);
                      requestAnimationFrame(() => {
                          searchRef.current?.focus();
                          searchRef.current?.select();
                      });
                  }
                : null,
    };
    useEffect(() => {
        const onKey = (e) => {
            if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
            const k = e.key.toLowerCase();
            const fn = k === "s" ? hotkeys.current.save : k === "k" ? hotkeys.current.find : null;
            if (!fn) return;
            e.preventDefault();
            fn();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    useEffect(() => {
        if (!dirty) return;
        const onLeave = (e) => {
            e.preventDefault();
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", onLeave);
        return () => window.removeEventListener("beforeunload", onLeave);
    }, [dirty]);

    useEffect(() => {
        if (notice?.type !== "ok") return;
        const t = setTimeout(() => setNotice(null), 5000);
        return () => clearTimeout(t);
    }, [notice]);

    if (error) return <div className="page"><Msg type="err">{error}</Msg></div>;
    if (!data) return <div className="page" style={{ color: "var(--text-muted)", fontSize: 13 }}>Đang tải…</div>;

    return (
        <ActiveFieldContext.Provider value={{ setActive }}>
            <div className="fade-in page" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
                    <div style={{ flex: "1 1 320px" }}>
                        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Embeds</h1>
                        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>
                            Mọi tin nhắn các bot gửi — sửa như Discohook, có biến thay thế, xem trước trực tiếp. Lưu xong bot dùng ngay (khoảng 15 giây).
                        </p>
                    </div>
                    <div className="tab-bar">
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
                </div>

                {tab === "custom" && <CustomVars custom={data.custom} onSaved={(custom) => setData((d) => ({ ...d, custom }))} />}
                {tab === "posted" && <Posted data={data} refresh={refreshPosted} adopt={adopt} />}

                {tab === "templates" && !all.length && (
                    <div className="card" style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 14 }}>
                        Chưa có bot nào gửi danh sách mẫu. Cập nhật bot (thư viện MessageTemplates) rồi khởi động lại.
                    </div>
                )}

                {tab === "templates" && all.length > 0 && (
                    <div ref={wrapRef}>
                        <div className={`emb-layout cols-${cols} ${listOpen ? "" : "list-closed"}`} data-pane={pane}>
                            {listOpen ? (
                                <TemplateList
                                    all={all}
                                    projects={data.projects}
                                    overrides={data.overrides}
                                    posted={data.posted}
                                    activeKey={key}
                                    onOpen={open}
                                    onCollapse={() => setListOpen(false)}
                                    searchRef={searchRef}
                                />
                            ) : (
                                <button type="button" className="card emb-rail" onClick={() => setListOpen(true)} title="Hiện danh sách mẫu (Ctrl+K)">
                                    <span style={{ fontSize: 14 }}>☰</span>
                                    <span className="emb-rail-text">Danh sách mẫu · {all.length}</span>
                                </button>
                            )}

                            {/* Editor */}
                            <div className="card emb-editor">
                                {!tpl && (
                                    <div style={{ color: "var(--text-dim)", fontSize: 14, padding: 32, textAlign: "center" }}>
                                        Chọn một mẫu {listOpen ? "bên trái" : "trong danh sách"} để sửa — hoặc bấm <b>Ctrl+K</b> rồi gõ tên / một đoạn chữ của tin nhắn.
                                    </div>
                                )}
                                {tpl && (
                                    <>
                                        <div className="emb-editor-head">
                                            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                                                <div style={{ minWidth: 0, flex: "1 1 200px" }}>
                                                    <div className="emb-crumb">{tpl.botName} › {tpl.def.group}</div>
                                                    <h2 style={{ margin: "2px 0 0", fontSize: 17, display: "flex", alignItems: "center", gap: 8 }}>
                                                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tpl.def.label}</span>
                                                        {dirty && <span className="emb-unsaved">chưa lưu</span>}
                                                    </h2>
                                                    <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                        {tpl.key} · {data.overrides[tpl.key] ? "đã sửa" : "mặc định"}
                                                    </div>
                                                </div>
                                                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                                                    {cols < 3 && (
                                                        <div className="tab-bar" style={{ padding: 2 }}>
                                                            {[["edit", "Sửa"], ["preview", "Xem trước"]].map(([id, label]) => (
                                                                <button key={id} type="button" className={`tab-item ${pane === id ? "active" : ""}`} style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setPane(id)}>
                                                                    {label}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    )}
                                                    <button
                                                        type="button"
                                                        className="btn-ghost emb-mini"
                                                        onClick={() => {
                                                            if (!jsonMode) setJsonText(JSON.stringify(draft, null, 2));
                                                            setJsonMode(!jsonMode);
                                                            setJsonError(null);
                                                            setPane("edit");
                                                        }}
                                                    >
                                                        {jsonMode ? "Trình sửa" : "JSON"}
                                                    </button>
                                                    {dirty && <button type="button" className="btn-ghost emb-mini" onClick={() => setDraft(clone(saved))}>Hoàn tác</button>}
                                                    {data.overrides[tpl.key] && <button type="button" className="btn-ghost emb-mini" style={{ color: "var(--danger)" }} onClick={() => setConfirmReset(true)}>Về mặc định</button>}
                                                    <button type="button" className="btn-primary" disabled={!canSave} onClick={save} title="Ctrl+S">
                                                        {busy ? "Đang lưu…" : "Lưu"}
                                                    </button>
                                                </div>
                                            </div>
                                            {notice && (
                                                <div style={{ marginTop: 10 }}>
                                                    <Msg type={notice.type} onClose={() => setNotice(null)}>{notice.text}</Msg>
                                                </div>
                                            )}
                                        </div>
                                        <div className="emb-editor-body">
                                            {tpl.def.description && <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{tpl.def.description}</p>}
                                            {tpl.def.refreshable && (
                                                <div className="emb-msg warn" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                                    <span style={{ flex: "1 1 220px" }}>
                                                        Panel gửi vào kênh — tin đã gửi không tự đổi theo mẫu.
                                                        {postedHere ? ` Đang theo dõi ${postedHere} tin.` : ' Chưa theo dõi tin nào (thêm ở tab "Panel đã gửi").'}
                                                    </span>
                                                    {postedHere > 0 && (
                                                        <button type="button" className="btn-ghost emb-mini" disabled={busy || refreshing || dirty} title={dirty ? "Lưu trước đã" : undefined} onClick={refreshHere}>
                                                            {refreshing ? "Đang cập nhật…" : `Cập nhật ${postedHere} tin`}
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                            {jsonMode ? (
                                                <>
                                                    <textarea className="input mono" rows={28} style={{ fontSize: 12, resize: "vertical" }} value={jsonText} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
                                                    {jsonError && <Msg type="err">JSON lỗi: {jsonError}</Msg>}
                                                </>
                                            ) : tpl.def.kind === "card" ? (
                                                <CardEditor key={tpl.key} value={draft} def={tpl.def} onChange={setDraft} />
                                            ) : (
                                                <MessageEditor key={tpl.key} value={draft} def={tpl.def} onChange={setDraft} />
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>

                            {/* Preview + variables */}
                            <div className="emb-sticky emb-preview-col">
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
