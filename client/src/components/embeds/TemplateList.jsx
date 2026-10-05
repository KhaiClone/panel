import { useEffect, useMemo, useRef, useState } from "react";

// The template list of the Embeds page, built for a few hundred templates:
// bot → group tree (collapsible, remembered in the browser), one bot picker
// instead of a chip per bot, "edited only", and a search over the names, keys
// and the text of the template itself — paste what the bot said in Discord to
// find which template sent it. Accents are ignored ("don moi" finds "Đơn mới").
// Keyboard: ↑ ↓ Enter in the search box (the page focuses it on Ctrl+K).

const OPEN_KEY = "emb.list.groups";
const BOTS_KEY = "emb.list.botsClosed";

const load = (k) => {
    try {
        const v = JSON.parse(localStorage.getItem(k));
        return Array.isArray(v) ? new Set(v) : null;
    } catch {
        return null;
    }
};
const store = (k, set) => {
    try {
        localStorage.setItem(k, JSON.stringify([...set]));
    } catch {
        /* storage disabled */
    }
};

// Lower case, no accents, same length as the input (so a match index points
// into the original text too).
const fold = (s) => {
    let out = "";
    for (const ch of String(s ?? "")) {
        const f = ch.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace("đ", "d");
        out += f.length === ch.length ? f : ch;
    }
    return out;
};

const strings = (v, out = []) => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
    return out;
};

/**
 * "…text around the match…" from the template's text: the string holding the
 * whole search as typed, else the one holding the most of its words.
 */
function Snippet({ texts, terms }) {
    const phrase = terms.join(" ");
    let best = null;
    for (const t of texts) {
        const f = fold(t);
        const whole = f.indexOf(phrase);
        const score = whole >= 0 ? terms.length + 1 : terms.filter((w) => f.includes(w)).length;
        if (!score || (best && score <= best.score)) continue;
        best = { t, f, score, at: whole >= 0 ? whole : Math.min(...terms.map((w) => f.indexOf(w)).filter((i) => i >= 0)) };
        if (whole >= 0) break;
    }
    if (!best) return null;
    const { t, f, at } = best;
    const from = Math.max(0, at - 18);
    const to = Math.min(t.length, from + 90);
    const marks = [];
    for (const w of terms) for (let i = f.indexOf(w, from); i >= 0 && i < to; i = f.indexOf(w, i + w.length)) marks.push([i, Math.min(to, i + w.length)]);
    marks.sort((a, b) => a[0] - b[0]);
    const parts = [];
    let pos = from;
    for (const [a, b] of marks) {
        if (b <= pos) continue;
        if (a > pos) parts.push(t.slice(pos, a));
        parts.push(<mark key={a}>{t.slice(Math.max(a, pos), b)}</mark>);
        pos = b;
    }
    parts.push(t.slice(pos, to));
    return (
        <div className="emb-snippet">
            {from > 0 && "…"}
            {parts}
            {to < t.length && "…"}
        </div>
    );
}

export default function TemplateList({ all, projects, overrides, posted, activeKey, onOpen, onCollapse, searchRef }) {
    const [search, setSearch] = useState("");
    const [bot, setBot] = useState("all");
    const [editedOnly, setEditedOnly] = useState(false);
    // Small catalogs start unfolded; big ones start as a list of groups.
    const [openGroups, setOpenGroups] = useState(() => load(OPEN_KEY) || new Set(all.length <= 40 ? all.map((t) => `${t.botId}::${t.def.group}`) : []));
    const [closedBots, setClosedBots] = useState(() => load(BOTS_KEY) || new Set());
    const [cursor, setCursor] = useState(0);
    const [focused, setFocused] = useState(false);
    const [moved, setMoved] = useState(false);
    const listRef = useRef(null);
    // Scroll the list (only the list — scrollIntoView would move the page too)
    // so `el` sits in the part of it that is on screen.
    const reveal = (el) => {
        const box = listRef.current;
        if (!box || !el) return;
        const b = box.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const bottom = Math.min(b.bottom, window.innerHeight);
        if (r.top >= b.top && r.bottom <= bottom) return;
        box.scrollTop += r.top - b.top - (bottom - b.top) / 3;
    };

    const toggle = (set, setter, key, id) => {
        const next = new Set(set);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setter(next);
        store(key, next);
    };

    // The open template gets unfolded and scrolled to (the admin can fold it again).
    const scrollToActive = useRef(true);
    useEffect(() => {
        const t = all.find((x) => x.key === activeKey);
        scrollToActive.current = true;
        if (!t) return;
        const gid = `${t.botId}::${t.def.group}`;
        if (!openGroups.has(gid)) {
            const next = new Set(openGroups).add(gid);
            setOpenGroups(next);
            store(OPEN_KEY, next);
        }
        if (closedBots.has(t.botId)) {
            const next = new Set(closedBots);
            next.delete(t.botId);
            setClosedBots(next);
            store(BOTS_KEY, next);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey]);
    useEffect(() => {
        if (!scrollToActive.current) return;
        const el = listRef.current?.querySelector(".emb-list-item.active");
        if (!el) return;
        reveal(el);
        scrollToActive.current = false;
    });

    // What the search looks through, built once per catalog.
    const index = useMemo(
        () =>
            new Map(
                all.map((t) => {
                    const texts = [...strings(overrides[t.key]?.value), ...strings(t.def.default)];
                    return [t.key, { name: fold(`${t.def.label} ${t.key} ${t.def.group} ${t.botName} ${t.def.description || ""}`), body: fold(texts.join("\n")), texts }];
                }),
            ),
        [all, overrides],
    );

    const terms = useMemo(() => fold(search.trim()).split(/\s+/).filter(Boolean), [search]);
    const filtering = terms.length > 0 || editedOnly;
    const postedKeys = useMemo(() => new Set(Object.values(posted || {}).flat().map((p) => p.key)), [posted]);

    const tree = useMemo(() => {
        const bots = [];
        for (const t of all) {
            if (bot !== "all" && t.botId !== bot) continue;
            if (editedOnly && !overrides[t.key]) continue;
            let byBody = false;
            if (terms.length) {
                const ix = index.get(t.key);
                if (!terms.every((w) => ix.name.includes(w) || ix.body.includes(w))) continue;
                byBody = !terms.every((w) => ix.name.includes(w));
            }
            let b = bots[bots.length - 1];
            if (!b || b.botId !== t.botId) bots.push((b = { botId: t.botId, name: t.botName, groups: [], count: 0, edited: 0 }));
            let g = b.groups[b.groups.length - 1];
            const gid = `${t.botId}::${t.def.group}`;
            if (!g || g.id !== gid) b.groups.push((g = { id: gid, name: t.def.group, items: [], edited: 0 }));
            g.items.push({ t, byBody });
            b.count++;
            if (overrides[t.key]) {
                g.edited++;
                b.edited++;
            }
        }
        return bots;
    }, [all, bot, editedOnly, terms, index, overrides]);

    const total = tree.reduce((n, b) => n + b.count, 0);
    const showBots = bot === "all" && tree.length > 1;
    const botOpen = (b) => filtering || !showBots || !closedBots.has(b.botId);
    const groupOpen = (g) => filtering || openGroups.has(g.id);

    // The rows ↑ ↓ walk through: what is visible right now.
    const visible = [];
    for (const b of tree) if (botOpen(b)) for (const g of b.groups) if (groupOpen(g)) for (const it of g.items) visible.push(it.t);
    // Shown (and Enter opens it) once there is a search or the arrows moved it.
    const cursorKey = focused && (terms.length || moved) ? visible[Math.min(cursor, visible.length - 1)]?.key : null;

    useEffect(() => {
        setCursor(0);
        setMoved(false);
    }, [search, bot, editedOnly]);
    useEffect(() => {
        reveal(listRef.current?.querySelector(".emb-list-item.cursor"));
    }, [cursor]);

    const onKey = (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const cur = Math.min(cursor, visible.length - 1);
            setCursor(moved || terms.length ? Math.max(0, Math.min(visible.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1))) : 0);
            setMoved(true);
        } else if (e.key === "Enter" && cursorKey) {
            e.preventDefault();
            onOpen(visible.find((t) => t.key === cursorKey));
        } else if (e.key === "Escape" && search) {
            e.preventDefault();
            setSearch("");
        }
    };

    const setAllGroups = (open) => {
        const next = new Set(open ? tree.flatMap((b) => b.groups.map((g) => g.id)) : []);
        setOpenGroups(next);
        store(OPEN_KEY, next);
    };

    const editedCount = all.filter((t) => overrides[t.key] && (bot === "all" || t.botId === bot)).length;

    return (
        <div className="card emb-list">
            <div style={{ display: "flex", gap: 6 }}>
                <div style={{ position: "relative", flex: 1 }}>
                    <input
                        ref={searchRef}
                        className="input"
                        placeholder="Tìm tên, key, nội dung… (Ctrl+K)"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        onKeyDown={onKey}
                        onFocus={() => setFocused(true)}
                        onBlur={() => setFocused(false)}
                        style={{ paddingRight: search ? 28 : undefined }}
                    />
                    {search && (
                        <button type="button" className="emb-clear" onClick={() => setSearch("")} title="Xoá (Esc)">
                            ✕
                        </button>
                    )}
                </div>
                <button type="button" className="btn-ghost emb-mini" onClick={onCollapse} title="Ẩn danh sách (Ctrl+K để mở lại)">
                    ⟨
                </button>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {projects.length > 1 && (
                    <select className="input" style={{ flex: 1, minWidth: 0, padding: "5px 8px", fontSize: 12 }} value={bot} onChange={(e) => setBot(e.target.value)}>
                        <option value="all">Tất cả bot ({all.length})</option>
                        {projects.map((p) => (
                            <option key={p.botId} value={p.botId}>
                                {p.name} ({Object.keys(p.templates).length})
                            </option>
                        ))}
                    </select>
                )}
                <button
                    type="button"
                    className={`btn-ghost emb-mini emb-toggle ${editedOnly ? "on" : ""}`}
                    onClick={() => setEditedOnly(!editedOnly)}
                    title="Chỉ hiện mẫu đã sửa"
                    disabled={!editedCount && !editedOnly}
                >
                    <span className="emb-dot" /> Đã sửa {editedCount}
                </button>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: "var(--text-dim)", padding: "0 2px" }}>
                <span>{filtering || bot !== "all" ? `${total} / ${all.length} mẫu` : `${all.length} mẫu`}</span>
                {!filtering && (
                    <span style={{ display: "flex", gap: 8 }}>
                        <button type="button" className="emb-link" onClick={() => setAllGroups(true)}>Mở hết</button>
                        <button type="button" className="emb-link" onClick={() => setAllGroups(false)}>Thu hết</button>
                    </span>
                )}
            </div>
            <div ref={listRef} className="emb-list-scroll">
                {!tree.length && <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "16px 6px", textAlign: "center" }}>Không có mẫu nào khớp.</div>}
                {tree.map((b) => (
                    <div key={b.botId}>
                        {showBots && (
                            <div className="emb-tree-bot" onClick={() => !filtering && toggle(closedBots, setClosedBots, BOTS_KEY, b.botId)}>
                                <span className="emb-caret">{botOpen(b) ? "▾" : "▸"}</span>
                                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                                {b.edited > 0 && <span className="emb-count edited" title="Đã sửa">{b.edited}</span>}
                                <span className="emb-count">{b.count}</span>
                            </div>
                        )}
                        {botOpen(b) &&
                            b.groups.map((g) => (
                                <div key={g.id} className={showBots ? "emb-tree-indent" : undefined}>
                                    <div className="emb-tree-group" onClick={() => !filtering && toggle(openGroups, setOpenGroups, OPEN_KEY, g.id)}>
                                        <span className="emb-caret">{groupOpen(g) ? "▾" : "▸"}</span>
                                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</span>
                                        {g.edited > 0 && <span className="emb-count edited" title="Đã sửa">{g.edited}</span>}
                                        <span className="emb-count">{g.items.length}</span>
                                    </div>
                                    {groupOpen(g) &&
                                        g.items.map(({ t, byBody }) => (
                                            <div
                                                key={t.key}
                                                className={`emb-list-item ${t.key === activeKey ? "active" : ""} ${t.key === cursorKey ? "cursor" : ""}`}
                                                onClick={() => onOpen(t)}
                                                title={t.key}
                                            >
                                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.def.label}</span>
                                                    {t.def.refreshable && <span className="emb-tag" title={postedKeys.has(t.key) ? "Panel gửi vào kênh — có tin đã gửi" : "Panel gửi vào kênh"}>panel</span>}
                                                    {t.def.kind === "card" && <span className="emb-tag">V2</span>}
                                                    {overrides[t.key] && <span className="emb-dot" title="Đã sửa" />}
                                                </div>
                                                {byBody && <Snippet texts={index.get(t.key).texts} terms={terms} />}
                                            </div>
                                        ))}
                                </div>
                            ))}
                    </div>
                ))}
            </div>
        </div>
    );
}
